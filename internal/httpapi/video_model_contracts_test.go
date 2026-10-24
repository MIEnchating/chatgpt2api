package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
		"duration_value_type", "必须选择 string", "必须选择 number",
		"严格按以下互斥矩阵", "image 的 first_frame.max 必须为 1", "reference 的 first_frame、last_frame 全部为 0",
		"ui.show、ui.hide、ui.disable 三组不能包含同一字段",
		"不可信资料", "证据缺失时只生成待人工确认的草稿", "端点、参数能力、轮询状态、产物下载四类证据",
		"优先匹配内置协议", "# Protocol matching", "普通 JSON 字段", "不是选择自定义协议的理由", "禁止根据 Grok、Seedance 等模型名称猜驱动",
	} {
		if !strings.Contains(videoContractImportSystemPrompt, requirement) {
			t.Errorf("document import prompt is missing requirement %q", requirement)
		}
	}
	if strings.Contains(videoContractImportSystemPrompt, `{"contracts"`) || len(videoContractImportSystemPrompt) >= 9_000 {
		t.Fatal("document import prompt still embeds a verbose contract example")
	}
	if strings.Contains(videoContractImportSystemPrompt, "普通 JSON 字段映射使用 custom-video") {
		t.Fatal("document import still routes all JSON mappings to the custom driver")
	}
	format := videoContractImportResponseFormat(false)
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
		`"evidence"`, `"endpoints_quote"`, `"parameters_quote"`, `"polling_quote"`, `"download_quote"`,
		`"create_path"`, `"query_path"`, `"artifact"`, `"content_path"`,
		`"allowed_hosts"`, `"generation"`, `"rules"`, `"model_profiles"`,
		`"queued_statuses"`, `"processing_statuses"`, `"progress_fields"`, `"generation_mode_field"`,
		`"when"`, `"require"`, `"require_any"`, `"forbid"`, `"limits"`,
		`"force_values"`, `"ui"`, `"show"`, `"hide"`, `"disable"`, `"message"`,
	} {
		if !bytes.Contains(encoded, []byte(field)) {
			t.Errorf("document import JSON Schema is missing current contract field %q", field)
		}
	}
}

func TestVideoContractGenerationPromptCarriesExactSchema(t *testing.T) {
	prompt := videoContractGenerationSystemPrompt(false)
	_, schemaText, ok := strings.Cut(prompt, "<output_schema>\n")
	if !ok {
		t.Fatal("model-visible prompt is missing the output schema")
	}
	schemaText, _, ok = strings.Cut(schemaText, "\n</output_schema>")
	if !ok {
		t.Fatal("model-visible schema is unterminated")
	}
	expected, _ := json.Marshal(videoContractImportJSONSchema(false))
	if schemaText != string(expected) {
		t.Fatal("model-visible schema differs from the transport schema")
	}
	for _, requirement := range []string{"additionalProperties=false", "extra_body", "必填参数若无法表达", "普通空格必须按文档保留"} {
		if !strings.Contains(prompt, requirement) {
			t.Errorf("prompt is missing %q", requirement)
		}
	}
}

