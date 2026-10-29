package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestCanvasAgentModelImagesKeepPublicURLsAndResolveProtectedImagesAtTransport(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner := service.Identity{ID: "image-owner"}
	var pixels bytes.Buffer
	if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	upload, err := app.storageFiles.Upload(context.Background(), owner.ID, false, "product.png", "image/png", pixels.Bytes(), nil)
	if err != nil {
		t.Fatal(err)
	}
	public := "https://cdn.example.test/product.png"
	messages := []map[string]any{{"role": "user", "content": []map[string]any{
		{"type": "text", "text": "比较两张产品图"},
		{"type": "image_url", "image_url": map[string]any{"url": upload.URL}},
		{"type": "image_url", "image_url": map[string]any{"url": public}},
	}}}
	before, _ := json.Marshal(messages)
	converted, err := app.canvasAgentModelImages(context.Background(), owner, messages)
	if err != nil {
		t.Fatal(err)
	}
	parts := util.AsMapSlice(converted[0]["content"])
	if !strings.HasPrefix(util.Clean(parts[1]["image_url"].(map[string]any)["url"]), "data:image/png;base64,") || parts[2]["image_url"].(map[string]any)["url"] != public {
		t.Fatal("incorrect image transport")
	}
	after, _ := json.Marshal(messages)
	if !bytes.Equal(before, after) {
		t.Fatal("transport conversion mutated agent memory")
	}
	if _, err := app.canvasAgentModelImages(context.Background(), service.Identity{ID: "other-owner"}, messages); err == nil {
		t.Fatal("private image ownership bypassed")
	}
}

func TestCanvasAgentHTTPContinuesAfterRequestDisconnect(t *testing.T) {
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
	doc.AgentSessions = json.RawMessage(`[{"id":"s","title":"后台验证","messages":[{"id":"u","role":"user","text":"hello"},{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	app.canvasAgent.Close()
	app.canvasAgent = service.NewCanvasAgentService(app.ctx, app.canvas, app.agentSkills, func(ctx context.Context, _ service.Identity, _ service.CanvasAgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
			return map[string]any{"text_response": "后台已完成"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}, nil)
	body, _ := json.Marshal(service.CanvasAgentRequest{ID: "run-http", SessionID: "s", AssistantID: "a", UserText: "hello", Model: "agent-test", RelayTokenName: "test", APIMode: "responses"})
	path := "/api/canvas/agent-runs?project_id=" + doc.ID

	malformed := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(append(append([]byte{}, body...), []byte(" {}")...)))
	setRequestAuthCookie(malformed, token)
	rejected := httptest.NewRecorder()
	app.Handler().ServeHTTP(rejected, malformed)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("trailing JSON accepted: %d", rejected.Code)
	}
	requestCtx, disconnect := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)).WithContext(requestCtx)
	setRequestAuthCookie(req, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	<-entered
	disconnect()
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		get := httptest.NewRequest(http.MethodGet, path, nil)
		setRequestAuthCookie(get, token)
		result := httptest.NewRecorder()
		app.Handler().ServeHTTP(result, get)
		if result.Code != 200 {
			t.Fatal(result.Body.String())
		}
		var snapshot struct {
			Document service.CanvasDocument `json:"document"`
		}
		if err := json.Unmarshal(result.Body.Bytes(), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Document.AgentRun.Status == "success" {
			if calls.Load() != 1 {
				t.Fatal("model executed repeatedly")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("disconnected request interrupted backend run")
}
func TestCanvasAgentHTTPRequiresAuthentication(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, method := range []string{"GET", "POST", "DELETE"} {
		r := httptest.NewRequest(method, "/api/canvas/agent-runs?project_id=unknown", nil)
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s returned %d", method, w.Code)
		}
	}
}
func TestCanvasAgentImageRejectsPrivateNetworkReferences(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, url := range []string{"file:///etc/passwd", "http://127.0.0.1/secret", "http://169.254.169.254/latest/meta-data"} {
		if _, err := app.canvasAgentImage(context.Background(), service.Identity{ID: "user"}, url); err == nil {
			t.Fatalf("accepted %s", url)
		}
	}
}

func TestCanvasAgentAudioReferenceEnforcesOwnership(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.canvasAgentVideoReference(context.Background(), service.Identity{ID: "user"}, "https://example.test/audios/not-owned.mp3", "audio"); err == nil {
		t.Fatal("protected audio reference forwarded without ownership check")
	}
}

func TestCanvasAgentHTTPExternalToolsValidateAndShareRunSnapshots(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	workspace, err := app.canvas.Workspace(identityScope(*identity))
	if err != nil {
		t.Fatal(err)
	}
	doc := workspace.Document
	doc.AgentSessions = json.RawMessage(`[{"id":"s","messages":[{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc)
	if err != nil {
		t.Fatal(err)
	}
	request := service.CanvasAgentToolRequest{Context: service.CanvasAgentRequest{ID: "tool", SessionID: "s", AssistantID: "a", UserText: "查看画布", APIMode: "responses"}}
	request.Call.ID, request.Call.Name, request.Call.Arguments = "tool", "get_canvas_summary", map[string]any{}
	body, _ := json.Marshal(request)
	path := "/api/canvas/agent-tools?project_id=" + doc.ID
	send := func(path string, body []byte, authenticated bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		if authenticated {
			setRequestAuthCookie(r, token)
		}
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		return w
	}
	if w := send(path, body, false); w.Code != 401 {
		t.Fatalf("anonymous status %d", w.Code)
	}
	for _, invalid := range [][]byte{append(append([]byte{}, body...), []byte(" {}")...), []byte(`{"context":{},"call":{},"approved":true}`)} {
		if w := send(path, invalid, true); w.Code != 400 {
			t.Fatalf("invalid payload status %d", w.Code)
		}
	}
	if w := send(path, body, true); w.Code != 200 {
		t.Fatalf("tool status %d: %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, e := app.canvasAgent.Snapshot(*identity, doc.ID)
		if e != nil {
			t.Fatal(e)
		}
		if snapshot.AgentRun.Status != "running" {
			if snapshot.AgentRun.ToolResult["ok"] != true {
				t.Fatal(snapshot.AgentRun.ToolResult)
			}
			review := send("/api/canvas/agent-tools/review-answers?project_id="+doc.ID, []byte(`{"sessionId":"s","prompts":{},"answer":"确认"}`), true)
			if review.Code != 400 {
				t.Fatalf("approved nonexistent review: %d", review.Code)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("tool run did not finish")
}
