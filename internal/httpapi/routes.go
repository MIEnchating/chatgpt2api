package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const maxImageConversationHistoryBodyBytes = 96 << 20

func (a *App) handleProfileRelayKey(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		selectedName := strings.TrimSpace(r.URL.Query().Get("token_name"))
		if configID := service.CustomRelayConfigIDFromTokenName(selectedName); configID != "" {
			if a.customRelayConfigs == nil {
				util.WriteError(w, http.StatusServiceUnavailable, "自定义 API 配置存储不可用")
				return
			}
			config, err := a.customRelayConfigs.Config(identityScope(identity), configID)
			if err != nil {
				a.writeCustomRelayConfigError(w, err)
				return
			}
			names := []string{}
			reader, releaseRelayTokenReader := a.acquireRelayTokenReader()
			if reader != nil {
				status := reader.StatusForGroupAndName(r.Context(), identity, "", "")
				names = append(names, util.AsStringSlice(status["token_names"])...)
			}
			releaseRelayTokenReader()
			if config.BaseURL != "" && config.APIKey != "" {
				names = append(names, selectedName)
			}
			status := map[string]any{
				"has_key": config.APIKey != "", "key_preview": "••••••••", "source": "custom",
				"token_name": selectedName, "token_names": names,
			}
			if config.BaseURL == "" || config.APIKey == "" {
				status["message"] = "自定义 API 配置不完整"
			}
			util.WriteJSON(w, http.StatusOK, status)
			return
		}
		reader, releaseRelayTokenReader := a.acquireRelayTokenReader()
		defer releaseRelayTokenReader()
		if reader == nil {
			message := "数据库连接未配置，请联系管理员"
			if identity.Role == service.AuthRoleAdmin {
				message = "请先配置数据库连接"
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"has_key": false, "key_preview": "", "source": "newapi", "message": message, "token_names": []string{}})
			return
		}
		status := reader.StatusForGroupAndName(r.Context(), identity, r.URL.Query().Get("group"), r.URL.Query().Get("token_name"))
		applyDatabaseStatusMessage(status, identity)
		util.WriteJSON(w, http.StatusOK, status)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleProfileBalance(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		reader, releaseRelayTokenReader := a.acquireRelayTokenReader()
		defer releaseRelayTokenReader()
		if reader == nil {
			message := "数据库连接未配置，请联系管理员"
			if identity.Role == service.AuthRoleAdmin {
				message = "请先配置数据库连接"
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"has_balance": false, "source": "newapi", "message": message, "token_names": []string{}})
			return
		}
		status := reader.BalanceStatus(r.Context(), identity)
		applyDatabaseStatusMessage(status, identity)
		util.WriteJSON(w, http.StatusOK, status)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func applyDatabaseStatusMessage(status map[string]any, identity service.Identity) {
	configured, present := status["database_configured"].(bool)
	if !present || configured {
		return
	}
	status["message"] = "数据库连接未配置，请联系管理员"
	if identity.Role == service.AuthRoleAdmin {
		status["message"] = "请先配置数据库连接"
	}
}

