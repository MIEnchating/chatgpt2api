package service

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	imageGenerationPreferenceDocumentDir  = "image_generation_preferences"
	imageGenerationPreferenceSaveAttempts = 4
)

type ImageGenerationPreferenceStorageError struct {
	Err error
}

func (e *ImageGenerationPreferenceStorageError) Error() string {
	return "image generation preference storage: " + e.Err.Error()
}

func (e *ImageGenerationPreferenceStorageError) Unwrap() error {
	return e.Err
}

type ImageGenerationPreferences struct {
	APIMode                 string                       `json:"api_mode"`
	Stream                  bool                         `json:"stream"`
	PartialImages           int                          `json:"partial_images"`
	ResponseFormatB64JSON   bool                         `json:"response_format_b64_json"`
	CodexCLICompatibility   bool                         `json:"codex_cli_compatibility"`
	SystemPrompt            string                       `json:"system_prompt"`
	VideoSystemPrompt       string                       `json:"video_system_prompt"`
	AudioInstructions       string                       `json:"audio_instructions"`
	DefaultTextModel        string                       `json:"default_text_model"`
	DefaultImageModel       string                       `json:"default_image_model"`
	DefaultVideoModel       string                       `json:"default_video_model"`
	DefaultAudioModel       string                       `json:"default_audio_model"`
	CanvasDefaultImageCount int                          `json:"canvas_default_image_count"`
	DefaultAudioVoice       string                       `json:"default_audio_voice"`
	DefaultAudioFormat      string                       `json:"default_audio_format"`
	DefaultAudioSpeed       float64                      `json:"default_audio_speed"`
	DefaultTextRelayTokens  []string                     `json:"default_text_relay_token_names"`
	DefaultImageRelayTokens []string                     `json:"default_image_relay_token_names"`
	DefaultVideoRelayTokens []string                     `json:"default_video_relay_token_names"`
	DefaultAudioRelayTokens []string                     `json:"default_audio_relay_token_names"`
	Workbench               CreationWorkbenchPreferences `json:"workbench"`
}

type CreationWorkbenchPreferences struct {
	ImageModel             string `json:"image_model"`
	ImageSize              string `json:"image_size"`
	ImageSizeMode          string `json:"image_size_mode"`
	ImageAspectRatio       string `json:"image_aspect_ratio"`
	ImageResolution        string `json:"image_resolution"`
	ImageCustomRatio       string `json:"image_custom_ratio"`
	ImageCustomWidth       string `json:"image_custom_width"`
	ImageCustomHeight      string `json:"image_custom_height"`
	ImageSnapToMultiple16  bool   `json:"image_snap_to_multiple_16"`
	ImageQuality           string `json:"image_quality"`
	ImageCount             int    `json:"image_count"`
	ImageOutputFormat      string `json:"image_output_format"`
	ImageOutputCompression string `json:"image_output_compression"`
	VideoModel             string `json:"video_model"`
	VideoSize              string `json:"video_size"`
	VideoSeconds           string `json:"video_seconds"`
	VideoResolution        string `json:"video_resolution"`
	VideoGenerateAudio     bool   `json:"video_generate_audio"`
	VideoWatermark         bool   `json:"video_watermark"`
}

type ImageGenerationPreferenceService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

type ImageGenerationPreferencePatch struct {
	Stream                *bool
	PartialImages         *int
	ResponseFormatB64JSON *bool
	CodexCLICompatibility *bool
	Workbench             *CreationWorkbenchPreferences
	RelayTokenNames       map[string][]string
}

func NewImageGenerationPreferenceService(backend storage.Backend) *ImageGenerationPreferenceService {
	return &ImageGenerationPreferenceService{store: jsonDocumentStoreFromBackend(backend)}
}

func defaultImageGenerationPreferences() ImageGenerationPreferences {
	return ImageGenerationPreferences{APIMode: "images", PartialImages: 1, CanvasDefaultImageCount: 1, DefaultAudioSpeed: 1, Workbench: defaultCreationWorkbenchPreferences()}
}