func TestVideoContractGenerationSchemaScopesPluginConnectionHints(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		schema := videoContractImportJSONSchema(enabled)
		properties := schema["properties"].(map[string]any)
		contracts := properties["contracts"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
		evidence := properties["evidence"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
		_, hasProvider := contracts["provider"]
		_, hasURLQuote := evidence["provider_base_url_quote"]
		_, hasAuthQuote := evidence["provider_auth_quote"]
		if hasProvider != enabled || hasURLQuote != enabled || hasAuthQuote != enabled {
			t.Fatalf("plugin connection fields must follow the explicit option: enabled=%t", enabled)
		}
		prompt := videoContractGenerationSystemPrompt(enabled)
		if !strings.Contains(prompt, "禁止因缺少这些配置添加 review_issues") {
			t.Fatal("channel configuration was treated as a contract blocker")
		}
		if !enabled && (strings.Contains(prompt, "# Provider connection hints") || !strings.Contains(prompt, "用户未开启 New API 插件生成")) {
			t.Fatal("ordinary contract extraction must not request plugin connection hints")
		}
		if enabled && !strings.Contains(prompt, "缺少默认地址不影响契约初审或插件生成") {
			t.Fatal("plugin defaults must remain optional")
		}
		encoded, _ := json.Marshal(schema)
		if !strings.Contains(prompt, "<output_schema>\n"+string(encoded)+"\n</output_schema>") {
			t.Fatal("prompt and tool schema disagree")
		}
	}
}

func TestGeneratedVideoContractRejectsExtraBodyAtEveryLevel(t *testing.T) {
	for _, location := range []string{"contract", "request", "profile"} {
		for _, value := range []string{`{}`, `null`, `{"seed":123}`} {
			t.Run(location+value, func(t *testing.T) {
				contract := protocol.DefaultVideoContracts()[0]
				contract.Models = []string{"document-video"}
				contract.ModelProfiles = nil
				data, _ := json.Marshal(contract)
				var fields map[string]any
				_ = json.Unmarshal(data, &fields)
				var extension any
				_ = json.Unmarshal([]byte(value), &extension)
				switch location {
				case "contract":
					fields["extra_body"] = extension
				case "request":
					fields["request"].(map[string]any)["extra_body"] = extension
				case "profile":
					fields["model_profiles"] = []any{map[string]any{"model": "document-video", "capability": fields["capability"], "generation": fields["generation"], "rules": fields["rules"], "extra_body": extension}}
				}
				data, _ = json.Marshal(fields)
				_, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`]}`, "document-video")
				if err == nil || !strings.Contains(err.Error(), "extra_body") {
					t.Fatalf("unsupported request data was accepted or silently dropped: %v", err)
				}
			})
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

func TestExtractDOCXTextLimitsTotalDecompressedContent(t *testing.T) {
	for _, entryCount := range []int{1, 2} {
		t.Run(fmt.Sprintf("entries_%d", entryCount), func(t *testing.T) {
			var document bytes.Buffer
			archive := zip.NewWriter(&document)
			for index := range entryCount {
				entry, err := archive.Create(fmt.Sprintf("word/header%d.xml", index))
				if err != nil {
					t.Fatalf("create DOCX entry: %v", err)
				}
				content := `<w:document xmlns:w="urn:w"><w:t>text</w:t>` + strings.Repeat(" ", maxVideoContractDocumentBytes/entryCount) + `</w:document>`
				if _, err := io.WriteString(entry, content); err != nil {
					t.Fatalf("write DOCX entry: %v", err)
				}
			}
			if err := archive.Close(); err != nil {
				t.Fatalf("close DOCX: %v", err)
			}
			if document.Len() >= maxVideoContractDocumentBytes {
				t.Fatal("compressed fixture must fit the upload limit")
			}
			if _, err := extractDOCXText(document.Bytes()); err == nil || !strings.Contains(err.Error(), "解压后的内容过大") {
				t.Fatalf("oversized DOCX error = %v", err)
			}
		})
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
	var overlappingRuleUIContract protocol.VideoModelContract
	if err := json.Unmarshal(data, &overlappingRuleUIContract); err != nil {
		t.Fatalf("decode overlapping rule UI fixture: %v", err)
	}
	if len(overlappingRuleUIContract.Rules) == 0 {
		t.Fatal("default contract must exercise generated rule UI normalization")
	}
	overlappingRuleUIContract.Rules[0].UI.Hide = []string{"duration"}
	overlappingRuleUIContract.Rules[0].UI.Disable = []string{"duration", "watermark"}
	overlappingRuleUIData, _ := json.Marshal(overlappingRuleUIContract)
	normalizedRuleUI, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(overlappingRuleUIData)+`]}`, "model: document/video-v1")
	if err != nil || len(normalizedRuleUI) != 1 {
		t.Fatalf("overlapping generated rule UI was not normalized: %#v, %v", normalizedRuleUI, err)
	}
	if !slices.Equal(normalizedRuleUI[0].Rules[0].UI.Hide, []string{"duration"}) || !slices.Equal(normalizedRuleUI[0].Rules[0].UI.Disable, []string{"watermark"}) {
		t.Fatalf("normalized generated rule UI = %#v", normalizedRuleUI[0].Rules[0].UI)
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
	if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(mixedData)+`]}`, "model: document/video-v1"); err == nil {
		t.Fatal("mixed mode materials were silently removed instead of rejected")
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
	invalidFirst := contract
	invalidFirst.Request.DurationField = ""
	invalidFirstData, _ := json.Marshal(invalidFirst)
	var invalidSecond protocol.VideoModelContract
	if err := json.Unmarshal(data, &invalidSecond); err != nil {
		t.Fatalf("decode second invalid contract fixture: %v", err)
	}
	invalidSecond.Name = "Document video v2"
	invalidSecond.Models = []string{"document/video-v2"}
	invalidSecond.Rules[0].Forbid = append(invalidSecond.Rules[0].Forbid, invalidSecond.Rules[0].Require[0])
	invalidSecondData, _ := json.Marshal(invalidSecond)
	if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(invalidFirstData)+`,`+string(invalidSecondData)+`]}`, "document/video-v1 document/video-v2"); err == nil || !strings.Contains(err.Error(), "第 1 份契约无效") || !strings.Contains(err.Error(), "第 2 份契约无效") {
		t.Fatalf("contract validation errors were not aggregated: %v", err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(data, &legacy); err != nil {
		t.Fatalf("decode contract for legacy fixture: %v", err)
	}
	for _, field := range []string{
		"name", "models", "priority", "driver", "transport", "artifact",
		"capability", "generation", "rules", "request", "polling",
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
	for _, includeProvider := range []bool{false, true} {
		t.Run(fmt.Sprintf("generate_plugin=%t", includeProvider), func(t *testing.T) {
			testAdminVideoModelContractImportStreamsUnsavedDraftProgress(t, includeProvider)
		})
	}
}

func testAdminVideoModelContractImportStreamsUnsavedDraftProgress(t *testing.T, includeProvider bool) {
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
	contract.Driver = protocol.VideoContractDriverCustom
	contract.Transport.CreatePath = "/v1/videos"
	contract.Transport.QueryPath = "/v1/videos/{task_id}"
	contractJSON, _ := json.Marshal(contract)
	contractBundleJSON := []byte(`{"contracts":[` + string(contractJSON) + `]}`)
	invalidContract := contract
	invalidContract.Request.DurationField = ""
	invalidContractJSON, _ := json.Marshal(invalidContract)
	invalidContractBundleJSON := []byte(`{"contracts":[` + string(invalidContractJSON) + `]}`)
	requestCount := 0
	var lastRequest time.Time
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
		if util.Clean(util.AsMapSlice(payload["messages"])[0]["content"]) != videoContractAgentSystemPrompt(includeProvider) {
			t.Error("agent prompt missing schema or workflow")
		}
		if !util.ToBool(payload["stream"]) || len(util.AsMapSlice(payload["tools"])) != 4 || payload["response_format"] != nil {
			t.Error("agent must use streamed tool calls")
		}
		toolSchema := util.StringMap(util.StringMap(util.AsMapSlice(payload["tools"])[2]["function"])["parameters"])
		contractProperties := util.StringMap(util.StringMap(util.StringMap(toolSchema["properties"])["contracts"])["items"])
		_, hasProvider := util.StringMap(contractProperties["properties"])["provider"]
		if hasProvider != includeProvider {
			t.Errorf("plugin option did not reach the model tool schema: provider=%t", hasProvider)
		}
		requestCount++
		if requestCount == 2 && time.Since(lastRequest) < videoContractRetryDelay(1) || requestCount == 3 && time.Since(lastRequest) < videoContractRetryDelay(2) {
			t.Error("upstream request retried without backoff")
		}
		lastRequest = time.Now()
		toolName, arguments := "inspect_protocols", "{}"
		validEvidence := `,"evidence":[{"model":"document/video-v1","endpoints_quote":"","parameters_quote":"","polling_quote":"","download_quote":"","review_issues":[]}]`
		messages := util.AsMapSlice(payload["messages"])
		switch requestCount {
		case 1:
			util.WriteError(w, 524, "The origin web server did not respond to Cloudflare within the allowed time.")
			return
		case 2:
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"断线前已收到的公开回复\"}}]}\n\n")
			fmt.Fprint(w, "data: {\"error\":{\"message\":\"temporary stream failure\"}}\n\n")
			return
		case 3:
			if util.Clean(util.StringMap(util.StringMap(payload["tool_choice"])["function"])["name"]) != "inspect_protocols" {
				t.Error("first call must inspect real protocol capabilities")
			}
		case 4:
			w.Header().Set("Content-Type", "text/event-stream")
			delta := map[string]any{"content": "正在核对文档。"}
			if includeProvider {
				delta["tool_calls"] = []map[string]any{
					{"index": 0, "id": "rejected-1", "type": "function", "function": map[string]any{"name": "validate_contracts", "arguments": "{}"}},
					{"index": 1, "id": "rejected-2", "type": "function", "function": map[string]any{"name": "finish", "arguments": "{}"}},
				}
			}
			encoded, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": delta, "finish_reason": "stop"}}})
			fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
			return
		case 5:
			toolName = "validate_contracts"
			arguments = string(invalidContractBundleJSON[:len(invalidContractBundleJSON)-1]) + validEvidence + "}"
			if messages[len(messages)-1]["role"] != "user" || !strings.Contains(util.Clean(messages[len(messages)-1]["content"]), "未执行任何工具") {
				t.Error("tool format correction missing")
			}
			encodedHistory, _ := json.Marshal(messages)
			if !strings.Contains(string(encodedHistory), "default_paths") || strings.Contains(string(encodedHistory), "rejected-") {
				t.Error("correction lost protocol evidence or included rejected calls")
			}
		case 6:
			toolName = "validate_contracts"
			if !strings.Contains(util.Clean(messages[len(messages)-1]["content"]), "request.duration_field") {
				t.Error("validation feedback missing")
			}
			withUnknown := strings.TrimSuffix(string(contractJSON), "}") + `,"extra_body":{}}`
			arguments = `{"contracts":[` + withUnknown + `]` + validEvidence + "}"
		case 7:
			toolName = "validate_contracts"
			if !strings.Contains(util.Clean(messages[len(messages)-1]["content"]), "extra_body") {
				t.Error("unknown-field feedback missing")
			}
			arguments = string(contractBundleJSON[:len(contractBundleJSON)-1]) + validEvidence + "}"
		case 8:
			toolName = "finish"
			if !strings.Contains(util.Clean(messages[len(messages)-1]["content"]), `"requests"`) {
				t.Error("actual request preview missing from tool result")
			}
		default:
			t.Errorf("unexpected extra request %d", requestCount)
			util.WriteError(w, 400, "unexpected request")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		publicText := "正在核对接口配置。"
		if toolName == "finish" {
			publicText = ""
		}
		encoded, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]any{
			"content": publicText, "reasoning_content": "PRIVATE_REASONING_MARKER",
			"tool_calls": []map[string]any{{"index": 0, "id": fmt.Sprintf("call-%d", requestCount), "type": "function", "function": map[string]any{"name": toolName, "arguments": arguments}}},
		}, "finish_reason": "tool_calls"}}})
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
	_ = writer.WriteField("generate_plugin", fmt.Sprint(includeProvider))
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
	if !strings.HasPrefix(strings.TrimSpace(res.Body.String()), "data: ") {
		t.Fatalf("import progress is not SSE formatted: %s", res.Body.String())
	}
	for _, stage := range []string{"reading_document", "document_ready", "preparing", "generating", "retrying", "matching_protocol", "receiving", "dry_run", "validating", "repairing", "completed"} {
		if !strings.Contains(res.Body.String(), `"stage":"`+stage+`"`) {
			t.Fatalf("import progress missing stage %q: %s", stage, res.Body.String())
		}
	}
	if !strings.Contains(res.Body.String(), `"warnings":[]`) {
		t.Fatalf("import warnings must be an array: %s", res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"driver":"openai-videos"`) || !strings.Contains(res.Body.String(), `"create_path":""`) || !strings.Contains(res.Body.String(), `"query_path":""`) {
		t.Fatalf("document import did not select the equivalent built-in protocol: %s", res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"detail":`) || !strings.Contains(res.Body.String(), "正在核对接口配置") || strings.Contains(res.Body.String(), "PRIVATE_REASONING_MARKER") {
		t.Fatal("execution details must show public replies and exclude private reasoning")
	}
	if strings.Contains(res.Body.String(), `"transcript_`) || strings.Contains(res.Body.String(), `"stage":"transcript"`) {
		t.Fatalf("import progress exposed model transcript: %s", res.Body.String())
	}
	if requestCount != 8 {
		t.Fatalf("document analysis requests = %d, want 8", requestCount)
	}
	details := map[string]videoContractAgentDetail{}
	corrections, toolRuns := 0, 0
	for _, frame := range strings.Split(strings.TrimSpace(res.Body.String()), "\n\n") {
		var event videoContractImportProgressEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(frame, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event.Detail == nil {
			continue
		}
		details[event.Detail.ID] = *event.Detail
		if event.Detail.Kind == "correction" {
			corrections++
		}
		if event.Detail.Kind == "tool" && event.Detail.Status == "running" {
			toolRuns++
		}
		if event.Detail.Name == "validate_contracts" && event.Detail.Status == "failed" && (event.ValidationCurrent == nil || *event.ValidationCurrent) {
			t.Fatal("failed validation did not invalidate frontend progress")
		}
	}
	if first := details["model-1-attempt-1"]; first.Status != "failed" || !strings.Contains(first.Error, "524") || first.Round != 1 || first.RequestAttempt != 1 {
		t.Fatalf("first request failure was overwritten: %#v", first)
	}
	if second := details["model-1-attempt-2"]; second.Status != "failed" || second.Output != "断线前已收到的公开回复" || !strings.Contains(second.Error, "temporary stream failure") {
		t.Fatalf("failed stream lost its public text or reason: %#v", second)
	}
	if third := details["model-1-attempt-3"]; third.Status != "completed" || third.RequestAttempt != 3 {
		t.Fatalf("successful retry missing: %#v", third)
	}
	if corrections != 1 || toolRuns != 5 {
		t.Fatalf("corrections=%d toolRuns=%d", corrections, toolRuns)
	}
	if last := details["model-6-attempt-1"]; last.Status != "completed" || last.Output != "" || last.Summary != "已返回 1 个工具调用" {
		t.Fatalf("tool-only model request did not complete visibly: %#v", last)
	}
	for id, detail := range details {
		if detail.Status == "running" {
			t.Fatalf("unfinished detail after completion: %s", id)
		}
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
		output:  &body,
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
	line := strings.SplitN(body.String(), "\n\n", 2)[0]
	line = strings.TrimPrefix(line, "data: ")
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("decode heartbeat: %v", err)
	}
	if event.Stage != "heartbeat" || event.Message == "" {
		t.Fatalf("heartbeat event = %#v", event)
	}
}

func TestVideoContractImportStreamsDocumentReadFailure(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("source_type", "url")
	_ = form.WriteField("url", "file:///invalid-document")
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/import", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Accept", "text/event-stream")
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.HasPrefix(res.Header().Get("Content-Type"), "text/event-stream") || !res.Flushed {
		t.Fatalf("document read failure must use the established event stream: status=%d headers=%v", res.Code, res.Header())
	}
	var events []videoContractImportProgressEvent
	for _, frame := range strings.Split(strings.TrimSpace(res.Body.String()), "\n\n") {
		var event videoContractImportProgressEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(frame, "data: ")), &event); err != nil {
			t.Fatalf("invalid SSE frame: %v", err)
		}
		events = append(events, event)
	}
	if len(events) != 2 || events[0].Stage != "reading_document" || events[1].Stage != "failed" || events[1].Message == "" {
		t.Fatalf("expected document reading followed by the actual failure: %#v", events)
	}
}

func TestVideoContractImportProgressPreservesModelRound(t *testing.T) {
	res := httptest.NewRecorder()
	writer := newVideoContractImportProgressWriter(res)
	writer.write(videoContractImportProgressEvent{Stage: "generating", Attempt: 2, MaxAttempts: 12, RequestAttempt: 1, MaxRequestAttempts: 3})
	writer.write(videoContractImportProgressEvent{Stage: "receiving", ReceivedCharacters: 16})
	frames := strings.Split(res.Body.String(), "\n\n")
	var event videoContractImportProgressEvent
	if err := json.Unmarshal([]byte(strings.TrimPrefix(frames[1], "data: ")), &event); err != nil {
		t.Fatal(err)
	}
	if event.Attempt != 2 || event.MaxAttempts != 12 || event.RequestAttempt != 1 || event.ReceivedCharacters != 16 {
		t.Fatalf("text updates lost the current model round: %#v", event)
	}
}