func (a *App) handleProfilePromptFavorites(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := util.Clean(identity.OwnerID)
	if ownerID == "" {
		util.WriteError(w, http.StatusForbidden, "prompt favorites require a bound user account")
		return
	}

	base := "/api/profile/prompt-favorites"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			items, err := a.promptFavoritesForIdentity(ownerID)
			if err != nil {
				if writePromptFavoriteStorageError(w, err) {
					return
				}
				util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			if util.ToBool(body["is_nsfw"]) {
				util.WriteError(w, http.StatusForbidden, "adult prompts are not supported")
				return
			}
			item, items, err := a.prompts.UpsertWithItems(ownerID, body)
			if err != nil {
				if writePromptFavoriteStorageError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": items})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "profile" || parts[2] != "prompt-favorites" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	deleted, items, err := a.prompts.DeleteWithItems(ownerID, parts[3])
	if err != nil {
		if writePromptFavoriteStorageError(w, err) {
			return
		}
		util.WriteError(w, http.StatusInternalServerError, "failed to delete prompt favorite")
		return
	}
	if !deleted {
		util.WriteError(w, http.StatusNotFound, "prompt favorite not found")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func writePromptFavoriteStorageError(w http.ResponseWriter, err error) bool {
	var storageErr *service.PromptFavoriteStorageError
	if !errors.As(err, &storageErr) {
		return false
	}
	if service.IsConcurrentRowUpdate(err) {
		util.WriteError(w, http.StatusConflict, "prompt favorite was modified by another request; please retry")
		return true
	}
	util.WriteError(w, http.StatusServiceUnavailable, "prompt favorite storage is temporarily unavailable")
	return true
}

func (a *App) handleProfileAssets(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		if r.URL.Query().Get("scope") == "visible" {
			items, err := a.myAssets.ListVisible(ownerID, identity.Role == service.AuthRoleAdmin, a.myAssetOwners(identity))
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load assets")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
			return
		}
		items, err := a.myAssets.EnsureTextStorage(r.Context(), ownerID, identity.Role == service.AuthRoleAdmin)
		if err != nil {
			a.logger.Warning("text asset storage migration failed", "owner_id", ownerID, "error", err)
			items, err = a.myAssets.List(ownerID)
		}
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load assets")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
	case http.MethodPost:
		var body struct {
			Item service.MyAsset `json:"item"`
		}
		if err := util.DecodeJSON(r.Body, &body); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		item, err := a.myAssets.Upsert(r.Context(), ownerID, identity.Role == service.AuthRoleAdmin, body.Item)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item})
	case http.MethodDelete:
		var body struct {
			ID string `json:"id"`
		}
		if err := util.DecodeJSON(r.Body, &body); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		deleted, err := a.myAssets.Delete(r.Context(), ownerID, identity.Role == service.AuthRoleAdmin, body.ID)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"deleted": deleted, "id": strings.TrimSpace(body.ID)})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) myAssetOwners(identity service.Identity) []service.MyAssetOwner {
	owners := map[string]string{"admin": "管理员"}
	viewerID := identityScope(identity)
	owners[viewerID] = firstNonEmpty(identityDisplayName(identity), util.Clean(identity.Username))
	for _, item := range a.auth.ListUsers() {
		ownerID := firstNonEmpty(util.Clean(item["owner_id"]), util.Clean(item["id"]))
		if ownerID == "" {
			continue
		}
		owners[ownerID] = firstNonEmpty(util.Clean(item["name"]), util.Clean(item["owner_name"]), util.Clean(item["username"]))
	}
	result := make([]service.MyAssetOwner, 0, len(owners))
	for id, name := range owners {
		result = append(result, service.MyAssetOwner{ID: id, Name: name})
	}
	return result
}

