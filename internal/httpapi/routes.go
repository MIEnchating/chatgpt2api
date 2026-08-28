package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const maxImageConversationHistoryBodyBytes = 96 << 20

func (a *App) handleImageGenerationPreferences(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		preferences, err := a.imagePreferences.Preferences(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load image generation preferences")
			return
		}
		preferences.DefaultTextModel = allowedPersonalModel(preferences.DefaultTextModel, a.config.TextModels())
		preferences.DefaultImageModel = allowedPersonalModel(preferences.DefaultImageModel, a.config.ImageModels())
		preferences.DefaultVideoModel = allowedPersonalModel(preferences.DefaultVideoModel, a.config.VideoModels())
		preferences.DefaultAudioModel = allowedPersonalModel(preferences.DefaultAudioModel, a.config.AudioModels())
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	case http.MethodPut, http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		partialImages, valid := imagePreferencePartialImages(body["partial_images"])
		if !valid {
			util.WriteError(w, http.StatusBadRequest, "partial_images must be an integer between 0 and 3")
			return
		}
		canvasDefaultImageCount, valid := imagePreferenceCanvasDefaultImageCount(body["canvas_default_image_count"])
		if !valid {
			util.WriteError(w, http.StatusBadRequest, "canvas_default_image_count must be an integer between 1 and 15")
			return
		}
		defaultAudioSpeed, valid := imagePreferenceAudioSpeed(body["default_audio_speed"])
		if !valid {
			util.WriteError(w, http.StatusBadRequest, "default_audio_speed must be between 0.25 and 4")
			return
		}
		defaultAudioFormat := strings.ToLower(strings.TrimSpace(util.Clean(body["default_audio_format"])))
		if defaultAudioFormat == "" {
			defaultAudioFormat = "mp3"
		}
		requestedModels := []struct {
			field   string
			model   string
			allowed []string
		}{
			{field: "default_text_model", model: util.Clean(body["default_text_model"]), allowed: a.config.TextModels()},
			{field: "default_image_model", model: util.Clean(body["default_image_model"]), allowed: a.config.ImageModels()},
			{field: "default_video_model", model: util.Clean(body["default_video_model"]), allowed: a.config.VideoModels()},
			{field: "default_audio_model", model: util.Clean(body["default_audio_model"]), allowed: a.config.AudioModels()},
		}
		for _, requested := range requestedModels {
			if strings.TrimSpace(requested.model) != "" && allowedPersonalModel(requested.model, requested.allowed) == "" {
				util.WriteError(w, http.StatusBadRequest, requested.field+" is not enabled by the administrator")
				return
			}
		}
		preferences, err := a.imagePreferences.Update(ownerID, service.ImageGenerationPreferences{
			APIMode:                 util.Clean(body["api_mode"]),
			Stream:                  util.ToBool(body["stream"]),
			PartialImages:           partialImages,
			ResponseFormatB64JSON:   util.ToBool(body["response_format_b64_json"]),
			CodexCLICompatibility:   util.ToBool(body["codex_cli_compatibility"]),
			SystemPrompt:            util.Clean(body["system_prompt"]),
			VideoSystemPrompt:       util.Clean(body["video_system_prompt"]),
			AudioInstructions:       util.Clean(body["audio_instructions"]),
			DefaultTextModel:        strings.TrimSpace(requestedModels[0].model),
			DefaultImageModel:       strings.TrimSpace(requestedModels[1].model),
			DefaultVideoModel:       strings.TrimSpace(requestedModels[2].model),
			DefaultAudioModel:       strings.TrimSpace(requestedModels[3].model),
			CanvasDefaultImageCount: canvasDefaultImageCount,
			DefaultAudioVoice:       strings.TrimSpace(util.Clean(body["default_audio_voice"])),
			DefaultAudioFormat:      defaultAudioFormat,
			DefaultAudioSpeed:       defaultAudioSpeed,
		})
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func allowedPersonalModel(model string, allowed []string) string {
	model = strings.TrimSpace(model)
	for _, candidate := range allowed {
		if model == strings.TrimSpace(candidate) {
			return model
		}
	}
	return ""
}

func imagePreferencePartialImages(value any) (int, bool) {
	if value == nil {
		return 0, true
	}
	partialImages, ok := util.StrictInt(value)
	return partialImages, ok && partialImages >= 0 && partialImages <= 3
}

func imagePreferenceCanvasDefaultImageCount(value any) (int, bool) {
	if value == nil {
		return 1, true
	}
	count, ok := util.StrictInt(value)
	return count, ok && count >= 1 && count <= 15
}

func imagePreferenceAudioSpeed(value any) (float64, bool) {
	if value == nil {
		return 1, true
	}
	speed, err := strconv.ParseFloat(strings.TrimSpace(util.Clean(value)), 64)
	return speed, err == nil && speed >= 0.25 && speed <= 4
}

func (a *App) handleProfileRelayKey(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		reader := a.relayTokenReader()
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
		reader := a.relayTokenReader()
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
			item, err := a.prompts.Upsert(ownerID, body)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			items, err := a.promptFavoritesForIdentity(ownerID)
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
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
	deleted, err := a.prompts.Delete(ownerID, parts[3])
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to delete prompt favorite")
		return
	}
	if !deleted {
		util.WriteError(w, http.StatusNotFound, "prompt favorite not found")
		return
	}
	items, err := a.promptFavoritesForIdentity(ownerID)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleProfileAssets(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		items, err := a.myAssets.EnsureTextStorage(r.Context(), ownerID, identity.Role == service.AuthRoleAdmin)
		if err != nil {
			a.logger.Warning("text asset storage migration failed", "owner_id", ownerID, "error", err)
			items, err = a.myAssets.List(ownerID)
		}
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load assets")
			return
		}
		if r.URL.Query().Get("scope") == "visible" {
			items, err = a.myAssets.ListVisible(ownerID, identity.Role == service.AuthRoleAdmin, a.myAssetOwners(identity))
		}
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load assets")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
	case http.MethodPut:
		var body struct {
			Items []service.MyAsset `json:"items"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		items, err := a.myAssets.Replace(r.Context(), ownerID, identity.Role == service.AuthRoleAdmin, body.Items)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
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
			body, err := readJSONMap(r)
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
			expectedGeneration, generationErr := imageConversationHistoryRequestGeneration(body)
			if generationErr != nil {
				util.WriteError(w, http.StatusBadRequest, generationErr.Error())
				return
			}
			acknowledgements, generation, mergeErr := a.history.MergeWithAcknowledgementsMinimal(r.Context(), ownerID, items, expectedGeneration)
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

func imageConversationHistoryRequestGeneration(body map[string]any) (*int64, error) {
	value, exists := body["generation"]
	if !exists {
		value, exists = body["history_epoch"]
	}
	if !exists || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
		return nil, nil
	}
	generation, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
	if err != nil || generation < 1 {
		return nil, fmt.Errorf("invalid conversation history generation")
	}
	return &generation, nil
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

func (a *App) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	base := "/api/admin/roles"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListRoles()})
		case http.MethodPost:
			body, _ := readJSONMap(r)
			item, err := a.auth.CreateRole(body)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListRoles()})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "roles" {
		http.NotFound(w, r)
		return
	}
	roleID := parts[3]
	switch r.Method {
	case http.MethodPost:
		body, _ := readJSONMap(r)
		item, err := a.auth.UpdateRole(roleID, body)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			status := http.StatusBadRequest
			if err.Error() == "role not found" {
				status = http.StatusNotFound
			}
			util.WriteError(w, status, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListRoles()})
	case http.MethodDelete:
		deleted, err := a.auth.DeleteRole(roleID)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			status := http.StatusBadRequest
			if err.Error() == "role is assigned to users" {
				status = http.StatusConflict
			}
			util.WriteError(w, status, err.Error())
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "role not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListRoles()})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	base := "/api/admin/users"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			response, err := a.managedUsersResponse(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, response)
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			enabled := true
			if value, ok := body["enabled"]; ok {
				enabled = util.ToBool(value)
			}
			item, err := a.auth.CreatePasswordUser(
				util.Clean(body["username"]),
				util.Clean(body["password"]),
				util.Clean(body["name"]),
				util.Clean(body["role_id"]),
				enabled,
			)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			response, err := a.managedUsersResponse(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if current := a.managedUser(util.Clean(item["id"])); current != nil {
				item = current
			}
			response["item"] = item
			util.WriteJSON(w, http.StatusOK, response)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "users" {
		http.NotFound(w, r)
		return
	}
	userID := parts[3]
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
		body, _ := readJSONMap(r)
		updates := map[string]any{}
		if value, ok := body["name"]; ok {
			updates["name"] = value
		}
		if value, ok := body["enabled"]; ok {
			updates["enabled"] = value
		}
		if value, ok := body["role_id"]; ok {
			if roleID := util.Clean(value); roleID != "" && !a.auth.RoleExists(roleID) {
				util.WriteError(w, http.StatusBadRequest, "role not found")
				return
			}
			updates["role_id"] = value
		}
		if len(updates) == 0 {
			util.WriteError(w, http.StatusBadRequest, "no updates provided")
			return
		}
		if len(updates) > 0 {
			item, err := a.auth.UpdateUser(userID, updates)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusInternalServerError, "failed to update user")
				return
			}
			if item == nil {
				util.WriteError(w, http.StatusNotFound, "user not found")
				return
			}
		} else if findManagedUser(a.auth.ListUsers(), userID) == nil {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		response, err := a.managedUsersResponse(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		item := a.managedUser(userID)
		response["item"] = item
		util.WriteJSON(w, http.StatusOK, response)
	case http.MethodDelete:
		deleted, err := a.auth.DeleteUser(userID)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to delete user")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		response, err := a.managedUsersResponse(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, response)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

type managedUsersQuery struct {
	Page       int
	PageSize   int
	Search     string
	Provider   string
	Status     string
	SortBy     string
	SortOrder  string
	Total      int
	TotalPages int
}

func (a *App) managedUsersResponse(r *http.Request) (map[string]any, error) {
	query, err := parseManagedUsersQuery(r)
	if err != nil {
		return nil, err
	}
	items := filterManagedUsers(a.auth.ListUsers(), query)
	a.prepareManagedUsersSortValues(items, query.SortBy)
	sortManagedUsers(items, query)
	query.Total = len(items)
	query.TotalPages = managedUsersTotalPages(query.Total, query.PageSize)
	if query.Page > query.TotalPages {
		query.Page = query.TotalPages
	}
	start := (query.Page - 1) * query.PageSize
	if start > query.Total {
		start = query.Total
	}
	end := start + query.PageSize
	if end > query.Total {
		end = query.Total
	}
	pageItems := items[start:end]
	a.attachManagedUserUsage(pageItems)
	return map[string]any{
		"items":       pageItems,
		"total":       query.Total,
		"page":        query.Page,
		"page_size":   query.PageSize,
		"sort_by":     query.SortBy,
		"sort_order":  query.SortOrder,
		"total_pages": query.TotalPages,
	}, nil
}

func (a *App) managedUser(id string) map[string]any {
	item := findManagedUser(a.auth.ListUsers(), id)
	if item == nil {
		return nil
	}
	a.attachManagedUserUsage([]map[string]any{item})
	return item
}

func (a *App) attachManagedUserUsage(items []map[string]any) {
	userIDs := managedUserIDs(items)
	if len(userIDs) == 0 {
		return
	}
	a.attachManagedUserUsageStats(items, userIDs)
}

func managedUserIDs(items []map[string]any) []string {
	userIDs := make([]string, 0, len(items))
	for _, item := range items {
		if userID := util.Clean(item["id"]); userID != "" {
			userIDs = append(userIDs, userID)
		}
	}
	return userIDs
}

func (a *App) attachManagedUserUsageStats(items []map[string]any, userIDs []string) {
	stats := a.logs.UserUsageStatsForUsers(14, userIDs)
	for _, item := range items {
		userID := util.Clean(item["id"])
		usage := stats[userID]
		if usage == nil {
			usage = service.ZeroUserUsageStats(14)
		}
		for key, value := range usage {
			item[key] = value
		}
	}
}

func (a *App) prepareManagedUsersSortValues(items []map[string]any, sortBy string) {
	if len(items) == 0 {
		return
	}
	switch sortBy {
	case "call_count", "quota_used", "failure_count":
		a.attachManagedUserUsageStats(items, managedUserIDs(items))
	}
}

func parseManagedUsersQuery(r *http.Request) (managedUsersQuery, error) {
	values := r.URL.Query()
	page, err := parseManagedUsersPage(values.Get("page"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	pageSize, err := parseManagedUsersPageSize(values.Get("page_size"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortBy, err := parseManagedUsersSortBy(values.Get("sort_by"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortOrder, err := parseManagedUsersSortOrder(values.Get("sort_order"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	return managedUsersQuery{
		Page:      page,
		PageSize:  pageSize,
		Search:    strings.TrimSpace(values.Get("search")),
		Provider:  strings.TrimSpace(values.Get("provider")),
		Status:    strings.TrimSpace(values.Get("status")),
		SortBy:    sortBy,
		SortOrder: sortOrder,
	}, nil
}

func parseManagedUsersPage(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page 参数无效")
	}
	return value, nil
}

func parseManagedUsersPageSize(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 20, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page_size 参数无效")
	}
	return normalizedManagedUsersPageSize(value), nil
}

func normalizedManagedUsersPageSize(value int) int {
	if value <= 0 {
		return 20
	}
	if value > 100 {
		return 100
	}
	return value
}

func managedUsersTotalPages(total, pageSize int) int {
	if pageSize <= 0 {
		pageSize = 20
	}
	if total <= 0 {
		return 1
	}
	return (total + pageSize - 1) / pageSize
}

func parseManagedUsersSortBy(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "created_at", nil
	}
	switch value {
	case "id", "name", "username", "provider", "enabled", "role_id", "role_name", "call_count", "quota_used", "failure_count", "created_at", "last_used_at", "updated_at":
		return value, nil
	default:
		return "", fmt.Errorf("sort_by 参数无效")
	}
}

func parseManagedUsersSortOrder(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "desc", nil
	}
	switch value {
	case "asc", "desc":
		return value, nil
	default:
		return "", fmt.Errorf("sort_order 参数无效")
	}
}

func filterManagedUsers(items []map[string]any, query managedUsersQuery) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	search := strings.ToLower(strings.TrimSpace(query.Search))
	provider := strings.TrimSpace(query.Provider)
	status := strings.TrimSpace(query.Status)
	for _, item := range items {
		if provider != "" && provider != "all" && util.Clean(item["provider"]) != provider {
			continue
		}
		if status == "enabled" && !util.ToBool(item["enabled"]) {
			continue
		}
		if status == "disabled" && util.ToBool(item["enabled"]) {
			continue
		}
		if search != "" && !strings.Contains(managedUserSearchText(item), search) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func sortManagedUsers(items []map[string]any, query managedUsersQuery) {
	desc := query.SortOrder == "desc"
	sort.SliceStable(items, func(i, j int) bool {
		cmp := compareManagedUsers(items[i], items[j], query.SortBy)
		if cmp == 0 {
			cmp = strings.Compare(util.Clean(items[i]["id"]), util.Clean(items[j]["id"]))
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
}

func compareManagedUsers(left, right map[string]any, sortBy string) int {
	switch sortBy {
	case "enabled":
		return compareManagedUserInts(managedUserSortBool(left, sortBy), managedUserSortBool(right, sortBy))
	case "call_count", "quota_used", "failure_count":
		return compareManagedUserInts(managedUserSortInt(left, sortBy), managedUserSortInt(right, sortBy))
	default:
		return strings.Compare(strings.ToLower(managedUserSortString(left, sortBy)), strings.ToLower(managedUserSortString(right, sortBy)))
	}
}

func managedUserSortString(item map[string]any, sortBy string) string {
	switch sortBy {
	case "name":
		return util.Clean(item["name"])
	case "username":
		return util.Clean(item["username"])
	case "provider":
		return util.Clean(item["provider"])
	case "role_id":
		return util.Clean(item["role_id"])
	case "role_name":
		return util.Clean(item["role_name"])
	case "created_at":
		return util.Clean(item["created_at"])
	case "last_used_at":
		return util.Clean(item["last_used_at"])
	case "updated_at":
		return util.Clean(item["updated_at"])
	default:
		return util.Clean(item["id"])
	}
}

func managedUserSortBool(item map[string]any, sortBy string) int {
	if sortBy == "enabled" && util.ToBool(item["enabled"]) {
		return 1
	}
	return 0
}

func managedUserSortInt(item map[string]any, sortBy string) int {
	return util.ToInt(item[sortBy], 0)
}

func compareManagedUserInts(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func managedUserSearchText(item map[string]any) string {
	parts := []string{
		util.Clean(item["id"]),
		util.Clean(item["username"]),
		util.Clean(item["name"]),
		util.Clean(item["role_id"]),
		util.Clean(item["role_name"]),
		util.Clean(item["owner_id"]),
		util.Clean(item["owner_name"]),
		util.Clean(item["provider"]),
		util.Clean(item["linuxdo_level"]),
		util.Clean(item["session_id"]),
		util.Clean(item["session_name"]),
	}
	return strings.ToLower(strings.Join(parts, " "))
}

func findManagedUser(items []map[string]any, id string) map[string]any {
	for _, item := range items {
		if item["id"] == id {
			return item
		}
	}
	return nil
}

func (a *App) writeAuthPersistenceError(w http.ResponseWriter, err error) bool {
	var persistenceErr service.AuthPersistenceError
	if !errors.As(err, &persistenceErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("auth persistence failed", "error", persistenceErr.Err)
	}
	if errors.Is(err, storage.ErrConcurrentRowUpdate) {
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
	if r.URL.Path == "/api/creation-tasks" && r.Method == http.MethodGet {
		tasks, err := a.tasks.ListTasksWithError(identity, util.ParseCommaList(r.URL.Query().Get("ids")))
		if err != nil {
			a.writeCreationTaskStorageError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, tasks)
		return
	}
	if r.URL.Path == "/api/creation-tasks/audio-voices" && r.Method == http.MethodGet {
		model := strings.TrimSpace(r.URL.Query().Get("model"))
		if audioProtocolForModel(model) != "grok" || allowedPersonalModel(model, a.config.AudioModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "Grok TTS 模型不可用")
			return
		}
		apiKey, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, strings.TrimSpace(r.URL.Query().Get("token_group")), strings.TrimSpace(r.URL.Query().Get("token_name")))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		voices, err := a.fetchGrokTTSVoices(r.Context(), apiKey, model)
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
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := a.applyDefaultImageModel(body)
		apiMode := normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), model)
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
		if apiMode == "images" {
			normalizeImagePayloadForModel(body)
		}
		if !validProtocolImageCount(body["n"], model) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage(model))
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateGoogleGeminiInlineRequest(body, nil); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitGenerationWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), util.ToInt(body["n"], 1), nil, imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/video-generations" && r.Method == http.MethodPost {
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := util.Clean(body["model"])
		if model == "" {
			model = firstString(a.config.VideoModels(), defaultVideoModel)
			body["model"] = model
		}
		allowed := false
		for _, candidate := range a.config.VideoModels() {
			if candidate == model {
				allowed = true
				break
			}
		}
		if !allowed {
			util.WriteError(w, http.StatusBadRequest, "视频模型不可用")
			return
		}
		seconds := util.ToInt(body["seconds"], videoDefaultSeconds(model))
		refs := util.AsStringSlice(body["reference_image_urls"])
		frameRefs := videoFrameAliases(body)
		refs = removeVideoFrameAliases(refs, frameRefs)
		referenceVideoURLs := util.AsStringSlice(body["reference_video_urls"])
		referenceAudioURLs := util.AsStringSlice(body["reference_audio_urls"])
		referenceMode := normalizeVideoReferenceMode(util.Clean(body["reference_mode"]))
		if referenceMode == "" {
			if len(referenceVideoURLs) > 0 || len(referenceAudioURLs) > 0 {
				referenceMode = "reference"
			} else {
				referenceMode = "first-frame"
			}
		}
		// Endpoint names that explicitly represent reference-to-video always use
		// the multimodal reference fields, even for a request containing only
		// images. This prevents silently dropping the image when callers omit the
		// UI's mode toggle.
		if strings.Contains(strings.ToLower(model), "reference-to-video") || strings.Contains(strings.ToLower(model), "-r2v") || strings.HasSuffix(strings.ToLower(model), "/r2v") {
			referenceMode = "reference"
		}
		if len(frameRefs) > 0 && len(refs)+len(referenceVideoURLs)+len(referenceAudioURLs) == 0 {
			// Named first/last-frame slots define keyframe mode even when an old
			// persisted task retained the reference-mode toggle.
			referenceMode = "first-frame"
		}
		// A persisted canvas node may retain the multimodal toggle after the
		// model is changed to a first-frame image-to-video endpoint. Preserve the
		// useful image-only request by normalizing it to first-frame mode; mixed
		// video/audio references still fail with the provider-specific validation
		// below instead of being silently discarded.
		capability := protocol.VideoCapability(model)
		if referenceMode == "reference" && !capability.ReferenceMode && len(referenceVideoURLs) == 0 && len(referenceAudioURLs) == 0 && capability.FirstFrameImageLimit > 0 {
			referenceMode = "first-frame"
		}
		body["reference_mode"] = referenceMode
		normalizeVideoControlParameters(body, model)
		if err := validateVideoAdvancedParameters(body, model); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateVideoPrompt(model, util.Clean(body["prompt"])); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		allImageRefs := append(append([]string{}, frameRefs...), refs...)
		if err := validateVideoAudioGeneration(model, util.ToBool(body["generate_audio"]), firstNonEmpty(util.Clean(body["video_mode"]), util.Clean(body["mode"])), len(allImageRefs)); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateVideoRequiredInputs(model, util.Clean(body["prompt"]), allImageRefs, referenceVideoURLs, referenceAudioURLs); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateVideoReferencesWithFrameSlots(
			model,
			referenceMode,
			videoFirstFrameAlias(body),
			videoLastFrameAlias(body),
			refs,
			referenceVideoURLs,
			referenceAudioURLs,
			hasKlingElementReferences(body["element_list"]),
		); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		firstFrameCount := len(frameRefs)
		if firstFrameCount == 0 && referenceMode == "first-frame" {
			firstFrameCount = len(refs)
		}
		multimodalReferenceCount := 0
		if referenceMode == "reference" {
			multimodalReferenceCount = len(refs) + len(referenceVideoURLs) + len(referenceAudioURLs)
		}
		if err := validateVideoParameters(model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), firstFrameCount, multimodalReferenceCount); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitVideo(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), util.ToBool(body["watermark"]), referenceMode, refs, referenceVideoURLs, referenceAudioURLs, videoTaskRequestMetadata(body))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/audio-generations" && r.Method == http.MethodPost {
		body, err := readJSONMap(r)
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
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
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
		body, err := readJSONMap(r)
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
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitChatWithMetadata(r.Context(), identity, util.Clean(body["client_task_id"]), prompt, model, messages, true, chatTaskRequestMetadata(body))
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
		apiMode := normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), model)
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
		if apiMode == "images" {
			normalizeImagePayloadForModel(body)
		}
		if !validProtocolImageCount(body["n"], model) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage(model))
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
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
		task, err := a.tasks.SubmitEditWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), images, util.ToInt(body["n"], 1), nil, imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	http.NotFound(w, r)
}

func videoFrameAliases(body map[string]any) []string {
	frames := make([]string, 0, 2)
	if value := videoFirstFrameAlias(body); value != "" {
		frames = append(frames, value)
	}
	if value := videoLastFrameAlias(body); value != "" {
		frames = append(frames, value)
	}
	return frames
}

func videoFirstFrameAlias(body map[string]any) string {
	for _, key := range []string{"first_frame_url", "first_frame_image"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			return value
		}
	}
	return ""
}

func videoLastFrameAlias(body map[string]any) string {
	for _, key := range []string{"last_frame_url", "last_frame_image", "end_image_url", "tail_image_url"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			return value
		}
	}
	return ""
}

func removeVideoFrameAliases(refs, frames []string) []string {
	frameSet := make(map[string]struct{}, len(frames))
	for _, value := range frames {
		frameSet[strings.TrimSpace(value)] = struct{}{}
	}
	filtered := make([]string, 0, len(refs))
	for _, value := range refs {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, isFrame := frameSet[value]; !isFrame {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func validateVideoReferencesWithFrameSlots(model, mode, firstFrameURL, lastFrameURL string, imageURLs, videoURLs, audioURLs []string, hasElementReferences bool) error {
	mode = normalizeVideoReferenceMode(mode)
	if mode != "first-frame" && mode != "reference" {
		return fmt.Errorf("视频参考模式仅支持 first-frame 或 reference")
	}
	firstFrameURL = strings.TrimSpace(firstFrameURL)
	lastFrameURL = strings.TrimSpace(lastFrameURL)
	hasFrames := firstFrameURL != "" || lastFrameURL != ""
	ordinaryImageURLs := imageURLs
	if !hasFrames && mode == "first-frame" {
		// First-frame mode uses the ordered image array for frame slots when
		// explicit named slots are absent.
		ordinaryImageURLs = nil
	}
	if err := validateVideoReferenceCombination(model, firstFrameURL != "", lastFrameURL != "", ordinaryImageURLs, videoURLs, audioURLs); err != nil {
		return err
	}
	if !hasFrames {
		return validateVideoReferences(model, mode, imageURLs, videoURLs, audioURLs, hasElementReferences)
	}
	frames := make([]string, 0, 2)
	if firstFrameURL != "" {
		frames = append(frames, firstFrameURL)
	}
	if lastFrameURL != "" {
		frames = append(frames, lastFrameURL)
	}
	if err := validateVideoReferences(model, "first-frame", frames, nil, nil); err != nil {
		return err
	}
	hasOrdinaryReferences := len(imageURLs)+len(videoURLs)+len(audioURLs) > 0
	if !hasOrdinaryReferences {
		return nil
	}
	return validateVideoReferences(model, "reference", imageURLs, videoURLs, audioURLs, hasElementReferences)
}

func validateVideoReferenceCombination(model string, hasFirstFrame, hasLastFrame bool, imageURLs, videoURLs, audioURLs []string) error {
	profileName := protocol.VideoModelProfile(model)
	hasFrames := hasFirstFrame || hasLastFrame
	hasOrdinaryReferences := len(imageURLs)+len(videoURLs)+len(audioURLs) > 0
	switch profileName {
	case "veo", "veo-31":
		if len(videoURLs) > 0 {
			return fmt.Errorf("Gemini Veo 不支持普通参考视频，请移除后重试")
		}
		if len(audioURLs) > 0 {
			return fmt.Errorf("Gemini Veo 不支持参考音频，请移除后重试")
		}
		if hasLastFrame && !hasFirstFrame {
			return fmt.Errorf("请先添加首帧图片")
		}
		if hasFrames && len(imageURLs) > 0 {
			return fmt.Errorf("首尾帧模式不能与普通参考图同时使用")
		}
		if profileName != "veo-31" && (hasLastFrame || len(imageURLs) > 0) {
			return fmt.Errorf("当前 Veo 模型不支持尾帧或普通参考图")
		}
		if len(imageURLs) > 3 {
			return fmt.Errorf("Veo 3.1 参考图最多 3 张")
		}
	case "agnes-25":
		if hasFrames && hasOrdinaryReferences {
			return fmt.Errorf("Agnes Video 2.5 的首尾帧不能和普通参考素材同时使用")
		}
	case "minimax-h3":
		if hasFrames && hasOrdinaryReferences {
			return fmt.Errorf("MiniMax H3 首尾帧不能与参考图片、视频或音频同时使用")
		}
		if len(audioURLs) > 0 && len(imageURLs)+len(videoURLs) == 0 {
			return fmt.Errorf("MiniMax H3 参考音频需要同时提供参考图片或参考视频")
		}
	case "cogvideox-3":
		if len(videoURLs)+len(audioURLs) > 0 {
			return fmt.Errorf("CogVideoX-3 不支持参考视频或参考音频")
		}
	}
	return nil
}

func validateVideoReferences(model, mode string, imageURLs, videoURLs, audioURLs []string, elementReferenceValues ...bool) error {
	model = protocol.CanonicalVideoModel(model)
	mode = normalizeVideoReferenceMode(mode)
	capability := protocol.VideoCapability(model)
	if mode != "first-frame" && mode != "reference" {
		return fmt.Errorf("视频参考模式仅支持 first-frame 或 reference")
	}
	for kind, values := range map[string][]string{"图片": imageURLs, "视频": videoURLs, "音频": audioURLs} {
		for _, value := range values {
			if !isPublicReferenceURL(value) {
				return fmt.Errorf("参考%s必须使用公网可访问的 http:// 或 https:// URL", kind)
			}
		}
	}
	profileName := protocol.VideoModelProfile(model)
	hasElementReferences := len(elementReferenceValues) > 0 && elementReferenceValues[0]
	name := strings.ToLower(strings.TrimSpace(model))
	wan27VisualInput := profileName == "wan-27-i2v" || profileName == "wan-27-kie-i2v"
	if !wan27VisualInput && (strings.Contains(name, "image-to-video") || strings.Contains(name, "image_to_video") || name == "kling/v2-1-pro" || name == "kling/v2-1-standard") && len(imageURLs) == 0 {
		return fmt.Errorf("当前图生视频模型必须提供至少一张参考图片")
	}
	if wan27VisualInput && len(imageURLs)+len(videoURLs) == 0 {
		return fmt.Errorf("Wan 2.7 图生视频或视频生视频必须提供参考图片或参考视频")
	}
	if (profileName == "wan-i2v" || profileName == "bytedance-v1-i2v" || profileName == "grok-i2v") && len(imageURLs) == 0 {
		return fmt.Errorf("当前图生视频模型必须提供至少一张参考图片")
	}
	if profileName == "minimax-hailuo" && strings.Contains(strings.ToLower(model), "image-to-video") && len(imageURLs) == 0 {
		return fmt.Errorf("Hailuo 图生视频模型必须提供至少一张参考图片")
	}
	if profileName == "wan-speech" && (len(imageURLs) == 0 || len(audioURLs) == 0) {
		return fmt.Errorf("Wan 语音驱动视频必须同时提供参考图片和参考音频")
	}
	if profileName == "wan-animate" && (len(imageURLs) == 0 || len(videoURLs) == 0) {
		return fmt.Errorf("Wan 动作迁移必须同时提供参考图片和参考视频")
	}
	if profileName == "kling-avatar" && (len(imageURLs) == 0 || len(audioURLs) == 0) {
		return fmt.Errorf("Kling AI Avatar 必须同时提供参考图片和参考音频")
	}
	if profileName == "vidu-q3" && len(imageURLs) == 0 {
		return fmt.Errorf("Vidu Q3 当前模式必须提供至少一张参考图片")
	}
	if profileName == "kling-motion" && (len(imageURLs) == 0 || len(videoURLs) == 0) {
		return fmt.Errorf("Kling Motion Control 必须同时提供参考图片和参考视频")
	}
	if profileName == "kling-omni-image" && len(imageURLs) == 0 {
		return fmt.Errorf("Kling Omni 图生视频必须提供至少一张参考图片")
	}
	if profileName == "kling-omni-reference" && len(imageURLs)+len(videoURLs) == 0 && !hasElementReferences {
		return fmt.Errorf("Kling Omni 参考生视频至少需要参考图片或参考视频")
	}
	if profileName == "kling-omni-transformation" && len(videoURLs) == 0 {
		return fmt.Errorf("Kling Omni Transformation 必须提供一个参考视频")
	}
	if profileName == "infinitalk" && (len(imageURLs) == 0 || len(audioURLs) == 0) {
		return fmt.Errorf("Infinitalk 必须同时提供参考图片和参考音频")
	}
	if profileName == "topaz-video" && len(videoURLs) == 0 {
		return fmt.Errorf("Topaz Video 必须提供一个参考视频")
	}
	if profileName == "happyhorse" {
		switch {
		case strings.Contains(name, "video-edit") && len(videoURLs) == 0:
			return fmt.Errorf("HappyHorse 视频编辑必须提供参考视频")
		case strings.Contains(name, "image-to-video") && len(imageURLs) == 0:
			return fmt.Errorf("HappyHorse 图生视频必须提供参考图片")
		case strings.Contains(name, "reference-to-video") && len(imageURLs) == 0:
			return fmt.Errorf("HappyHorse 参考生视频必须提供参考图片")
		}
	}
	if (profileName == "wan-videoedit" || profileName == "wan-v2v") && len(videoURLs) == 0 {
		return fmt.Errorf("当前 Wan 视频编辑模型必须提供一个公网参考视频 URL")
	}
	if profileName == "wan-27-r2v" && len(imageURLs)+len(videoURLs) == 0 {
		return fmt.Errorf("Wan R2V 至少需要参考图片或参考视频")
	}
	if profileName == "wan-27-i2v" && len(videoURLs) > 0 && len(audioURLs) > 0 {
		return fmt.Errorf("Wan 2.7 参考视频和参考音频不能同时使用")
	}
	if profileName == "skyreels" && len(audioURLs) > 0 && len(imageURLs) == 0 {
		return fmt.Errorf("SkyReels 参考音频必须和至少一张参考图片一起使用")
	}
	if mode == "first-frame" {
		if len(videoURLs) > 0 || len(audioURLs) > 0 {
			return fmt.Errorf("首帧图生视频不能同时传入参考视频或参考音频")
		}
		if len(imageURLs) > capability.FirstFrameImageLimit {
			return fmt.Errorf("当前视频模型最多支持 %d 张帧参考图", capability.FirstFrameImageLimit)
		}
		return nil
	}
	genericWorkbench := !usesReferenceSpecialVideoPanelModel(model)
	if !genericWorkbench && !capability.ReferenceMode {
		return fmt.Errorf("当前模型尚未接入多模态参考生视频")
	}
	if len(imageURLs)+len(videoURLs)+len(audioURLs) == 0 && !hasElementReferences {
		return fmt.Errorf("多模态参考生视频至少需要一个参考图片、视频或音频 URL")
	}
	imageLimit, videoLimit, audioLimit := capability.References.Image, capability.References.Video, capability.References.Audio
	if genericWorkbench {
		// The reference workbench accepts one shared material envelope and leaves
		// provider-specific truncation/removal to the final adapter.
		imageLimit, videoLimit, audioLimit = 9, 3, 3
	}
	if len(imageURLs) > imageLimit || len(videoURLs) > videoLimit || len(audioURLs) > audioLimit {
		return fmt.Errorf("当前模型最多支持 %d 张参考图片、%d 个参考视频和 %d 个参考音频", imageLimit, videoLimit, audioLimit)
	}
	if protocol.VideoModelProfile(model) == "minimax-h3" && len(audioURLs) > 0 && len(imageURLs)+len(videoURLs) == 0 {
		return fmt.Errorf("MiniMax H3 参考音频需要同时提供参考图片或参考视频")
	}
	return nil
}

func validateVideoAudioGeneration(model string, enabled bool, mode string, imageCount int) error {
	name := strings.NewReplacer("_", "-", ".", "-", "/", "-").Replace(strings.ToLower(strings.TrimSpace(protocol.CanonicalVideoModel(model))))
	if !enabled || name != "kling-v2-6" {
		return nil
	}
	if strings.ToLower(strings.TrimSpace(mode)) != "pro" {
		return fmt.Errorf("Kling v2.6 音频生成需要 pro 模式")
	}
	if imageCount > 1 {
		return fmt.Errorf("Kling v2.6 开启音频时最多 1 张参考图")
	}
	return nil
}

// Normalize controls before persistence so direct API callers receive the
// same provider-safe envelope as the web client.
func normalizeVideoControlParameters(body map[string]any, model string) {
	model = protocol.CanonicalVideoModel(model)
	capability := protocol.VideoCapability(model)
	profile := protocol.VideoModelProfile(model)
	if size := normalizeVideoWorkbenchSizeForModel(model, util.Clean(body["size"])); size != "" {
		body["size"] = size
	} else {
		delete(body, "size")
	}
	switch capability.AudioControl {
	case "none":
		delete(body, "generate_audio")
	case "always":
		body["generate_audio"] = true
	}
	if !capability.Watermark || !strings.HasPrefix(profile, "seedance-") {
		delete(body, "watermark")
	}
	if profile == "grok-kie" || profile == "grok-i2v" {
		mode := strings.ToLower(strings.TrimSpace(util.Clean(body["video_mode"])))
		if mode != "fun" && mode != "spicy" {
			mode = "normal"
		}
		body["video_mode"] = mode
	} else if supportsKlingMode(model) {
		mode := strings.ToLower(strings.TrimSpace(util.Clean(body["video_mode"])))
		if mode != "pro" && mode != "4k" {
			mode = "std"
		}
		if profile == "kling-legacy" && mode == "4k" {
			mode = "pro"
		}
		body["video_mode"] = mode
	} else {
		delete(body, "video_mode")
	}
	if !supportsKlingNegativePrompt(model) {
		delete(body, "negative_prompt")
	}
	if !supportsKlingMultiShot(model) {
		for _, key := range []string{"multi_shot", "shot_type", "multi_prompt", "element_list"} {
			delete(body, key)
		}
	}
	if !supportsKlingShotType(model) {
		delete(body, "shot_type")
	}
	if !supportsKlingElements(model) {
		delete(body, "element_list")
	}
	if profile != "kling-motion" {
		delete(body, "character_orientation")
	}
}

func klingOmniVariant(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	const prefix = "kling-3.0-omni/"
	if !strings.HasPrefix(name, prefix) {
		return ""
	}
	variant := strings.TrimPrefix(name, prefix)
	switch variant {
	case "text-to-video", "image-to-video", "reference-to-video", "transformation":
		return variant
	default:
		return ""
	}
}

func supportsKlingNegativePrompt(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling-3-0-turbo" {
		return false
	}
	profile := protocol.VideoModelProfile(name)
	return !strings.Contains(name, "/") && (profile == "kling-3" || profile == "kling-legacy")
}

func supportsKlingMultiShot(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling-3-0-turbo" {
		return false
	}
	if variant := klingOmniVariant(name); variant != "" {
		return variant != "transformation"
	}
	return name == "kling-3.0/video" || (!strings.Contains(name, "/") && protocol.VideoModelProfile(name) == "kling-3")
}

func supportsKlingShotType(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling-3-0-turbo" {
		return false
	}
	if variant := klingOmniVariant(name); variant != "" {
		return variant == "text-to-video" || variant == "image-to-video"
	}
	return !strings.Contains(name, "/") && protocol.VideoModelProfile(name) == "kling-3"
}

func supportsKlingElements(model string) bool {
	return supportsKlingMultiShot(model)
}

func supportsKlingMode(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling-3-0-turbo" {
		return false
	}
	profile := protocol.VideoModelProfile(name)
	return name == "kling-3.0/video" || klingOmniVariant(name) != "" || (!strings.Contains(name, "/") && (profile == "kling-3" || profile == "kling-legacy"))
}

func validateVideoAdvancedParameters(body map[string]any, model string) error {
	profile := protocol.VideoModelProfile(model)
	if value := util.Clean(body["shot_type"]); value != "" && value != "intelligence" && value != "customize" {
		return fmt.Errorf("Kling 分镜类型仅支持 intelligence 或 customize")
	}
	if value := util.Clean(body["character_orientation"]); value != "" && value != "image" && value != "video" {
		return fmt.Errorf("Kling Motion Control 角色朝向仅支持 image 或 video")
	}
	if util.ToBool(body["multi_shot"]) && (!supportsKlingShotType(model) || util.Clean(body["shot_type"]) == "customize") && len(util.AsMapSlice(body["multi_prompt"])) == 0 {
		return fmt.Errorf("Kling 自定义多镜头必须提供 multi_prompt 分镜列表")
	}
	if value, ok := body["multi_prompt"]; ok && value != nil {
		if _, ok := value.([]any); !ok {
			return fmt.Errorf("multi_prompt 必须是 JSON 数组")
		}
	}
	if value, ok := body["element_list"]; ok && value != nil {
		if _, ok := value.([]any); !ok {
			return fmt.Errorf("element_list 必须是 JSON 数组")
		}
		if err := validateKlingElementList(value); err != nil {
			return err
		}
	}
	if profile == "kling-motion" && util.Clean(body["character_orientation"]) == "" {
		body["character_orientation"] = "video"
	}
	return nil
}

func validateKlingElementList(value any) error {
	rawItems, _ := value.([]any)
	if len(rawItems) > 3 {
		return fmt.Errorf("Kling 元素列表最多支持 3 个元素")
	}
	for index, rawItem := range rawItems {
		item, ok := rawItem.(map[string]any)
		if !ok {
			return fmt.Errorf("Kling 元素 %d 必须是 JSON 对象", index+1)
		}
		type elementReference struct {
			kind string
			url  string
		}
		references := make([]elementReference, 0, 4)
		if rawReferences, exists := item["references"]; exists {
			items, ok := rawReferences.([]any)
			if !ok {
				return fmt.Errorf("Kling 元素 %d 的 references 必须是 JSON 数组", index+1)
			}
			for _, rawReference := range items {
				reference, ok := rawReference.(map[string]any)
				if !ok {
					return fmt.Errorf("Kling 元素 %d 的资源必须是 JSON 对象", index+1)
				}
				references = append(references, elementReference{kind: strings.ToLower(strings.TrimSpace(util.Clean(reference["kind"]))), url: strings.TrimSpace(util.Clean(reference["url"]))})
			}
		}
		for _, key := range []string{"element_input_urls", "element_input_audio_urls"} {
			if rawURLs, exists := item[key]; exists {
				items, ok := rawURLs.([]any)
				if !ok {
					return fmt.Errorf("Kling 元素 %d 的 %s 必须是 JSON 数组", index+1, key)
				}
				kind := "image"
				if key == "element_input_audio_urls" {
					kind = "audio"
				}
				for _, rawURL := range items {
					url, ok := rawURL.(string)
					if !ok {
						return fmt.Errorf("Kling 元素 %d 的资源 URL 必须是字符串", index+1)
					}
					references = append(references, elementReference{kind: kind, url: strings.TrimSpace(url)})
				}
			}
		}
		if len(references) == 0 {
			continue
		}
		if strings.TrimSpace(util.Clean(item["name"])) == "" {
			return fmt.Errorf("Kling 元素 %d 需要填写名称", index+1)
		}
		if strings.TrimSpace(util.Clean(item["description"])) == "" {
			return fmt.Errorf("Kling 元素 %d 需要填写描述", index+1)
		}
		if len(references) < 2 || len(references) > 4 {
			return fmt.Errorf("Kling 元素 %d 的资源数量需要 2-4 个", index+1)
		}
		for _, reference := range references {
			if reference.kind != "image" && reference.kind != "video" && reference.kind != "audio" {
				return fmt.Errorf("Kling 元素 %d 的资源类型仅支持 image、video 或 audio", index+1)
			}
			if !isPublicReferenceURL(reference.url) {
				return fmt.Errorf("Kling 元素 %d 的资源必须使用公网可访问的 http:// 或 https:// URL", index+1)
			}
		}
	}
	return nil
}

func hasKlingElementReferences(value any) bool {
	for _, item := range util.AsMapSlice(value) {
		if len(util.AsMapSlice(item["references"])) > 0 || len(util.AsStringSlice(item["element_input_urls"])) > 0 || len(util.AsStringSlice(item["element_input_audio_urls"])) > 0 {
			return true
		}
	}
	return false
}

func normalizeVideoReferenceMode(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func isPublicReferenceURL(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 2083 {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Hostname())), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".home.arpa") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPublicReferenceIP(ip)
	}
	return strings.Contains(host, ".")
}

func isPublicReferenceIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, raw := range []string{
		"100.64.0.0/10",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"240.0.0.0/4",
		"2001:db8::/32",
	} {
		_, block, err := net.ParseCIDR(raw)
		if err == nil && block.Contains(ip) {
			return false
		}
	}
	return true
}

func validateVideoParameters(model, size string, seconds int, resolution string, referenceCountValues ...int) error {
	model = protocol.CanonicalVideoModel(model)
	name := strings.ToLower(strings.TrimSpace(model))
	size = normalizeVideoWorkbenchSizeForModel(model, size)
	resolution = strings.ToLower(strings.TrimSpace(resolution))
	// The reference workbench deliberately exposes 480p and 720p for every
	// generic panel, even when a provider advertises a different native enum.
	// Validate those shared choices against the closest provider value while
	// leaving the original request value available to the adapter for shaping.
	validationResolution := normalizeGenericWorkbenchResolutionForValidation(model, resolution)
	manualResolution := videoAllowsArbitraryResolutionModel(name) && regexp.MustCompile(`^(\d{3,5})(p|k)$`).MatchString(validationResolution)
	referenceCount := 0
	multimodalReferenceCount := 0
	if len(referenceCountValues) > 0 {
		referenceCount = referenceCountValues[0]
	}
	if len(referenceCountValues) > 1 {
		multimodalReferenceCount = referenceCountValues[1]
	}
	hasH3Reference := referenceCount > 0 || multimodalReferenceCount > 0
	if referenceCount > protocol.VideoCapability(model).FirstFrameImageLimit {
		return fmt.Errorf("当前视频模型最多支持 %d 张帧参考图", protocol.VideoCapability(model).FirstFrameImageLimit)
	}
	// The shared protocol is the first line of validation. Provider-specific
	// rules below add semantic constraints such as Hailuo's 10-second limit.
	if profileName := protocol.VideoModelProfile(model); profileName != "vendor-unknown" && profileName != "generic" {
		capability := protocol.VideoCapability(model)
		validationSeconds := seconds
		genericWorkbenchDuration := !usesReferenceSpecialVideoPanelModel(model) && profileName != "cogvideox-3" && videoDurationSupportedProfile(profileName)
		seedanceWorkbenchDuration := strings.HasPrefix(profileName, "seedance-")
		if genericWorkbenchDuration || seedanceWorkbenchDuration ||
			!videoDurationSupportedProfile(profileName) ||
			strings.HasPrefix(name, "wan/2-2-a14b-") ||
			strings.HasPrefix(name, "wan/2-2-animate-") ||
			name == "gemini-omni-flash-preview" ||
			(profileName == "happyhorse" && strings.Contains(name, "video-edit")) {
			validationSeconds = capability.DefaultSeconds
		}
		isAPIMartKlingMotion := strings.Contains(name, "kling-v2-6-motion-control") || strings.Contains(name, "kling-v3-motion-control")
		// KIE's v3 turbo image endpoint has no size/aspect field at all;
		// unlike the text endpoint, a custom pixel size would be silently
		// discarded by the provider adapter and must be rejected here.
		customSize := videoAllowsCustomDimensionsModel(name) && regexp.MustCompile(`^\d+x\d+$`).MatchString(size)
		if size != "" && !customSize && !(profileName == "minimax-h3" && hasH3Reference && size == "adaptive") && !protocol.VideoCapabilitySupports(capability, size, validationSeconds, "") {
			return fmt.Errorf("当前视频模型不支持所选尺寸")
		}
		apimartKlingMotionResolution := isAPIMartKlingMotion && stringIn(resolution, "720p", "1080p")
		customResolution := manualResolution || isGenericWorkbenchResolutionPreset(model, resolution) || apimartKlingMotionResolution
		if !customResolution && !protocol.VideoCapabilitySupports(capability, "", validationSeconds, validationResolution) {
			return fmt.Errorf("当前视频模型不支持所选视频参数")
		}
		switch profileName {
		case "veo-31", "veo":
			if ((validationResolution != "" && validationResolution != "720p") || referenceCount > 0 || multimodalReferenceCount > 0) && seconds != 8 {
				return fmt.Errorf("Veo 使用 1080p、4K 或参考图时固定生成 8 秒视频")
			}
			return nil
		case "bytedance-v1-i2v", "bytedance-v1-t2v", "agnes-25", "agnes", "wan-27-i2v", "wan-27-kie-i2v", "wan-27-r2v", "wan-videoedit", "wan-v2v", "wan-speech", "wan-animate", "wan-i2v", "wan-t2v", "wan-kie-t2v", "vidu-q3", "vidu", "jimeng", "cogvideox-3", "kling-motion", "kling-avatar", "kling-kie-v3", "kling-kie-26", "kling-kie-legacy", "kling-omni-text", "kling-omni-image", "kling-omni-reference", "kling-omni-transformation", "kling-omni", "grok-i2v", "gemini-omni", "pixverse", "skyreels", "happyhorse", "infinitalk", "topaz-video", "flux-3-video":
			return nil
		}
		// These KIE configurations declare a duration type but no duration
		// bounds in the reference project. Their creator controls therefore use
		// the generic manual range instead of a provider-family preset enum.
		if genericWorkbenchDuration && isKIEVideoModelName(name) && profileName != "minimax-h3" && profileName != "grok-kie" {
			return nil
		}
	}
	contains := func(values ...string) bool {
		for _, value := range values {
			if value == size {
				return true
			}
		}
		return false
	}
	validRange := func(min, max int) bool { return seconds >= min && seconds <= max }
	if profile := seedanceVideoProfile(name); profile != "" {
		if !contains("", "adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9") {
			return fmt.Errorf("Seedance 官方画幅仅支持 adaptive、16:9、4:3、1:1、3:4、9:16、21:9")
		}
		// The reference Seedance panel exposes smart duration plus a manual
		// 4-15 second range for every displayed version. Its submission helper
		// serializes smart duration as 1 before this route receives the request.
		resolutionValues := []string{"480p", "720p", "1080p"}
		switch profile {
		case "2.0":
			resolutionValues = []string{"480p", "720p", "1080p"}
		case "2.0-fast", "2.0-mini":
			resolutionValues = []string{"480p", "720p"}
		}
		if seconds != 1 && !validRange(4, 15) {
			return fmt.Errorf("Seedance 创作台视频时长支持智能时长或 4-15 秒")
		}
		if validationResolution != "" && !stringIn(validationResolution, resolutionValues...) {
			return fmt.Errorf("Seedance 官方清晰度不受支持")
		}
		return nil
	}
	if strings.Contains(name, "seedance") && (size != "" || resolution != "") {
		return fmt.Errorf("尚未录入当前 Seedance 型号的官方画幅和清晰度，请留空并使用上游默认值")
	}
	if isKnownGrokVideoModel(name) {
		if !contains("", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3") || !validRange(1, 15) {
			return fmt.Errorf("Grok 官方视频支持 1-15 秒及 1:1、16:9、9:16、4:3、3:4、3:2、2:3 画幅")
		}
		if validationResolution != "" && !manualResolution && !stringIn(validationResolution, "480p", "720p", "1080p") {
			return fmt.Errorf("Grok 官方清晰度仅支持 480p、720p、1080p")
		}
		if !manualResolution && !strings.Contains(name, "1.5") && !strings.Contains(name, "1-5") && validationResolution == "1080p" {
			return fmt.Errorf("Grok 官方 1080p 仅支持 grok-imagine-video-1.5")
		}
		return nil
	}
	if strings.Contains(name, "kling") && (isKling3Model(name) || isKlingLegacyModel(name)) {
		if !contains("", "16:9", "9:16", "1:1") {
			return fmt.Errorf("Kling 官方画幅仅支持 16:9、9:16、1:1")
		}
		if isKling3Model(name) {
			if !validRange(3, 15) {
				return fmt.Errorf("Kling 3.0 官方视频时长支持 3-15 秒")
			}
		} else if seconds != 5 && seconds != 10 {
			return fmt.Errorf("Kling 当前模型官方视频时长支持 5 秒或 10 秒")
		}
		resolutionValues := []string{"720p", "1080p"}
		if isKling3Model(name) {
			resolutionValues = append(resolutionValues, "4k")
		}
		if validationResolution != "" && !stringIn(validationResolution, resolutionValues...) {
			return fmt.Errorf("Kling 官方清晰度不支持当前选择")
		}
		return nil
	}
	if strings.Contains(name, "kling") && (size != "" || resolution != "") {
		return fmt.Errorf("尚未录入当前 Kling 型号的官方画幅和清晰度，请留空并使用上游默认值")
	}
	if strings.Contains(name, "minimax") || strings.Contains(name, "hailuo") || strings.HasPrefix(name, "t2v-") || strings.HasPrefix(name, "i2v-") || strings.HasPrefix(name, "s2v-") {
		if strings.Contains(name, "h3") {
			if !hasH3Reference && !contains("21:9", "16:9", "4:3", "1:1", "3:4", "9:16") {
				return fmt.Errorf("MiniMax H3 文生视频必须选择 21:9、16:9、4:3、1:1、3:4 或 9:16，不能使用自适应画幅")
			}
			if hasH3Reference && !contains("", "adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16") {
				return fmt.Errorf("MiniMax H3 图生视频画幅由首帧参考图决定")
			}
			if !validRange(4, 15) {
				return fmt.Errorf("MiniMax H3 官方视频时长仅支持 4-15 秒")
			}
			if !manualResolution && !stringIn(validationResolution, "768p", "2k") {
				return fmt.Errorf("MiniMax H3 官方清晰度仅支持 768P、2K")
			}
			return nil
		}
		if size != "" {
			return fmt.Errorf("MiniMax v1 官方接口没有画幅参数")
		}
		validDurations := []string{"6", "10"}
		if strings.HasPrefix(name, "hailuo/02-") {
			validDurations = []string{"5", "10"}
		}
		if !stringIn(strconv.Itoa(seconds), validDurations...) {
			return fmt.Errorf("MiniMax 当前模型不支持所选视频时长")
		}
		if resolution != "" {
			if strings.Contains(name, "hailuo") && !manualResolution && !stringIn(validationResolution, "768p", "1080p") {
				return fmt.Errorf("MiniMax Hailuo 官方清晰度仅支持 768P、1080P")
			}
			if !strings.Contains(name, "hailuo") && !manualResolution && validationResolution != "720p" {
				return fmt.Errorf("MiniMax 旧版官方清晰度仅支持 720P")
			}
		}
		if strings.Contains(name, "hailuo") && seconds == 10 && validationResolution == "1080p" {
			return fmt.Errorf("MiniMax Hailuo 官方 10 秒视频仅支持 768P")
		}
		if strings.Contains(name, "hailuo-2.3-fast") && referenceCount == 0 {
			return fmt.Errorf("MiniMax-Hailuo-2.3-Fast 官方仅支持图生视频，请上传一张首帧参考图")
		}
		if strings.HasPrefix(name, "i2v-") && referenceCount == 0 {
			return fmt.Errorf("MiniMax I2V 官方模型仅支持图生视频，请上传一张首帧参考图")
		}
		return nil
	}
	if isSora2Model(name) {
		allowedSizes := []string{"1280x720", "720x1280"}
		if strings.Contains(name, "pro") {
			allowedSizes = append(allowedSizes, "1792x1024", "1024x1792", "1920x1080", "1080x1920")
		}
		if !stringIn(size, allowedSizes...) && !videoAllowsCustomDimensionsModel(name) {
			return fmt.Errorf("Sora 官方视频尺寸不支持当前选择")
		}
		if !stringIn(strconv.Itoa(seconds), "4", "8", "12", "16", "20") {
			return fmt.Errorf("Sora 官方视频时长仅支持 4、8、12、16、20 秒")
		}
		if validationResolution != "" && !regexp.MustCompile(`^(\d{3,5})(p|k)$`).MatchString(validationResolution) {
			return fmt.Errorf("Sora 清晰度必须使用 720p、1080p、2k 等格式")
		}
		if referenceCount > 1 {
			return fmt.Errorf("Sora 官方 input_reference 只支持一张首帧参考图")
		}
		return nil
	}
	if size != "" && size != "auto" && size != "adaptive" && !regexp.MustCompile(`^\d+x\d+$`).MatchString(size) {
		return fmt.Errorf("视频尺寸必须使用 宽x高 格式")
	}
	if !validRange(1, 30) {
		return fmt.Errorf("视频时长支持 1-30 秒")
	}
	if validationResolution != "" && !regexp.MustCompile(`^(\d+p|\d+k)$`).MatchString(validationResolution) {
		return fmt.Errorf("视频清晰度必须使用 720p、1080p、2k 等格式")
	}
	return nil
}

func videoAllowsCustomDimensionsModel(model string) bool {
	return !usesReferenceSpecialVideoPanelModel(model)
}

func usesReferenceSpecialVideoPanelModel(model string) bool {
	value := strings.ToLower(protocol.CanonicalVideoModel(model))
	value = strings.NewReplacer(".", "-", "_", "-", "/", "-").Replace(value)
	if strings.HasPrefix(value, "seedance-") || strings.HasPrefix(value, "doubao-seedance-") {
		return true
	}
	return value == "kling-v2-6" || value == "kling-v3" || value == "kling-3-0-video" || strings.HasPrefix(value, "kling-3-0-omni-")
}

// isGenericWorkbenchResolutionPreset identifies the two shared quality
// buttons rendered by the reference project's generic video panel. They are
// intentionally accepted across generic providers even when a provider uses
// a different native enum (for example 768P instead of 720p).
func isGenericWorkbenchResolutionPreset(model, resolution string) bool {
	return !usesReferenceSpecialVideoPanelModel(model) &&
		stringIn(strings.ToLower(strings.TrimSpace(resolution)), "480p", "720p")
}

// normalizeGenericWorkbenchResolutionForValidation converts a generic panel
// preset to the closest documented provider value for server-side capability
// checks. The original value is still passed to the adapter, which performs
// the final provider-specific serialization (such as 480p -> 512P for
// Hailuo). Empty capability lists are left untouched because those endpoints
// deliberately omit resolution after the adapter runs.
func normalizeGenericWorkbenchResolutionForValidation(model, resolution string) string {
	requested := strings.ToLower(strings.TrimSpace(resolution))
	if requested == "" || !isGenericWorkbenchResolutionPreset(model, requested) {
		return requested
	}
	capability := protocol.VideoCapability(model)
	for _, supported := range capability.Resolutions {
		if strings.EqualFold(supported, requested) {
			return requested
		}
	}
	for _, preferred := range []string{"768p", "720p", "1080p", "2k", "4k"} {
		for _, supported := range capability.Resolutions {
			if strings.EqualFold(supported, preferred) {
				return preferred
			}
		}
	}
	return requested
}

// The generic reference workbench stores pixel dimensions even when a
// provider accepts a ratio enum. Normalize that value before validation and
// persistence so browser and direct API submissions use the same contract.
func normalizeVideoWorkbenchSizeForModel(model, size string) string {
	requested := strings.ToLower(strings.TrimSpace(size))
	if requested == "" || !videoAllowsCustomDimensionsModel(model) || !regexp.MustCompile(`^\d+x\d+$`).MatchString(requested) {
		return requested
	}
	capability := protocol.VideoCapability(model)
	for _, supported := range capability.Sizes {
		if strings.EqualFold(supported, requested) {
			return requested
		}
	}
	ratio := normalizeKIEAspectRatio(requested)
	for _, supported := range capability.Sizes {
		if strings.EqualFold(supported, ratio) {
			return strings.ToLower(supported)
		}
	}
	if len(capability.Sizes) == 0 {
		switch protocol.VideoModelProfile(model) {
		case "generic", "agnes", "sora", "sora-pro":
			return requested
		default:
			return ""
		}
	}
	return requested
}

// The workbench keeps a manual quality input for parity with the reference
// project, but only these profiles can safely carry a non-enumerated value.
// Other providers expose an enum and must be validated against it before the
// request reaches their API.
func videoAllowsArbitraryResolutionModel(model string) bool {
	if !usesReferenceSpecialVideoPanelModel(model) {
		return true
	}
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling/v3-turbo-text-to-video" || name == "kling-3-0-turbo" {
		return true
	}
	switch protocol.VideoModelProfile(model) {
	case "generic", "sora", "sora-pro", "veo", "veo-31", "minimax-h3":
		return true
	default:
		return false
	}
}

func videoDurationSupportedProfile(profile string) bool {
	switch profile {
	case "kling-motion", "kling-avatar", "wan-speech", "wan-animate", "infinitalk", "topaz-video":
		return false
	default:
		return true
	}
}

func validateVideoPrompt(model, prompt string) error {
	if strings.TrimSpace(prompt) == "" {
		return fmt.Errorf("请输入视频提示词")
	}
	characters := utf8.RuneCountInString(prompt)
	if isMiniMaxH3Model(model) && characters > 7000 {
		return fmt.Errorf("MiniMax H3 官方提示词最多支持 7000 个字符")
	}
	if isKling3Model(model) && characters > 3072 {
		return fmt.Errorf("Kling 3.0 官方提示词最多支持 3072 个字符")
	}
	return nil
}

func validateVideoRequiredInputs(model, prompt string, imageURLs, videoURLs, audioURLs []string) error {
	name := strings.ToLower(strings.TrimSpace(model))
	normalized := strings.NewReplacer("_", "-", ".", "-", "/", "-").Replace(name)
	if normalized == "kling-3-0-turbo" || normalized == "happyhorse-1-1" {
		if strings.TrimSpace(prompt) == "" && len(imageURLs) == 0 {
			return fmt.Errorf("当前视频模型至少需要提示词或一张参考图片")
		}
	}
	switch name {
	case "kling-3.0-omni/text-to-video", "kling/v3-turbo-text-to-video", "bytedance/seedance-2-mini", "happyhorse-1-1/text-to-video":
		if strings.TrimSpace(prompt) == "" {
			return fmt.Errorf("当前文生视频模型必须提供提示词")
		}
	}
	return nil
}

func seedanceVideoProfile(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(name, "seedance") {
		return ""
	}
	switch {
	case strings.Contains(name, "2-5") || strings.Contains(name, "2.5"):
		return "2.5"
	case strings.Contains(name, "2-0") || strings.Contains(name, "2.0"):
		if strings.Contains(name, "fast") {
			return "2.0-fast"
		}
		if strings.Contains(name, "mini") {
			return "2.0-mini"
		}
		return "2.0"
	case strings.Contains(name, "1-5") || strings.Contains(name, "1.5"):
		return "1.5"
	case strings.Contains(name, "1-0") || strings.Contains(name, "1.0"):
		return "1.0"
	default:
		if strings.Contains(name, "fast") {
			return "2.0-fast"
		}
		if strings.Contains(name, "mini") {
			return "2.0-mini"
		}
		return "2.0"
	}
}

func isKling3Model(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "kling") && (strings.Contains(name, "v3") || strings.Contains(name, "3-0") || strings.Contains(name, "3.0"))
}

func isKnownGrokVideoModel(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return name == "grok-imagine" || name == "grok-imagine-video" || name == "grok-imagine-video-latest" || strings.Contains(name, "grok-imagine-video-1.5") || strings.Contains(name, "grok-imagine-video-1-5")
}

func isKlingLegacyModel(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(name, "kling") || isKling3Model(name) {
		return false
	}
	return strings.Contains(name, "kling-v1") || strings.Contains(name, "kling-v2") || strings.Contains(name, "kling-1") || strings.Contains(name, "kling-2")
}

func isSora2Model(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "sora-2") || strings.Contains(name, "sora_2")
}

func stringIn(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func videoDefaultSeconds(model string) int {
	if value := protocol.VideoCapability(model).DefaultSeconds; value != 0 {
		return value
	}
	return 4
}

func creationTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := map[string]any{}
	if tokenGroup := selectedRelayTokenGroupFromPayload(body); tokenGroup != "" {
		metadata["token_group"] = tokenGroup
	}
	if tokenName := selectedRelayTokenNameFromPayload(body); tokenName != "" {
		metadata["token_name"] = tokenName
	}
	if videoMode := util.Clean(body["video_mode"]); videoMode != "" {
		metadata["video_mode"] = videoMode
	}
	// Advanced video controls are kept in metadata so the task service can
	// carry them through the shared envelope and let each provider adapter
	// map only the fields its model actually supports.
	for _, key := range []string{"negative_prompt", "multi_shot", "shot_type", "multi_prompt", "element_list", "character_orientation", "video_generate_audio", "preset", "mode"} {
		if value, ok := body[key]; ok {
			metadata[key] = value
		}
	}
	return metadata
}

func chatTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := creationTaskRequestMetadata(body)
	if tools := util.AsMapSlice(body["tools"]); len(tools) > 0 {
		metadata["tools"] = tools
	}
	if choice, ok := body["tool_choice"]; ok && choice != nil {
		metadata["tool_choice"] = choice
	}
	return metadata
}

func videoTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := creationTaskRequestMetadata(body)
	for _, key := range []string{"first_frame_url", "last_frame_url"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			metadata[key] = value
		}
	}
	// Preserve an explicit channel hint for model families whose bare name is
	// shared by KIE and APIMart (for example `minimax-h3`). The normal route
	// does not guess a provider from an ambiguous model string.
	for _, key := range []string{"provider", "video_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		if value := util.Clean(body[key]); value != "" {
			metadata[key] = value
		}
	}
	return metadata
}

func imageTaskRequestMetadata(body map[string]any) map[string]any {
	requestedSize := firstNonEmpty(util.Clean(body["requested_size"]), util.Clean(body["size"]))
	metadata := creationTaskRequestMetadata(body)
	if workflowContext := util.StringMap(body["workflow_context"]); len(workflowContext) > 0 {
		metadata["workflow_context"] = workflowContext
	}
	metadata["api_mode"] = normalizeImageTaskAPIMode(util.Clean(body["api_mode"]), util.Clean(body["model"]))
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

func normalizeImageTaskAPIMode(value, model string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "images"
	}
	if value != "images" && value != "responses" && value != "chat" {
		return ""
	}
	route := util.ImageModelRouteFor(model)
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
