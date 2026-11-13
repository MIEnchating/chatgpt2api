package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

type canvasReadCountingBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	reads map[string]int
}

func TestCanvasLongHistoryNegotiatesGzip(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	history, err := json.Marshal([]map[string]any{
		{"id": "current", "messages": []any{}, "protocolMessages": []map[string]string{{"role": "user", "content": strings.Repeat("完整正文 <图像>&😀 ", 4096)}}},
		{"id": "archived", "messages": []any{}, "protocolMessages": []any{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := app.canvas.Import(identityScope(*identity), service.CanvasDocument{
		Title: "Long conversation", AgentSessions: history, ActiveAgentSessionID: "current",
		AgentPanel: &service.CanvasAgentPanel{Open: true, Width: 440, Mode: "docked"},
	})
	if err != nil {
		t.Fatal(err)
	}
	doc := workspace.Document
	documentPath := "/api/canvas?history=editor&project_id=" + url.QueryEscape(doc.ID)
	sessionPath := "/api/canvas/agent-history?project_id=" + url.QueryEscape(doc.ID) + "&session_id=current&revision=" + strconv.FormatInt(doc.Revision, 10)
	send := func(method, path, body string, encoding []string, authorized bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		for _, value := range encoding {
			req.Header.Add("Accept-Encoding", value)
		}
		if authorized {
			setRequestAuthCookie(req, token)
		}
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	for _, endpoint := range []struct{ method, path, body string }{
		{http.MethodGet, documentPath, ""},
		{http.MethodPost, "/api/canvas?history=editor", fmt.Sprintf(`{"action":"activate","project_id":%q}`, doc.ID)},
		{http.MethodGet, "/api/canvas/agent-runs?history=active&project_id=" + url.QueryEscape(doc.ID), ""},
		{http.MethodGet, sessionPath, ""},
	} {
		plain := send(endpoint.method, endpoint.path, endpoint.body, nil, true)
		compressed := send(endpoint.method, endpoint.path, endpoint.body, []string{"br", "gzip"}, true)
		if plain.Code != http.StatusOK || compressed.Code != http.StatusOK {
			t.Fatalf("%s %s: identity %d, gzip %d", endpoint.method, endpoint.path, plain.Code, compressed.Code)
		}
		if compressed.Header().Get("Content-Encoding") != "gzip" {
			t.Errorf("%s %s: expected gzip for large history", endpoint.method, endpoint.path)
			continue
		}
		if compressed.Header().Get("Cache-Control") != "private, no-store" || compressed.Header().Get("Vary") != "Accept-Encoding" ||
			plain.Header().Get("Vary") != "Accept-Encoding" || plain.Header().Get("Content-Encoding") != "" ||
			plain.Header().Get("Content-Type") != compressed.Header().Get("Content-Type") {
			t.Fatalf("%s: unexpected negotiated response headers", endpoint.path)
		}
		compressedSize := compressed.Body.Len()
		reader, err := gzip.NewReader(compressed.Body)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := io.ReadAll(reader)
		if err != nil || reader.Close() != nil || !bytes.Equal(decoded, plain.Body.Bytes()) || !strings.Contains(string(decoded), "完整正文") {
			t.Fatalf("%s: gzip changed history: %v", endpoint.path, err)
		}
		if compressedSize >= plain.Body.Len()/2 {
			t.Fatal("fixture did not meaningfully compress")
		}
	}
	for _, encoding := range []string{"gzip;q=0, *;q=1", "br", "gzip;q=bad"} {
		if res := send(http.MethodGet, sessionPath, "", []string{encoding}, true); res.Code != http.StatusOK || res.Header().Get("Content-Encoding") != "" {
			t.Fatalf("encoding %q must preserve identity", encoding)
		}
	}
	if res := send(http.MethodGet, sessionPath, "", []string{"*;q=0.5"}, true); res.Header().Get("Content-Encoding") != "gzip" {
		t.Error("wildcard must allow gzip")
	}
	small := strings.Replace(sessionPath, "session_id=current", "session_id=archived", 1)
	if res := send(http.MethodGet, small, "", []string{"gzip"}, true); res.Code != http.StatusOK || res.Header().Get("Content-Encoding") != "" {
		t.Fatal("a short transcript should remain uncompressed")
	}
	if res := send(http.MethodGet, sessionPath, "", []string{"gzip"}, false); res.Code != http.StatusUnauthorized || res.Header().Get("Content-Encoding") != "" {
		t.Fatal("unauthenticated response did not preserve the existing error contract")
	}
}

func (b *canvasReadCountingBackend) LoadJSONDocument(name string) (any, error) {
	b.reads[name]++
	return b.JSONDocumentBackend.LoadJSONDocument(name)
}

func (b *canvasReadCountingBackend) SaveJSONDocumentAndPrune(ctx context.Context, name string, value any, prefix string, retained []string) error {
	return b.Backend.(storage.JSONDocumentPruningBackend).SaveJSONDocumentAndPrune(ctx, name, value, prefix, retained)
}

func TestCanvasProjectReadsDoNotLoadUnrelatedHistoryOrRepeatSnapshot(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)
	backend, err := storage.NewDatabaseBackend("sqlite:///:memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	counting := &canvasReadCountingBackend{Backend: backend, JSONDocumentBackend: backend, reads: map[string]int{}}
	app.canvasAgent.Close()
	app.canvas = service.NewCanvasDocumentService(counting)
	app.canvasAgent = service.NewCanvasAgentService(context.Background(), nil, app.canvas, nil, nil, nil)

	for _, withRun := range []bool{false, true} {
		t.Run(fmt.Sprintf("run_%t", withRun), func(t *testing.T) {
			var other service.CanvasWorkspaceResult
			for index := range 3 {
				other, err = app.canvas.Import(service.AuthRoleAdmin, service.CanvasDocument{Title: fmt.Sprintf("Unrelated %d", index), AgentSessions: json.RawMessage(fmt.Sprintf(`[{"id":"other-%d","messages":[{"role":"assistant","text":"%s"}]}]`, index, strings.Repeat("Unrelated private transcript. ", 4000)))})
				if err != nil {
					t.Fatal(err)
				}
			}
			doc := service.CanvasDocument{Title: "Selected project", AgentSessions: json.RawMessage(`[{"id":"selected","messages":[{"id":"reply","role":"assistant","text":"Selected transcript"}]},{"id":"inactive","messages":[{"id":"old","role":"assistant","text":"Inactive transcript retained"}]}]`), ActiveAgentSessionID: "selected"}
			if withRun {
				doc.AgentRun = &service.CanvasAgentRun{ID: "finished", SessionID: "selected", AssistantID: "reply", Status: "success"}
			}
			selected, importErr := app.canvas.Import(service.AuthRoleAdmin, doc)
			if importErr != nil {
				t.Fatal(importErr)
			}
			// Import clears execution metadata. Seed the persisted completed run.
			if withRun {
				for name := range counting.reads {
					if !strings.HasPrefix(name, "canvas_workspaces/") {
						continue
					}
					raw, loadErr := backend.LoadJSONDocument(name)
					if loadErr != nil {
						t.Fatal(loadErr)
					}
					root := raw.(map[string]any)
					for _, item := range root["projects"].([]any) {
						project := item.(map[string]any)
						if project["id"] == selected.Document.ID {
							project["agent_run"] = map[string]any{"id": "finished", "sessionId": "selected", "assistantId": "reply", "status": "success"}
						}
					}
					if err := backend.SaveJSONDocument(name, root); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := app.canvas.UpdateProject(service.AuthRoleAdmin, "activate", other.Document.ID, ""); err != nil {
				t.Fatal(err)
			}
			for _, history := range []string{"", "active", "editor"} {
				partial, deferred := history != "", history == "editor"
				for _, endpoint := range []string{"/api/canvas", "/api/canvas/agent-runs", "/api/canvas:activate"} {
					if deferred && endpoint == "/api/canvas/agent-runs" {
						continue
					}
					counting.reads = map[string]int{}
					query := ""
					if partial {
						query = "&history=" + history
					}
					req := httptest.NewRequest(http.MethodGet, endpoint+"?project_id="+url.QueryEscape(selected.Document.ID)+query, nil)
					if endpoint == "/api/canvas:activate" {
						req = httptest.NewRequest(http.MethodPost, "/api/canvas?project_id="+url.QueryEscape(selected.Document.ID)+query, strings.NewReader(fmt.Sprintf(`{"action":"activate","project_id":%q}`, selected.Document.ID)))
					}
					setRequestAuthCookie(req, authorization)
					response := httptest.NewRecorder()
					app.Handler().ServeHTTP(response, req)
					if response.Code != http.StatusOK {
						t.Fatalf("load selected project: %d %s", response.Code, response.Body.String())
					}
					var result service.CanvasWorkspaceResult
					if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
						t.Fatal(err)
					}
					if result.Document.ID != selected.Document.ID || (endpoint == "/api/canvas" && result.ActiveProjectID != selected.Document.ID) || strings.Contains(string(result.Document.AgentSessions), "Selected transcript") == deferred {
						t.Fatalf("wrong project or missing history: %+v", result)
					}
					if withRun && (result.Document.AgentRun == nil || result.Document.AgentRun.Status != "success") {
						t.Fatal("completed run lost", result.Document.AgentRun)
					}
					rootReads, chunkReads := 0, 0
					for name, count := range counting.reads {
						if strings.HasPrefix(name, "canvas_workspaces/") {
							rootReads += count
						}
						if strings.HasPrefix(name, "canvas_agent_history/") {
							chunkReads += count
						}
					}
					expectedChunks := 2
					if partial {
						expectedChunks = 1
					}
					if deferred {
						expectedChunks = 0
						if result.Document.ActiveAgentSessionID != "selected" || len(result.Document.AgentSessionSummaries) != 2 || string(result.Document.AgentSessions) != "[]" {
							t.Fatal("deferred editor must retain the active id and the complete session directory")
						}
					}
					if result.Document.AgentHistoryPartial != partial || strings.Contains(string(result.Document.AgentSessions), "Inactive transcript retained") == partial {
						t.Fatal("wrong history scope", partial)
					}
					if rootReads != 1 || chunkReads != expectedChunks {
						t.Fatalf("selected project reread or unrelated history loaded: roots=%d chunks=%d reads=%v", rootReads, chunkReads, counting.reads)
					}
				}
			}
			workspace, err := app.canvas.Workspace(service.AuthRoleAdmin)
			if err != nil || workspace.ActiveProjectID != selected.Document.ID {
				t.Fatal("activation did not persist its target", err)
			}
		})
	}
}

func TestCanvasProjectListReturnsSummariesWithoutLoadingHistory(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)
	backend, err := storage.NewDatabaseBackend("sqlite:///:memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	counting := &canvasReadCountingBackend{Backend: backend, JSONDocumentBackend: backend, reads: map[string]int{}}
	app.canvasAgent.Close()
	app.canvas = service.NewCanvasDocumentService(counting)
	app.canvasAgent = service.NewCanvasAgentService(context.Background(), nil, app.canvas, nil, nil, nil)

	request := func(method, body string, authorized bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/api/canvas?view=projects", strings.NewReader(body))
		if authorized {
			setRequestAuthCookie(req, authorization)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		return response
	}
	readList := func(response *httptest.ResponseRecorder) service.CanvasProjectList {
		t.Helper()
		if response.Code != http.StatusOK {
			t.Fatalf("project list status = %d: %s", response.Code, response.Body.String())
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if len(fields) != 2 || fields["projects"] == nil || fields["active_project_id"] == nil || fields["document"] != nil {
			t.Fatal("project list returned more than summary and selection fields")
		}
		var result service.CanvasProjectList
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if response := request(http.MethodGet, "", false); response.Code != http.StatusUnauthorized || len(counting.reads) != 0 {
		t.Fatalf("anonymous project list status = %d, reads = %v", response.Code, counting.reads)
	}
	first := readList(request(http.MethodGet, "", true))
	if len(first.Projects) != 1 || first.ActiveProjectID != first.Projects[0].ID {
		t.Fatal("first open did not initialize the default canvas")
	}
	private, err := app.canvas.Import("separate-owner", service.CanvasDocument{Title: "Other owner project"})
	if err != nil {
		t.Fatal(err)
	}
	active, err := app.canvas.Import(service.AuthRoleAdmin, service.CanvasDocument{
		Title:         "Selected canvas",
		Nodes:         []service.CanvasNode{{ID: "text-node", Type: "text", Width: 300, Height: 180, ScaleX: 1, ScaleY: 1, Prompt: "Private node text"}},
		AgentSessions: json.RawMessage(fmt.Sprintf(`[{"id":"active","messages":[{"role":"assistant","text":"%s"}]}]`, strings.Repeat("Private transcript. ", 4000))),
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := app.canvas.UpdateProject(service.AuthRoleAdmin, "create", "", "Newer inactive canvas")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.canvas.UpdateProject(service.AuthRoleAdmin, "activate", active.Document.ID, ""); err != nil {
		t.Fatal(err)
	}
	counting.reads = map[string]int{}
	list := readList(request(http.MethodGet, "", true))
	if list.ActiveProjectID != active.Document.ID || len(list.Projects) != 3 || list.Projects[0].ID != other.Document.ID {
		t.Fatalf("wrong project list or active selection: %+v", list)
	}
	selected := list.Projects[1]
	if selected.ID != active.Document.ID || selected.Title != active.Document.Title || selected.NodeCount != 1 ||
		selected.Revision != active.Document.Revision || selected.UpdatedAt != active.Document.UpdatedAt || selected.CreatedAt != active.Document.CreatedAt {
		t.Fatalf("selected project summary = %+v", selected)
	}
	for _, project := range list.Projects {
		if project.ID == private.Document.ID {
			t.Fatal("project list leaked another owner")
		}
	}
	rootReads, selectionReads := 0, 0
	for name, count := range counting.reads {
		switch {
		case strings.HasPrefix(name, "canvas_workspaces/"):
			rootReads += count
		case strings.HasPrefix(name, "canvas_active_projects/"):
			selectionReads += count
		default:
			t.Fatalf("unexpected project list storage read %q", name)
		}
	}
	if rootReads != 1 || selectionReads != 1 {
		t.Fatalf("directory read the workspace or pointer repeatedly: %v", counting.reads)
	}

	renamed := readList(request(http.MethodPost, fmt.Sprintf(`{"action":"rename","project_id":%q,"title":"Renamed canvas","revision":%d}`, active.Document.ID, selected.Revision), true))
	if renamed.ActiveProjectID != active.Document.ID || renamed.Projects[1].Title != "Renamed canvas" || renamed.Projects[1].Revision != selected.Revision+1 {
		t.Fatalf("rename returned incorrect metadata: %+v", renamed)
	}
	saved, err := app.canvas.Project(service.AuthRoleAdmin, active.Document.ID)
	if err != nil || !bytes.Equal(saved.AgentSessions, active.Document.AgentSessions) || saved.Nodes[0].Prompt != "Private node text" {
		t.Fatal("listing or renaming changed project content", err)
	}
}

func TestWriteCanvasMutationErrorPreservesPublicMappings(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		fallback string
		status   int
		message  string
	}{
		{
			name:     "revision conflict",
			err:      fmt.Errorf("stale update: %w", service.ErrCanvasRevisionConflict),
			fallback: "failed to save canvas",
			status:   http.StatusConflict,
			message:  "stale update: canvas revision conflict",
		},
		{
			name:     "invalid document",
			err:      fmt.Errorf("invalid node: %w", service.ErrInvalidCanvasDocument),
			fallback: "failed to update canvas project",
			status:   http.StatusBadRequest,
			message:  "invalid node: invalid canvas document",
		},
		{
			name:     "internal failure",
			err:      errors.New("private storage detail"),
			fallback: "failed to clear canvas",
			status:   http.StatusInternalServerError,
			message:  "failed to clear canvas",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeCanvasMutationError(response, test.err, test.fallback)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			var payload struct {
				Detail struct {
					Error string `json:"error"`
				} `json:"detail"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error response: %v", err)
			}
			if payload.Detail.Error != test.message {
				t.Fatalf("message = %q, want %q", payload.Detail.Error, test.message)
			}
		})
	}
}

func TestCanvasSessionMetadataUpdatesReturnSmallReceiptsAndRejectStaleHistory(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	request := func(method, path string, data any, authenticated bool) *httptest.ResponseRecorder {
		body, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if authenticated {
			setRequestAuthCookie(req, token)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		return response
	}
	var workspace service.CanvasWorkspaceResult
	response := request(http.MethodGet, "/api/canvas", nil, true)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &workspace) != nil {
		t.Fatal("could not read initial canvas")
	}
	workspace.Document.AgentSessions, _ = json.Marshal([]map[string]any{{"id": "s", "title": "Original", "messages": []map[string]any{{"id": "u", "role": "user", "text": "Keep request"}}, "protocolMessages": []map[string]any{{"role": "assistant", "content": strings.Repeat("Private complete protocol. ", 50000)}}}})
	workspace.Document.ActiveAgentSessionID = "s"
	response = request(http.MethodPut, "/api/canvas", workspace.Document, true)
	if response.Code != http.StatusOK {
		t.Fatalf("could not save fixture: %d", response.Code)
	}
	response = request(http.MethodGet, "/api/canvas?history=active", nil, true)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &workspace) != nil {
		t.Fatal("could not read versioned history")
	}
	partial := workspace.Document
	partial.AgentSessions = json.RawMessage("[]")
	partial.AgentSessionUpdates = []service.CanvasAgentSessionUpdate{{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"codex"`)}}}
	if response := request(http.MethodPut, "/api/canvas", partial, false); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated metadata write returned %d", response.Code)
	}
	response = request(http.MethodPut, "/api/canvas", partial, true)
	var receipt struct {
		Document service.CanvasDocument `json:"document"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &receipt) != nil || response.Body.Len() > 10000 || strings.Contains(response.Body.String(), "Private complete protocol") || string(receipt.Document.AgentSessions) != "[]" || len(receipt.Document.AgentSessionUpdates) != 1 {
		t.Fatalf("metadata save did not return a small accepted receipt: status=%d bytes=%d", response.Code, response.Body.Len())
	}
	partial.Revision = receipt.Document.Revision
	if response := request(http.MethodPut, "/api/canvas", partial, true); response.Code != http.StatusConflict {
		t.Fatalf("stale conversation hash bypassed current canvas revision: %d", response.Code)
	}
	response = request(http.MethodGet, "/api/canvas", nil, true)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &workspace) != nil {
		t.Fatal("could not reopen saved history")
	}
	var sessions []map[string]any
	if json.Unmarshal(workspace.Document.AgentSessions, &sessions) != nil || len(sessions) != 1 || sessions[0]["engine"] != "codex" || !strings.Contains(string(workspace.Document.AgentSessions), "Private complete protocol") {
		t.Fatal("metadata save lost history after reopening")
	}
}

func TestCanvasAgentHistoryPagesRequireOwnerAndCurrentRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)
	request := func(path string, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if authenticated {
			setRequestAuthCookie(req, authorization)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		return response
	}
	workspaceResponse := request("/api/canvas", true)
	if workspaceResponse.Code != http.StatusOK {
		t.Fatal(workspaceResponse.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(workspaceResponse.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	var sessions []map[string]any
	for index := range 25 {
		sessions = append(sessions, map[string]any{"id": fmt.Sprintf("http-session-%d", index), "title": fmt.Sprintf("History %d", index), "messages": []map[string]any{{"id": "reply", "role": "assistant", "text": strings.Repeat("Private transcript. ", 1000)}}})
	}
	workspace.Document.AgentSessions, _ = json.Marshal(sessions)
	body, _ := json.Marshal(workspace.Document)
	saveRequest := httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(body))
	saveRequest.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(saveRequest, authorization)
	saveResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(saveResponse, saveRequest)
	if saveResponse.Code != http.StatusOK {
		t.Fatal(saveResponse.Body.String())
	}
	var saved struct {
		Document service.CanvasDocument `json:"document"`
	}
	if err := json.Unmarshal(saveResponse.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	base := "/api/canvas/agent-history?project_id=" + url.QueryEscape(saved.Document.ID)
	response := request(base, true)
	var page service.CanvasAgentHistoryPage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Sessions) != 20 || page.NextCursor == "" || strings.Contains(response.Body.String(), "Private transcript") {
		t.Fatalf("invalid public history page: %d %s", response.Code, response.Body.String())
	}
	second := request(base+"&cursor="+url.QueryEscape(page.NextCursor), true)
	var remaining service.CanvasAgentHistoryPage
	if second.Code != http.StatusOK || json.Unmarshal(second.Body.Bytes(), &remaining) != nil || len(remaining.Sessions) != 5 || remaining.NextCursor != "" {
		t.Fatalf("second page invalid: %d %s", second.Code, second.Body.String())
	}
	sessionPath := base + "&session_id=http-session-24&revision=" + strconv.FormatInt(page.Revision, 10)
	selected := request(sessionPath, true)
	if selected.Code != http.StatusOK || !strings.Contains(selected.Body.String(), "Private transcript") || strings.Contains(selected.Body.String(), "http-session-23") {
		t.Fatalf("selected history invalid: %d %s", selected.Code, selected.Body.String())
	}
	foreign, err := app.canvas.Import("other-history-owner", service.CanvasDocument{Title: "Other owner", AgentSessions: saved.Document.AgentSessions})
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		path          string
		authenticated bool
		status        int
	}{
		{base, false, http.StatusUnauthorized},
		{"/api/canvas/agent-history", true, http.StatusBadRequest},
		{base + "&limit=51", true, http.StatusBadRequest},
		{base + "&limit=oops", true, http.StatusBadRequest},
		{base + "&cursor=not-a-cursor", true, http.StatusBadRequest},
		{base + "&session_id=http-session-24", true, http.StatusBadRequest},
		{base + "&session_id=missing&revision=" + strconv.FormatInt(page.Revision, 10), true, http.StatusBadRequest},
		{base + "&session_id=http-session-24&revision=0", true, http.StatusConflict},
		{"/api/canvas/agent-history?project_id=" + url.QueryEscape(foreign.Document.ID), true, http.StatusBadRequest},
	} {
		if response := request(fixture.path, fixture.authenticated); response.Code != fixture.status || strings.Contains(response.Body.String(), "Private transcript") {
			t.Fatalf("history access %s: status=%d want=%d body=%s", fixture.path, response.Code, fixture.status, response.Body.String())
		}
	}
	editorResponse := request("/api/canvas?history=active&project_id="+url.QueryEscape(saved.Document.ID), true)
	var editor service.CanvasWorkspaceResult
	if editorResponse.Code != http.StatusOK || json.Unmarshal(editorResponse.Body.Bytes(), &editor) != nil || !editor.Document.AgentHistoryPartial || len(editor.Document.AgentSessionSummaries) != 25 {
		t.Fatal("editor history projection failed", editorResponse.Body.String())
	}
	var selectedBodies []json.RawMessage
	_ = json.Unmarshal(editor.Document.AgentSessions, &selectedBodies)
	if len(selectedBodies) != 1 {
		t.Fatal("editor downloaded inactive session bodies")
	}
	editor.Document.AgentSessions = json.RawMessage(`[]`)
	editor.Document.DeletedAgentSessionIDs = []string{"http-session-24"}
	body, _ = json.Marshal(editor.Document)
	partialRequest := httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(body))
	partialRequest.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(partialRequest, authorization)
	partialResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(partialResponse, partialRequest)
	if partialResponse.Code != http.StatusOK {
		t.Fatal("partial save failed", partialResponse.Body.String())
	}
	var receipt struct {
		Document service.CanvasDocument `json:"document"`
	}
	if err := json.Unmarshal(partialResponse.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(receipt.Document.AgentSessions, &selectedBodies); err != nil || len(selectedBodies) != 0 || len(receipt.Document.AgentSessionSummaries) != 24 || !receipt.Document.AgentHistoryPartial {
		t.Fatalf("save response retransmitted unchanged transcript: bodies=%d error=%v", len(selectedBodies), err)
	}
	fullResponse := request("/api/canvas?project_id="+url.QueryEscape(saved.Document.ID), true)
	var complete service.CanvasWorkspaceResult
	if fullResponse.Code != http.StatusOK || json.Unmarshal(fullResponse.Body.Bytes(), &complete) != nil || complete.Document.AgentHistoryPartial || strings.Contains(fullResponse.Body.String(), "http-session-24") {
		t.Fatal("full export retained deleted history", fullResponse.Body.String())
	}
	_ = json.Unmarshal(complete.Document.AgentSessions, &selectedBodies)
	if len(selectedBodies) != 24 {
		t.Fatalf("partial save erased unloaded sessions: got %d", len(selectedBodies))
	}
}

func TestCanvasClearRequiresExplicitProjectID(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("missing project id status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas?project_id="+url.QueryEscape(workspace.Document.ID)+"&revision="+strconv.FormatInt(workspace.Document.Revision, 10), nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("clear status = %d body = %s", res.Code, res.Body.String())
	}
	var payload struct {
		Document service.CanvasDocument `json:"document"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("clear json: %v", err)
	}
	if payload.Document.ID != workspace.Document.ID {
		t.Fatalf("cleared project id = %q, want %q", payload.Document.ID, workspace.Document.ID)
	}
}

func TestCanvasClearRejectsStaleRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	updated := workspace.Document
	updated.Title = "更新后的画布"
	data, err := json.Marshal(updated)
	if err != nil {
		t.Fatalf("Marshal(canvas) error = %v", err)
	}
	req = httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(data))
	setRequestAuthCookie(req, authorization)
	req.Header.Set("Content-Type", "application/json")
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("save status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas?project_id="+url.QueryEscape(workspace.Document.ID)+"&revision="+strconv.FormatInt(workspace.Document.Revision, 10), nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale clear status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestCanvasSaveRejectsStaleRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	save := func(document service.CanvasDocument) *httptest.ResponseRecorder {
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatalf("Marshal(canvas) error = %v", err)
		}
		req := httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(data))
		setRequestAuthCookie(req, authorization)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	first := workspace.Document
	first.Title = "第一台设备"
	res = save(first)
	if res.Code != http.StatusOK {
		t.Fatalf("first save status = %d body = %s", res.Code, res.Body.String())
	}
	stale := workspace.Document
	stale.Title = "第二台设备"
	res = save(stale)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale save status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestDefaultUserCanvasImageUploadStoresPrivateGalleryImage(t *testing.T) {
	const imageBaseURL = "https://assets.example.test"

	t.Setenv("IMAGE_BASE_URL", imageBaseURL)
	app := newTestApp(t)
	defer app.Close()
	_, rawKey, err := createTestUserSession(app, "canvas-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	authorization := "Bearer " + rawKey

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "reference.png")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatalf("encode upload png: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/canvas/images", body)
	setRequestAuthCookie(req, authorization)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body = %s", res.Code, res.Body.String())
	}

	var payload struct {
		URL         string `json:"url"`
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("upload json: %v", err)
	}
	if !strings.HasPrefix(payload.URL, imageBaseURL+"/images/") || payload.Name != "reference.png" || payload.ContentType != "image/png" {
		t.Fatalf("upload payload = %#v", payload)
	}

	parsed, err := url.Parse(payload.URL)
	if err != nil {
		t.Fatalf("parse image url: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, parsed.Path, nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.Len() == 0 {
		t.Fatalf("stored image status = %d bytes = %d", res.Code, res.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=mine", nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("gallery status = %d body = %s", res.Code, res.Body.String())
	}
	var gallery struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &gallery); err != nil {
		t.Fatalf("gallery json: %v", err)
	}
	if len(gallery.Items) != 1 || gallery.Items[0]["visibility"] != "private" {
		t.Fatalf("gallery items = %#v", gallery.Items)
	}
}

func TestCanceledCanvasImageUploadDoesNotCreateImageOrThumbnail(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "canceled.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/canvas/images", body)
	setRequestAuthCookie(request, authorization)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request.WithContext(ctx))
	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("upload status = %d, want %d; body = %s", response.Code, http.StatusRequestTimeout, response.Body.String())
	}
	items, err := app.images.ListImages("", "", "", service.ImageAccessScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(items["items"].([]map[string]any)); got != 0 {
		t.Fatalf("canceled upload created %d images", got)
	}
	thumbnailEntries, err := os.ReadDir(app.config.ImageThumbnailsDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(thumbnailEntries) != 0 {
		t.Fatalf("canceled upload created thumbnails: %#v", thumbnailEntries)
	}
}

func TestCanvasUploadWaitsForImageSlotBeforeReadingBody(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	app.imageUploadSlots = make(chan struct{}, 1)
	app.imageUploadSlots <- struct{}{}
	defer func() { <-app.imageUploadSlots }()
	request := httptest.NewRequest(http.MethodPost, "/api/canvas/images", strings.NewReader("unread multipart body"))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	setRequestAuthCookie(request, token)
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request.WithContext(ctx))
	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("canceled upload status = %d, body = %s", response.Code, response.Body.String())
	}
}
