package translation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newEngine(t *testing.T, server *httptest.Server, source string, variables map[string]any) *Engine {
	t.Helper()
	engine, err := New(Channel{Source: source, BaseURL: server.URL + "/gateway/v1"}, "custom", "secret", variables, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if engine == nil {
		t.Fatal("missing rule")
	}
	engine.interval = time.Millisecond
	return engine
}
func TestTransformJSONReferencesAndIsolateModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/gateway/v1/generate" || r.Header.Get("Authorization") != "" {
			t.Errorf("wrong routing: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["text"] != "hello" || len(body["refs"].([]any)) != 2 || body["key"] != "secret" {
			t.Errorf("body: %#v", body)
		}
		io.WriteString(w, `{"result":{"urls":["https://cdn.example/a.png","https://cdn.example/b.png"]}}`)
	}))
	defer server.Close()
	e := newEngine(t, server, `{models:{custom:{POST:{url:"/generate",body:{text:prompt,refs:images,key:"{channelKey}"}},result:r=>r.result.urls},unused:{POST:{url:missing.value}}}}`, map[string]any{"prompt": "hello", "images": []string{"https://a.example/a.png", "data:image/png;base64,aA=="}})
	result, err := e.Execute(context.Background(), "image", nil)
	if err != nil || len(result.URLs) != 2 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}
