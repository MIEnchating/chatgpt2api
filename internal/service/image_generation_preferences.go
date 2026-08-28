package service

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const imageGenerationPreferenceDocumentDir = "image_generation_preferences"

type ImageGenerationPreferences struct {
	APIMode                 string  `json:"api_mode"`
	Stream                  bool    `json:"stream"`
	PartialImages           int     `json:"partial_images"`
	ResponseFormatB64JSON   bool    `json:"response_format_b64_json"`
	CodexCLICompatibility   bool    `json:"codex_cli_compatibility"`
	SystemPrompt            string  `json:"system_prompt"`
	VideoSystemPrompt       string  `json:"video_system_prompt"`
	AudioInstructions       string  `json:"audio_instructions"`
	DefaultTextModel        string  `json:"default_text_model"`
	DefaultImageModel       string  `json:"default_image_model"`
	DefaultVideoModel       string  `json:"default_video_model"`
	DefaultAudioModel       string  `json:"default_audio_model"`
	CanvasDefaultImageCount int     `json:"canvas_default_image_count"`
	DefaultAudioVoice       string  `json:"default_audio_voice"`
	DefaultAudioFormat      string  `json:"default_audio_format"`
	DefaultAudioSpeed       float64 `json:"default_audio_speed"`
}

type ImageGenerationPreferenceService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewImageGenerationPreferenceService(backend storage.Backend) *ImageGenerationPreferenceService {
	return &ImageGenerationPreferenceService{store: jsonDocumentStoreFromBackend(backend)}
}

func defaultImageGenerationPreferences() ImageGenerationPreferences {
	return ImageGenerationPreferences{APIMode: "images", PartialImages: 1, CanvasDefaultImageCount: 1, DefaultAudioSpeed: 1}
}

func (s *ImageGenerationPreferenceService) Preferences(ownerID string) (ImageGenerationPreferences, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return ImageGenerationPreferences{}, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(ownerID)
}

func (s *ImageGenerationPreferenceService) Update(ownerID string, input ImageGenerationPreferences) (ImageGenerationPreferences, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return ImageGenerationPreferences{}, fmt.Errorf("owner_id is required")
	}
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
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store == nil {
		return ImageGenerationPreferences{}, fmt.Errorf("storage document backend is required")
	}
	if err := s.store.SaveJSONDocument(imageGenerationPreferenceDocumentName(ownerID), input); err != nil {
		return ImageGenerationPreferences{}, err
	}
	return input, nil
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

func imageGenerationPreferenceDocumentName(ownerID string) string {
	return imageGenerationPreferenceDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}
