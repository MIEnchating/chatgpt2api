package service

import (
	"chatgpt2api/internal/storage"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkbenchSettingsPersistPerAccountAndModel(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "preferences.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	svc := NewImageGenerationPreferenceService(backend)
	patch := func(owner string, value CreationWorkbenchPreferences) ImageGenerationPreferences {
		t.Helper()
		result, err := svc.Patch(owner, ImageGenerationPreferencePatch{Workbench: &value})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	image := defaultCreationWorkbenchPreferences()
	image.ImageModel = "image-a"
	image.ImageCount = 3
	patch("alice", image)
	video := defaultCreationWorkbenchPreferences()
	video.ComposerMode = "video"
	video.VideoModel = "video-a"
	video.VideoTaskCount = 4
	video.VideoSeconds = "8"
	video.VideoParameters = map[string]any{"seed": float64(42), "audio": false}
	patch("alice", video)
	video.VideoModel = "video-b"
	video.VideoTaskCount = 2
	video.VideoSeconds = "12"
	video.VideoParameters = map[string]any{"style": "cinematic"}
	patch("alice", video)
	image.ImageModel = "image-b"
	image.ImageCount = 5
	patch("alice", image)
	got, err := NewImageGenerationPreferenceService(backend).Preferences("alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.Workbench.ComposerMode != "image" || got.Workbench.VideoModel != "video-b" || got.Workbench.VideoTaskCount != 2 {
		t.Fatalf("inactive video state overwritten: %#v", got.Workbench)
	}
	if got.ImageModelSettings["image-a"].ImageCount != 3 || got.ImageModelSettings["image-b"].ImageCount != 5 {
		t.Fatalf("image settings lost: %#v", got.ImageModelSettings)
	}
	a, b := got.VideoModelSettings["video-a"], got.VideoModelSettings["video-b"]
	if a.VideoTaskCount != 4 || a.VideoSeconds != "8" || b.VideoTaskCount != 2 || b.VideoSeconds != "12" || !reflect.DeepEqual(a.VideoParameters, map[string]any{"seed": float64(42), "audio": false}) {
		t.Fatalf("video settings lost: %#v", got.VideoModelSettings)
	}
	other, err := svc.Preferences("bob")
	if err != nil {
		t.Fatal(err)
	}
	if len(other.ImageModelSettings) != 0 || len(other.VideoModelSettings) != 0 {
		t.Fatal("model settings leaked between accounts")
	}
	before := got.VideoModelSettings
	_, err = svc.Patch("alice", ImageGenerationPreferencePatch{RelayTokenNames: map[string][]string{"video": {"new-key"}}})
	if err != nil {
		t.Fatal(err)
	}
	got, err = svc.Preferences("alice")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, got.VideoModelSettings) {
		t.Fatal("unrelated preferences overwrote model settings")
	}
}

func TestWorkbenchProfileAudioUpdatePreservesModelParameters(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "preferences.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	svc := NewImageGenerationPreferenceService(backend)
	video := defaultCreationWorkbenchPreferences()
	video.ComposerMode = "video"
	video.VideoModel = "video-a"
	video.VideoTaskCount = 4
	video.VideoParameters = map[string]any{"seed": float64(42)}
	if _, err := svc.Patch("alice", ImageGenerationPreferencePatch{Workbench: &video}); err != nil {
		t.Fatal(err)
	}
	image := defaultCreationWorkbenchPreferences()
	image.ImageModel = "image-a"
	current, err := svc.Patch("alice", ImageGenerationPreferencePatch{Workbench: &image})
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	current.WorkbenchGenerateAudio = &enabled
	got, err := svc.UpdateProfile("alice", current, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Workbench.ComposerMode != "image" || !got.Workbench.VideoGenerateAudio || got.Workbench.VideoTaskCount != 4 || got.VideoModelSettings["video-a"].VideoParameters["seed"] != float64(42) || !got.VideoModelSettings["video-a"].VideoGenerateAudio {
		t.Fatalf("profile audio clobbered settings: %#v", got)
	}
}

func TestWorkbenchSettingsRejectInvalidValues(t *testing.T) {
	for _, modify := range []func(*CreationWorkbenchPreferences){
		func(v *CreationWorkbenchPreferences) { v.ComposerMode = "chat" },
		func(v *CreationWorkbenchPreferences) { v.VideoTaskCount = 7 },
		func(v *CreationWorkbenchPreferences) {
			v.VideoParameters = map[string]any{"nested": map[string]any{"token": "private"}}
		},
	} {
		value := defaultCreationWorkbenchPreferences()
		modify(&value)
		if _, err := normalizeCreationWorkbenchPreferences(value); err == nil {
			t.Fatalf("accepted invalid preferences: %#v", value)
		}
	}
}

func TestWorkbenchContextPreferencesPersistAcrossModelsAndAccounts(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "preferences.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	svc := NewImageGenerationPreferenceService(backend)
	assertContext := func(owner string, enabled bool, textModel string) {
		t.Helper()
		got, err := NewImageGenerationPreferenceService(backend).Preferences(owner)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(got.Workbench)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		if fields["smart_context_enabled"] != enabled || fields["context_text_model"] != textModel {
			t.Fatalf("context preferences lost for %s: %s", owner, data)
		}
	}
	for _, mode := range []string{"image", "video", "image"} {
		var value CreationWorkbenchPreferences
		if err := json.Unmarshal([]byte(`{"composer_mode":"`+mode+`","image_count":1,"image_model":"image-b","video_model":"video-a","smart_context_enabled":true,"context_text_model":"vision-model"}`), &value); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Patch("alice", ImageGenerationPreferencePatch{Workbench: &value}); err != nil {
			t.Fatal(err)
		}
		assertContext("alice", true, "vision-model")
	}
	assertContext("bob", false, "")
	current, err := svc.Preferences("alice")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(current.Workbench)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	fields["smart_context_enabled"] = false
	data, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	var off CreationWorkbenchPreferences
	if err := json.Unmarshal(data, &off); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Patch("alice", ImageGenerationPreferencePatch{Workbench: &off}); err != nil {
		t.Fatal(err)
	}
	assertContext("alice", false, "vision-model")
	enabled := true
	if _, err := svc.Patch("alice", ImageGenerationPreferencePatch{Stream: &enabled}); err != nil {
		t.Fatal(err)
	}
	assertContext("alice", false, "vision-model")
}