func defaultCreationWorkbenchPreferences() CreationWorkbenchPreferences {
	return CreationWorkbenchPreferences{
		ImageSize:             "1024x1024",
		ImageSizeMode:         "ratio",
		ImageAspectRatio:      "1:1",
		ImageResolution:       "auto",
		ImageCustomRatio:      "16:9",
		ImageCustomWidth:      "1024",
		ImageCustomHeight:     "1024",
		ImageSnapToMultiple16: true,
		ImageCount:            1,
		ImageOutputFormat:     "png",
		VideoSize:             "1280x720",
		VideoSeconds:          "6",
		VideoResolution:       "720p",
	}
}

func (s *ImageGenerationPreferenceService) Preferences(ownerID string) (ImageGenerationPreferences, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return ImageGenerationPreferences{}, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	preferences, err := s.loadLocked(ownerID)
	if err != nil {
		return preferences, imageGenerationPreferenceStorageError(err)
	}
	return preferences, nil
}

// UpdateProfile replaces the profile fields while preserving optional fields that
// were omitted by the caller. The merge is repeated after a document CAS conflict
// so a concurrent workbench or relay-token update is not overwritten by stale data.
func (s *ImageGenerationPreferenceService) UpdateProfile(ownerID string, input ImageGenerationPreferences, workbench *CreationWorkbenchPreferences, relayTokenNames map[string][]string) (ImageGenerationPreferences, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return ImageGenerationPreferences{}, fmt.Errorf("owner_id is required")
	}
	normalizedTokens, err := normalizeRelayTokenUpdates(relayTokenNames)
	if err != nil {
		return ImageGenerationPreferences{}, err
	}
	if workbench == nil {
		input.Workbench = defaultCreationWorkbenchPreferences()
	} else {
		input.Workbench = *workbench
	}
	applyRelayTokenUpdates(&input, normalizedTokens)
	normalized, err := normalizeImageGenerationPreferences(input)
	if err != nil {
		return ImageGenerationPreferences{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store == nil {
		return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(fmt.Errorf("storage document backend is required"))
	}
	for attempt := 0; attempt < imageGenerationPreferenceSaveAttempts; attempt++ {
		current, loadErr := s.loadLocked(ownerID)
		if loadErr != nil {
			return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(loadErr)
		}
		candidate := normalized
		if workbench == nil {
			candidate.Workbench = current.Workbench
		}
		preserveUnspecifiedRelayTokens(&candidate, current, normalizedTokens)
		if saveErr := s.store.SaveJSONDocument(imageGenerationPreferenceDocumentName(ownerID), candidate); saveErr != nil {
			if errors.Is(saveErr, storage.ErrConcurrentRowUpdate) && attempt+1 < imageGenerationPreferenceSaveAttempts {
				continue
			}
			return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(saveErr)
		}
		return candidate, nil
	}
	return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(fmt.Errorf("%w: update image generation profile after %d attempts", storage.ErrConcurrentRowUpdate, imageGenerationPreferenceSaveAttempts))
}

func normalizeImageGenerationPreferences(input ImageGenerationPreferences) (ImageGenerationPreferences, error) {
	if input.PartialImages < 0 || input.PartialImages > 3 {
		return ImageGenerationPreferences{}, fmt.Errorf("partial_images must be an integer between 0 and 3")
	}
	if input.CanvasDefaultImageCount < 1 || input.CanvasDefaultImageCount > 15 {
		return ImageGenerationPreferences{}, fmt.Errorf("canvas_default_image_count must be an integer between 1 and 15")
	}
	if !validPreferenceAudioFormat(input.DefaultAudioFormat) {
		return ImageGenerationPreferences{}, fmt.Errorf("default_audio_format is not supported")
	}
	if math.IsNaN(input.DefaultAudioSpeed) || math.IsInf(input.DefaultAudioSpeed, 0) || input.DefaultAudioSpeed < 0.25 || input.DefaultAudioSpeed > 4 {
		return ImageGenerationPreferences{}, fmt.Errorf("default_audio_speed must be between 0.25 and 4")
	}
	input.APIMode = strings.ToLower(strings.TrimSpace(input.APIMode))
	if input.APIMode == "" {
		input.APIMode = "images"
	}
	if input.APIMode != "images" && input.APIMode != "responses" && input.APIMode != "chat" {
		return ImageGenerationPreferences{}, fmt.Errorf("api_mode must be images, responses, or chat")
	}
	input.SystemPrompt = normalizePreferenceText(input.SystemPrompt)
	input.VideoSystemPrompt = normalizePreferenceText(input.VideoSystemPrompt)
	input.AudioInstructions = normalizePreferenceText(input.AudioInstructions)
	input.DefaultTextModel = strings.TrimSpace(input.DefaultTextModel)
	input.DefaultImageModel = strings.TrimSpace(input.DefaultImageModel)
	input.DefaultVideoModel = strings.TrimSpace(input.DefaultVideoModel)
	input.DefaultAudioModel = strings.TrimSpace(input.DefaultAudioModel)
	input.DefaultAudioVoice = strings.TrimSpace(input.DefaultAudioVoice)
	input.DefaultAudioFormat = strings.ToLower(strings.TrimSpace(input.DefaultAudioFormat))
	input.DefaultAudioSpeed = math.Round(input.DefaultAudioSpeed*100) / 100
	input.DefaultTextRelayTokens = normalizeRelayTokenNames(input.DefaultTextRelayTokens)
	input.DefaultImageRelayTokens = normalizeRelayTokenNames(input.DefaultImageRelayTokens)
	input.DefaultVideoRelayTokens = normalizeRelayTokenNames(input.DefaultVideoRelayTokens)
	input.DefaultAudioRelayTokens = normalizeRelayTokenNames(input.DefaultAudioRelayTokens)
	workbench, err := normalizeCreationWorkbenchPreferences(input.Workbench)
	if err != nil {
		return ImageGenerationPreferences{}, err
	}
	input.Workbench = workbench
	return input, nil
}

func (s *ImageGenerationPreferenceService) Patch(ownerID string, patch ImageGenerationPreferencePatch) (ImageGenerationPreferences, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return ImageGenerationPreferences{}, fmt.Errorf("owner_id is required")
	}
	if patch.Stream == nil && patch.PartialImages == nil && patch.ResponseFormatB64JSON == nil && patch.CodexCLICompatibility == nil && patch.Workbench == nil && len(patch.RelayTokenNames) == 0 {
		return ImageGenerationPreferences{}, fmt.Errorf("at least one preference is required")
	}
	if patch.PartialImages != nil && (*patch.PartialImages < 0 || *patch.PartialImages > 3) {
		return ImageGenerationPreferences{}, fmt.Errorf("partial_images must be an integer between 0 and 3")
	}
	var workbench *CreationWorkbenchPreferences
	if patch.Workbench != nil {
		normalized, err := normalizeCreationWorkbenchPreferences(*patch.Workbench)
		if err != nil {
			return ImageGenerationPreferences{}, err
		}
		workbench = &normalized
	}
	normalizedTokens, err := normalizeRelayTokenUpdates(patch.RelayTokenNames)
	if err != nil {
		return ImageGenerationPreferences{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < imageGenerationPreferenceSaveAttempts; attempt++ {
		preferences, err := s.loadLocked(ownerID)
		if err != nil {
			return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(err)
		}
		applyRelayTokenUpdates(&preferences, normalizedTokens)
		if patch.Stream != nil {
			preferences.Stream = *patch.Stream
		}
		if patch.PartialImages != nil {
			preferences.PartialImages = *patch.PartialImages
		}
		if patch.ResponseFormatB64JSON != nil {
			preferences.ResponseFormatB64JSON = *patch.ResponseFormatB64JSON
		}
		if patch.CodexCLICompatibility != nil {
			preferences.CodexCLICompatibility = *patch.CodexCLICompatibility
		}
		if workbench != nil {
			preferences.Workbench = *workbench
		}
		if err := s.store.SaveJSONDocument(imageGenerationPreferenceDocumentName(ownerID), preferences); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < imageGenerationPreferenceSaveAttempts {
				continue
			}
			return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(err)
		}
		return preferences, nil
	}
	return ImageGenerationPreferences{}, imageGenerationPreferenceStorageError(fmt.Errorf("%w: patch image generation preferences after %d attempts", storage.ErrConcurrentRowUpdate, imageGenerationPreferenceSaveAttempts))
}

func normalizeRelayTokenUpdates(values map[string][]string) (map[string][]string, error) {
	normalized := make(map[string][]string, len(values))
	for kind, value := range values {
		switch kind {
		case "text", "image", "video", "audio":
			normalized[kind] = normalizeRelayTokenNames(value)
		default:
			return nil, fmt.Errorf("unsupported relay token preference %q", kind)
		}
	}
	return normalized, nil
}

func applyRelayTokenUpdates(preferences *ImageGenerationPreferences, values map[string][]string) {
	for kind, value := range values {
		switch kind {
		case "text":
			preferences.DefaultTextRelayTokens = value
		case "image":
			preferences.DefaultImageRelayTokens = value
		case "video":
			preferences.DefaultVideoRelayTokens = value
		case "audio":
			preferences.DefaultAudioRelayTokens = value
		}
	}
}

func preserveUnspecifiedRelayTokens(candidate *ImageGenerationPreferences, current ImageGenerationPreferences, specified map[string][]string) {
	if _, ok := specified["text"]; !ok {
		candidate.DefaultTextRelayTokens = current.DefaultTextRelayTokens
	}
	if _, ok := specified["image"]; !ok {
		candidate.DefaultImageRelayTokens = current.DefaultImageRelayTokens
	}
	if _, ok := specified["video"]; !ok {
		candidate.DefaultVideoRelayTokens = current.DefaultVideoRelayTokens
	}
	if _, ok := specified["audio"]; !ok {
		candidate.DefaultAudioRelayTokens = current.DefaultAudioRelayTokens
	}
}

func (s *ImageGenerationPreferenceService) loadLocked(ownerID string) (ImageGenerationPreferences, error) {
	preferences := defaultImageGenerationPreferences()
	if s.store == nil {
		return preferences, fmt.Errorf("storage document backend is required")
	}
	raw, err := s.store.LoadJSONDocument(imageGenerationPreferenceDocumentName(ownerID))
	if err != nil {
		return preferences, err
	}
	value := util.StringMap(raw)
	if apiMode := strings.ToLower(strings.TrimSpace(util.Clean(value["api_mode"]))); apiMode == "images" || apiMode == "responses" || apiMode == "chat" {
		preferences.APIMode = apiMode
	}
	preferences.Stream = util.ToBool(value["stream"])
	preferences.ResponseFormatB64JSON = util.ToBool(value["response_format_b64_json"])
	preferences.CodexCLICompatibility = util.ToBool(value["codex_cli_compatibility"])
	preferences.SystemPrompt = normalizePreferenceText(util.Clean(value["system_prompt"]))
	preferences.VideoSystemPrompt = normalizePreferenceText(util.Clean(value["video_system_prompt"]))
	preferences.AudioInstructions = normalizePreferenceText(util.Clean(value["audio_instructions"]))
	preferences.DefaultTextModel = strings.TrimSpace(util.Clean(value["default_text_model"]))
	preferences.DefaultImageModel = strings.TrimSpace(util.Clean(value["default_image_model"]))
	preferences.DefaultVideoModel = strings.TrimSpace(util.Clean(value["default_video_model"]))
	preferences.DefaultAudioModel = strings.TrimSpace(util.Clean(value["default_audio_model"]))
	preferences.DefaultTextRelayTokens = normalizeRelayTokenNames(util.AsStringSlice(value["default_text_relay_token_names"]))
	preferences.DefaultImageRelayTokens = normalizeRelayTokenNames(util.AsStringSlice(value["default_image_relay_token_names"]))
	preferences.DefaultVideoRelayTokens = normalizeRelayTokenNames(util.AsStringSlice(value["default_video_relay_token_names"]))
	preferences.DefaultAudioRelayTokens = normalizeRelayTokenNames(util.AsStringSlice(value["default_audio_relay_token_names"]))
	if workbenchValue := util.StringMap(value["workbench"]); len(workbenchValue) > 0 {
		workbench := defaultCreationWorkbenchPreferences()
		workbench.ImageModel = util.Clean(workbenchValue["image_model"])
		workbench.ImageSize = util.Clean(workbenchValue["image_size"])
		workbench.ImageSizeMode = util.Clean(workbenchValue["image_size_mode"])
		workbench.ImageAspectRatio = util.Clean(workbenchValue["image_aspect_ratio"])
		workbench.ImageResolution = util.Clean(workbenchValue["image_resolution"])
		workbench.ImageCustomRatio = util.Clean(workbenchValue["image_custom_ratio"])
		workbench.ImageCustomWidth = util.Clean(workbenchValue["image_custom_width"])
		workbench.ImageCustomHeight = util.Clean(workbenchValue["image_custom_height"])
		workbench.ImageQuality = util.Clean(workbenchValue["image_quality"])
		workbench.ImageOutputFormat = util.Clean(workbenchValue["image_output_format"])
		workbench.ImageOutputCompression = util.Clean(workbenchValue["image_output_compression"])
		workbench.VideoModel = util.Clean(workbenchValue["video_model"])
		workbench.VideoSize = util.Clean(workbenchValue["video_size"])
		workbench.VideoSeconds = util.Clean(workbenchValue["video_seconds"])
		workbench.VideoResolution = util.Clean(workbenchValue["video_resolution"])
		if _, present := workbenchValue["image_snap_to_multiple_16"]; present {
			workbench.ImageSnapToMultiple16 = util.ToBool(workbenchValue["image_snap_to_multiple_16"])
		}
		workbench.VideoGenerateAudio = util.ToBool(workbenchValue["video_generate_audio"])
		workbench.VideoWatermark = util.ToBool(workbenchValue["video_watermark"])
		if count, ok := util.StrictInt(workbenchValue["image_count"]); ok {
			workbench.ImageCount = count
		}
		if normalized, normalizeErr := normalizeCreationWorkbenchPreferences(workbench); normalizeErr == nil {
			preferences.Workbench = normalized
		}
	}
	if count, ok := util.StrictInt(value["canvas_default_image_count"]); ok && count >= 1 && count <= 15 {
		preferences.CanvasDefaultImageCount = count
	}
	if voice := strings.TrimSpace(util.Clean(value["default_audio_voice"])); voice != "" {
		preferences.DefaultAudioVoice = voice
	}
	if format := strings.ToLower(strings.TrimSpace(util.Clean(value["default_audio_format"]))); validPreferenceAudioFormat(format) {
		preferences.DefaultAudioFormat = format
	}
	if speed, err := strconv.ParseFloat(strings.TrimSpace(util.Clean(value["default_audio_speed"])), 64); err == nil && speed >= 0.25 && speed <= 4 {
		preferences.DefaultAudioSpeed = math.Round(speed*100) / 100
	}
	if partialImages, ok := util.StrictInt(value["partial_images"]); ok && partialImages >= 0 && partialImages <= 3 {
		preferences.PartialImages = partialImages
	}
	return preferences, nil
}

func imageGenerationPreferenceStorageError(err error) error {
	if err == nil {
		return nil
	}
	return &ImageGenerationPreferenceStorageError{Err: err}
}

func validPreferenceAudioFormat(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "mp3", "wav", "opus", "aac", "flac", "pcm":
		return true
	default:
		return false
	}
}

