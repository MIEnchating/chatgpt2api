package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleImageGenerationPreferences(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		var onboardingWarnings []string
		if identity.Provider == service.AuthProviderNewAPI || identity.Provider == service.AuthProviderSub2API {
			reader, release := a.acquireRelayTokenReader()
			onboardingWarnings = a.initializeRelayGroups(r.Context(), reader, identity, nil, "")
			release()
		}
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
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences, "relay_onboarding_warnings": onboardingWarnings})
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
		var workbench *service.CreationWorkbenchPreferences
		if rawWorkbench, present := body["workbench"]; present {
			parsedWorkbench, parseErr := creationWorkbenchPreferencesFromValue(rawWorkbench)
			if parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, parseErr.Error())
				return
			}
			if err = a.validateCreationWorkbenchModels(parsedWorkbench); err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			workbench = &parsedWorkbench
		}
		relayTokenNames := map[string][]string{}
		for _, kind := range []string{"text", "image", "video", "audio"} {
			field := "default_" + kind + "_relay_token_names"
			if value, present := body[field]; present {
				relayTokenNames[kind] = util.AsStringSlice(value)
			}
		}
		var workbenchGenerateAudio *bool
		if value, present := body["workbench_generate_audio"]; present {
			enabled, ok := value.(bool)
			if !ok {
				util.WriteError(w, http.StatusBadRequest, "workbench_generate_audio must be a boolean")
				return
			}
			workbenchGenerateAudio = &enabled
		}
		preferences, err := a.imagePreferences.UpdateProfile(ownerID, service.ImageGenerationPreferences{
			WorkbenchGenerateAudio:  workbenchGenerateAudio,
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
			NodeRegenerateBehavior:  util.Clean(body["node_regenerate_behavior"]),
			DefaultAudioVoice:       strings.TrimSpace(util.Clean(body["default_audio_voice"])),
			DefaultAudioFormat:      defaultAudioFormat,
			DefaultAudioSpeed:       defaultAudioSpeed,
		}, workbench, relayTokenNames)
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
		if service.IsConcurrentRowUpdate(err) {
			util.WriteError(w, http.StatusConflict, "创作偏好已被其他请求修改，请重试")
			return
		}
		util.WriteError(w, http.StatusServiceUnavailable, "创作偏好存储暂时不可用")
		return
	}
	util.WriteError(w, http.StatusBadRequest, err.Error())
}

func creationWorkbenchPreferencesFromValue(value any) (service.CreationWorkbenchPreferences, error) {
	workbench := util.StringMap(value)
	if len(workbench) == 0 {
		return service.CreationWorkbenchPreferences{}, fmt.Errorf("workbench must be an object")
	}
	if _, ok := util.StrictInt(workbench["image_count"]); !ok {
		return service.CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_count must be an integer")
	}
	if value, present := workbench["video_task_count"]; present {
		if count, ok := util.StrictInt(value); !ok || count < 1 || count > 6 {
			return service.CreationWorkbenchPreferences{}, fmt.Errorf("workbench.video_task_count must be an integer between 1 and 6")
		}
	}
	data, err := json.Marshal(workbench)
	if err != nil {
		return service.CreationWorkbenchPreferences{}, err
	}
	var result service.CreationWorkbenchPreferences
	if err := json.Unmarshal(data, &result); err != nil {
		return result, fmt.Errorf("invalid workbench parameters: %w", err)
	}
	return result, nil
}

func (a *App) validateCreationWorkbenchModels(workbench service.CreationWorkbenchPreferences) error {
	if workbench.ComposerMode != "video" && workbench.ImageModel != "" && allowedPersonalModel(workbench.ImageModel, a.config.ImageModels()) == "" {
		return fmt.Errorf("workbench.image_model is not enabled by the administrator")
	}
	if workbench.ComposerMode == "video" && workbench.VideoModel != "" && allowedPersonalModel(workbench.VideoModel, a.configuredVideoModels()) == "" {
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
