package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

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
	if !strings.Contains(videoContractImportSystemPrompt, "当前 v4 格式中的单个 contract JSON 对象") ||
		!strings.Contains(videoContractImportSystemPrompt, "不要包裹 version 或 contracts") {
		t.Fatal("document import prompt does not distinguish a generated draft from a transfer document")
	}
	for _, field := range []string{
		`"create_path"`, `"query_path"`, `"artifact"`, `"content_path"`,
		`"allowed_hosts"`, `"generation"`, `"rules"`, `"validation"`, "custom-video",
		"queued_statuses", "processing_statuses", "progress_fields", "generation_mode_field",
		`"when"`, `"require"`, `"require_any"`, `"forbid"`, `"limits"`,
		`"force_values"`, `"ui"`, `"show"`, `"hide"`, `"disable"`, `"message"`,
	} {
		if !strings.Contains(videoContractImportSystemPrompt, field) {
			t.Errorf("document import prompt is missing current contract field %q", field)
		}
	}

	const schemaEnd = "\n}\n\n规则："
	start := strings.Index(videoContractImportSystemPrompt, "{")
	end := strings.Index(videoContractImportSystemPrompt, schemaEnd)
	if start < 0 || end < start {
		t.Fatal("document import prompt does not contain a complete contract example")
	}
	contract, err := decodeGeneratedVideoModelContract(videoContractImportSystemPrompt[start : end+2])
	if err != nil {
		t.Fatalf("document import prompt example does not match the current contract schema: %v", err)
	}
	if contract.Artifact.Mode != "response_url" || contract.Generation.DefaultMode != "text-to-video" || len(contract.Rules) != 1 {
		t.Fatalf("document import prompt example lost current contract fields: %#v", contract)
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

func TestDecodeGeneratedVideoModelContractIsStrict(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Document video v1"
	contract.Models = []string{"document/video-v1"}
	data, err := json.Marshal(contract)
	if err != nil {
		t.Fatalf("marshal contract: %v", err)
	}
	decoded, err := decodeGeneratedVideoModelContract("```json\n" + string(data) + "\n```")
	if err != nil || decoded.Name != contract.Name {
		t.Fatalf("decoded = %#v, err = %v", decoded, err)
	}
	withUnknown := strings.TrimSuffix(string(data), "}") + `,"unexpected":true}`
	if _, err := decodeGeneratedVideoModelContract(withUnknown); err == nil {
		t.Fatal("unknown contract field was accepted")
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
		if _, err := decodeGeneratedVideoModelContract(string(legacyData)); err == nil || !strings.Contains(err.Error(), field) {
			t.Fatalf("generated contract without %s was accepted: %v", field, err)
		}
	}
}

func TestAdminVideoModelContractImportReturnsUnsavedDraft(t *testing.T) {
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
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": string(contractJSON)}}},
		})
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{
		"relay_base_url":     upstream.URL,
		"text_models":        []string{"gpt-contract-parser"},
		"default_text_model": "gpt-contract-parser",
	}); err != nil {
		t.Fatalf("configure import relay: %v", err)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("source_type", "file")
	_ = writer.WriteField("model", "gpt-contract-parser")
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Document video v1"`) {
		t.Fatalf("import status = %d body = %s", res.Code, res.Body.String())
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
