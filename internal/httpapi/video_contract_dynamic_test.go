package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestVideoContractLoadingShellDetection(t *testing.T) {
	for _, test := range []struct {
		name, body string
		want       bool
	}{
		{"localized shell", `<title>API docs</title><header>Company</header><nav><a href="/models">Models</a></nav><main><svg>icon</svg>加载中…</main><footer>Sign in</footer><script src="/docs.js"></script>`, true},
		{"English shell", `<main>Loading documentation...</main><script>render()</script>`, true},
		{"empty script page", `<script>render()</script>`, true},
		{"article and loader", `<main><h1>Video API</h1><p>POST /v1/videos</p><aside>Loading...</aside></main><script>render()</script>`, false},
		{"static index", `<nav><a href="/docs/videos">Videos</a></nav>`, false},
		{"static document", `<article>model: example-video-v1; duration: 5</article>`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := videoContractHTMLIsLoadingShell([]byte(test.body)); got != test.want {
				t.Fatalf("loading shell=%v, want %v", got, test.want)
			}
		})
	}
}

func videoContractCatalogFixture(slugs ...string) string {
	items := make([]map[string]string, 0, len(slugs))
	for _, slug := range slugs {
		items = append(items, map[string]string{"slug": slug, "name": "Video " + slug})
	}
	data, _ := json.Marshal(map[string]any{"code": 200, "data": map[string]any{"capabilities": []any{
		map[string]any{"model_type": "image", "families": []any{map[string]any{"items": []any{map[string]any{"slug": "image-only"}}}}},
		map[string]any{"model_type": "video", "families": []any{map[string]any{"items": items}}},
	}}})
	return string(data)
}

func videoContractDetailFixture(slug string) string {
	data, _ := json.Marshal(map[string]any{"code": 200, "data": map[string]any{
		"slug": slug, "name": "Video " + slug, "model_type": "video",
		"auth": map[string]string{"type": "bearer_api_key", "format": "Bearer <platform_api_key>"},
		"endpoints": []any{
			map[string]any{"method": "POST", "path": "/v1/videos", "forms": []any{map[string]any{
				"parameters": map[string]any{"properties": map[string]any{"seconds": map[string]any{"type": "integer", "minimum": 4, "maximum": 15}}},
				"example":    map[string]any{"model": slug, "prompt": "example", "seconds": 5},
			}}},
			map[string]string{"method": "GET", "path": "/v1/videos/{video_id}"},
			map[string]string{"method": "GET", "path": "/v1/videos/{video_id}/content"},
		},
		"status_reference": map[string]any{"statuses": []string{"queued", "in_progress", "completed", "failed"}},
	}})
	return string(data)
}

