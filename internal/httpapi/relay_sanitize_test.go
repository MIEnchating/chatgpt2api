package httpapi

import "testing"

func TestRelayImageResolutionCleanupKeepsOnlyProviderSpecificSchemas(t *testing.T) {
	tests := []struct {
		name string
		body map[string]any
		keep bool
	}{
		{
			name: "generic OpenAI schema",
			body: map[string]any{"model": "codex-gpt-image-2", "image_resolution": "2k"},
		},
		{
			name: "KIE schema",
			body: map[string]any{"model": "bytedance/seedream-v4-text-to-image", "image_resolution": "2K"},
			keep: true,
		},
		{
			name: "APIMart schema",
			body: map[string]any{"model": "seedream-5-0-pro", "provider": "apimart", "image_resolution": "2k"},
			keep: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := relayPayloadForPath("/v1/images/generations", test.body)
			_, kept := payload["image_resolution"]
			if kept != test.keep {
				t.Fatalf("image_resolution kept = %v, want %v; payload = %#v", kept, test.keep, payload)
			}
		})
	}
}