func TestTransformPollingRetriesWithoutResubmit(t *testing.T) {
	var submitted, polled atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			submitted.Add(1)
			io.WriteString(w, `{"ids":["a","b"]}`)
			return
		}
		if polled.Add(1) == 1 {
			w.WriteHeader(429)
			return
		}
		io.WriteString(w, `{"state":"ok","output":"https://cdn.example/video.mp4"}`)
	}))
	defer server.Close()
	e := newEngine(t, server, `{models:{custom:{POST:{url:"/create"},result:"output",poll:{GET:{url:"/query/{taskId}"},taskId:"ids",status:"state",success:["ok"],failure:["error"]}}}}`, nil)
	result, err := e.Execute(context.Background(), "video", nil)
	if err != nil || len(result.URLs) != 2 || submitted.Load() != 1 || polled.Load() != 3 {
		t.Fatalf("result=%#v submits=%d polls=%d err=%v", result, submitted.Load(), polled.Load(), err)
	}
}
func TestTransformFormatsAndBinaryErrors(t *testing.T) {
	for _, format := range []string{"formData", "urlencoded", "raw"} {
		t.Run(format, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if format == "formData" {
					if err := r.ParseMultipartForm(1024); err != nil {
						t.Error(err)
					}
					if r.FormValue("text") != "hello" {
						t.Error("lost field")
					}
				} else if format == "urlencoded" {
					if err := r.ParseForm(); err != nil {
						t.Error(err)
					}
					if r.FormValue("text") != "hello" {
						t.Error("lost field")
					}
				} else {
					body, _ := io.ReadAll(r.Body)
					if string(body) != "hello" {
						t.Error("wrong raw body")
					}
				}
				w.Header().Set("Content-Type", "audio/wav")
				w.Write([]byte("RIFF1234WAVEtest"))
			}))
			defer server.Close()
			body := `{text:prompt}`
			if format == "raw" {
				body = `prompt`
			}
			e := newEngine(t, server, `{models:{custom:{POST:{url:"/speech",format:"`+format+`",body:`+body+`,responseType:"blob"}}}}`, map[string]any{"prompt": "hello"})
			result, err := e.Execute(context.Background(), "audio", nil)
			if err != nil || !strings.HasPrefix(result.URLs[0], "data:audio/wav;") {
				t.Fatalf("%#v %v", result, err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"error":{"message":"rejected"}}`) }))
	defer server.Close()
	e := newEngine(t, server, `{models:{custom:{POST:{url:"/speech",responseType:"blob"}}}}`, nil)
	if _, err := e.Execute(context.Background(), "audio", nil); err == nil {
		t.Fatal("error JSON accepted as audio")
	}
}
func TestTransformCancellationAndExpressionTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			io.WriteString(w, `{"id":"x"}`)
		} else {
			io.WriteString(w, `{"state":"running"}`)
		}
	}))
	defer server.Close()
	e := newEngine(t, server, `{models:{custom:{POST:{url:"/create"},poll:{GET:{url:"/poll/{taskId}"},taskId:"id",status:"state",success:["done"]}}}}`, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := e.Execute(ctx, "video", nil); err == nil {
		t.Fatal("cancellation ignored")
	}
	start := time.Now()
	_, err := New(Channel{Source: `{models:{custom:{POST:{url:(()=>{while(true){}})()}}}}`}, "custom", "", nil, server.Client())
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("unbounded expression: %v", err)
	}
}
func TestTransformValidationDoesNotExecute(t *testing.T) {
	for _, source := range []string{`({models:{x:{POST:{url:"/x"},GET:{url:"/x"}}}})`, `{models:{x:{POST:{}}}}`, `{models:{x:{POST:{url:"/x"}}},extra:1}`, `{models:{x:{POST:{url:"/x"}},x:{}}}`} {
		if _, err := Models(source); err == nil {
			t.Fatalf("invalid accepted: %s", source)
		}
	}
	models, err := Models(`{models:{custom:{POST:{url:(()=>{while(true){}})()}},empty:{}}}`)
	if err != nil || len(models) != 1 || models[0] != "custom" {
		t.Fatalf("models=%v err=%v", models, err)
	}
}

func TestTransformVideoContentKeepsHeadersAndQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			io.WriteString(w, `{"id":"task"}`)
			return
		}
		if r.Header.Get("X-Api-Key") != "secret" || r.URL.Query().Get("ticket") != "keep" {
			t.Error("lost download credentials")
		}
		if strings.HasSuffix(r.URL.Path, "/content") {
			w.Header().Set("Content-Type", "video/mp4")
			w.Write([]byte("video-bytes"))
			return
		}
		io.WriteString(w, `{"status":"done"}`)
	}))
	defer server.Close()
	engine := newEngine(t, server, `{headers:{"X-Api-Key":"{channelKey}"},models:{custom:{POST:{url:"/videos"},poll:{GET:{url:"/videos/{taskId}",params:{ticket:"keep"}},taskId:"id",status:"status",success:["done"]}}}}`, nil)
	result, err := engine.Execute(context.Background(), "video", nil)
	if err != nil || len(result.URLs) != 1 || !strings.HasPrefix(result.URLs[0], "data:video/mp4;") {
		t.Fatalf("%#v %v", result, err)
	}
}

func TestTransformDoesNotForwardAuthAcrossRedirects(t *testing.T) {
	reached := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer server.Close()
	engine := newEngine(t, server, `{models:{custom:{POST:{url:"/x"}}}}`, nil)
	_, err := engine.Execute(context.Background(), "image", nil)
	if err == nil || reached {
		t.Fatalf("redirect reached=%v err=%v", reached, err)
	}
}

func TestTransformInvalidRuntimeConfigurationDoesNotSubmit(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer server.Close()
	for _, source := range []string{
		`{models:{custom:{POST:{url:"/jobs"},poll:{taskId:"id",status:"state",success:["done"]}}}}`,
		`{headers:(()=>{JSON.stringify=null;return {}})(),models:{custom:{POST:{url:"/jobs"}}}}`,
		`{headers:(()=>{Object.defineProperty(JSON,"stringify",{get(){throw new Error("broken")}});return {}})(),models:{custom:{POST:{url:"/jobs"}}}}`,
	} {
		if _, err := New(Channel{Source: source, BaseURL: server.URL}, "custom", "secret", nil, server.Client()); err == nil {
			t.Fatalf("invalid runtime config accepted: %s", source)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("invalid rules submitted a billable request")
	}
}

func TestTransformErrorsDoNotLeakChannelKey(t *testing.T) {
	const key = "s3cret/key"
	closed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	closedURL := closed.URL
	closed.Close()
	for name, source := range map[string]string{
		"query": `{models:{custom:{POST:{url:"/x",params:{api_key:"{channelKey}"}}}}}`,
		"path":  `{models:{custom:{POST:{url:"/x/{channelKey}/y"}}}}`,
	} {
		t.Run("transport "+name, func(t *testing.T) {
			engine, err := New(Channel{Source: source, BaseURL: closedURL}, "custom", key, nil, &http.Client{})
			if err != nil || engine == nil {
				t.Fatalf("engine=%v err=%v", engine, err)
			}
			_, _, err = engine.send(context.Background(), "image", false, "")
			var urlErr *url.Error
			if err == nil || errors.As(err, &urlErr) {
				t.Fatalf("transport error kept the request URL: %v", err)
			}
			for _, leak := range []string{"s3cret", url.QueryEscape(key), closedURL, "/x"} {
				if strings.Contains(err.Error(), leak) {
					t.Fatalf("error leaks %q: %v", leak, err)
				}
			}
		})
	}
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"error":"invalid key `+key+` and `+url.QueryEscape(key)+`"}`)
	}))
	defer echo.Close()
	engine, err := New(Channel{Source: `{models:{custom:{POST:{url:"/x"}}}}`, BaseURL: echo.URL}, "custom", key, nil, echo.Client())
	if err != nil || engine == nil {
		t.Fatalf("engine=%v err=%v", engine, err)
	}
	_, err = engine.Execute(context.Background(), "image", nil)
	if err == nil || strings.Contains(err.Error(), "s3cret") || !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("upstream error text leaks the key: %v", err)
	}
}

