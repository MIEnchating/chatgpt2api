package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestVideoContractRuleValuesCountCanonicalMaterials(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	for _, test := range []struct {
		name    string
		payload map[string]any
		field   string
	}{
		{"video", map[string]any{"reference_video_urls": []string{"https://example.com/video.mp4"}}, "reference_video"},
		{"image frame", map[string]any{"reference_image_urls": []string{"https://example.com/first.png"}}, "first_frame"},
		{"explicit frame alias", map[string]any{"first_frame_url": "https://example.com/first.png", "reference_image_urls": []string{"https://example.com/first.png"}}, "first_frame"},
	} {
		t.Run(test.name, func(t *testing.T) {
			contract.Rules = []protocol.VideoModelContractRule{{
				When:        protocol.VideoModelContractRuleCondition{Field: test.field, Operator: "equals", Value: "1"},
				ForceValues: map[string]string{"duration": "8"}, Message: "one material fixes duration",
			}}
			test.payload["seconds"] = 5
			values := videoContractRuleValues(test.payload, contract)
			if values[test.field] != 1 || values["reference_image"] != 0 {
				t.Fatalf("canonical counts = %#v", values)
			}
			protocol.ApplyVideoContractForcedValues(contract, values)
			if values["duration"] != 8 {
				t.Fatalf("effective duration = %#v", values["duration"])
			}
			request := declaredVideoContractRequestPayload(test.payload, contract)
			if request[contract.Request.DurationField] != 8 {
				t.Fatalf("outbound duration = %#v", request[contract.Request.DurationField])
			}
		})
	}
}

func TestVideoCreationValidatesDefaultParametersAndCanonicalMaterialCounts(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Canonical defaults"
	contract.Models = []string{"canonical-defaults-video"}
	contract.Rules = []protocol.VideoModelContractRule{
		{When: protocol.VideoModelContractRuleCondition{Field: "resolution", Operator: "equals", Value: contract.Capability.DefaultResolution}, Require: []string{"generate_audio"}, Message: "default resolution requires audio"},
		{When: protocol.VideoModelContractRuleCondition{Field: "first_frame", Operator: "equals", Value: "1"}, ForceValues: map[string]string{"duration": "8"}, Message: "one frame fixes duration"},
		{When: protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "8"}, Require: []string{"first_frame"}, Message: "fixed duration requires frame"},
	}
	if _, err := app.videoContracts.Create(contract, true); err != nil {
		t.Fatal(err)
	}
	if _, err := app.config.Update(map[string]any{"video_models": contract.Models}); err != nil {
		t.Fatal(err)
	}
	received := make(chan map[string]any, 1)
	app.tasks.SetVideoHandler(func(_ context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
		received <- payload
		return map[string]any{"data": []any{}}, nil
	})
	token := adminSessionToken(t, app)
	request := func(path string, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(req, token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		return response
	}
	response := request("/api/profile/custom-relay-configs", map[string]any{
		"kind": "video", "name": "Test video key", "base_url": "https://relay.example", "api_key": "test-only",
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("create relay: %d %s", response.Code, response.Body.String())
	}
	var config map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	response = request("/api/creation-tasks/video-generations", map[string]any{
		"model": contract.Models[0], "prompt": "Animate a boat", "client_task_id": "canonical-defaults",
		"reference_image_urls": []string{"https://media.example/first.png"},
		"token_name":           util.StringMap(config["item"])["token_name"],
	})
	if response.Code != http.StatusOK {
		t.Fatalf("submit: %d %s", response.Code, response.Body.String())
	}
	select {
	case payload := <-received:
		if util.ToInt(payload["seconds"], 0) != 8 || !util.ToBool(payload["generate_audio"]) || payload["resolution"] != contract.Capability.DefaultResolution {
			t.Fatalf("canonical payload = %#v", payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("video was not dispatched")
	}
}
