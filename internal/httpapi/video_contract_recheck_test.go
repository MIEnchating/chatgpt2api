package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func TestVideoContractPreviewUsesSubmissionDefaultsAndRules(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	for _, driver := range []string{protocol.VideoContractDriverOpenAI, protocol.VideoContractDriverArk} {
		t.Run(driver, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Name, contract.Models = "Preview rules", []string{"preview-rules"}
			contract.Driver = driver
			contract.Request.GenerateAudioField = "generate_audio"
			contract.Rules = []protocol.VideoModelContractRule{
				{When: protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "8"}, ForceValues: map[string]string{"watermark": "true"}, Message: "must not apply twice"},
				{When: protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "5"}, ForceValues: map[string]string{"duration": "8"}, Message: "default duration becomes eight"},
			}
			body, _ := json.Marshal(map[string]any{"contract": contract, "input": map[string]any{"model": "preview-rules", "prompt": "boat"}})
			req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/preview", bytes.NewReader(body))
			setRequestAuthCookie(req, adminSessionToken(t, app))
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusOK {
				t.Fatalf("preview = %d %s", res.Code, res.Body.String())
			}
			var result map[string]any
			_ = json.Unmarshal(res.Body.Bytes(), &result)
			outbound := util.StringMap(util.StringMap(result["request"])["body"])
			if util.ToInt(outbound["duration"], 0) != 8 || outbound["generate_audio"] != true {
				t.Fatalf("preview did not use submission defaults/rules: %#v", outbound)
			}
			watermarkField := contract.Request.WatermarkField
			if driver == protocol.VideoContractDriverArk {
				watermarkField = "watermark"
			}
			if outbound[watermarkField] != false {
				t.Fatalf("preview reapplied forced values: %#v", outbound)
			}
		})
	}
}

func TestVideoContractPreviewRejectsInvalidSubmissionInput(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name, contract.Models = "Preview validation", []string{"preview-validation"}
	for _, input := range []map[string]any{
		{"generation_mode": "nonexistent"},
		{"seconds": 3600},
		{"last_frame_url": "https://media.example/last.png"},
	} {
		input["model"], input["prompt"] = contract.Models[0], "boat"
		body, _ := json.Marshal(map[string]any{"contract": contract, "input": input})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/preview", bytes.NewReader(body))
		setRequestAuthCookie(req, adminSessionToken(t, app))
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("invalid preview input %#v accepted: %d %s", input, res.Code, res.Body.String())
		}
	}
}

func TestVideoContractMultipartKeepsAllReferencesOnReusedModePath(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Request.FirstFrameField = "images"
	contract.Request.ReferenceImagesField = "images"
	if _, err := protocol.NormalizeVideoModelContract(contract); err != nil {
		t.Fatal(err)
	}
	request := declaredVideoContractRequestPayload(map[string]any{
		"model": contract.Models[0], "prompt": "boat", "reference_mode": "reference",
		"reference_image_urls": []string{"https://media.example/one.png", "https://media.example/two.png"},
	}, contract)
	_, _, err := app.extractContractLocalVideoMaterials(request, contract, "reference")
	if err != nil {
		t.Fatal(err)
	}
	if len(util.AsStringSlice(request["images"])) != 2 {
		t.Fatalf("reference list was truncated by inactive frame mapping: %#v", request)
	}
	for _, driver := range []string{protocol.VideoContractDriverArk, protocol.VideoContractDriverVolcengine} {
		contract.Driver = driver
		payload := map[string]any{
			"model": contract.Models[0], "prompt": "boat", "reference_mode": "reference",
			"reference_image_urls": []string{"https://media.example/one.png", "https://media.example/two.png"},
		}
		var outbound map[string]any
		if driver == protocol.VideoContractDriverArk {
			outbound, err = arkVideoRequest(payload, contract)
		} else {
			outbound, err = newAPIDoubaoVideoRequest(declaredCanonicalVideoContractRequestPayload(payload, contract), payload, contract)
		}
		if err != nil {
			t.Fatalf("%s interpreted ordinary references as frames: %v", driver, err)
		}
		content := util.AsMapSlice(outbound["content"])
		if driver == protocol.VideoContractDriverVolcengine {
			content = util.AsMapSlice(videoJSONPathValue(outbound, "metadata.content"))
		} else {
			content = content[1:]
		}
		if len(content) != 2 || content[0]["role"] != "reference_image" || content[1]["role"] != "reference_image" {
			t.Fatalf("%s lost references: %#v", driver, outbound)
		}
	}
}
