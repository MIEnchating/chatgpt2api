package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/service"
)

// A run left "running" by a service restart must not block renaming the project.
func TestCanvasProjectRenameSettlesRunLeftRunningByRestart(t *testing.T) {
	runtimePath, pathErr := filepath.Abs("../../agent-runtime/worker.mjs")
	if pathErr != nil {
		t.Fatal(pathErr)
	}
	t.Setenv("AGENT_RUNTIME_PATH", runtimePath)
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"text_models": []string{"agent-test"}}); err != nil {
		t.Fatal(err)
	}
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	if identity == nil {
		t.Fatal("missing identity")
	}
	workspace, err := app.canvas.Workspace(identityScope(*identity))
	if err != nil {
		t.Fatal(err)
	}
	doc := workspace.Document
	doc.AgentSessions = json.RawMessage(`[{"id":"s","title":"重启验证","messages":[{"id":"u","role":"user","text":"hello"},{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	if doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc); err != nil {
		t.Fatal(err)
	}

	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	app.canvasAgent.Close()
	old := service.NewCanvasAgentService(app.ctx, app.canvas, app.agentSkills, func(context.Context, service.Identity, service.CanvasAgentModelRequest) (map[string]any, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		// Ignore cancellation so the persisted run stays "running" like a crashed process would.
		<-release
		return map[string]any{"text_response": "done"}, nil
	}, nil)
	defer old.Close()
	defer close(release)
	if _, err = old.Start(*identity, doc.ID, service.CanvasAgentRequest{ID: "run-restart", SessionID: "s", AssistantID: "a", UserText: "hello", Model: "agent-test", RelayTokenName: "test", APIMode: "responses"}); err != nil {
		t.Fatal(err)
	}
	<-entered

	// The new service has an empty active table, exactly like a restarted process.
	app.canvasAgent = service.NewCanvasAgentService(app.ctx, app.canvas, app.agentSkills, nil, nil)
	persisted, err := app.canvas.Project(identityScope(*identity), doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.AgentRun == nil || persisted.AgentRun.Status != "running" {
		t.Fatalf("fixture did not leave a running run: %+v", persisted.AgentRun)
	}

	body, _ := json.Marshal(map[string]any{"action": "rename", "project_id": doc.ID, "title": "重启后改名", "revision": persisted.Revision})
	req := httptest.NewRequest(http.MethodPost, "/api/canvas", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(req, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("rename after restart: %d %s", response.Code, response.Body.String())
	}
	renamed, err := app.canvas.Project(identityScope(*identity), doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "重启后改名" {
		t.Fatalf("title = %q", renamed.Title)
	}
}