func (a *App) promptFavoritesForIdentity(ownerID string) ([]map[string]any, error) {
	items, err := a.prompts.ListWithError(ownerID)
	if err != nil {
		return nil, err
	}
	filtered := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if util.ToBool(item["is_nsfw"]) {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, nil
}

func (a *App) handleProfileImageConversations(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	base := "/api/profile/image-conversations"
	if r.URL.Path == base+"/window" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		limit := 0
		if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
			parsed, parseErr := strconv.Atoi(rawLimit)
			if parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid conversation history limit")
				return
			}
			limit = parsed
		}
		for attempt := 0; attempt < 3; attempt++ {
			firstPage, err := a.history.ListPage(r.Context(), ownerID, "", limit)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			activeItems, generation, err := a.history.ListActive(r.Context(), ownerID, 0)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			if firstPage.Generation != generation {
				continue
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{
				"first_page": firstPage,
				"active_page": map[string]any{
					"items":      activeItems,
					"has_more":   false,
					"generation": generation,
				},
			})
			return
		}
		util.WriteError(w, http.StatusServiceUnavailable, "历史记录正在更新，请稍后重试")
		return
	}
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
			limit := 0
			if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
				parsed, parseErr := strconv.Atoi(rawLimit)
				if parseErr != nil {
					util.WriteError(w, http.StatusBadRequest, "invalid conversation history limit")
					return
				}
				limit = parsed
			}
			page, err := a.history.ListPage(r.Context(), ownerID, cursor, limit)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			util.WriteJSON(w, http.StatusOK, page)
		case http.MethodPost:
			release, acquired := a.acquireImageConversationHistoryWrite(r)
			if !acquired {
				util.WriteError(w, http.StatusRequestTimeout, "conversation history request was canceled")
				return
			}
			defer release()
			r.Body = http.MaxBytesReader(w, r.Body, maxImageConversationHistoryBodyBytes)
			body, err := readJSONMapLimit(r, maxImageConversationHistoryBodyBytes)
			if err != nil {
				status := http.StatusBadRequest
				message := "invalid json body"
				var maxBytesError *http.MaxBytesError
				if errors.As(err, &maxBytesError) {
					status = http.StatusRequestEntityTooLarge
					message = "conversation history payload is too large"
				}
				util.WriteError(w, status, message)
				return
			}
			items := util.AsMapSlice(body["items"])
			if item := util.StringMap(body["item"]); len(item) > 0 {
				items = append(items, item)
			}
			if len(items) == 0 {
				util.WriteError(w, http.StatusBadRequest, "conversation items are required")
				return
			}
			// Assetization happens before the row CAS. Always enqueue owner GC so
			// files created by a rejected/conflicting write are reclaimed after the
			// orphan grace window as well as files released by a successful update.
			defer a.scheduleImageConversationAssetCleanupDebounced(ownerID)
			acknowledgements, generation, mergeErr := a.history.MergeWithAcknowledgementsMinimal(r.Context(), ownerID, items)
			if mergeErr != nil {
				writeImageConversationHistoryError(w, mergeErr)
				return
			}
			// A durable task submission always saves one conversation and needs a
			// strict acknowledgement. Bulk background sync can legitimately contain
			// both accepted and stale snapshots, so report each result without
			// turning a partially successful write into a request-level failure.
			if len(acknowledgements) == 1 {
				acknowledgement := acknowledgements[0]
				if acknowledgement.Gone {
					util.WriteJSON(w, http.StatusGone, map[string]any{
						"error":      "conversation history item was deleted or cleared",
						"id":         acknowledgement.ID,
						"generation": generation,
					})
					return
				}
				if !acknowledgement.Accepted {
					util.WriteJSON(w, http.StatusConflict, map[string]any{
						"error":      "conversation history revision is stale",
						"id":         acknowledgement.ID,
						"revision":   acknowledgement.ActualRevision,
						"generation": generation,
					})
					return
				}
			}
			response := map[string]any{
				"ok":         true,
				"generation": generation,
			}
			if len(acknowledgements) == 1 {
				response["accepted"] = true
				response["id"] = acknowledgements[0].ID
				response["revision"] = acknowledgements[0].ActualRevision
			} else {
				response["acknowledgements"] = acknowledgements
			}
			util.WriteJSON(w, http.StatusOK, response)
		case http.MethodDelete:
			generation, err := a.history.ClearMinimal(r.Context(), ownerID)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			a.scheduleImageConversationAssetCleanup(ownerID)
			util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "generation": generation})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "profile" || parts[2] != "image-conversations" {
		http.NotFound(w, r)
		return
	}
	if parts[3] == "active" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		limit := 0
		if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
			parsed, parseErr := strconv.Atoi(rawLimit)
			if parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid active conversation limit")
				return
			}
			limit = parsed
		}
		items, generation, err := a.history.ListActive(r.Context(), ownerID, limit)
		if err != nil {
			writeImageConversationHistoryError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": items, "generation": generation})
		return
	}
	if r.Method == http.MethodGet {
		item, found, generation, err := a.history.GetItem(r.Context(), ownerID, parts[3])
		if err != nil {
			writeImageConversationHistoryError(w, err)
			return
		}
		if !found {
			util.WriteError(w, http.StatusNotFound, "image conversation not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "generation": generation})
		return
	}
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	removed, generation, err := a.history.DeleteMinimal(r.Context(), ownerID, parts[3])
	if err != nil {
		writeImageConversationHistoryError(w, err)
		return
	}
	a.scheduleImageConversationAssetCleanup(ownerID)
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"removed":    removed,
		"generation": generation,
	})
}

func (a *App) acquireImageConversationHistoryWrite(r *http.Request) (func(), bool) {
	if a == nil || a.historyWriteLimiter == nil {
		return func() {}, true
	}
	return a.historyWriteLimiter.acquire(
		r.Context(),
		imageConversationHistoryWriteWeight(r.ContentLength),
	)
}