func TestTransformAbsoluteURLRequiresExplicitCrossOrigin(t *testing.T) {
	var otherHits, homeHits atomic.Int32
	var otherAuth, homeAuth atomic.Value
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits.Add(1)
		otherAuth.Store(r.Header.Get("Authorization"))
		io.WriteString(w, `{"result":["https://cdn.example/a.png"]}`)
	}))
	defer other.Close()
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		homeHits.Add(1)
		homeAuth.Store(r.Header.Get("Authorization"))
		io.WriteString(w, `{"result":["https://cdn.example/a.png"]}`)
	}))
	defer home.Close()

	t.Run("cross origin is rejected by default", func(t *testing.T) {
		e := newEngine(t, home, `{models:{custom:{POST:{url:"`+other.URL+`/x"},result:"result"}}}`, nil)
		if _, err := e.Execute(context.Background(), "image", nil); err == nil || otherHits.Load() != 0 {
			t.Fatalf("cross origin request was sent: hits=%d err=%v", otherHits.Load(), err)
		}
	})
	t.Run("explicit cross origin carries no bearer", func(t *testing.T) {
		e := newEngine(t, home, `{models:{custom:{POST:{url:"`+other.URL+`/x",crossOrigin:true},result:"result"}}}`, nil)
		if _, err := e.Execute(context.Background(), "image", nil); err != nil || otherHits.Load() != 1 {
			t.Fatalf("hits=%d err=%v", otherHits.Load(), err)
		}
		if auth, _ := otherAuth.Load().(string); auth != "" {
			t.Fatalf("bearer sent to another origin: %q", auth)
		}
	})
	t.Run("same origin absolute url keeps bearer", func(t *testing.T) {
		e := newEngine(t, home, `{models:{custom:{POST:{url:"`+home.URL+`/gateway/v1/x"},result:"result"}}}`, nil)
		if _, err := e.Execute(context.Background(), "image", nil); err != nil || homeHits.Load() != 1 {
			t.Fatalf("hits=%d err=%v", homeHits.Load(), err)
		}
		if auth, _ := homeAuth.Load().(string); auth != "Bearer secret" {
			t.Fatalf("missing bearer on same origin: %q", auth)
		}
	})
	t.Run("config validation", func(t *testing.T) {
		if _, err := Models(`{models:{x:{POST:{url:"/x",crossOrigin:flag}}}}`); err == nil {
			t.Fatal("non-literal crossOrigin accepted")
		}
		if _, err := Models(`{models:{x:{POST:{url:"/x",crossOrigin:"yes"}}}}`); err == nil {
			t.Fatal("non-boolean crossOrigin accepted")
		}
		if models, err := Models(`{models:{x:{POST:{url:"/x",crossOrigin:true}}}}`); err != nil || len(models) != 1 {
			t.Fatalf("models=%v err=%v", models, err)
		}
	})
}

