package service

import (
	"errors"
	"path/filepath"
	"reflect"
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
		DefaultTextRelayTokens:  []string{"text-key", "text-backup"},
		DefaultImageRelayTokens: []string{"image-key"},
		DefaultVideoRelayTokens: []string{"video-key"},
		DefaultAudioRelayTokens: []string{"audio-key"},
		Workbench: CreationWorkbenchPreferences{
			ImageModel:             "image-workbench-model",
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
			VideoModel:             "video-workbench-model",
			VideoSize:              "1920x1080",
			VideoSeconds:           "10",
			VideoResolution:        "1080p",
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
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reloaded preferences = %#v, want %#v", got, want)
	}
	updated, err := preferences.Patch("user-a", ImageGenerationPreferencePatch{RelayTokenNames: map[string][]string{"image": {"image-key-2", "image-key-3"}, "audio": {"audio-key-2"}}})
	if err != nil {
		t.Fatalf("Patch(relay tokens) error = %v", err)
	}
	if !reflect.DeepEqual(updated.DefaultImageRelayTokens, []string{"image-key-2", "image-key-3"}) || !reflect.DeepEqual(updated.DefaultAudioRelayTokens, []string{"audio-key-2"}) || !reflect.DeepEqual(updated.DefaultTextRelayTokens, []string{"text-key", "text-backup"}) || !reflect.DeepEqual(updated.DefaultVideoRelayTokens, []string{"video-key"}) {
		t.Fatalf("updated relay token preferences = %#v", updated)
	}
	if updated.DefaultImageModel != want.DefaultImageModel || updated.SystemPrompt != want.SystemPrompt {
		t.Fatalf("relay token update overwrote generation preferences = %#v", updated)
	}
	workbench := want.Workbench
	workbench.ImageCount = 6
	workbench.ImageQuality = "medium"
	updated, err = preferences.Patch("user-a", ImageGenerationPreferencePatch{Workbench: &workbench})
	if err != nil {
		t.Fatalf("Patch(workbench) error = %v", err)
	}
	if updated.Workbench.ImageCount != 6 || updated.Workbench.ImageQuality != "medium" || !reflect.DeepEqual(updated.DefaultTextRelayTokens, []string{"text-key", "text-backup"}) {
		t.Fatalf("updated workbench preferences = %#v", updated)
	}
	beforeInvalidPatch := updated
	invalidPartialImages := 4
	if _, err := preferences.Patch("user-a", ImageGenerationPreferencePatch{
		PartialImages:   &invalidPartialImages,
		RelayTokenNames: map[string][]string{"text": {"must-not-be-saved"}},
	}); err == nil {
		t.Fatal("Patch() accepted invalid partial_images")
	}
	afterInvalidPatch, err := preferences.Preferences("user-a")
	if err != nil {
		t.Fatalf("Preferences(after invalid patch) error = %v", err)
	}
	if !reflect.DeepEqual(afterInvalidPatch, beforeInvalidPatch) {
		t.Fatalf("invalid patch modified preferences: got %#v, want %#v", afterInvalidPatch, beforeInvalidPatch)
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

func TestImageGenerationPreferenceServiceMergesConcurrentPatches(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-preferences.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendA.Close()
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendB.Close()

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewImageGenerationPreferenceService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewImageGenerationPreferenceService(newFirstSaveBarrierBackend(t, backendB, barrier))
	type patchResult struct {
		preferences ImageGenerationPreferences
		err         error
	}
	results := make(chan patchResult, 2)
	go func() {
		stream := true
		preferences, patchErr := serviceA.Patch("owner", ImageGenerationPreferencePatch{Stream: &stream})
		results <- patchResult{preferences: preferences, err: patchErr}
	}()
	go func() {
		preferences, patchErr := serviceB.Patch("owner", ImageGenerationPreferencePatch{RelayTokenNames: map[string][]string{"video": {"video-key"}}})
		results <- patchResult{preferences: preferences, err: patchErr}
	}()
	returnedMergedState := false
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent Patch() error = %v", result.err)
		}
		if result.preferences.Stream && reflect.DeepEqual(result.preferences.DefaultVideoRelayTokens, []string{"video-key"}) {
			returnedMergedState = true
		}
	}
	preferences, err := serviceA.Preferences("owner")
	if err != nil {
		t.Fatal(err)
	}
	if !preferences.Stream || !reflect.DeepEqual(preferences.DefaultVideoRelayTokens, []string{"video-key"}) || !returnedMergedState {
		t.Fatalf("merged preferences = %#v, returned merged state = %v", preferences, returnedMergedState)
	}
}

func TestImageGenerationPreferenceServiceProfileUpdatePreservesConcurrentOptionalFields(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-profile-preferences.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendA.Close()
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendB.Close()

	initial := defaultImageGenerationPreferences()
	initial.SystemPrompt = "before"
	initial.DefaultVideoRelayTokens = []string{"video-before"}
	initial.Workbench.ImageQuality = "low"
	if _, err := NewImageGenerationPreferenceService(backendA).Update("owner", initial); err != nil {
		t.Fatal(err)
	}

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewImageGenerationPreferenceService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewImageGenerationPreferenceService(newFirstSaveBarrierBackend(t, backendB, barrier))
	profile := initial
	profile.SystemPrompt = "after"
	workbench := initial.Workbench
	workbench.ImageQuality = "high"
	type updateResult struct {
		preferences ImageGenerationPreferences
		err         error
	}
	results := make(chan updateResult, 2)
	go func() {
		preferences, updateErr := serviceA.UpdateProfile("owner", profile, nil, nil)
		results <- updateResult{preferences: preferences, err: updateErr}
	}()
	go func() {
		preferences, patchErr := serviceB.Patch("owner", ImageGenerationPreferencePatch{
			Workbench:       &workbench,
			RelayTokenNames: map[string][]string{"video": {"video-after"}},
		})
		results <- updateResult{preferences: preferences, err: patchErr}
	}()
	for range 2 {
		if result := <-results; result.err != nil {
			t.Fatalf("concurrent preference update error = %v", result.err)
		}
	}

	preferences, err := serviceA.Preferences("owner")
	if err != nil {
		t.Fatal(err)
	}
	if preferences.SystemPrompt != "after" || preferences.Workbench.ImageQuality != "high" || !reflect.DeepEqual(preferences.DefaultVideoRelayTokens, []string{"video-after"}) {
		t.Fatalf("merged profile preferences = %#v", preferences)
	}
}

func TestImageGenerationPreferenceServiceClassifiesStorageErrors(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "closed-preferences.db")))
	if err != nil {
		t.Fatal(err)
	}
	service := NewImageGenerationPreferenceService(backend)
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = service.Preferences("owner")
	var storageErr *ImageGenerationPreferenceStorageError
	if !errors.As(err, &storageErr) {
		t.Fatalf("Preferences() error = %T %v, want storage error", err, err)
	}
}
