package protocol

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestAutoDLClientDirectoryAndTaskProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/comfyui/workflows":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" {
				t.Errorf("directory request = %s %s", r.Method, r.Header.Get("Authorization"))
			}
			var page struct {
				Index int `json:"page_index"`
			}
			_ = json.NewDecoder(r.Body).Decode(&page)
			if page.Index == 1 {
				_, _ = w.Write([]byte(`{"code":"Success","data":{"list":[{"uuid":"video-1","name":"视频"}],"max_page":2}}`))
			} else {
				_, _ = w.Write([]byte(`{"code":"Success","data":{"list":[{"uuid":"video-1"},{"uuid":"audio-1"}],"max_page":2}}`))
			}
		case "/api/v1/comfyui/workflows/video-1":
			_, _ = w.Write([]byte(`{"code":"Success","data":{"uuid":"video-1","input_rules":{"duration":{"type":"integer","default":5}}}}`))
		case "/api/v1/comfyui/comfyui_workflow/video-1":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "test-token" {
				t.Errorf("submit auth/method mismatch")
			}
			_, _ = w.Write([]byte(`{"code":"Success","data":{"task_id":"task a?b","status":"queued"}}`))
		case "/api/v1/comfyui/comfyui_workflow/result/task a?b":
			if r.URL.RawQuery != "" || r.Method != http.MethodGet || r.Header.Get("Authorization") != "test-token" {
				t.Errorf("poll request = %s", r.URL.String())
			}
			_, _ = w.Write([]byte(`{"code":"Success","data":{"task_id":"task a?b","status":"completed","results":[{"type":"video","url":"https://cdn.example/video.mp4","file_type":"mp4","output_type":"output"}]}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client := AutoDLClient{HTTP: server.Client()}
	items, err := client.Workflows(context.Background(), server.URL)
	if err != nil || len(items) != 2 {
		t.Fatalf("workflows = %#v, %v", items, err)
	}
	workflow, err := client.Workflow(context.Background(), server.URL, "video-1")
	if err != nil || workflow.Kind != "video" {
		t.Fatalf("workflow = %#v, %v", workflow, err)
	}
	task, err := client.Task(context.Background(), server.URL, "video-1", "test-token", map[string]any{"duration": 5})
	if err != nil {
		t.Fatal(err)
	}
	task, err = client.Task(context.Background(), server.URL, task.ID, "test-token", nil)
	if err != nil {
		t.Fatal(err)
	}
	uri, mime, err := task.Output("video")
	if err != nil || uri != "https://cdn.example/video.mp4" || mime != "video/mp4" {
		t.Fatalf("output = %q %q %v", uri, mime, err)
	}
}

func TestAutoDLRulesRejectLossyAndUndeclaredInputs(t *testing.T) {
	minimum, maximum := float64(3), float64(15)
	workflow := model.AutoDLWorkflow{UUID: "test", InputRules: map[string]model.AutoDLInputRule{
		"prompt": {Type: "string", Required: true}, "duration": {Type: "integer", Default: float64(5), Min: &minimum, Max: &maximum}, "ref_image_0": {Type: "string"}, "ref_image_2": {Type: "string"}, "seed": {Type: "integer", Default: float64(0)},
	}}
	for _, input := range []map[string]any{
		{"prompt": "go", "seconds": true}, {"prompt": "go", "seconds": 3.5}, {"prompt": "go", "seconds": 20},
		{"prompt": "go", "reference_image_urls": []any{"https://cdn.example/a.png", 4}},
		{"prompt": "go", "reference_image_urls": []string{"http://127.0.0.1/a.png"}},
		{"prompt": "go", "reference_image_urls": []string{"https://cdn.example/a", "https://cdn.example/b", "https://cdn.example/c"}},
		{"prompt": "go", "workflow_inputs": map[string]any{"undeclared": "value"}},
	} {
		if _, err := AutoDLRequest(workflow, input); err == nil {
			t.Fatalf("accepted invalid input %#v", input)
		}
	}
	input := map[string]any{"prompt": "go", "seconds": "8", "reference_image_urls": []string{"https://cdn.example/a", "https://cdn.example/b"}}
	output, err := AutoDLRequest(workflow, input)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"prompt": "go", "duration": float64(8), "ref_image_0": "https://cdn.example/a", "ref_image_2": "https://cdn.example/b", "seed": float64(0)}
	if !reflect.DeepEqual(output, want) {
		t.Fatalf("output = %#v", output)
	}
}

func TestAutoDLRulesHandleCurrentMediaDefaultsAndTextLimits(t *testing.T) {
	maximum := 4
	workflow := model.AutoDLWorkflow{UUID: "current-workflow", InputRules: map[string]model.AutoDLInputRule{
		"prompt":        {Type: "prompt", Required: true, MaxLength: &maximum},
		"ref_image_0":   {Type: "image", Required: true, Default: "default_local_path:<redacted>"},
		"ref_image_1":   {Type: "image", Default: "default_local_path:<redacted>"},
		"ref_audio_0":   {Type: "audio", Default: "default_local_path:<redacted>"},
		"emo_ref_audio": {Type: "audio"},
	}}
	request := map[string]any{"prompt": "画面", "reference_image_urls": []string{"https://cdn.example/ref.png"}}
	output, err := AutoDLRequest(workflow, request)
	if err != nil {
		t.Fatal(err)
	}
	if output["ref_audio_0"] != nil || output["ref_image_1"] != nil {
		t.Fatalf("sent upstream local defaults: %#v", output)
	}
	request["prompt"] = "超过四个字符限制"
	if _, err = AutoDLRequest(workflow, request); err == nil {
		t.Fatal("max_length was not enforced")
	}
	request["prompt"] = "画面"
	request["workflow_inputs"] = map[string]any{"emo_ref_audio": "/api/files/private/content"}
	if _, err = AutoDLRequest(workflow, request); err == nil {
		t.Fatal("audio-typed workflow parameter accepted private URL")
	}
}

func TestAutoDLVideoContractKeepsMultimodalRequirements(t *testing.T) {
	minimum, maximum := float64(4), float64(12)
	workflow := model.AutoDLWorkflow{UUID: "motion-video", Name: "运动视频", InputRules: map[string]model.AutoDLInputRule{
		"duration": {Type: "integer", Default: float64(5), Min: &minimum, Max: &maximum}, "prompt": {Type: "string"}, "first_frame": {Type: "string", Required: true}, "ref_audio": {Type: "string", Required: true},
	}}
	contract, err := AutoDLVideoContract(workflow)
	if err != nil {
		t.Fatal(err)
	}
	if len(contract.Generation.Modes) != 1 || contract.Generation.Modes[0].Kind != "reference" || contract.Capability.References.Image != 1 || contract.Capability.References.Audio != 1 {
		t.Fatalf("contract = %#v", contract)
	}
	output, err := AutoDLRequest(workflow, map[string]any{"prompt": "go", "reference_image_urls": []string{"https://cdn.example/first.png"}, "reference_audio_urls": []string{"https://cdn.example/audio.mp3"}})
	if err != nil || output["first_frame"] != "https://cdn.example/first.png" || output["ref_audio"] != "https://cdn.example/audio.mp3" {
		t.Fatalf("mapped multimodal request = %#v, %v", output, err)
	}
}

func TestAutoDLClientRejectsFailedMalformedAndOversizedMetadata(t *testing.T) {
	for _, body := range []string{`{"code":"Failed","data":{}}`, `{"code":"Success","data":null}`, `{"code":"Success","data":{"list":null}}`, strings.Repeat("x", 4<<20+1)} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		_, err := (AutoDLClient{HTTP: server.Client()}).Workflows(context.Background(), server.URL)
		server.Close()
		if err == nil {
			t.Fatal("invalid metadata accepted")
		}
	}
}
