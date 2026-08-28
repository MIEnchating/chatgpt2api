package httpapi

import (
	"encoding/base64"
	"reflect"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func TestCopyRelayTaskCredentialsCopiesCurrentFieldOnly(t *testing.T) {
	target := map[string]any{}
	copyRelayTaskCredentials(target, map[string]any{
		"api_key":       "current-key",
		"relay_api_key": "removed-key",
	})
	if !reflect.DeepEqual(target, map[string]any{"api_key": "current-key"}) {
		t.Fatalf("copied credentials = %#v", target)
	}
}

func TestImageResponsesRequestMatchesReferenceContract(t *testing.T) {
	payload := map[string]any{
		"model":          "gpt-image-2",
		"prompt":         "system\n\ndraw",
		"size":           "2048x1152",
		"quality":        "medium",
		"stream":         true,
		"partial_images": 3,
		"api_key":        "secret",
	}
	request := imageResponsesRequest(payload, []protocol.UploadedImage{{Data: []byte("png"), ContentType: "image/png"}}, true)
	if request["model"] != "gpt-image-2" || request["tool_choice"] != "required" || request["stream"] != true || request["api_key"] != "secret" {
		t.Fatalf("responses request envelope = %#v", request)
	}
	tools := util.AsMapSlice(request["tools"])
	if len(tools) != 1 || tools[0]["type"] != "image_generation" || tools[0]["action"] != "edit" || tools[0]["size"] != "2048x1152" || tools[0]["quality"] != "medium" || util.ToInt(tools[0]["partial_images"], -1) != 3 {
		t.Fatalf("responses image tool = %#v", tools)
	}
	input := util.AsMapSlice(request["input"])
	if len(input) != 1 {
		t.Fatalf("responses input = %#v", request["input"])
	}
	content := util.AsMapSlice(input[0]["content"])
	wantDataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("png"))
	if len(content) != 2 || content[0]["type"] != "input_text" || content[0]["text"] != "system\n\ndraw" || content[1]["type"] != "input_image" || content[1]["image_url"] != wantDataURL {
		t.Fatalf("responses multimodal content = %#v", content)
	}
}

func TestImageResponsesRequestPreservesExplicitZeroPartialImages(t *testing.T) {
	request := imageResponsesRequest(map[string]any{
		"model":          "gpt-image-2",
		"prompt":         "draw",
		"stream":         true,
		"partial_images": 0,
	}, nil, false)
	tools := util.AsMapSlice(request["tools"])
	if len(tools) != 1 {
		t.Fatalf("responses tools = %#v", request["tools"])
	}
	partialImages, ok := tools[0]["partial_images"]
	if !ok || util.ToInt(partialImages, -1) != 0 {
		t.Fatalf("responses partial_images = %#v, want explicit 0", partialImages)
	}
}

func TestImageChatRequestMatchesReferenceContract(t *testing.T) {
	payload := map[string]any{
		"model":          "gpt-image-2",
		"prompt":         "draw",
		"size":           "3840x2160",
		"requested_size": "3840x2160",
		"quality":        "auto",
	}
	request := imageChatRequest(payload, nil)
	if request["stream"] != false || !reflect.DeepEqual(request["modalities"], []string{"image", "text"}) {
		t.Fatalf("chat request envelope = %#v", request)
	}
	messages := util.AsMapSlice(request["messages"])
	if len(messages) != 1 || messages[0]["role"] != "user" || messages[0]["content"] != "draw" {
		t.Fatalf("chat messages = %#v", messages)
	}
	config := util.StringMap(request["image_config"])
	if config["aspect_ratio"] != "16:9" || config["image_size"] != "4K" {
		t.Fatalf("chat image_config = %#v", config)
	}
}

func TestImageAPIModeFallsBackForReferenceExcludedModels(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{model: "gpt-image-2", want: "responses"},
		{model: "gemini-3.1-flash-image", want: "images"},
		{model: "glm-image", want: "images"},
	}
	for _, test := range tests {
		if got := normalizeImageTaskAPIMode("responses", test.model); got != test.want {
			t.Errorf("normalizeImageTaskAPIMode(responses, %q) = %q, want %q", test.model, got, test.want)
		}
	}
	if got := normalizeImageTaskAPIMode("legacy", "gpt-image-2"); got != "" {
		t.Fatalf("unknown api mode normalized to %q", got)
	}
}

func TestImageAPIModeResultsMatchReferenceParsing(t *testing.T) {
	chat, err := chatImageTaskResult(map[string]any{
		"choices": []map[string]any{{"message": map[string]any{"images": []map[string]any{{"image_url": map[string]any{"url": "https://cdn.example/image.png"}}}}}},
	})
	if err != nil || util.AsMapSlice(chat["data"])[0]["url"] != "https://cdn.example/image.png" {
		t.Fatalf("chat image result = %#v, %v", chat, err)
	}

	responses, err := responsesImageTaskResult(map[string]any{
		"output": []map[string]any{{"type": "image_generation_call", "result": map[string]any{"data": "aW1hZ2U="}}},
	}, nil, nil)
	if err != nil {
		t.Fatalf("responsesImageTaskResult() error = %v", err)
	}
	data := util.AsMapSlice(responses["data"])
	if len(data) != 1 || data[0]["b64_json"] != "aW1hZ2U=" {
		t.Fatalf("responses image result = %#v", responses)
	}
}
