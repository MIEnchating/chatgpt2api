package httpapi

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestNormalizeAPIMartImagePayloadCoversReferenceContracts(t *testing.T) {
	type contractExpectation struct {
		model          string
		explicit       bool
		resolution     string
		count          bool
		quality        bool
		outputFormat   string
		referenceCount int
	}
	tests := []contractExpectation{
		{model: "gpt-image-2-official", resolution: "4k", count: true, quality: true, outputFormat: "jpeg", referenceCount: 12},
		{model: "gpt-image-2-apimart", resolution: "4k", count: true, quality: true, referenceCount: 12},
		{model: "gpt-4o-image-apimart", count: true, referenceCount: 12},
		{model: "gpt-image-1-apimart", count: true, quality: true, outputFormat: "jpeg", referenceCount: 12},
		{model: "gemini-3.1-flash-lite-image", explicit: true, resolution: "1K", count: true, referenceCount: 12},
		{model: "gemini-3.1-flash-image", explicit: true, resolution: "4K", referenceCount: 12},
		{model: "gemini-31-image-apimart", resolution: "4K", referenceCount: 12},
		{model: "nano-banana2-apimart", resolution: "4K", referenceCount: 12},
		{model: "gemini-3-pro-image", explicit: true, resolution: "4K", referenceCount: 12},
		{model: "nano-banana-pro", explicit: true, resolution: "4K", referenceCount: 12},
		{model: "gemini-2.5-flash-image", explicit: true, resolution: "1K", referenceCount: 12},
		{model: "nano-banana", explicit: true, resolution: "1K", referenceCount: 12},
		{model: "imagen-4-0-apimart", referenceCount: 0},
		{model: "seedream-5-0-pro", resolution: "2K", referenceCount: 10},
		{model: "seedream-5-apimart", resolution: "4K", count: true, outputFormat: "jpeg", referenceCount: 12},
		{model: "seedream-4.5-apimart", resolution: "4K", count: true, referenceCount: 12},
		{model: "seedream-4-apimart", resolution: "4K", count: true, referenceCount: 12},
		{model: "qwen-image-apimart", resolution: "2K", count: true, referenceCount: 12},
		{model: "z-image", explicit: true, resolution: "2K", referenceCount: 0},
		{model: "grok-imagine-edit-apimart", count: true, referenceCount: 12},
		{model: "wan2.7-image-apimart", resolution: "4K", count: true, referenceCount: 12},
		{model: "flux-2-image-apimart", resolution: "4K", referenceCount: 12},
	}
	references := make([]string, 12)
	for index := range references {
		references[index] = fmt.Sprintf("https://cdn.example.com/reference-%02d.png", index)
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			payload := map[string]any{
				"model":                test.model,
				"size":                 "4096x4096",
				"image_resolution":     "4K",
				"quality":              "HIGH",
				"n":                    "3",
				"output_format":        "jpg",
				"reference_image_urls": references,
				"requested_size":       "4096x4096",
				"stream":               true,
				"partial_images":       2,
				"response_format":      "b64_json",
			}
			if test.explicit {
				payload["provider"] = "apimart"
			}
			if !normalizeAPIMartImagePayload(payload) {
				t.Fatalf("model was not recognized as APIMart: %#v", payload)
			}
			if payload["size"] != "1:1" {
				t.Fatalf("size = %#v, want 1:1: %#v", payload["size"], payload)
			}
			if test.resolution == "" {
				if _, ok := payload["resolution"]; ok {
					t.Fatalf("unsupported resolution leaked: %#v", payload)
				}
			} else if payload["resolution"] != test.resolution {
				t.Fatalf("resolution = %#v, want %s: %#v", payload["resolution"], test.resolution, payload)
			}
			if test.count {
				if payload["n"] != 3 {
					t.Fatalf("n = %#v, want 3: %#v", payload["n"], payload)
				}
			} else if _, ok := payload["n"]; ok {
				t.Fatalf("unsupported n leaked: %#v", payload)
			}
			if test.quality {
				if payload["quality"] != "high" {
					t.Fatalf("quality = %#v, want high: %#v", payload["quality"], payload)
				}
			} else if _, ok := payload["quality"]; ok {
				t.Fatalf("unsupported quality leaked: %#v", payload)
			}
			if test.outputFormat == "" {
				if _, ok := payload["output_format"]; ok {
					t.Fatalf("unsupported output_format leaked: %#v", payload)
				}
			} else if payload["output_format"] != test.outputFormat {
				t.Fatalf("output_format = %#v, want %s: %#v", payload["output_format"], test.outputFormat, payload)
			}
			gotReferences, _ := payload["image_urls"].([]string)
			if len(gotReferences) != test.referenceCount {
				t.Fatalf("image_urls count = %d, want %d: %#v", len(gotReferences), test.referenceCount, payload)
			}
			for _, key := range []string{"image_resolution", "reference_image_urls", "requested_size", "stream", "partial_images", "response_format"} {
				if _, ok := payload[key]; ok {
					t.Fatalf("compatibility field %s leaked: %#v", key, payload)
				}
			}
		})
	}
}

