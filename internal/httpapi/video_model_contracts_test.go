package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

type videoContractImportTestFlusher struct {
	flushed chan<- struct{}
}

func (f videoContractImportTestFlusher) Flush() {
	select {
	case f.flushed <- struct{}{}:
	default:
	}
}

func TestAdminVideoModelContractLifecycle(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	token := adminSessionToken(t, app)
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Custom video v1"
	contract.Models = []string{"custom/video-v1"}

	request := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var reader *bytes.Reader
		if body == nil {
			reader = bytes.NewReader(nil)
		} else {
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal request body: %v", err)
			}
			reader = bytes.NewReader(data)
		}
		req := httptest.NewRequest(method, path, reader)
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	res := request(http.MethodPost, "/api/admin/video-model-contracts/validate", map[string]any{"contract": contract, "enabled": true})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"valid":true`) {
		t.Fatalf("validate status = %d body = %s", res.Code, res.Body.String())
	}
	res = request(http.MethodPost, "/api/admin/video-model-contracts", map[string]any{"contract": contract, "enabled": true})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Custom video v1"`) {
		t.Fatalf("create status = %d body = %s", res.Code, res.Body.String())
	}
	var created struct {
		Item struct {
			ID string `json:"id"`
		} `json:"item"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil || created.Item.ID == "" {
		t.Fatalf("decode created contract: %#v, error = %v", created, err)
	}
	res = request(http.MethodGet, "/api/model-config", nil)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"custom/video-v1"`) || !strings.Contains(res.Body.String(), `"video_model_contracts"`) {
		t.Fatalf("model config status = %d body = %s", res.Code, res.Body.String())
	}
	var modelConfig struct {
		Config struct {
			VideoModels []string `json:"video_models"`
		} `json:"config"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &modelConfig); err != nil {
		t.Fatalf("decode model config: %v", err)
	}
	for _, model := range modelConfig.Config.VideoModels {
		if model == "custom/video-v1" {
			t.Fatal("contract model alias leaked into configured video models")
		}
	}
	path := "/api/admin/video-model-contracts/" + created.Item.ID
	res = request(http.MethodPatch, path, map[string]any{"contract": map[string]any{}, "enabled": false})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"enabled":false`) {
		t.Fatalf("disable status = %d body = %s", res.Code, res.Body.String())
	}
	if _, ok := protocol.VideoContractForModel("custom/video-v1"); ok {
		t.Fatal("disabled API contract remained active")
	}
	res = request(http.MethodDelete, path, nil)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), `"Custom video v1"`) {
		t.Fatalf("delete status = %d body = %s", res.Code, res.Body.String())
	}

	contract.Name = "Invalid driver"
	contract.Models = []string{"custom/invalid"}
	contract.Driver = "javascript"
	res = request(http.MethodPost, "/api/admin/video-model-contracts", map[string]any{"contract": contract, "enabled": true})
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "openai-videos") {
		t.Fatalf("invalid driver status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestAdminVideoModelContractJSONImport(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	token := adminSessionToken(t, app)
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Imported video contract"
	contract.Models = []string{"imported/video-v1"}
	body, _ := json.Marshal(map[string]any{
		"version":   4,
		"contracts": []any{map[string]any{"contract": contract, "enabled": true}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/import-json", bytes.NewReader(body))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"imported":1`) || !strings.Contains(res.Body.String(), `"created":1`) {
		t.Fatalf("import status = %d body = %s", res.Code, res.Body.String())
	}
	if _, ok := protocol.VideoContractForModel("imported/video-v1"); !ok {
		t.Fatal("imported API contract was not installed")
	}

	body = []byte(`{"version":4,"contracts":[],"unexpected":true}`)
	req = httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/import-json", bytes.NewReader(body))
	setRequestAuthCookie(req, token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unknown import field status = %d body = %s", res.Code, res.Body.String())
	}

	for _, version := range []int{1, 2} {
		body, _ = json.Marshal(map[string]any{"version": version, "contracts": []any{}})
		req = httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/import-json", bytes.NewReader(body))
		setRequestAuthCookie(req, token)
		res = httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "不支持的契约导入版本") {
			t.Fatalf("legacy import version %d status = %d body = %s", version, res.Code, res.Body.String())
		}
	}
}

func TestAdminVideoModelContractPreviewBuildsRequestAndParsesResponses(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	items, err := app.videoContracts.List()
	if err != nil || len(items) == 0 {
		t.Fatalf("List() = %#v, error = %v", items, err)
	}
	contract := items[0].Contract
	body, _ := json.Marshal(map[string]any{
		"contract":    contract,
		"existing_id": items[0].ID,
		"input": map[string]any{
			"model": contract.Models[0], "prompt": "preview", "seconds": contract.Capability.DefaultSeconds,
			"size": contract.Capability.DefaultSize, "resolution": contract.Capability.DefaultResolution,
		},
		"submit_response": map[string]any{"id": "task-123"},
		"query_response":  map[string]any{"status": "completed", "progress": "100%", "video_url": "https://cdn.example.com/video.mp4"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/preview", bytes.NewReader(body))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"create_path":"/v1/videos"`) || !strings.Contains(res.Body.String(), `"task_id":"task-123"`) || !strings.Contains(res.Body.String(), `"status":"completed"`) {
		t.Fatalf("preview status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestVideoContractDocumentImportPromptUsesCurrentSchema(t *testing.T) {
	for _, requirement := range []string{
		"按真实协议差异拆分", "完整模型 ID", "只声明文档有证据支持的能力",
		"custom-video", "generation.selection 固定为 infer", "polling", "artifact.mode",
		"严格按以下互斥矩阵", "image 的 first_frame.max 必须为 1", "reference 的 first_frame、last_frame 全部为 0",
		"不可信资料", "只返回 Schema 要求的 JSON 对象",
	} {
		if !strings.Contains(videoContractImportSystemPrompt, requirement) {
			t.Errorf("document import prompt is missing requirement %q", requirement)
		}
	}
	if strings.Contains(videoContractImportSystemPrompt, `{"contracts"`) || len(videoContractImportSystemPrompt) >= 8_000 {
		t.Fatal("document import prompt still embeds a verbose contract example")
	}
	format := videoContractImportResponseFormat()
	jsonSchema, ok := format["json_schema"].(map[string]any)
	if !ok {
		t.Fatalf("document import JSON Schema wrapper is invalid: %#v", format)
	}
	if format["type"] != "json_schema" || !util.ToBool(jsonSchema["strict"]) {
		t.Fatalf("document import response format is not strict JSON Schema: %#v", format)
	}
	encoded, err := json.Marshal(jsonSchema["schema"])
	if err != nil {
		t.Fatalf("marshal document import schema: %v", err)
	}
	if len(encoded) >= 16_000 || !bytes.Contains(encoded, []byte(`"$ref":"#/$defs/`)) {
		t.Fatalf("document import schema is not compact enough for prompt caching: %d bytes", len(encoded))
	}
	for _, field := range []string{
		`"create_path"`, `"query_path"`, `"artifact"`, `"content_path"`,
		`"allowed_hosts"`, `"generation"`, `"rules"`, `"validation"`,
		`"queued_statuses"`, `"processing_statuses"`, `"progress_fields"`, `"generation_mode_field"`,
		`"when"`, `"require"`, `"require_any"`, `"forbid"`, `"limits"`,
		`"force_values"`, `"ui"`, `"show"`, `"hide"`, `"disable"`, `"message"`,
	} {
		if !bytes.Contains(encoded, []byte(field)) {
			t.Errorf("document import JSON Schema is missing current contract field %q", field)
		}
	}
}

func TestNormalizeGeneratedVideoContractRuleMaps(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Rules = []protocol.VideoModelContractRule{{
		When:        protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "5"},
		Require:     []string{},
		RequireAny:  []string{},
		Forbid:      []string{},
		Limits:      map[string]int{"reference_image": 2},
		ForceValues: map[string]string{"watermark": "false"},
		UI:          protocol.VideoModelContractRuleUI{Show: []string{}, Hide: []string{}, Disable: []string{}},
		Message:     "测试条件规则",
	}}
	data, err := json.Marshal(contract)
	if err != nil {
		t.Fatalf("marshal contract: %v", err)
	}
	var generated map[string]any
	if err := json.Unmarshal(data, &generated); err != nil {
		t.Fatalf("decode generated contract: %v", err)
	}
	rules := generated["rules"].([]any)
	rule := rules[0].(map[string]any)
	rule["limits"] = []any{map[string]any{"field": "reference_image", "max": 2}}
	rule["force_values"] = []any{map[string]any{"field": "watermark", "value": "false"}}
	generatedData, _ := json.Marshal(generated)
	normalized, err := normalizeGeneratedVideoContractRuleMaps(generatedData)
	if err != nil {
		t.Fatalf("normalize generated rule maps: %v", err)
	}
	decoded, err := decodeGeneratedVideoModelContractJSON(normalized)
	if err != nil {
		t.Fatalf("decode normalized contract: %v", err)
	}
	if decoded.Rules[0].Limits["reference_image"] != 2 || decoded.Rules[0].ForceValues["watermark"] != "false" {
		t.Fatalf("normalized rule maps = %#v", decoded.Rules[0])
	}

	rule["limits"] = []any{
		map[string]any{"field": "reference_image", "max": 2},
		map[string]any{"field": "reference_image", "max": 3},
	}
	duplicateData, _ := json.Marshal(generated)
	if _, err := normalizeGeneratedVideoContractRuleMaps(duplicateData); err == nil || !strings.Contains(err.Error(), "重复") {
		t.Fatalf("duplicate generated rule field error = %v", err)
	}
}

func TestExtractVideoContractDocuments(t *testing.T) {
	htmlText, err := extractVideoContractDocument([]byte(`<html><head><style>hidden</style></head><body><h1>Video API</h1><script>ignore()</script><p>duration: 5</p></body></html>`), "docs.html", "text/html")
	if err != nil || !strings.Contains(htmlText, "Video API") || !strings.Contains(htmlText, "duration: 5") || strings.Contains(htmlText, "hidden") || strings.Contains(htmlText, "ignore") {
		t.Fatalf("HTML text = %q, err = %v", htmlText, err)
	}

	var document bytes.Buffer
	archive := zip.NewWriter(&document)
	entry, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatalf("create DOCX entry: %v", err)
	}
	_, _ = entry.Write([]byte(`<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>MiniMax H3</w:t></w:r></w:p><w:p><w:r><w:t>duration</w:t></w:r></w:p></w:body></w:document>`))
	if err := archive.Close(); err != nil {
		t.Fatalf("close DOCX: %v", err)
	}
	docxText, err := extractVideoContractDocument(document.Bytes(), "docs.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	if err != nil || !strings.Contains(docxText, "MiniMax H3") || !strings.Contains(docxText, "duration") {
		t.Fatalf("DOCX text = %q, err = %v", docxText, err)
	}

	if _, err := extractVideoContractDocument([]byte("pdf"), "docs.pdf", "application/pdf"); err == nil || !strings.Contains(err.Error(), "暂不支持 PDF") {
		t.Fatalf("PDF error = %v", err)
	}
}

func TestDecodeGeneratedVideoModelContractsIsStrict(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Document video v1"
	contract.Models = []string{"document/video-v1"}
	data, err := json.Marshal(contract)
	if err != nil {
		t.Fatalf("marshal contract: %v", err)
	}
	bundle := `{"contracts":[` + string(data) + `]}`
	decoded, err := decodeGeneratedVideoModelContracts("```json\n"+bundle+"\n```", "model: document/video-v1")
	if err != nil || len(decoded) != 1 || decoded[0].Name != contract.Name {
		t.Fatalf("decoded = %#v, err = %v", decoded, err)
	}
	var mixedMaterialsContract protocol.VideoModelContract
	if err := json.Unmarshal(data, &mixedMaterialsContract); err != nil {
		t.Fatalf("decode mixed-material fixture: %v", err)
	}
	foundImageMode := false
	foundReferenceMode := false
	for index := range mixedMaterialsContract.Generation.Modes {
		mode := &mixedMaterialsContract.Generation.Modes[index]
		switch mode.Kind {
		case "image":
			foundImageMode = true
			mode.Materials.Image = protocol.VideoModelMaterialRange{Max: 4}
			mode.Materials.Video = protocol.VideoModelMaterialRange{Max: 2}
			mode.Materials.Audio = protocol.VideoModelMaterialRange{Max: 1}
			mode.Materials.Total = protocol.VideoModelMaterialRange{Max: 7}
		case "reference":
			foundReferenceMode = true
			mode.Materials.FirstFrame = protocol.VideoModelMaterialRange{Min: 1, Max: 1}
			mode.Materials.LastFrame = protocol.VideoModelMaterialRange{Max: 1}
		}
	}
	if !foundImageMode || !foundReferenceMode {
		t.Fatal("default contract must exercise image and reference material normalization")
	}
	mixedData, _ := json.Marshal(mixedMaterialsContract)
	normalizedMixed, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(mixedData)+`]}`, "model: document/video-v1")
	if err != nil || len(normalizedMixed) != 1 {
		t.Fatalf("mixed mode materials were not normalized: %#v, %v", normalizedMixed, err)
	}
	for _, mode := range normalizedMixed[0].Generation.Modes {
		if mode.Kind == "image" && mode.Materials.Image.Max+mode.Materials.Video.Max+mode.Materials.Audio.Max != 0 {
			t.Fatalf("image mode retained ordinary reference materials: %#v", mode.Materials)
		}
		if mode.Kind == "reference" && mode.Materials.FirstFrame.Max+mode.Materials.LastFrame.Max != 0 {
			t.Fatalf("reference mode retained frame materials: %#v", mode.Materials)
		}
	}
	withUnknown := strings.TrimSuffix(string(data), "}") + `,"unexpected":true}`
	if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+withUnknown+`]}`, "document/video-v1"); err == nil || !strings.Contains(err.Error(), `未知字段 "unexpected"`) {
		t.Fatalf("unknown contract field error = %v", err)
	}
	if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`],"unexpected":true}`, "document/video-v1"); err == nil {
		t.Fatal("unknown bundle field was accepted")
	}
	if _, err := decodeGeneratedVideoModelContracts(bundle, "different-video-model"); err == nil || !strings.Contains(err.Error(), "未在原始文档中出现") {
		t.Fatalf("invented model error = %v", err)
	}
	if _, err := decodeGeneratedVideoModelContracts(bundle, "model: document/video-v10"); err == nil || !strings.Contains(err.Error(), "未在原始文档中出现") {
		t.Fatalf("partial model identifier error = %v", err)
	}
	wrongPriorityType := strings.Replace(string(data), `"priority":0`, `"priority":"high"`, 1)
	if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+wrongPriorityType+`]}`, "document/video-v1"); err == nil || !strings.Contains(err.Error(), `字段 "priority" 类型错误`) {
		t.Fatalf("contract field type error = %v", err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(data, &legacy); err != nil {
		t.Fatalf("decode contract for legacy fixture: %v", err)
	}
	for _, field := range []string{
		"name", "models", "priority", "driver", "transport", "artifact",
		"capability", "validation", "generation", "rules", "request", "polling",
	} {
		withoutField := maps.Clone(legacy)
		delete(withoutField, field)
		legacyData, _ := json.Marshal(withoutField)
		if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(legacyData)+`]}`, "document/video-v1"); err == nil || !strings.Contains(err.Error(), field) {
			t.Fatalf("generated contract without %s was accepted: %v", field, err)
		}
	}
	second := contract
	second.Name = "Document video v2"
	second.Models = []string{"document/video-v2"}
	secondData, _ := json.Marshal(second)
	multiple, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`,`+string(secondData)+`]}`, "document/video-v1 document/video-v2")
	if err != nil || len(multiple) != 1 || !slices.Equal(multiple[0].Models, []string{"document/video-v1", "document/video-v2"}) {
		t.Fatalf("equivalent contracts = %#v, error = %v", multiple, err)
	}

	different := second
	different.Name = "Document video v3"
	different.Models = []string{"document/video-v3"}
	different.Priority++
	differentData, _ := json.Marshal(different)
	multiple, err = decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`,`+string(secondData)+`,`+string(differentData)+`]}`, "document/video-v1 document/video-v2 document/video-v3")
	if err != nil || len(multiple) != 2 || !slices.Equal(multiple[0].Models, []string{"document/video-v1", "document/video-v2"}) || !slices.Equal(multiple[1].Models, []string{"document/video-v3"}) {
		t.Fatalf("different contracts = %#v, error = %v", multiple, err)
	}
}