func writeImageConversationHistoryError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrImageConversationAssetStorageLimit) {
		util.WriteError(w, http.StatusInsufficientStorage, "image storage limit exceeded")
		return
	}
	var cursorInvalidated service.ImageConversationHistoryCursorInvalidatedError
	if errors.As(err, &cursorInvalidated) {
		util.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":      cursorInvalidated.Error(),
			"code":       "history_reset",
			"generation": cursorInvalidated.Generation,
		})
		return
	}
	var cursorError service.ImageConversationHistoryCursorError
	if errors.As(err, &cursorError) {
		util.WriteError(w, http.StatusBadRequest, cursorError.Error())
		return
	}
	var validationErr service.ImageConversationHistoryValidationError
	if errors.As(err, &validationErr) {
		util.WriteError(w, http.StatusBadRequest, validationErr.Error())
		return
	}
	util.WriteError(w, http.StatusServiceUnavailable, "历史记录数据库暂时不可用，请稍后重试")
}

func (a *App) writeAuthPersistenceError(w http.ResponseWriter, err error) bool {
	var persistenceErr service.AuthPersistenceError
	if !errors.As(err, &persistenceErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("auth persistence failed", "error", persistenceErr.Err)
	}
	if service.IsConcurrentRowUpdate(err) {
		util.WriteError(w, http.StatusConflict, "认证数据已被其他实例更新，请重试")
		return true
	}
	util.WriteError(w, http.StatusServiceUnavailable, "认证数据库暂时不可用，请稍后重试")
	return true
}