func TestNormalizeAPIMartImagePayloadReferenceExclusionsAndNestedAliases(t *testing.T) {
	for _, model := range []string{"grok-imagine-1-5-apimart", "imagen-4-0-apimart"} {
		payload := map[string]any{
			"model":                model,
			"image":                "https://cdn.example.com/a.png",
			"image_urls":           []string{"https://cdn.example.com/b.png"},
			"reference_image_urls": []any{map[string]any{"url": "https://cdn.example.com/c.png"}},
			"first_frame_image":    "https://cdn.example.com/d.png",
			"last_frame_image":     "https://cdn.example.com/e.png",
			"input_reference[]":    "https://cdn.example.com/f.png",
			"reference_image_url":  "https://cdn.example.com/g.png",
			"reference_image":      "https://cdn.example.com/h.png",
			"reference_images":     []string{"https://cdn.example.com/i.png"},
		}
		normalizeAPIMartImagePayload(payload)
		for _, key := range apimartImageReferenceAliasKeys() {
			if _, ok := payload[key]; ok {
				t.Fatalf("%s retained excluded reference %s: %#v", model, key, payload)
			}
		}
	}

	payload := map[string]any{
		"model":     "gpt-image-2-apimart",
		"image":     map[string]any{"url": "https://cdn.example.com/a.png"},
		"images":    []any{map[string]any{"image_url": "https://cdn.example.com/b.png"}},
		"input_url": "https://cdn.example.com/a.png",
	}
	normalizeAPIMartImagePayload(payload)
	if got := payload["image_urls"]; !reflect.DeepEqual(got, []string{"https://cdn.example.com/a.png", "https://cdn.example.com/b.png"}) {
		t.Fatalf("nested image_urls = %#v", got)
	}
}

func TestValidateAPIMartGrokImageEditRequiredInput(t *testing.T) {
	payload := map[string]any{"model": "grok-imagine-edit-apimart", "provider": "apimart"}
	err := validateRelayImageRequest("/v1/images/generations", "grok-imagine-edit-apimart", payload, nil)
	var httpErr protocol.HTTPError
	if err == nil || !errors.As(err, &httpErr) || httpErr.Status != 400 {
		t.Fatalf("missing reference HTTP error = %#v", err)
	}
	if err == nil || err.Error() != "APIMart required input missing: image_urls" {
		t.Fatalf("missing reference error = %v", err)
	}
	payload["reference_image_url"] = "https://cdn.example.com/source.png"
	if err := validateRelayImageRequest("/v1/images/generations", "grok-imagine-edit-apimart", payload, nil); err != nil {
		t.Fatalf("public reference was rejected: %v", err)
	}
}