const maxGenerationPreferenceTextLength = 12000

func normalizePreferenceText(value string) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > maxGenerationPreferenceTextLength {
		return string([]rune(value)[:maxGenerationPreferenceTextLength])
	}
	return value
}

func normalizeRelayTokenNames(values []string) []string {
	normalized := make([]string, 0, min(len(values), 20))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if len([]rune(value)) > 256 {
			value = string([]rune(value)[:256])
		}
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, value)
		if len(normalized) == 20 {
			break
		}
	}
	return normalized
}

func normalizeCreationWorkbenchPreferences(value CreationWorkbenchPreferences) (CreationWorkbenchPreferences, error) {
	defaults := defaultCreationWorkbenchPreferences()
	value.ImageModel = normalizeOptionalShortPreference(value.ImageModel)
	value.ImageSize = normalizeShortPreference(value.ImageSize, defaults.ImageSize)
	value.ImageSizeMode = strings.ToLower(normalizeShortPreference(value.ImageSizeMode, defaults.ImageSizeMode))
	if value.ImageSizeMode != "auto" && value.ImageSizeMode != "ratio" && value.ImageSizeMode != "custom" {
		return CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_size_mode is not supported")
	}
	value.ImageAspectRatio = normalizeShortPreference(value.ImageAspectRatio, defaults.ImageAspectRatio)
	value.ImageResolution = strings.ToLower(normalizeShortPreference(value.ImageResolution, defaults.ImageResolution))
	value.ImageCustomRatio = normalizeShortPreference(value.ImageCustomRatio, defaults.ImageCustomRatio)
	value.ImageCustomWidth = normalizeShortPreference(value.ImageCustomWidth, defaults.ImageCustomWidth)
	value.ImageCustomHeight = normalizeShortPreference(value.ImageCustomHeight, defaults.ImageCustomHeight)
	value.ImageQuality = strings.ToLower(strings.TrimSpace(value.ImageQuality))
	if value.ImageQuality != "" && value.ImageQuality != "low" && value.ImageQuality != "medium" && value.ImageQuality != "high" {
		return CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_quality is not supported")
	}
	if value.ImageCount < 1 || value.ImageCount > 10 {
		return CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_count must be between 1 and 10")
	}
	value.ImageOutputFormat = strings.ToLower(normalizeShortPreference(value.ImageOutputFormat, defaults.ImageOutputFormat))
	if value.ImageOutputFormat != "png" && value.ImageOutputFormat != "jpeg" && value.ImageOutputFormat != "webp" {
		return CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_output_format is not supported")
	}
	value.ImageOutputCompression = strings.TrimSpace(value.ImageOutputCompression)
	if value.ImageOutputCompression != "" {
		compression, err := strconv.Atoi(value.ImageOutputCompression)
		if err != nil || compression < 0 || compression > 100 {
			return CreationWorkbenchPreferences{}, fmt.Errorf("workbench.image_output_compression must be between 0 and 100")
		}
		value.ImageOutputCompression = strconv.Itoa(compression)
	}
	value.VideoModel = normalizeOptionalShortPreference(value.VideoModel)
	value.VideoSize = normalizeShortPreference(value.VideoSize, defaults.VideoSize)
	value.VideoSeconds = normalizeShortPreference(value.VideoSeconds, defaults.VideoSeconds)
	value.VideoResolution = normalizeShortPreference(value.VideoResolution, defaults.VideoResolution)
	return value, nil
}

func normalizeOptionalShortPreference(value string) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > 128 {
		return string([]rune(value)[:128])
	}
	return value
}

func normalizeShortPreference(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if len([]rune(value)) > 128 {
		return string([]rune(value)[:128])
	}
	return value
}

func imageGenerationPreferenceDocumentName(ownerID string) string {
	return imageGenerationPreferenceDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}