func (a *App) handleCreationTasks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	parts := splitPath(r.URL.Path)
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "creation-tasks" && parts[3] == "video-content" {
		a.handleVideoContentRecovery(w, r, identity, parts[2])
		return
	}
	if r.URL.Path == "/api/creation-tasks/events" && r.Method == http.MethodGet {
		a.handleCreationTaskEvents(w, r, identity)
		return
	}
	if r.URL.Path == "/api/creation-tasks" && r.Method == http.MethodGet {
		tasks, err := a.tasks.ListTasksWithError(identity, util.ParseCommaList(r.URL.Query().Get("ids")))
		if err != nil {
			a.writeCreationTaskStorageError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, tasks)
		return
	}
	if r.URL.Path == "/api/creation-tasks" && r.Method == http.MethodDelete {
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		ids := util.AsStringSlice(body["ids"])
		if len(ids) > 1000 {
			util.WriteError(w, http.StatusBadRequest, "一次最多清理 1000 条任务")
			return
		}
		result, err := a.tasks.DeleteTasks(identity, ids)
		if err != nil {
			if a.writeCreationTaskStorageError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, result)
		return
	}
	if r.URL.Path == "/api/creation-tasks/audio-voices" && r.Method == http.MethodGet {
		model := strings.TrimSpace(r.URL.Query().Get("model"))
		if audioProtocolForModel(model) != "grok" || allowedPersonalModel(model, a.config.AudioModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "Grok TTS 模型不可用")
			return
		}
		credential, err := a.relayCredentialForIdentitySelection(r.Context(), identity, strings.TrimSpace(r.URL.Query().Get("token_group")), strings.TrimSpace(r.URL.Query().Get("token_name")))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		requestContext := r.Context()
		if credential.Custom {
			requestContext = withCustomRelayContext(requestContext)
		}
		voices, err := a.fetchGrokTTSVoicesAt(requestContext, credential.BaseURL, credential.APIKey, model)
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"voices": voices})
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "creation-tasks" && parts[3] == "cancel" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		task, err := a.tasks.CancelTask(identity, parts[2])
		if err != nil {
			if a.writeCreationTaskStorageError(w, err) {
				return
			}
			util.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-generations" && r.Method == http.MethodPost {
		body, err := readJSONMapLimit(r, maxCreationTaskJSONBytes)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := a.applyDefaultImageModel(body)
		apiMode := normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), model, body)
		if apiMode == "" {
			util.WriteError(w, http.StatusBadRequest, "api_mode must be images, responses, or chat")
			return
		}
		body["api_mode"] = apiMode
		if err := validateRelayImageRequest("/api/creation-tasks/image-generations", model, body, nil); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		// Keep the application's quality vocabulary in the persisted task.
		// Provider normalization below may replace it with a native value (for
		// example Agnes 3K), but the worker needs the original value when it
		// builds the upstream request later.
		taskQuality := util.Clean(body["quality"])
		if !validProtocolImageCount(body["n"]) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage())
			return
		}
		taskCount := normalizedProtocolImageCount(body["n"])
		if apiMode == "images" {
			normalizeImagePayloadForModel(body)
		}
		if allowedPersonalModel(model, a.config.ImageModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "图片模型不可用")
			return
		}
		if err := a.freezeRelayCredentialForTask(r.Context(), identity, body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateGoogleGeminiInlineRequest(body, nil); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitGenerationWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), taskCount, imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/video-generations" && r.Method == http.MethodPost {
		body, err := readJSONMapLimit(r, maxCreationTaskJSONBytes)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := util.Clean(body["model"])
		if model == "" {
			util.WriteError(w, http.StatusBadRequest, "请选择视频模型")
			return
		}
		allowed := false
		for _, candidate := range a.configuredVideoModels() {
			if strings.EqualFold(candidate, model) {
				allowed = true
				model = candidate
				body["model"] = candidate
				break
			}
		}
		if !allowed {
			util.WriteError(w, http.StatusBadRequest, "视频模型不可用")
			return
		}
		contract, ok := protocol.VideoContractForModel(model)
		if !ok {
			util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("视频模型 %q 未配置启用的视频模型契约", model))
			return
		}
		if err := normalizeVideoContractInput(body, contract); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		refs := removeVideoFrameAliases(util.AsStringSlice(body["reference_image_urls"]), videoFrameAliases(body))
		referenceVideoURLs := util.AsStringSlice(body["reference_video_urls"])
		referenceAudioURLs := util.AsStringSlice(body["reference_audio_urls"])
		referenceMode := util.Clean(body["reference_mode"])
		seconds := util.ToInt(body["seconds"], contract.Capability.DefaultSeconds)
		if err := a.freezeRelayCredentialForTask(r.Context(), identity, body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		contractReference, err := a.videoContracts.ReferenceForContract(contract, model)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "读取视频契约版本失败")
			return
		}
		metadata := videoTaskRequestMetadata(body, contract)
		metadata["video_contract"] = contractReference
		task, err := a.tasks.SubmitVideo(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), util.ToBool(body["watermark"]), referenceMode, refs, referenceVideoURLs, referenceAudioURLs, metadata)
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/audio-generations" && r.Method == http.MethodPost {
		body, err := readJSONMapLimit(r, maxCreationTaskJSONBytes)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := firstNonEmpty(util.Clean(body["model"]), a.config.DefaultAudioModel(), firstString(a.config.AudioModels(), "tts-1"))
		if allowedPersonalModel(model, a.config.AudioModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "音频模型不可用")
			return
		}
		body["model"] = model
		if err := validateAudioGenerationPayload(body); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.freezeRelayCredentialForTask(r.Context(), identity, body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitAudio(r.Context(), identity, util.Clean(body["client_task_id"]), body, creationTaskRequestMetadata(body))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/chat-completions" && r.Method == http.MethodPost {
		body, err := readJSONMapLimit(r, maxCreationTaskJSONBytes)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := firstNonEmpty(util.Clean(body["model"]), a.config.DefaultTextModel(), firstString(a.config.TextModels(), a.defaultChatModel()))
		if allowedPersonalModel(model, a.config.TextModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "文本模型不可用")
			return
		}
		messages := util.AsMapSlice(body["messages"])
		prompt := util.Clean(body["prompt"])
		if len(messages) == 0 && prompt != "" {
			messages = []map[string]any{{"role": "user", "content": prompt}}
		}
		if len(messages) == 0 {
			util.WriteError(w, http.StatusBadRequest, "messages are required")
			return
		}
		if prompt == "" {
			prompt = util.Clean(messages[len(messages)-1]["content"])
		}
		if err := a.freezeRelayCredentialForTask(r.Context(), identity, body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitChatWithMetadata(r.Context(), identity, util.Clean(body["client_task_id"]), prompt, model, messages, chatTaskRequestMetadata(body))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-edits" && r.Method == http.MethodPost {
		release, acquired := a.acquireImageUpload(r.Context())
		if !acquired {
			util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
			return
		}
		defer release()
		body, images, err := readMultipartImageBody(w, r)
		if err != nil {
			writeMultipartImageBodyError(w, err)
			return
		}
		model := a.applyDefaultImageModel(body)
		apiMode := normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), model, body)
		if apiMode == "" {
			util.WriteError(w, http.StatusBadRequest, "api_mode must be images, responses, or chat")
			return
		}
		body["api_mode"] = apiMode
		if err := validateRelayImageRequest("/api/creation-tasks/image-edits", model, body, images); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		taskQuality := util.Clean(body["quality"])
		if !validProtocolImageCount(body["n"]) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage())
			return
		}
		taskCount := normalizedProtocolImageCount(body["n"])
		if apiMode == "images" {
			normalizeImagePayloadForModel(body)
		}
		if allowedPersonalModel(model, a.config.ImageModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "图片模型不可用")
			return
		}
		if err := a.freezeRelayCredentialForTask(r.Context(), identity, body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateRelayImageReferenceCount(model, len(images), body); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateGoogleGeminiInlineRequest(body, images); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitEditWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), images, taskCount, imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	http.NotFound(w, r)
}

