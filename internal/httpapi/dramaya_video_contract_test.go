package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func dramayaVideoContract(t *testing.T) protocol.VideoModelContract {
	t.Helper()
	data, err := os.ReadFile("../../docs/examples/dramaya-grok-video-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var document videoModelContractTransferDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	contract, err := protocol.NormalizeVideoModelContract(document.Contracts[0].Contract)
	if err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestDramayaVideoProfilesPreviewMatchesRuntimeValidation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	contract := dramayaVideoContract(t)
	created, err := app.videoContracts.Create(contract, true)
	if err != nil {
		t.Fatal(err)
	}
	token := adminSessionToken(t, app)
	for _, test := range []struct {
		name, model string
		input       map[string]any
		valid       bool
	}{
		{"base defaults", "grok-imagine-video", map[string]any{}, true},
		{"base 1080p rejected", "grok-imagine-video", map[string]any{"resolution": "1080p"}, false},
		{"base image rejected", "grok-imagine-video", map[string]any{"reference_image_urls": []string{"https://media.example/image.png"}}, false},
		{"enhanced 1080p image", "grok-imagine-video-1.5", map[string]any{"resolution": "1080p", "reference_mode": "reference", "reference_image_urls": []string{"https://media.example/image.png"}}, true},
		{"too many images", "grok-imagine-video-1.5", map[string]any{"reference_mode": "reference", "reference_image_urls": []string{"https://media.example/1.png", "https://media.example/2.png"}}, false},
		{"unsupported video", "grok-imagine-video-1.5", map[string]any{"reference_video_urls": []string{"https://media.example/video.mp4"}}, false},
		{"duration out of range", "grok-imagine-video-1.5", map[string]any{"seconds": 16}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.input["model"] = test.model
			test.input["prompt"] = "Animate a boat"
			body, _ := json.Marshal(map[string]any{"contract": contract, "existing_id": created.ID, "input": test.input, "submit_response": map[string]any{"id": "video_task_example", "status": "queued"}, "query_response": map[string]any{"status": "running", "progress": 25}})
			req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/preview", bytes.NewReader(body))
			setRequestAuthCookie(req, token)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, req)
			if (response.Code == http.StatusOK) != test.valid {
				t.Fatalf("preview = %d %s", response.Code, response.Body.String())
			}
			effective, _ := protocol.VideoContractForModel(test.model)
			err := normalizeVideoContractInput(test.input, effective)
			if (err == nil) != test.valid {
				t.Fatalf("runtime validation = %v", err)
			}
			if !test.valid {
				return
			}
			var preview map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &preview); err != nil {
				t.Fatal(err)
			}
			runtime := declaredCanonicalVideoContractRequestPayload(test.input, effective)
			data, _ := json.Marshal(runtime)
			var decoded map[string]any
			_ = json.Unmarshal(data, &decoded)
			if !reflect.DeepEqual(util.StringMap(util.StringMap(preview["request"])["body"]), decoded) {
				t.Fatalf("preview differs from runtime: %#v", preview)
			}
			if runtime["duration"] != 8 || runtime["aspect_ratio"] != "16:9" {
				t.Fatalf("wrong public defaults: %#v", runtime)
			}
			for _, key := range []string{"seconds", "generate_audio", "watermark", "generation_mode", "reference_image_urls"} {
				if _, ok := runtime[key]; ok {
					t.Fatalf("undeclared field: %s", key)
				}
			}
			if test.name == "enhanced 1080p image" && len(util.AsStringSlice(runtime["image_urls"])) != 1 {
				t.Fatal("reference image missing from public request")
			}
			reference, err := app.videoContracts.ReferenceForContract(effective, test.model)
			if err != nil || reference["id"] != created.ID || reference["revision"] != 1 {
				t.Fatalf("profile lost published revision: %#v %v", reference, err)
			}
		})
	}
}

func TestDramayaVideoProfileStatusMapping(t *testing.T) {
	contract := dramayaVideoContract(t)
	for _, status := range []string{"running", "in_progress", "processing", "pending", "cancel_requested"} {
		if got := videoRelayTaskStatusForContract(map[string]any{"status": status}, contract); got != "in_progress" {
			t.Fatalf("%s became %s", status, got)
		}
	}
	for _, status := range []string{"failed", "cancelled", "expired"} {
		if got := videoRelayTaskStatusForContract(map[string]any{"status": status}, contract); got != "failed" {
			t.Fatalf("%s became %s", status, got)
		}
	}
}

func TestGeneratedDramayaContractPreservesModelProfiles(t *testing.T) {
	contract := dramayaVideoContract(t)
	data, err := json.Marshal(contract)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	profiles := raw["model_profiles"].([]any)
	profiles[1].(map[string]any)["rules"] = []any{map[string]any{
		"when":         map[string]any{"field": "resolution", "operator": "equals", "value": "1080p"},
		"limits":       []any{map[string]any{"field": "reference_image", "max": 1}},
		"force_values": []any{map[string]any{"field": "duration", "value": "8"}},
		"message":      "1080p uses eight seconds",
	}}
	data, _ = json.Marshal(raw)
	normalized, err := normalizeGeneratedVideoContractRuleMaps(data)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := decodeGeneratedVideoModelContractJSON(normalized)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.ModelProfiles) != 2 || parsed.ModelProfiles[1].Rules[0].Limits["reference_image"] != 1 || parsed.ModelProfiles[1].Rules[0].ForceValues["duration"] != "8" {
		t.Fatalf("profile rules lost: %#v", parsed.ModelProfiles)
	}
	if len(parsed.ModelProfiles[0].Rules) != 0 {
		t.Fatal("model rules leaked")
	}
}