func TestVideoContractDynamicCatalogReadsAllVideoDetails(t *testing.T) {
	var externalRequests, detailRequests atomic.Int32
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		externalRequests.Add(1)
	}))
	defer external.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("document reads must not carry user or relay credentials")
		}
		switch r.URL.Path {
		case "/zh/docs":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<nav><a href="/login">Login</a></nav><main>加载中…</main><script src="%s/external.js"></script><script src="/common.js"></script><script src="/docs.js"></script><script src="/docs.js"></script>`, external.URL)
		case "/common.js":
			fmt.Fprint(w, `const unrelated = "API documentation";`)
		case "/docs.js":
			fmt.Fprint(w, `throw new Error("Do not execute scripts"); get("/api-docs/list"); get('/api-docs/detail');`)
		case "/api/api-docs/list":
			if r.URL.Query().Get("model_type") != "video" {
				t.Errorf("catalog query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, videoContractCatalogFixture("alpha-video", "beta-video", "alpha-video"))
		case "/api/api-docs/detail":
			detailRequests.Add(1)
			slug := r.URL.Query().Get("slug")
			if slug != "alpha-video" && slug != "beta-video" {
				t.Errorf("unrelated documentation requested: %q", slug)
			}
			fmt.Fprint(w, videoContractDetailFixture(slug))
		default:
			t.Errorf("unexpected document request: %s", r.URL.String())
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	content, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/zh/docs", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"alpha-video", "beta-video", `"maximum": 15`, "/v1/videos/{video_id}/content", "bearer_api_key", "completed"} {
		if !strings.Contains(content, marker) {
			t.Errorf("document body missing %q", marker)
		}
	}
	if strings.Contains(content, "加载中") || strings.Contains(content, "image-only") || strings.Contains(content, "Do not execute") {
		t.Fatal("placeholder, unrelated models or scripts leaked into document content")
	}
	if source.Site != nil || !strings.Contains(source.Name, "2 份") || externalRequests.Load() != 0 || detailRequests.Load() != 2 {
		t.Fatalf("incomplete catalog read: source=%#v external=%d details=%d", source, externalRequests.Load(), detailRequests.Load())
	}
}

func TestVideoContractDynamicCatalogRejectsIncompleteDocuments(t *testing.T) {
	for _, test := range []struct {
		name, list, detail, want string
		status                   int
	}{
		{"missing detail", videoContractCatalogFixture("alpha"), "", "HTTP 404", 404},
		{"business error", videoContractCatalogFixture("alpha"), `{"code":403,"data":null}`, "访问权限", 200},
		{"wrong document", videoContractCatalogFixture("alpha"), videoContractDetailFixture("beta"), "标识、类型或接口正文无效", 200},
		{"empty detail", videoContractCatalogFixture("alpha"), `{"code":200,"data":{"slug":"alpha","model_type":"video","endpoints":[]}}`, "接口正文无效", 200},
		{"empty catalog", videoContractCatalogFixture(), "", "没有视频接口文档", 200},
		{"invalid catalog", `{"code":200,"data":{}}`, "", "模型分类", 200},
		{"missing slug", videoContractCatalogFixture(""), "", "无效的文档标识", 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/docs":
					w.Header().Set("Content-Type", "text/html")
					fmt.Fprint(w, `<main>Loading...</main><script>get("/api-docs/list");get("/api-docs/detail")</script>`)
				case "/api/api-docs/list":
					fmt.Fprint(w, test.list)
				case "/api/api-docs/detail":
					w.WriteHeader(test.status)
					fmt.Fprint(w, test.detail)
				default:
					t.Errorf("unexpected request: %s", r.URL)
				}
			}))
			defer server.Close()
			content, _, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/docs", server.Client())
			if err == nil || !strings.Contains(err.Error(), test.want) || content != "" {
				t.Fatalf("invalid document accepted: content=%q err=%v", content, err)
			}
		})
	}
}

func TestVideoContractDynamicCatalogBounds(t *testing.T) {
	var detailRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/api-docs/list" {
			slugs := make([]string, maxVideoContractDocumentPages+1)
			for i := range slugs {
				slugs[i] = fmt.Sprintf("video-%d", i)
			}
			fmt.Fprint(w, videoContractCatalogFixture(slugs...))
		} else {
			detailRequests.Add(1)
			fmt.Fprint(w, videoContractDetailFixture("video-0"))
		}
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	initial := fetchedVideoContractDocument{url: base}
	for _, budget := range []int{maxVideoContractDocumentBytes, 10} {
		content, _, err := fetchVideoContractDynamicCatalog(context.Background(), initial, budget, server.Client())
		if err == nil || content != "" {
			t.Fatalf("budget=%d accepted an incomplete catalog: %v", budget, err)
		}
	}
	if detailRequests.Load() != 0 {
		t.Fatal("over-limit catalog triggered detail requests")
	}
}

func TestVideoContractUnknownDynamicPageCannotGenerateFromNavigation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<title>API docs</title><nav><a href="/models">Model list</a></nav><main>加载中…</main><script>unknownRenderer()</script>`)
	}))
	defer server.Close()
	content, source, err := fetchVideoContractDocumentSet(context.Background(), server.URL+"/docs", server.Client())
	if err != nil || content != "" || source.Site == nil {
		t.Fatalf("dynamic navigation was treated as content: %q %v", content, err)
	}
	if _, _, err := fetchSelectedVideoContractDocuments(context.Background(), content, source, nil, server.Client()); err == nil || !strings.Contains(err.Error(), "加载中") {
		t.Fatalf("empty planning result must explain loading shell: %v", err)
	}
}

func TestVideoContractEmptyGenerationExplainsMissingDocument(t *testing.T) {
	for _, output := range []string{`{"contracts":[]}`, `{"contracts":null}`, `{}`} {
		if _, err := decodeGeneratedVideoModelContracts(output, "document"); err == nil || !strings.Contains(err.Error(), "具体视频接口正文") {
			t.Fatalf("empty generation has no actionable error: %v", err)
		}
	}
}