func TestValidateAPIMartImageReferenceCountUsesReferenceContracts(t *testing.T) {
	tests := []struct {
		model   string
		count   int
		wantErr bool
	}{
		{model: "gpt-image-2-apimart", count: 15},
		{model: "seedream-5-0-pro", count: 10},
		{model: "seedream-5-0-pro", count: 11, wantErr: true},
		{model: "imagen-4-0-apimart", count: 1, wantErr: true},
		{model: "z-image", count: 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%s/%d", test.model, test.count), func(t *testing.T) {
			payload := map[string]any{"model": test.model, "provider": "apimart"}
			err := validateRelayImageReferenceCount(test.model, test.count, payload)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestAPIMartImageProviderPrecedenceAndRoutingMetadata(t *testing.T) {
	if isAPIMartImagePayload(map[string]any{"model": "nano-banana-pro"}) {
		t.Fatal("bare KIE nano-banana-pro was classified as APIMart")
	}
	for _, model := range []string{"gpt-image-1", "gemini-3.1-flash-image", "gemini-2.5-flash-image", "grok-imagine-image"} {
		if isAPIMartImagePayload(map[string]any{"model": model}) {
			t.Fatalf("official model %s was classified as APIMart without a channel hint", model)
		}
	}
	if !isAPIMartImagePayload(map[string]any{"model": "nano-banana-pro", "protocol": "apimart"}) {
		t.Fatal("explicit APIMart nano-banana-pro was not classified as APIMart")
	}
	if isAPIMartImagePayload(map[string]any{"model": "gpt-image-2-apimart", "provider": "kie"}) {
		t.Fatal("explicit KIE provider did not override APIMart model inference")
	}

	body := map[string]any{
		"model":             "seedream-5-0-pro",
		"provider":          "apimart",
		"channel_protocol":  "apimart",
		"provider_base_url": "https://api.apimart.ai",
		"resolution":        "2K",
	}
	metadata := imageTaskRequestMetadata(body)
	for _, key := range []string{"provider", "channel_protocol", "provider_base_url"} {
		if metadata[key] != body[key] {
			t.Fatalf("metadata %s = %#v, want %#v", key, metadata[key], body[key])
		}
	}
	if metadata["image_resolution"] != "2k" {
		t.Fatalf("metadata image_resolution = %#v", metadata["image_resolution"])
	}

	request := map[string]any{
		"model":            "gpt-image-2-apimart",
		"provider":         "apimart",
		"channel_protocol": "apimart",
		"prompt":           "draw",
		"size":             "2048x2048",
		"resolution":       "2k",
	}
	normalizeImagePayloadForModel(request)
	upstream := relayPayloadForPath("/v1/images/generations", request)
	if upstream["size"] != "1:1" || upstream["resolution"] != "2k" {
		t.Fatalf("APIMart upstream contract = %#v", upstream)
	}
	for _, key := range []string{"provider", "image_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		if _, ok := upstream[key]; ok {
			t.Fatalf("routing hint %s leaked upstream: %#v", key, upstream)
		}
	}
}

func TestRelayImageEditPathMatchesAPIMartReferenceRouting(t *testing.T) {
	tests := []struct {
		payload map[string]any
		want    string
	}{
		{payload: map[string]any{"model": "custom-image-model"}, want: "/v1/images/edits"},
		{payload: map[string]any{"model": "seedream-5-0-pro"}, want: "/v1/images/generations"},
		{payload: map[string]any{"model": "gpt-image-2", "provider": "apimart"}, want: "/v1/images/generations"},
		{payload: map[string]any{"model": "grok-imagine-edit-apimart"}, want: "/v1/images/edits"},
	}
	for _, test := range tests {
		if got := relayImageEditPath(test.payload); got != test.want {
			t.Errorf("relayImageEditPath(%#v) = %q, want %q", test.payload, got, test.want)
		}
	}
}
