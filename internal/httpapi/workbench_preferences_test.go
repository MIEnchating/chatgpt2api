package httpapi

import "testing"

func TestWorkbenchPreferencesDecodeRejectsInvalidTypes(t *testing.T) {
	for _, value := range []any{
		map[string]any{"image_count": 1, "video_task_count": 1.5},
		map[string]any{"image_count": 1, "video_task_count": 0},
		map[string]any{"image_count": 1, "video_task_count": 7},
		map[string]any{"image_count": 1, "video_parameters": []any{"bad"}},
		map[string]any{"image_count": 1, "video_generate_audio": "true"},
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
