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