func TestTransformBoundsResponsesDownloadsAndRuleOutput(t *testing.T) {
	chunk := make([]byte, 1<<20)
	const videoRule = `{models:{custom:{POST:{url:"/videos"},poll:{GET:{url:"/videos/{taskId}"},taskId:"id",status:"status",success:["done"]}}}}`
	videoServer := func(content func(w http.ResponseWriter)) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == "POST":
				io.WriteString(w, `{"id":"task"}`)
			case strings.HasSuffix(r.URL.Path, "/content"):
				w.Header().Set("Content-Type", "video/mp4")
				content(w)
			default:
				io.WriteString(w, `{"status":"done"}`)
			}
		}))
	}
	t.Run("submit response cap", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for written := 0; written <= maxResponseBytes; written += len(chunk) {
				w.Write(chunk)
			}
		}))
		defer server.Close()
		e := newEngine(t, server, `{models:{custom:{POST:{url:"/x"}}}}`, nil)
		if _, err := e.Execute(context.Background(), "image", nil); err == nil || !strings.Contains(err.Error(), "响应超过") {
			t.Fatalf("oversized response accepted: %v", err)
		}
	})
	t.Run("video download cap", func(t *testing.T) {
		server := videoServer(func(w http.ResponseWriter) {
			for written := 0; written <= maxVideoBytes; written += len(chunk) {
				w.Write(chunk)
			}
		})
		defer server.Close()
		e := newEngine(t, server, videoRule, nil)
		if _, err := e.Execute(context.Background(), "video", nil); err == nil || !strings.Contains(err.Error(), "下载结果超过") {
			t.Fatalf("oversized video accepted: %v", err)
		}
	})
	t.Run("download waits for a free slot", func(t *testing.T) {
		var hits atomic.Int32
		server := videoServer(func(w http.ResponseWriter) {
			hits.Add(1)
			w.Write([]byte("video-bytes"))
		})
		defer server.Close()
		e := newEngine(t, server, videoRule, nil)
		for i := 0; i < maxConcurrentDownloads; i++ {
			downloadSlots <- struct{}{}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		_, err := e.Execute(ctx, "video", nil)
		for i := 0; i < maxConcurrentDownloads; i++ {
			<-downloadSlots
		}
		if err == nil || hits.Load() != 0 {
			t.Fatalf("download ignored the slot limit: hits=%d err=%v", hits.Load(), err)
		}
	})
	t.Run("concurrent downloads stay bounded", func(t *testing.T) {
		var inflight, peak atomic.Int32
		server := videoServer(func(w http.ResponseWriter) {
			n := inflight.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(30 * time.Millisecond)
			inflight.Add(-1)
			w.Write([]byte("video-bytes"))
		})
		defer server.Close()
		engines := make([]*Engine, 3*maxConcurrentDownloads)
		for i := range engines {
			engines[i] = newEngine(t, server, videoRule, nil)
		}
		var wg sync.WaitGroup
		errs := make(chan error, len(engines))
		for _, e := range engines {
			wg.Add(1)
			go func(e *Engine) {
				defer wg.Done()
				_, err := e.Execute(context.Background(), "video", nil)
				errs <- err
			}(e)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if peak.Load() == 0 || peak.Load() > maxConcurrentDownloads {
			t.Fatalf("peak concurrent downloads=%d", peak.Load())
		}
	})
	t.Run("rule output and source size", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"a":1}`) }))
		defer server.Close()
		e := newEngine(t, server, `{models:{custom:{POST:{url:"/x"},result:()=>"x".repeat(33<<20)}}}`, nil)
		if _, err := e.Execute(context.Background(), "image", nil); err == nil || !strings.Contains(err.Error(), "转换结果超过") {
			t.Fatalf("oversized rule output accepted: %v", err)
		}
		if _, err := Models(strings.Repeat(" ", MaxSourceBytes+1) + `{models:{x:{POST:{url:"/x"}}}}`); err == nil {
			t.Fatal("oversized rule source accepted")
		}
	})
}
