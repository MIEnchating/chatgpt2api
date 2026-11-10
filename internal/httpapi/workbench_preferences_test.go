package httpapi

import (
	"testing"

	"chatgpt2api/internal/service"
)

func TestWorkbenchPreferencesDecodeRejectsInvalidTypes(t *testing.T) {
	for _, value := range []any{
		map[string]any{"image_count": 1, "video_task_count": 1.5},
		map[string]any{"image_count": 1, "video_task_count": 0},
		map[string]any{"image_count": 1, "video_task_count": 7},
		map[string]any{"image_count": 1, "video_parameters": []any{"bad"}},
		map[string]any{"image_count": 1, "video_generate_audio": "true"},
		map[string]any{"image_count": 1, "smart_context_enabled": "true"},
		map[string]any{"image_count": 1, "context_text_model": 12},
	} {
		if _, err := creationWorkbenchPreferencesFromValue(value); err == nil {
			t.Fatalf("accepted invalid workbench: %#v", value)
		}
	}
	value, err := creationWorkbenchPreferencesFromValue(map[string]any{"image_count": 1, "composer_mode": "video", "video_task_count": 3, "video_parameters": map[string]any{"seed": 42, "audio": false}})
	if err != nil || value.VideoTaskCount != 3 || value.VideoParameters["audio"] != false {
		t.Fatalf("valid settings lost: %#v %v", value, err)
	}
}

func TestWorkbenchPreferencesDecodePreservesContextChoice(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		got, err := creationWorkbenchPreferencesFromValue(map[string]any{"image_count": 1, "smart_context_enabled": enabled, "context_text_model": "vision-model"})
		if err != nil || got.SmartContextEnabled != enabled || got.ContextTextModel != "vision-model" {
			t.Fatalf("context choice lost: %#v %v", got, err)
		}
	}
}

func TestWorkbenchPreferencesValidateContextModel(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"text_models": []string{"vision-model"}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		mode    string
		enabled bool
		model   string
		wantErr bool
	}{
		{name: "enabled allowed model", enabled: true, model: "vision-model"},
		{name: "enabled removed model", enabled: true, model: "removed-model", wantErr: true},
		{name: "disabled keeps previous choice", model: "removed-model"},
		{name: "video keeps image context choice", mode: "video", enabled: true, model: "removed-model"},
		{name: "no model configured", enabled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := app.validateCreationWorkbenchModels(service.CreationWorkbenchPreferences{
				ComposerMode: tc.mode, SmartContextEnabled: tc.enabled, ContextTextModel: tc.model,
			})
			if (err != nil) != tc.wantErr {
				t.Fatalf("validate context model = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}
