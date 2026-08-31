package httpapi

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
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
			util.WriteError(w, http.StatusServiceUnavailable, "创作偏好存储暂时不可用")
			return
		}
		preferences.DefaultTextModel = allowedPersonalModel(preferences.DefaultTextModel, a.config.TextModels())
		preferences.DefaultImageModel = allowedPersonalModel(preferences.DefaultImageModel, a.config.ImageModels())
		preferences.DefaultVideoModel = allowedPersonalModel(preferences.DefaultVideoModel, a.configuredVideoModels())
		preferences.DefaultAudioModel = allowedPersonalModel(preferences.DefaultAudioModel, a.config.AudioModels())
		preferences.Workbench.ImageModel = allowedPersonalModel(preferences.Workbench.ImageModel, a.config.ImageModels())
		preferences.Workbench.VideoModel = allowedPersonalModel(preferences.Workbench.VideoModel, a.configuredVideoModels())
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
			{field: "default_video_model", model: util.Clean(body["default_video_model"]), allowed: a.configuredVideoModels()},
			{field: "default_audio_model", model: util.Clean(body["default_audio_model"]), allowed: a.config.AudioModels()},
		}
		for _, requested := range requestedModels {
			if strings.TrimSpace(requested.model) != "" && allowedPersonalModel(requested.model, requested.allowed) == "" {
				util.WriteError(w, http.StatusBadRequest, requested.field+" is not enabled by the administrator")
				return
			}
		}
		current, err := a.imagePreferences.Preferences(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusServiceUnavailable, "创作偏好存储暂时不可用")
			return
		}
		workbench := current.Workbench
		if rawWorkbench, present := body["workbench"]; present {
			workbench, err = creationWorkbenchPreferencesFromValue(rawWorkbench)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err = a.validateCreationWorkbenchModels(workbench); err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
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
			DefaultTextRelayTokens:  relayTokenPreferenceValues(body, "default_text_relay_token_names", current.DefaultTextRelayTokens),
			DefaultImageRelayTokens: relayTokenPreferenceValues(body, "default_image_relay_token_names", current.DefaultImageRelayTokens),
			DefaultVideoRelayTokens: relayTokenPreferenceValues(body, "default_video_relay_token_names", current.DefaultVideoRelayTokens),
			DefaultAudioRelayTokens: relayTokenPreferenceValues(body, "default_audio_relay_token_names", current.DefaultAudioRelayTokens),
			Workbench:               workbench,
		})
		if err != nil {
			writeImageGenerationPreferenceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	case http.MethodPatch:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		updates := map[string][]string{}
		for _, kind := range []string{"text", "image", "video", "audio"} {
			field := "default_" + kind + "_relay_token_names"
			if value, present := body[field]; present {
				updates[kind] = util.AsStringSlice(value)
			}
		}
		_, hasWorkbench := body["workbench"]
		_, hasStream := body["stream"]
		_, hasPartialImages := body["partial_images"]
		_, hasResponseFormat := body["response_format_b64_json"]
		_, hasCodexCompatibility := body["codex_cli_compatibility"]
		hasCreationOptions := hasWorkbench || hasStream || hasPartialImages || hasResponseFormat || hasCodexCompatibility
		if len(updates) == 0 && !hasCreationOptions {
			util.WriteError(w, http.StatusBadRequest, "at least one preference is required")
			return
		}
		patch := service.ImageGenerationPreferencePatch{RelayTokenNames: updates}
		if rawWorkbench, present := body["workbench"]; present {
			workbench, parseErr := creationWorkbenchPreferencesFromValue(rawWorkbench)
			if parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, parseErr.Error())
				return
			}
			if parseErr = a.validateCreationWorkbenchModels(workbench); parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, parseErr.Error())
				return
			}
			patch.Workbench = &workbench
		}
		if hasStream {
			stream := util.ToBool(body["stream"])
			patch.Stream = &stream
		}
		if hasPartialImages {
			partialImages, valid := imagePreferencePartialImages(body["partial_images"])
			if !valid {
				util.WriteError(w, http.StatusBadRequest, "partial_images must be an integer between 0 and 3")
				return
			}
			patch.PartialImages = &partialImages
		}
		if hasResponseFormat {
			responseFormat := util.ToBool(body["response_format_b64_json"])
			patch.ResponseFormatB64JSON = &responseFormat
		}
		if hasCodexCompatibility {
			codexCompatibility := util.ToBool(body["codex_cli_compatibility"])
			patch.CodexCLICompatibility = &codexCompatibility
		}
		preferences, err := a.imagePreferences.Patch(ownerID, patch)
		if err != nil {
			writeImageGenerationPreferenceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func writeImageGenerationPreferenceError(w http.ResponseWriter, err error) {
	var storageErr *service.ImageGenerationPreferenceStorageError
	if errors.As(err, &storageErr) {
		if errors.Is(err, storage.ErrConcurrentRowUpdate) {
			util.WriteError(w, http.StatusConflict, "创作偏好已被其他请求修改，请重试")
			return
		}
		util.WriteError(w, http.StatusServiceUnavailable, "创作偏好存储暂时不可用")
		return
	}
	util.WriteError(w, http.StatusBadRequest, err.Error())
}

func relayTokenPreferenceValues(body map[string]any, field string, fallback []string) []string {
	if value, present := body[field]; present {
		return util.AsStringSlice(value)
	}
	return append([]string(nil), fallback...)
}

func creationWorkbenchPreferencesFromValue(value any) (service.CreationWorkbenchPreferences, error) {
	workbench := util.StringMap(value)
	if len(workbench) == 0 {
		return service.CreationWorkbenchPreferences{}, fmt.Errorf("workbench must be an object")
	}
	count, ok := util.StrictInt(workbench["image_count"])
	if !ok {
		return service.CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_count must be an integer")
	}
	return service.CreationWorkbenchPreferences{
		ImageModel:             util.Clean(workbench["image_model"]),
		ImageSize:              util.Clean(workbench["image_size"]),
		ImageSizeMode:          util.Clean(workbench["image_size_mode"]),
		ImageAspectRatio:       util.Clean(workbench["image_aspect_ratio"]),
		ImageResolution:        util.Clean(workbench["image_resolution"]),
		ImageCustomRatio:       util.Clean(workbench["image_custom_ratio"]),
		ImageCustomWidth:       util.Clean(workbench["image_custom_width"]),
		ImageCustomHeight:      util.Clean(workbench["image_custom_height"]),
		ImageSnapToMultiple16:  util.ToBool(workbench["image_snap_to_multiple_16"]),
		ImageQuality:           util.Clean(workbench["image_quality"]),
		ImageCount:             count,
		ImageOutputFormat:      util.Clean(workbench["image_output_format"]),
		ImageOutputCompression: util.Clean(workbench["image_output_compression"]),
		VideoModel:             util.Clean(workbench["video_model"]),
		VideoSize:              util.Clean(workbench["video_size"]),
		VideoSeconds:           util.Clean(workbench["video_seconds"]),
		VideoResolution:        util.Clean(workbench["video_resolution"]),
		VideoGenerateAudio:     util.ToBool(workbench["video_generate_audio"]),
		VideoWatermark:         util.ToBool(workbench["video_watermark"]),
	}, nil
}

func (a *App) validateCreationWorkbenchModels(workbench service.CreationWorkbenchPreferences) error {
	if workbench.ImageModel != "" && allowedPersonalModel(workbench.ImageModel, a.config.ImageModels()) == "" {
		return fmt.Errorf("workbench.image_model is not enabled by the administrator")
	}
	if workbench.VideoModel != "" && allowedPersonalModel(workbench.VideoModel, a.configuredVideoModels()) == "" {
		return fmt.Errorf("workbench.video_model is not enabled by the administrator")
	}
	return nil
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
		selectedName := strings.TrimSpace(r.URL.Query().Get("token_name"))
		if configID := service.CustomRelayConfigIDFromTokenName(selectedName); configID != "" {
			if a.customRelayConfigs == nil {
				util.WriteError(w, http.StatusServiceUnavailable, "自定义 API 配置存储不可用")
				return
			}
			config, err := a.customRelayConfigs.Config(identityScope(identity), configID)
			if err != nil {
				writeCustomRelayConfigError(w, err)
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
		util.WriteError(w, http.StatusInternalServerError, "failed to delete prompt favorite")
		return
	}
	if !deleted {
		util.WriteError(w, http.StatusNotFound, "prompt favorite not found")
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
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
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
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
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
			query, err := parseManagedUsersQuery(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
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
			response := a.managedUsersResponseForQuery(query)
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
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
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
		query, err := parseManagedUsersQuery(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
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
		response := a.managedUsersResponseForQuery(query)
		item := a.managedUser(userID)
		response["item"] = item
		util.WriteJSON(w, http.StatusOK, response)
	case http.MethodDelete:
		query, err := parseManagedUsersQuery(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
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
		response := a.managedUsersResponseForQuery(query)
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
	return a.managedUsersResponseForQuery(query), nil
}

func (a *App) managedUsersResponseForQuery(query managedUsersQuery) map[string]any {
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
	}
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
		voices, err := a.fetchGrokTTSVoicesAt(r.Context(), credential.BaseURL, credential.APIKey, model)
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
		task, err := a.tasks.SubmitGenerationWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), util.ToInt(body["n"], 1), imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
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
		refs := util.AsStringSlice(body["reference_image_urls"])
		frameRefs := videoFrameAliases(body)
		refs = removeVideoFrameAliases(refs, frameRefs)
		referenceVideoURLs := util.AsStringSlice(body["reference_video_urls"])
		referenceAudioURLs := util.AsStringSlice(body["reference_audio_urls"])
		generationKind, valid := videoContractGenerationKind(body, contract)
		if !valid {
			util.WriteError(w, http.StatusBadRequest, "generation_mode 不属于当前视频模型契约")
			return
		}
		generationMode, supported := protocol.VideoContractModeForKind(contract, generationKind)
		if !supported {
			util.WriteError(w, http.StatusBadRequest, "当前模型不支持所选生成模式")
			return
		}
		body["generation_mode"] = firstNonEmpty(generationMode.RequestValue, generationMode.ID)
		referenceMode := "first-frame"
		if generationKind == "reference" {
			referenceMode = "reference"
		}
		body["reference_mode"] = referenceMode
		counts := videoContractMaterialCounts(generationKind, body, refs, referenceVideoURLs, referenceAudioURLs)
		if err := protocol.ValidateVideoContractModeMaterials(contract, generationKind, counts); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		ruleValues := videoContractRuleValues(body)
		protocol.ApplyVideoContractForcedValues(contract, ruleValues)
		if err := protocol.ValidateVideoContractRuleValues(contract, ruleValues); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		for field, bodyField := range map[string]string{
			"duration": "seconds", "size": "size", "resolution": "resolution",
			"generate_audio": "generate_audio", "watermark": "watermark",
		} {
			if value, exists := ruleValues[field]; exists {
				body[bodyField] = value
			}
		}
		seconds := util.ToInt(body["seconds"], contract.Capability.DefaultSeconds)
		if strings.TrimSpace(util.Clean(body["prompt"])) == "" {
			util.WriteError(w, http.StatusBadRequest, "请输入视频提示词")
			return
		}
		if utf8.RuneCountInString(util.Clean(body["prompt"])) > contract.Validation.MaxPromptCharacters {
			util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("当前视频模型提示词最多支持 %d 个字符", contract.Validation.MaxPromptCharacters))
			return
		}
		switch contract.Capability.AudioControl {
		case "none":
			body["generate_audio"] = false
		case "always":
			body["generate_audio"] = true
		}
		if !contract.Capability.Watermark {
			body["watermark"] = false
		}
		if !protocol.VideoContractSupports(contract, util.Clean(body["size"]), seconds, util.Clean(body["resolution"])) {
			util.WriteError(w, http.StatusBadRequest, "当前视频模型不支持所选视频参数")
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitVideo(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), util.ToBool(body["watermark"]), referenceMode, refs, referenceVideoURLs, referenceAudioURLs, videoTaskRequestMetadata(body, contract))
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
		task, err := a.tasks.SubmitEditWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), taskQuality, a.relayBaseURL(), images, util.ToInt(body["n"], 1), imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
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

func videoContractMaterialCounts(kind string, body map[string]any, imageURLs, videoURLs, audioURLs []string) protocol.VideoModelMaterialCounts {
	counts := protocol.VideoModelMaterialCounts{
		Video: len(videoURLs),
		Audio: len(audioURLs),
	}
	firstFrame := videoFirstFrameAlias(body)
	lastFrame := videoLastFrameAlias(body)
	switch kind {
	case "image":
		if firstFrame != "" {
			counts.FirstFrame = 1
		} else if len(imageURLs) > 0 {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		} else if firstFrame == "" && len(imageURLs) > 1 {
			counts.LastFrame = 1
		}
		if firstFrame != "" {
			counts.Image = len(imageURLs)
		}
	case "reference":
		if firstFrame != "" {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		}
		counts.Image = len(imageURLs)
	default:
		if firstFrame != "" {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		}
		counts.Image = len(imageURLs)
	}
	return counts
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

func creationTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := map[string]any{}
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
	if tools := util.AsMapSlice(body["tools"]); len(tools) > 0 {
		metadata["tools"] = tools
	}
	if choice, ok := body["tool_choice"]; ok && choice != nil {
		metadata["tool_choice"] = choice
	}
	return metadata
}

func videoTaskRequestMetadata(body map[string]any, contract protocol.VideoModelContract) map[string]any {
	metadata := map[string]any{
		protocol.VideoContractSnapshotPayloadKey:  contract,
		service.VideoTaskTimeoutSecondsPayloadKey: contract.Polling.TimeoutSeconds + contract.Polling.IntervalSeconds,
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
