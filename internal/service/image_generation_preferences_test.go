package service

import (
	"path/filepath"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestImageGenerationPreferencesArePersistentAndPersonal(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "preferences.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	preferences := NewImageGenerationPreferenceService(backend)
	defaults, err := preferences.Preferences("user-a")
	if err != nil {
		t.Fatalf("Preferences(default) error = %v", err)
	}
	if defaults.APIMode != "images" || defaults.Stream || defaults.PartialImages != 1 || defaults.ResponseFormatB64JSON || defaults.CodexCLICompatibility || defaults.CanvasDefaultImageCount != 1 || defaults.DefaultAudioVoice != "" || defaults.DefaultAudioFormat != "" || defaults.DefaultAudioSpeed != 1 {
		t.Fatalf("default preferences = %#v", defaults)
	}

	want := ImageGenerationPreferences{
		APIMode:                 "responses",
		Stream:                  true,
		PartialImages:           3,
		ResponseFormatB64JSON:   true,
		CodexCLICompatibility:   true,
		SystemPrompt:            "系统",
		VideoSystemPrompt:       "视频系统",
		AudioInstructions:       "自然、温暖、适合旁白。",
		DefaultTextModel:        "gpt-5.5",
		DefaultImageModel:       "gpt-image-2",
		DefaultVideoModel:       "sora-2",
		DefaultAudioModel:       "gpt-4o-mini-tts",
		CanvasDefaultImageCount: 4,
		DefaultAudioVoice:       "coral",
		DefaultAudioFormat:      "wav",
		DefaultAudioSpeed:       1.25,
		DefaultTextRelayToken:   "text-key",
		DefaultImageRelayToken:  "image-key",
		DefaultVideoRelayToken:  "video-key",
		DefaultAudioRelayToken:  "audio-key",
		Workbench: CreationWorkbenchPreferences{
			ImageSize:              "2048x1152",
			ImageSizeMode:          "ratio",
			ImageAspectRatio:       "16:9",
			ImageResolution:        "2k",
			ImageCustomRatio:       "3:2",
			ImageCustomWidth:       "1536",
			ImageCustomHeight:      "1024",
			ImageSnapToMultiple16:  true,
			ImageQuality:           "high",
			ImageCount:             3,
			ImageOutputFormat:      "webp",
			ImageOutputCompression: "88",
			VideoSize:              "1920x1080",
			VideoSeconds:           "10",
			VideoResolution:        "1080p",
			VideoMode:              "pro",
			VideoGenerateAudio:     true,
			VideoWatermark:         true,
		},
	}
	if _, err := preferences.Update("user-a", want); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	got, err := NewImageGenerationPreferenceService(backend).Preferences("user-a")
	if err != nil {
		t.Fatalf("Preferences(reload) error = %v", err)
	}
	if got != want {
		t.Fatalf("reloaded preferences = %#v, want %#v", got, want)
	}
	updated, err := preferences.UpdateRelayTokenNames("user-a", map[string]string{"image": "image-key-2", "audio": "audio-key-2"})
	if err != nil {
		t.Fatalf("UpdateRelayTokenNames() error = %v", err)
	}
	if updated.DefaultImageRelayToken != "image-key-2" || updated.DefaultAudioRelayToken != "audio-key-2" || updated.DefaultTextRelayToken != "text-key" || updated.DefaultVideoRelayToken != "video-key" {
		t.Fatalf("updated relay token preferences = %#v", updated)
	}
	if updated.DefaultImageModel != want.DefaultImageModel || updated.SystemPrompt != want.SystemPrompt {
		t.Fatalf("relay token update overwrote generation preferences = %#v", updated)
	}
	workbench := want.Workbench
	workbench.ImageCount = 6
	workbench.ImageQuality = "medium"
	updated, err = preferences.UpdateWorkbench("user-a", workbench)
	if err != nil {
		t.Fatalf("UpdateWorkbench() error = %v", err)
	}
	if updated.Workbench.ImageCount != 6 || updated.Workbench.ImageQuality != "medium" || updated.DefaultTextRelayToken != "text-key" {
		t.Fatalf("updated workbench preferences = %#v", updated)
	}
	other, err := preferences.Preferences("user-b")
	if err != nil {
		t.Fatalf("Preferences(other) error = %v", err)
	}
	if other.APIMode != "images" || other.Stream || other.PartialImages != 1 || other.ResponseFormatB64JSON || other.CodexCLICompatibility || other.CanvasDefaultImageCount != 1 || other.DefaultAudioVoice != "" || other.DefaultAudioFormat != "" || other.DefaultAudioSpeed != 1 {
		t.Fatalf("other user preferences = %#v", other)
	}
	if _, err := preferences.Update("user-a", ImageGenerationPreferences{PartialImages: 4}); err == nil {
		t.Fatal("Update() accepted partial_images greater than 3")
	}
	if _, err := preferences.Update("user-a", ImageGenerationPreferences{APIMode: "legacy", PartialImages: 1}); err == nil {
		t.Fatal("Update() accepted an unknown api_mode")
	}
	invalid := defaultImageGenerationPreferences()
	invalid.CanvasDefaultImageCount = 16
	if _, err := preferences.Update("user-a", invalid); err == nil {
		t.Fatal("Update() accepted canvas_default_image_count greater than 15")
	}
	invalid = defaultImageGenerationPreferences()
	invalid.DefaultAudioFormat = "ogg"
	if _, err := preferences.Update("user-a", invalid); err == nil {
		t.Fatal("Update() accepted unsupported default_audio_format")
	}
	invalid = defaultImageGenerationPreferences()
	invalid.DefaultAudioSpeed = 4.1
	if _, err := preferences.Update("user-a", invalid); err == nil {
		t.Fatal("Update() accepted default_audio_speed greater than 4")
	}
}
