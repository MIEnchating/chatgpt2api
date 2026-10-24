package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestVideoContractInputRejectsInvalidDurationWithoutDefaulting(t *testing.T) {
	contract := dramayaVideoContract(t)
	contract.ModelProfiles = nil
	contract.Capability.Seconds = nil
	contract.Capability.SecondsRange = &protocol.VideoDurationRange{Min: 1, Step: 1}
	for _, value := range []any{1.5, "1.5", "invalid", nil, true, []any{5}, map[string]any{"seconds": 5}} {
		t.Run(fmt.Sprintf("%T-%v", value, value), func(t *testing.T) {
			body := map[string]any{"prompt": "Animate", "seconds": value}
			if err := normalizeVideoContractInput(body, contract); err == nil {
				t.Fatalf("invalid duration %v was silently changed to %v", value, body["seconds"])
			}
		})
	}
	body := map[string]any{"prompt": "Animate"}
	if err := normalizeVideoContractInput(body, contract); err != nil || body["seconds"] != contract.Capability.DefaultSeconds {
		t.Fatalf("omitted duration did not use the default: %#v, %v", body, err)
	}
}

func TestVideoExtendedParametersReachOutboundAndTaskMetadata(t *testing.T) {
	c := dramayaVideoContract(t)
	c.ModelProfiles = nil
	c.Capability.AudioControl, c.Capability.Watermark = "none", false
	c.Request.GenerateAudioField, c.Request.WatermarkField = "audio", "aigc_watermark"
	c.Capability.Parameters = []protocol.VideoModelParameter{
		{Name: "seed", Label: "Seed", Field: "settings.seed", Type: "integer"},
		{Name: "prompt_enhance", Label: "Enhance", Field: "prompt_enhance", Type: "boolean"},
		{Name: "prompt_expansion_mode", Label: "Mode", Field: "prompt_expansion_mode", Type: "string", Required: true, Enum: []string{"balanced", "quality"}},
	}
	body := map[string]any{"model": c.Models[0], "prompt": "Animate", "parameters": map[string]any{"seed": 0, "prompt_enhance": false, "prompt_expansion_mode": "quality"}}
	if err := normalizeVideoContractInput(body, c); err != nil {
		t.Fatal(err)
	}
	request := declaredCanonicalVideoContractRequestPayload(body, c)
	if videoJSONPathValue(request, "settings.seed") != 0 || request["prompt_enhance"] != false || request["prompt_expansion_mode"] != "quality" {
		t.Fatalf("parameters lost: %#v", request)
	}
	for _, key := range []string{"audio", "aigc_watermark", "parameters"} {
		if _, ok := request[key]; ok {
			t.Fatalf("unexpected field %s", key)
		}
	}
	if len(videoTaskRequestMetadata(body, c)["parameters"].(map[string]any)) != 3 {
		t.Fatal("task metadata lost parameters")
	}
	delete(body, "parameters")
	if err := normalizeVideoContractInput(body, c); err == nil {
		t.Fatal("missing required parameter accepted")
	}
}

func TestVideoNamedMultipartFilesStaySeparate(t *testing.T) {
	request, err := relayVideoMultipartRequest(context.Background(), "https://video.invalid", "key", "/videos", map[string]any{"prompt": "sample"}, "", []videoMultipartFile{
		{Field: "image_url", Filename: "first.png", ContentType: "image/png", Data: []byte("first")},
		{Field: "end_image_url", Filename: "last.png", ContentType: "image/png", Data: []byte("last")},
		{Field: "reference_videos", Filename: "ref.mp4", ContentType: "video/mp4", Data: []byte("video")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := request.ParseMultipartForm(1024); err != nil {
		t.Fatal(err)
	}
	defer request.MultipartForm.RemoveAll()
	for field, want := range map[string]string{"image_url": "first", "end_image_url": "last", "reference_videos": "video"} {
		files := request.MultipartForm.File[field]
		if len(files) != 1 {
			t.Fatalf("missing file %s", field)
		}
		file, err := files[0].Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(file)
		file.Close()
		if string(data) != want {
			t.Fatalf("wrong route %s", field)
		}
	}
}

func TestVideoSourceReviewDetectsMissingModelAndRequiredField(t *testing.T) {
	c := dramayaVideoContract(t)
	c.ModelProfiles = nil
	c.Models = []string{"MiniMax H3 Max"}
	source := `{"model_type":"video","endpoints":[{"method":"POST","forms":[{"template_id":"max_text_to_video","parameters":{"required":["prompt","prompt_expansion_mode"]},"example":{"model":"MiniMax H3 Max"}}]}]}`
	issues, err := reviewVideoSourceRequirements(source, []protocol.VideoModelContract{c})
	if err != nil || len(issues[c.Models[0]]) != 1 {
		t.Fatalf("missing requirement not detected: %#v %v", issues, err)
	}
	c.Capability.Parameters = []protocol.VideoModelParameter{{Name: "prompt_expansion_mode", Label: "Expansion", Field: "prompt_expansion_mode", Type: "string", Required: true, Enum: []string{"balanced", "quality"}}}
	issues, err = reviewVideoSourceRequirements(source, []protocol.VideoModelContract{c})
	if err != nil || len(issues[c.Models[0]]) != 0 {
		t.Fatalf("mapped requirement rejected: %#v %v", issues, err)
	}
	if _, err = reviewVideoSourceRequirements(source+strings.ReplaceAll(source, "MiniMax H3 Max", "missing-model"), []protocol.VideoModelContract{c}); err == nil {
		t.Fatal("missing model accepted")
	}
	output, _ := json.Marshal(map[string]any{"contracts": []protocol.VideoModelContract{c}, "evidence": []map[string]any{{"model": c.Models[0], "endpoints_quote": "", "parameters_quote": "", "polling_quote": "", "download_quote": "", "review_issues": []string{}, "limitations": []string{"Optional callback is not configured"}, "notes": []string{"Poll every 5 seconds"}}}})
	result, err := reviewGeneratedVideoContracts(string(output), source)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.DryRun[0].ReviewIssues) != 0 || len(result.DryRun[0].Notes) != 1 || len(result.DryRun[0].Limitations) != 1 {
		t.Fatal("review categories collapsed")
	}
}