// isPublicReferenceURL delegates to the shared public URL validation in util.
func isPublicReferenceURL(value string) bool {
	return util.IsPublicHTTPURL(value)
}

func creationTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := map[string]any{relayTaskCredentialKey: body[relayTaskCredentialKey]}
	if tokenGroup := selectedRelayTokenGroupFromPayload(body); tokenGroup != "" {
		metadata["token_group"] = tokenGroup
	}
	if tokenName := selectedRelayTokenNameFromPayload(body); tokenName != "" {
		metadata["token_name"] = tokenName
	}
	for _, key := range []string{"preset", "mode"} {
		if value, ok := body[key]; ok {
			metadata[key] = value
		}
	}
	return metadata
}

func chatTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := creationTaskRequestMetadata(body)
	for _, key := range []string{"api_mode", "reasoning_enabled", "max_output_tokens", "stream"} {
		if value, ok := body[key]; ok {
			metadata[key] = value
		}
	}
	if tools := util.AsMapSlice(body["tools"]); len(tools) > 0 {
		metadata["tools"] = tools
	}
	if choice, ok := body["tool_choice"]; ok && choice != nil {
		metadata["tool_choice"] = choice
	}
	return metadata
}

func videoTaskRequestMetadata(body map[string]any, contract protocol.VideoModelContract) map[string]any {
	constraints := service.VideoTaskInputConstraints{PromptRequired: contract.Capability.Prompt == nil || contract.Capability.Prompt.Required, MaximumSeconds: 3600}
	if duration := contract.Capability.SecondsRange; duration != nil {
		constraints.MaximumSeconds = 0
		if duration.Max != nil {
			constraints.MaximumSeconds = *duration.Max
		}
	}

	metadata := map[string]any{
		relayTaskCredentialKey:                    body[relayTaskCredentialKey],
		protocol.VideoContractSnapshotPayloadKey:  contract,
		service.VideoTaskInputConstraintsKey:      constraints,
		service.VideoTaskTimeoutSecondsPayloadKey: contract.Polling.TimeoutSeconds + contract.Polling.IntervalSeconds,
	}
	if parameters, ok := body["parameters"].(map[string]any); ok {
		metadata["parameters"] = parameters
	}
	if inputs, ok := body["workflow_inputs"]; ok {
		metadata["workflow_inputs"] = inputs
	}
	if tokenGroup := selectedRelayTokenGroupFromPayload(body); tokenGroup != "" {
		metadata["token_group"] = tokenGroup
	}
	if tokenName := selectedRelayTokenNameFromPayload(body); tokenName != "" {
		metadata["token_name"] = tokenName
	}
	for _, key := range []string{"first_frame_url", "last_frame_url"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			metadata[key] = value
		}
	}
	if generationMode := strings.TrimSpace(util.Clean(body["generation_mode"])); generationMode != "" {
		metadata["generation_mode"] = generationMode
	}
	return metadata
}

