package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestFetchVideoContractDocumentSetUsesLLMSIndex(t *testing.T) {
	var imageRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/markdown")
			_, _ = fmt.Fprint(w, "# Current API page\n\nmodel: alpha-video-current")
		case "/llms.txt":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = fmt.Fprint(w, `# API documentation

## API Docs
- [Create Alpha Video](/video-create.md): Submit a video task.
- [Query Alpha Video](/video-query.md): Query video status.
- [Create Image](/image-create.md): Submit an image task.
- [External Video](https://external.example/video.md): Must not be fetched.
`)
		case "/video-create.md":
			w.Header().Set("Content-Type", "text/markdown")
			_, _ = fmt.Fprint(w, "# Create Alpha Video\nmodel: alpha-video-v1\nPOST /v1/videos")
		case "/video-query.md":
			w.Header().Set("Content-Type", "text/markdown")
			_, _ = fmt.Fprint(w, "# Query Alpha Video\nGET /v1/videos/{task_id}\nstatus: completed")
		case "/image-create.md":
			imageRequests.Add(1)
			w.Header().Set("Content-Type", "text/markdown")
			_, _ = fmt.Fprint(w, "IMAGE_DOCUMENT_MUST_NOT_BE_INCLUDED")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	initialContent, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/", server.Client())
	if err != nil {
		t.Fatalf("fetch document set: %v", err)
	}
	if source.Site == nil || len(source.Site.links) != 3 {
		t.Fatalf("discovered document site = %#v", source.Site)
	}
	content, source, err := fetchSelectedVideoContractDocuments(context.Background(), initialContent, source, []int{1, 2}, server.Client())
	if err != nil {
		t.Fatalf("fetch selected documents: %v", err)
	}
	for _, marker := range []string{"alpha-video-v1", "GET /v1/videos/{task_id}"} {
		if !strings.Contains(content, marker) {
			t.Errorf("document set is missing %q: %s", marker, content)
		}
	}
	if strings.Contains(content, "IMAGE_DOCUMENT_MUST_NOT_BE_INCLUDED") || imageRequests.Load() != 0 {
		t.Fatalf("unrelated image documentation was fetched: requests=%d content=%s", imageRequests.Load(), content)
	}
	if source.Type != "url" || !strings.Contains(source.Name, "2 个相关页面") || len(source.Warnings) != 0 {
		t.Fatalf("document set source = %#v", source)
	}

	directInitial, directSource, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/llms.txt", server.Client())
	if err != nil {
		t.Fatalf("inspect direct llms.txt: %v", err)
	}
	directContent, directSource, err := fetchSelectedVideoContractDocuments(context.Background(), directInitial, directSource, []int{1, 2}, server.Client())
	if err != nil || !strings.Contains(directContent, "alpha-video-v1") || !strings.Contains(directSource.Name, "2 个相关页面") {
		t.Fatalf("direct llms.txt import content=%q source=%#v error=%v", directContent, directSource, err)
	}
}

func TestFetchVideoContractDocumentSetFallsBackToHTMLLinks(t *testing.T) {
	var unrelatedRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/docs/":
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, `<html><body><nav><a href="/docs/veo">Veo 视频生成接口</a><a href="/docs/chat">Chat API</a></nav></body></html>`)
		case "/docs/llms.txt", "/llms.txt":
			http.NotFound(w, r)
		case "/docs/veo":
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, `<html><body><h1>Veo video API</h1><p>model: veo-video-v1</p></body></html>`)
		case "/docs/chat":
			unrelatedRequests.Add(1)
			_, _ = fmt.Fprint(w, "CHAT_DOCUMENT_MUST_NOT_BE_INCLUDED")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	initialContent, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/docs/", server.Client())
	if err != nil {
		t.Fatalf("fetch HTML document set: %v", err)
	}
	if source.Site == nil || len(source.Site.links) != 2 {
		t.Fatalf("HTML candidates = %#v", source.Site)
	}
	content, source, err := fetchSelectedVideoContractDocuments(context.Background(), initialContent, source, []int{1}, server.Client())
	if err != nil {
		t.Fatalf("fetch selected HTML document: %v", err)
	}
	if !strings.Contains(content, "veo-video-v1") || strings.Contains(content, "CHAT_DOCUMENT_MUST_NOT_BE_INCLUDED") || unrelatedRequests.Load() != 0 {
		t.Fatalf("HTML discovery content=%q unrelated requests=%d", content, unrelatedRequests.Load())
	}
	if !strings.Contains(source.Name, "1 个相关页面") {
		t.Fatalf("HTML discovery source = %#v", source)
	}
}

