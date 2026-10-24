package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	for _, marker := range []string{"alpha-video-current", "alpha-video-v1", "GET /v1/videos/{task_id}"} {
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

func TestVideoContractSelectedDocumentsRejectIncompleteInput(t *testing.T) {
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "External documentation")
	}))
	defer external.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/create":
			fmt.Fprint(w, "POST /v1/videos")
		case "/empty":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<html><body><script>renderDocs()</script></body></html>`)
		case "/redirect":
			http.Redirect(w, r, external.URL, http.StatusFound)
		case "/binary":
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "invalid document")
		case "/large":
			fmt.Fprint(w, strings.Repeat("x", 2048))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	for _, test := range []struct {
		name, path, want string
		limit            int
	}{
		{"missing query", "/missing", "HTTP 404", 1024},
		{"empty query", "/empty", "没有可读取的正文", 1024},
		{"external redirect", "/redirect", "重定向到其他站点", 1024},
		{"unsupported format", "/binary", "不支持该文档格式", 1024},
		{"oversized query", "/large", "总大小限制", 1024},
		{"exhausted budget", "/missing", "总大小限制", len("POST /v1/videos")},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := videoContractImportSource{Type: "url", Site: &videoContractDocumentSite{
				baseURL: base, remainingBytes: test.limit,
				links: []videoContractDocumentLink{
					{index: 1, name: "Create", url: base.ResolveReference(&url.URL{Path: "/create"})},
					{index: 2, name: "Query", url: base.ResolveReference(&url.URL{Path: test.path})},
				},
			}}
			content, _, err := fetchSelectedVideoContractDocuments(context.Background(), "Entry", source, []int{1, 2}, server.Client())
			if err == nil || !strings.Contains(err.Error(), test.want) || !strings.Contains(err.Error(), "Query") || content != "" {
				t.Fatalf("partial documentation accepted or missing failure detail: content=%q error=%v", content, err)
			}
		})
	}
}

func TestVideoContractDocumentDetectsGenericContentTypes(t *testing.T) {
	for _, contentType := range []string{"", "application/octet-stream"} {
		for _, document := range []struct{ name, body, want string }{
			{"html", `<html><body><p>Video API</p><script>hidden()</script><a href="/query">Query</a></body></html>`, "Video API"},
			{"markdown", "# Video API\nPOST /v1/videos", "POST /v1/videos"},
			{"json", `{"paths":{"/v1/videos":{}}}`, `"/v1/videos"`},
		} {
			t.Run(contentType+"/"+document.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/docs" {
						http.NotFound(w, r)
						return
					}
					w.Header()["Content-Type"] = []string{contentType}
					fmt.Fprint(w, document.body)
				}))
				defer server.Close()
				content, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/docs", server.Client())
				if err != nil || !strings.Contains(content, document.want) || strings.Contains(content, "hidden()") {
					t.Fatalf("generic content type extraction: content=%q error=%v", content, err)
				}
				if document.name == "html" && (source.Site == nil || len(source.Site.links) != 1) {
					t.Fatalf("detected HTML did not expose related documents: %#v", source.Site)
				}
			})
		}
	}
}

func TestVideoContractDocumentRejectsEmptyEntryWithoutReadableSelection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><body><script>renderDocs()</script></body></html>`)
	}))
	defer server.Close()
	if _, _, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/docs", server.Client()); err == nil || !strings.Contains(err.Error(), "JavaScript") {
		t.Fatalf("empty JavaScript page must explain how to provide documentation: %v", err)
	}
	source := videoContractImportSource{Site: &videoContractDocumentSite{}}
	if _, _, err := fetchSelectedVideoContractDocuments(context.Background(), "", source, nil, server.Client()); err == nil {
		t.Fatal("empty entry with no selected supplements was accepted")
	}
}

func TestVideoContractDocumentDiscoveryCombinesIndexAndHTMLWithoutEntryAnchors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			http.Redirect(w, r, "/docs#videos", http.StatusFound)
		case "/docs":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<html><body><p>Video API</p><a href="#videos">Videos</a><a href="/query">Query</a><script>SwaggerUIBundle({url: "/openapi.json"})</script></body></html>`)
		case "/llms.txt":
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, "[Chat](/chat.md)\n[Query](/query)")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for _, entry := range []string{"/start", "/docs#videos"} {
		_, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+entry, server.Client())
		if err != nil || source.Site == nil || len(source.Site.links) != 3 {
			t.Fatalf("index must not hide HTML/spec links or duplicate entry: source=%#v error=%v", source.Site, err)
		}
		foundSpec := false
		for _, link := range source.Site.links {
			if link.url.Path == "/docs" {
				t.Fatal("entry fragment was offered as a supplementary page")
			}
			foundSpec = foundSpec || link.url.Path == "/openapi.json"
		}
		if !foundSpec {
			t.Fatal("llms.txt hid the OpenAPI specification")
		}
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

func TestVideoContractDocumentsRetainEntryWithQuerySupplement(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/create":
			fmt.Fprint(w, `<p>model: entry-video-v1; POST /v1/videos; duration: 5</p><a href="/query">Query task</a>`)
		case "/query":
			fmt.Fprint(w, `<p>GET /v1/videos/{task_id}; status: completed</p>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	initial, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/create", server.Client())
	if err != nil || source.Site == nil {
		t.Fatalf("discover entry: %v", err)
	}
	content, _, err := fetchSelectedVideoContractDocuments(context.Background(), initial, source, []int{1}, server.Client())
	if err != nil || !strings.Contains(content, "entry-video-v1") || !strings.Contains(content, "GET /v1/videos/{task_id}") {
		t.Fatalf("entry and supplement must both reach extraction: %q, %v", content, err)
	}
	content, _, err = fetchSelectedVideoContractDocuments(context.Background(), initial, source, []int{}, server.Client())
	if err != nil || content != initial {
		t.Fatalf("empty supplementary selection lost entry: %q, %v", content, err)
	}
}