func imageTaskRequestMetadata(body map[string]any) map[string]any {
	requestedSize := firstNonEmpty(util.Clean(body["requested_size"]), util.Clean(body["size"]))
	metadata := creationTaskRequestMetadata(body)
	if workflowContext := util.StringMap(body["workflow_context"]); len(workflowContext) > 0 {
		metadata["workflow_context"] = workflowContext
	}
	if source := service.NormalizeImageGenerationSource(util.Clean(body["generation_source"])); source != "" {
		metadata["generation_source"] = source
	}
	metadata["api_mode"] = normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), util.Clean(body["model"]), body)
	if preset := service.NormalizeImageResolutionPreset(firstNonEmpty(util.Clean(body["image_resolution"]), util.Clean(body["resolution"]))); preset != "" {
		metadata["image_resolution"] = preset
	}
	if requestedSize != "" {
		metadata["requested_size"] = requestedSize
	}
	for _, key := range []string{"aspect_ratio", "ratio"} {
		if value := util.Clean(body[key]); value != "" {
			metadata[key] = value
		}
	}
	for _, key := range []string{"provider", "image_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		if value := util.Clean(body[key]); value != "" {
			metadata[key] = value
		}
	}
	if util.ToBool(body["share_prompt_parameters"]) {
		metadata["share_prompt_parameters"] = true
		if util.ToBool(body["share_reference_images"]) {
			metadata["share_reference_images"] = true
		}
	}
	if conversationID := util.Clean(body["frontend_conversation_id"]); conversationID != "" {
		metadata["frontend_conversation_id"] = conversationID
	}
	if fallback := util.StringMap(body["fallback_reference_image"]); len(fallback) > 0 {
		metadata["fallback_reference_image"] = fallback
	}
	return metadata
}

func normalizeImageTaskAPIMode(value, model string, payloads ...map[string]any) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "images"
	}
	if value != "images" && value != "responses" && value != "chat" {
		return ""
	}
	route := util.ImageModelRouteFor(model)
	if len(payloads) > 0 {
		route = imagePayloadRoute(payloads[0])
		if _, configured := configuredImageDefinition(payloads[0]); configured {
			return "images"
		}
	}
	if route == util.ImageModelRouteGoogleGemini || route == util.ImageModelRouteZhipu {
		return "images"
	}
	return value
}

func imageOutputOptionsFromBody(body map[string]any) service.ImageOutputOptions {
	rawFormat := util.Clean(body["output_format"])
	if rawFormat == "" {
		return service.ImageOutputOptions{}
	}
	format := service.NormalizeImageOutputFormat(rawFormat)
	options := service.ImageOutputOptions{Format: format}
	if service.SupportsImageOutputCompression(format) {
		if compression, ok := imageOutputCompressionFromBody(body["output_compression"]); ok {
			options.Compression = &compression
		}
	}
	return options
}

func imageToolOptionsFromBody(body map[string]any) service.ImageToolOptions {
	options := service.ImageToolOptions{
		Moderation:     util.Clean(body["moderation"]),
		InputImageMask: util.Clean(body["input_image_mask"]),
		Stream:         util.ToBool(body["stream"]),
		ResponseFormat: util.Clean(body["response_format"]),
	}
	if partialImages, ok := imagePartialImagesFromBody(body["partial_images"]); ok {
		options.PartialImages = partialImages
		options.PartialImagesSet = true
	}
	return options
}

func imagePartialImagesFromBody(value any) (int, bool) {
	partialImages, ok := util.StrictInt(value)
	if !ok {
		return 0, false
	}
	if partialImages < 0 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func imageOutputCompressionFromBody(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression, ok := util.StrictInt(value)
	if !ok {
		return 0, false
	}
	if compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func (a *App) writeCreationTaskSubmitError(w http.ResponseWriter, err error) {
	var httpErr protocol.HTTPError
	if errors.As(err, &httpErr) {
		status := httpErr.Status
		if status < http.StatusBadRequest || status > 599 {
			status = http.StatusBadRequest
		}
		util.WriteError(w, status, httpErr.Message)
		return
	}
	var limitErr service.ImageTaskLimitError
	if errors.As(err, &limitErr) {
		util.WriteError(w, http.StatusTooManyRequests, limitErr.Error())
		return
	}
	if a.writeCreationTaskStorageError(w, err) {
		return
	}
	util.WriteError(w, http.StatusBadRequest, err.Error())
}

func (a *App) writeCreationTaskStorageError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, service.ErrImageTaskServiceClosed) {
		util.WriteError(w, http.StatusServiceUnavailable, "创建任务服务暂时不可用，请稍后重试")
		return true
	}
	var persistenceErr service.ImageTaskPersistenceError
	if errors.As(err, &persistenceErr) {
		if a != nil && a.logger != nil {
			a.logger.Error("creation task persistence failed", "error", persistenceErr.Err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, persistenceErr.Error())
		return true
	}
	var loadErr service.ImageTaskLoadError
	if !errors.As(err, &loadErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("creation task database load failed", "error", loadErr.Err)
	}
	util.WriteError(w, http.StatusServiceUnavailable, loadErr.Error())
	return true
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}