func TestAdminVideoModelContractImportStreamsUnsavedDraftProgress(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, testAdminUsername, "admin@example.test")
	insertHTTPTestNewAPIToken(t, dbURL, 1, 1, "text", "contract-import-token", -1, 0, true)
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	app.swapRelayTokenReader(reader)

	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Document video v1"
	contract.Models = []string{"document/video-v1"}
	contractJSON, _ := json.Marshal(contract)
	contractBundleJSON := []byte(`{"contracts":[` + string(contractJSON) + `]}`)
	invalidContract := contract
	invalidContract.Request.DurationField = ""
	invalidContractJSON, _ := json.Marshal(invalidContract)
	invalidContractBundleJSON := []byte(`{"contracts":[` + string(invalidContractJSON) + `]}`)
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode upstream request: %v", err)
		}
		if !strings.Contains(util.Clean(util.AsMapSlice(payload["messages"])[1]["content"]), "PRIVATE_DOC_MARKER") {
			t.Errorf("document content missing from analysis payload: %#v", payload["messages"])
		}
		responseFormat, _ := payload["response_format"].(map[string]any)
		jsonSchema, _ := responseFormat["json_schema"].(map[string]any)
		if !util.ToBool(payload["stream"]) || responseFormat["type"] != "json_schema" || !util.ToBool(jsonSchema["strict"]) || util.Clean(payload["reasoning_effort"]) != "low" {
			t.Errorf("document analysis requires strict structured low-reasoning streaming: %#v", payload)
		}
		requestCount++
		responseContent := string(contractBundleJSON)
		switch requestCount {
		case 1:
			util.WriteError(w, 524, "The origin web server did not respond to Cloudflare within the allowed time.")
			return
		case 2:
			responseContent = string(invalidContractBundleJSON)
		case 3:
			messages := util.AsMapSlice(payload["messages"])
			if len(messages) != 3 || !strings.Contains(util.Clean(messages[len(messages)-1]["content"]), "request.duration_field") {
				t.Errorf("request mapping feedback missing from retry: %#v", messages)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		encoded, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": responseContent}}},
		})
		_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{
		"relay_base_url":     upstream.URL,
		"text_models":        []string{"gpt-5-contract-parser"},
		"default_text_model": "gpt-5-contract-parser",
	}); err != nil {
		t.Fatalf("configure import relay: %v", err)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("source_type", "file")
	_ = writer.WriteField("model", "gpt-5-contract-parser")
	file, err := writer.CreateFormFile("file", "video-api.md")
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	_, _ = file.Write([]byte("# PRIVATE_DOC_MARKER\nmodel: document/video-v1"))
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/import", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", videoContractImportProgressType)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Document video v1"`) {
		t.Fatalf("import status = %d body = %s", res.Code, res.Body.String())
	}
	if contentType := res.Header().Get("Content-Type"); !strings.HasPrefix(contentType, videoContractImportProgressType) {
		t.Fatalf("import Content-Type = %q", contentType)
	}
	if !res.Flushed {
		t.Fatal("import progress response was not flushed")
	}
	for _, stage := range []string{"document_ready", "preparing", "generating", "retrying", "upstream_connected", "receiving", "validating", "repairing", "completed"} {
		if !strings.Contains(res.Body.String(), `"stage":"`+stage+`"`) {
			t.Fatalf("import progress missing stage %q: %s", stage, res.Body.String())
		}
	}
	if !strings.Contains(res.Body.String(), `"warnings":[]`) {
		t.Fatalf("import warnings must be an array: %s", res.Body.String())
	}
	if strings.Contains(res.Body.String(), `"transcript_`) || strings.Contains(res.Body.String(), `"stage":"transcript"`) {
		t.Fatalf("import progress exposed model transcript: %s", res.Body.String())
	}
	if requestCount != videoContractGenerationAttempts+1 {
		t.Fatalf("document analysis requests = %d, want %d", requestCount, videoContractGenerationAttempts+1)
	}
	items, err := app.videoContracts.List()
	if err != nil {
		t.Fatalf("list contracts: %v", err)
	}
	for _, item := range items {
		if item.Contract.Name == contract.Name {
			t.Fatal("imported draft was saved before confirmation")
		}
	}
	logs := mustSearchAppLogs(t, app, service.LogQuery{Limit: 20})
	encodedLogs, _ := json.Marshal(logs)
	if strings.Contains(string(encodedLogs), "PRIVATE_DOC_MARKER") {
		t.Fatal("document content leaked into operation logs")
	}
}

func TestVideoContractImportProgressWriterSendsHeartbeat(t *testing.T) {
	var body bytes.Buffer
	flushed := make(chan struct{}, 1)
	writer := &videoContractImportProgressWriter{
		encoder: json.NewEncoder(&body),
		flusher: videoContractImportTestFlusher{flushed: flushed},
	}
	stop := writer.startHeartbeat(context.Background(), time.Millisecond)
	select {
	case <-flushed:
	case <-time.After(time.Second):
		t.Fatal("heartbeat was not flushed")
	}
	stop()

	var event videoContractImportProgressEvent
	if err := json.NewDecoder(&body).Decode(&event); err != nil {
		t.Fatalf("decode heartbeat: %v", err)
	}
	if event.Stage != "heartbeat" || event.Message == "" {
		t.Fatalf("heartbeat event = %#v", event)
	}
}
