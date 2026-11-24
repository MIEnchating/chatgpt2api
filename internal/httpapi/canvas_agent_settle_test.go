package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

// A run left "running" by a service restart must not block renaming the project.
func TestCanvasProjectRenameSettlesRunLeftRunningByRestart(t *testing.T) {
	for _, readBeforeRename := range []bool{false, true} {
		t.Run(map[bool]string{false: "rename-directly", true: "read-before-rename"}[readBeforeRename], func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			backend, err := storage.NewDatabaseBackend("sqlite:///:memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer backend.Close()
			app.canvasAgent.Close()
			app.canvas = service.NewCanvasDocumentService(backend)
			app.canvasAgent = service.NewCanvasAgentService(context.Background(), nil, app.canvas, nil, nil, nil)
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

			name := fmt.Sprintf("canvas_workspaces/%x.json", sha256.Sum256([]byte(identityScope(*identity))))
			raw, err := backend.LoadJSONDocument(name)
			if err != nil {
				t.Fatal(err)
			}
			work := raw.(map[string]any)
			project := work["projects"].([]any)[0].(map[string]any)
			project["agent_run"] = service.CanvasAgentRun{ID: "run-restart", SessionID: "s", AssistantID: "a", Status: "running", Engine: "langgraph"}
			if err := backend.SaveJSONDocument(name, work); err != nil {
				t.Fatal(err)
			}
			persisted, err := app.canvas.Project(identityScope(*identity), doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			if persisted.AgentRun == nil || persisted.AgentRun.Status != "running" {
				t.Fatalf("fixture did not leave a running run: %+v", persisted.AgentRun)
			}

			if readBeforeRename {
				request := httptest.NewRequest(http.MethodGet, "/api/canvas?project_id="+doc.ID, nil)
				setRequestAuthCookie(request, token)
				response := httptest.NewRecorder()
				app.Handler().ServeHTTP(response, request)
				var loaded service.CanvasWorkspaceResult
				if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &loaded) != nil {
					t.Fatalf("read after restart: %d %s", response.Code, response.Body.String())
				}
				if loaded.Document.AgentRun == nil || loaded.Document.AgentRun.Status != "interrupted" {
					t.Fatalf("page load did not settle interrupted run: %+v", loaded.Document.AgentRun)
				}
				for _, project := range loaded.Projects {
					if project.ID == doc.ID && project.Revision != loaded.Document.Revision {
						t.Fatal("project list returned a stale revision after settling")
					}
				}
				persisted = loaded.Document
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
		})
	}
}
