package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestSessionMutationRejectsUntrustedSources(t *testing.T) {
	t.Setenv(corsAllowedOriginsEnv, "https://trusted.example.test")
	t.Setenv(devModeEnv, "")
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		for _, source := range []struct{ origin, site string }{
			{"https://evil.example.test", "same-site"},
			{"null", "cross-site"},
			{"https://app.example.test.evil.test", "cross-site"},
			{"https://app.example.test?spoofed", "same-origin"},
			{"https://app.example.test#spoofed", "same-origin"},
			{"https://app.example.test:8443", "same-site"},
			{"", "same-site"},
			{"", "cross-site"},
			{"", "none"},
		} {
			t.Run(method+"/"+source.origin+"/"+source.site, func(t *testing.T) {
				called := false
				routes := []appRoute{exact(method, "/api/canvas/agent-tools", func(http.ResponseWriter, *http.Request) { called = true })}
				r := httptest.NewRequest(method, "https://app.example.test/api/canvas/agent-tools", strings.NewReader(`{}`))
				r.Header.Set("Origin", source.origin)
				r.Header.Set("Sec-Fetch-Site", source.site)
				r.Header.Set("Content-Type", "text/plain")
				r.Header.Set("X-Forwarded-Host", "evil.example.test")
				setRequestAuthCookie(r, token)
				w := httptest.NewRecorder()
				app.serveHTTP(w, r, routes)
				if w.Code != http.StatusForbidden || called {
					t.Fatalf("untrusted mutation reached handler: status=%d called=%v", w.Code, called)
				}
			})
		}
	}
	for _, source := range []struct{ origin, site string }{{"https://app.example.test", "same-origin"}, {"https://trusted.example.test", "cross-site"}, {"", "same-origin"}, {"", ""}} {
		called := false
		r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/canvas/agent-tools", strings.NewReader(`{}`))
		r.Header.Set("Origin", source.origin)
		r.Header.Set("Sec-Fetch-Site", source.site)
		r.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(r, token)
		w := httptest.NewRecorder()
		app.serveHTTP(w, r, []appRoute{exact(http.MethodPost, "/api/canvas/agent-tools", func(http.ResponseWriter, *http.Request) { called = true })})
		if !called {
			t.Fatalf("trusted request rejected: source=%+v status=%d", source, w.Code)
		}
	}
}

func TestCanvasAgentRejectsSimpleContentTypes(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, path := range []string{"/api/canvas/agent-runs", "/api/canvas/agent-tools", "/api/canvas/agent-tools/review-answers"} {
		for _, contentType := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json-bogus", "application/json; charset"} {
			r := httptest.NewRequest(http.MethodPost, path+"?project_id=test", strings.NewReader(`{}`))
			r.Header.Set("Content-Type", contentType)
			setRequestAuthCookie(r, token)
			w := httptest.NewRecorder()
			app.Handler().ServeHTTP(w, r)
			if w.Code != http.StatusUnsupportedMediaType {
				t.Errorf("%s Content-Type %q: status=%d", path, contentType, w.Code)
			}
		}
	}
}

func TestCanvasAgentForeignOriginCannotMutateDocument(t *testing.T) {
	t.Setenv(corsAllowedOriginsEnv, "")
	t.Setenv(devModeEnv, "")
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	workspace, err := app.canvas.Workspace(identityScope(*identity))
	if err != nil {
		t.Fatal(err)
	}
	doc := workspace.Document
	doc.AgentSessions = json.RawMessage(`[{"id":"security-session","messages":[{"id":"answer","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc)
	if err != nil {
		t.Fatal(err)
	}
	input := service.CanvasAgentToolRequest{Context: service.CanvasAgentRequest{ID: "security-run", SessionID: "security-session", AssistantID: "answer", UserText: "create text", APIMode: "responses"}}
	input.Call.ID = "security-call"
	input.Call.Name = "create_text_node"
	input.Call.Arguments = map[string]any{"title": "security marker", "content": "isolated test data"}
	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	send := func(origin, contentType string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/canvas/agent-tools?project_id="+doc.ID, bytes.NewReader(payload))
		r.Header.Set("Origin", origin)
		r.Header.Set("Sec-Fetch-Site", "same-site")
		r.Header.Set("Content-Type", contentType)
		setRequestAuthCookie(r, token)
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		return w
	}
	for _, contentType := range []string{"text/plain", "application/json"} {
		if response := send("https://untrusted.example.test", contentType); response.Code != http.StatusForbidden {
			t.Fatalf("foreign request accepted: status=%d body=%s", response.Code, response.Body.String())
		}
		snapshot, err := app.canvasAgent.Snapshot(*identity, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.Revision != doc.Revision || len(snapshot.Nodes) != len(doc.Nodes) || snapshot.AgentRun != nil {
			t.Fatal("rejected request changed the document or started an agent run")
		}
	}
	if response := send("https://app.example.test", "application/json; charset=utf-8"); response.Code != http.StatusOK {
		t.Fatalf("same-origin tool rejected: status=%d body=%s", response.Code, response.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err := app.canvasAgent.Snapshot(*identity, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, node := range snapshot.Nodes {
			if node.Title == "security marker" {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("same-origin tool did not create the node")
}