func TestFetchVideoContractDocumentSetDiscoversOpenAPISpecification(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/swagger":
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, `<html><body><div id="swagger-ui"></div><script>SwaggerUIBundle({url: "/openapi.json"})</script></body></html>`)
		case "/llms.txt":
			http.NotFound(w, r)
		case "/openapi.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"openapi":"3.1.0","paths":{"/v1/videos":{"post":{"summary":"Create video"}}},"x-model":"swagger-video-v1"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	initialContent, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/swagger", server.Client())
	if err != nil {
		t.Fatalf("fetch Swagger document set: %v", err)
	}
	if source.Site == nil || len(source.Site.links) != 1 {
		t.Fatalf("Swagger candidates = %#v", source.Site)
	}
	content, source, err := fetchSelectedVideoContractDocuments(context.Background(), initialContent, source, []int{1}, server.Client())
	if err != nil || !strings.Contains(content, "swagger-video-v1") || !strings.Contains(source.Name, "1 个相关页面") {
		t.Fatalf("Swagger discovery content=%q source=%#v", content, source)
	}
}

func TestFetchVideoContractDocumentSetKeepsSingleMarkdownIsolated(t *testing.T) {
	var linkedRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/single.md":
			w.Header().Set("Content-Type", "text/markdown")
			_, _ = fmt.Fprint(w, "# Single Video API\nmodel: single-video-v1\n[Another Video](/another.md)")
		case "/another.md":
			linkedRequests.Add(1)
			_, _ = fmt.Fprint(w, "model: another-video-v1")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	content, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/single.md", server.Client())
	if err != nil {
		t.Fatalf("fetch single Markdown document: %v", err)
	}
	if !strings.Contains(content, "single-video-v1") || strings.Contains(content, "another-video-v1") || linkedRequests.Load() != 0 {
		t.Fatalf("single Markdown import content=%q linked requests=%d", content, linkedRequests.Load())
	}
	if source.Name != "single.md" {
		t.Fatalf("single Markdown source = %#v", source)
	}
}

func TestDecodeVideoContractDocumentPlanIsStrict(t *testing.T) {
	selected, err := decodeVideoContractDocumentPlan(`{"selected":[3,1]}`, 4)
	if err != nil || len(selected) != 2 || selected[0] != 3 || selected[1] != 1 {
		t.Fatalf("decoded document plan = %#v, error = %v", selected, err)
	}
	for name, content := range map[string]string{
		"empty selection": `{"selected":[]}`,
		"unknown field":   `{"selected":[1],"url":"https://example.com/private"}`,
		"unknown id":      `{"selected":[5]}`,
		"duplicate id":    `{"selected":[1,1]}`,
		"multiple plans":  `{"selected":[1]} {"selected":[2]}`,
	} {
		if _, err := decodeVideoContractDocumentPlan(content, 4); err == nil {
			t.Errorf("%s document plan was accepted", name)
		}
	}
	format := videoContractDocumentPlanResponseFormat(40)
	jsonSchema, ok := format["json_schema"].(map[string]any)
	if !ok || format["type"] != "json_schema" || jsonSchema["strict"] != true {
		t.Fatalf("document plan response format = %#v", format)
	}
	encoded, _ := json.Marshal(jsonSchema["schema"])
	if !strings.Contains(string(encoded), `"minItems":1`) || !strings.Contains(string(encoded), `"maxItems":24`) || !strings.Contains(string(encoded), `"uniqueItems":true`) {
		t.Fatalf("document plan schema = %s", encoded)
	}
	for _, requirement := range []string{"只能返回候选列表中已有的整数 id", "入口摘录只用于辅助判断", "不可信资料", "视频编辑", "任务查询"} {
		if !strings.Contains(videoContractDocumentPlannerPrompt, requirement) {
			t.Errorf("document planner prompt is missing %q", requirement)
		}
	}
}
