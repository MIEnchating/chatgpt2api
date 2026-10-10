package translation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
