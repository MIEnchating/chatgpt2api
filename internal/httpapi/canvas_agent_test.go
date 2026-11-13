package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
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
	app.canvasAgent = service.NewCanvasAgentService(app.ctx, app.agentExecutions, app.canvas, app.agentSkills, func(ctx context.Context, _ service.Identity, _ service.AgentModelRequest) (map[string]any, error) {
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
	malformed.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(malformed, token)
	rejected := httptest.NewRecorder()
	app.Handler().ServeHTTP(rejected, malformed)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("trailing JSON accepted: %d", rejected.Code)
	}
	requestCtx, disconnect := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)).WithContext(requestCtx)
	req.Header.Set("Content-Type", "application/json")
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
	if _, err := app.canvasAgentVideoReference(context.Background(), service.Identity{ID: "user"}, "https://example.test/audios/not-owned.mp3", "audio", protocol.DefaultVideoContracts()[0]); err == nil {
		t.Fatal("protected audio reference forwarded without ownership check")
	}
}

func TestCanvasAgentVideoReferenceHonorsContractTransport(t *testing.T) {
	for _, transport := range []string{"url", "base64", "multipart"} {
		for _, baseURL := range []string{"", "https://media.example.test", "https://media.example.test/base"} {
			for _, site := range []string{"", "https://canvas.example.test", "http://127.0.0.1:8002"} {
				t.Run(transport+"/"+baseURL+"/"+site, func(t *testing.T) {
					t.Setenv("IMAGE_BASE_URL", baseURL)
					app := newTestApp(t)
					defer app.Close()
					owner := service.Identity{ID: "reference-owner"}
					var pixels bytes.Buffer
					if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
						t.Fatal(err)
					}
					upload, err := app.storageFiles.Upload(context.Background(), owner.ID, false, "reference.png", "image/png", pixels.Bytes(), nil)
					if err != nil {
						t.Fatal(err)
					}
					contract := protocol.DefaultVideoContracts()[0]
					contract.Transport.LocalMaterial = transport
					ctx := context.WithValue(context.Background(), mediaBaseURLContextKey{}, site)
					result, err := app.canvasAgentVideoReference(ctx, owner, upload.URL, "image", contract)
					if transport == "url" && baseURL == "" && !isPublicReferenceURL(site) {
						if err == nil || !strings.Contains(err.Error(), "IMAGE_BASE_URL") {
							t.Fatalf("URL-only reference did not report unusable site: result=%q err=%v", result, err)
						}
						return
					}
					if err != nil || transport == "url" && !isPublicReferenceURL(result) || transport != "url" && !isLocalVideoReferencePath(result) {
						t.Fatalf("reference transport mismatch: result=%q err=%v", result, err)
					}
					if transport == "url" {
						wantBase := baseURL
						if wantBase == "" {
							wantBase = site
						}
						if !strings.HasPrefix(result, wantBase+"/") {
							t.Fatalf("wrong reference base: %s", result)
						}
					}
					file, local, localErr := app.localVideoReferenceFile(result)
					if localErr != nil || !local || !bytes.Equal(file.Data, pixels.Bytes()) {
						t.Fatalf("local reference resolution: local=%v err=%v", local, localErr)
					}
					if !app.validReferenceCapability(httptest.NewRequest(http.MethodGet, result, nil).URL, time.Now()) {
						t.Fatal("reference signature was lost during transport conversion")
					}
				})
			}
		}
	}
}

func TestCanvasAgentGeneratedMaterialSubmissionPriority(t *testing.T) {
	t.Setenv("IMAGE_BASE_URL", "https://media.example.test/base")
	app := newTestApp(t)
	defer app.Close()
	owner := service.Identity{ID: "generated-material-owner"}
	var pixels bytes.Buffer
	if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	upload, err := app.storageFiles.Upload(context.Background(), owner.ID, false, "generated.png", "image/png", pixels.Bytes(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, methods := range [][]string{{"url"}, {"base64"}, {"multipart"}, {"url", "base64"}, {"url", "multipart"}, {"base64", "multipart"}, {"url", "base64", "multipart"}} {
		for _, format := range []string{"data_url", "raw"} {
			t.Run(strings.Join(methods, "+")+"/"+format, func(t *testing.T) {
				contract := protocol.DefaultVideoContracts()[0]
				contract.Transport.MaterialTransports = methods
				contract.Transport.LocalMaterial = "url"
				contract.Transport.Base64Format = format
				contract, err := protocol.NormalizeVideoModelContract(contract)
				if err != nil {
					t.Fatal(err)
				}
				want := "url"
				for _, method := range methods {
					if method == "base64" {
						want = "base64"
					}
				}
				for _, method := range methods {
					if method == "multipart" {
						want = "multipart"
					}
				}
				reference, err := app.canvasAgentVideoReference(context.Background(), owner, upload.URL, "image", contract)
				if err != nil {
					t.Fatal(err)
				}
				posts := 0
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					posts++
					if want == "multipart" {
						if err := r.ParseMultipartForm(1024); err != nil {
							t.Error(err)
							return
						}
						defer r.MultipartForm.RemoveAll()
						file, _, err := r.FormFile(contract.Transport.MultipartFileField)
						if err != nil {
							t.Error(err)
							return
						}
						defer file.Close()
						data, _ := io.ReadAll(file)
						if !bytes.Equal(data, pixels.Bytes()) {
							t.Error("uploaded material bytes changed")
						}
					} else {
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Error(err)
							return
						}
						value := util.Clean(videoJSONPathValue(body, contract.Request.FirstFrameField))
						expected := reference
						if want == "base64" {
							expected = base64.StdEncoding.EncodeToString(pixels.Bytes())
							if format == "data_url" {
								expected = "data:image/png;base64," + expected
							}
						}
						if value != expected {
							t.Errorf("material encoding did not follow %s", want)
						}
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"status": "failed", "error": "fixture stopped after submit"})
				}))
				defer upstream.Close()
				payload := map[string]any{"model": contract.Models[0], "prompt": "Animate generated material", "first_frame_url": reference, "api_key": "fixture", "relay_base_url": upstream.URL, protocol.VideoContractSnapshotPayloadKey: contract}
				before, _ := json.Marshal(payload)
				_, err = app.relayVideoTask(context.Background(), payload)
				if err == nil || posts != 1 {
					t.Fatalf("submit count = %d, err = %v", posts, err)
				}
				after, _ := json.Marshal(payload)
				if !bytes.Equal(before, after) {
					t.Fatal("upstream encoding mutated durable task data")
				}
			})
		}
	}
}

func TestCanvasAgentBase64ReferenceArrayKeepsStoredReferences(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	var pixels bytes.Buffer
	if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	stored, err := app.storeReferenceUpload(context.Background(), referenceUpload{data: pixels.Bytes()}, ".png", "image/png", "image", "/video-image-references/")
	if err != nil {
		t.Fatal(err)
	}
	reference := util.Clean(stored["url"])
	contract := protocol.DefaultVideoContracts()[0]
	contract.Transport.LocalMaterial = "base64"
	contract.Request.ReferenceImagesField = "media.images"
	refs := []string{reference, reference}
	request := declaredCanonicalVideoContractRequestPayload(map[string]any{"reference_mode": "reference", "reference_image_urls": refs}, contract)
	if err := app.encodeVideoContractBase64Materials(request, contract, "reference"); err != nil {
		t.Fatal(err)
	}
	encoded := util.AsStringSlice(videoJSONPathValue(request, "media.images"))
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pixels.Bytes())
	if len(encoded) != 2 || encoded[0] != want || encoded[1] != want || refs[0] != reference || refs[1] != reference {
		t.Fatal("Base64 array conversion changed the stored material references")
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
		r.Header.Set("Content-Type", "application/json")
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

func TestCanvasAgentHTTPVideoModelToolsUseServerConfiguration(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"video_models": []string{"minimax-h3-768p", "unknown-video"}}); err != nil {
		t.Fatal(err)
	}
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	workspace, err := app.canvas.Workspace(identityScope(*identity))
	if err != nil {
		t.Fatal(err)
	}
	doc := workspace.Document
	doc.AgentSessions = json.RawMessage(`[{"id":"s","messages":[{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	if doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc); err != nil {
		t.Fatal(err)
	}
	for i, tc := range []struct {
		name string
		args map[string]any
	}{
		{"list_video_models", map[string]any{}},
		{"set_video_model", map[string]any{"model": "minimax-h3-768p"}},
		{"get_generation_config", map[string]any{}},
	} {
		runID := fmt.Sprintf("video-tool-%d", i)
		input := service.CanvasAgentToolRequest{Context: service.CanvasAgentRequest{
			ID: runID, SessionID: "s", AssistantID: "a", UserText: "切换有声视频模型", APIMode: "responses",
			Generation: map[string]any{"videoModel": "unknown-video", "videoSupportsAudio": false, "capabilities": map[string]any{"video": map[string]any{"audioControl": "none"}}},
		}}
		input.Call.ID, input.Call.Name, input.Call.Arguments = runID, tc.name, tc.args
		body, _ := json.Marshal(input)
		r := httptest.NewRequest(http.MethodPost, "/api/canvas/agent-tools?project_id="+doc.ID, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(r, token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, r)
		if response.Code != 200 {
			t.Fatalf("%s: %d %s", tc.name, response.Code, response.Body.String())
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			doc, err = app.canvasAgent.Snapshot(*identity, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			if doc.AgentRun.Status != "running" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("video model tool did not finish")
			}
			time.Sleep(5 * time.Millisecond)
		}
		result := doc.AgentRun.ToolResult
		if result["ok"] != true {
			t.Fatal(tc.name, result)
		}
		if tc.name == "list_video_models" {
			models := util.AsMapSlice(result["models"])
			if len(models) != 2 || util.StringMap(models[0]["capabilities"])["audioControl"] != "always" || util.StringMap(models[1]["capabilities"])["audioControl"] != "unknown" {
				t.Fatal("server model catalog not used", models)
			}
		}
		if tc.name == "get_generation_config" {
			generation := util.StringMap(result["generation"])
			if generation["videoModel"] != "minimax-h3-768p" || generation["videoSupportsAudio"] != true {
				t.Fatal("stale browser capability or choice was trusted", generation)
			}
		}
	}
}

func TestCanvasAgentModelForwardsDirectlyWithoutCreatingBackgroundTask(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if r.URL.Path != "/v1/chat/completions" || body["stream"] != stream {
					t.Errorf("wrong transport: %s %v", r.URL.Path, body)
				}
				if body["prompt_cache_key"] != "agent-test-session" {
					t.Error("agent cache identity was lost before reaching upstream")
				}
				if stream && util.StringMap(body["stream_options"])["include_usage"] != true {
					t.Error("stream did not request real upstream usage")
				}
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"SDK reply\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
				} else {
					util.WriteJSON(w, 200, map[string]any{"choices": []map[string]any{{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": "SDK reply"}}}})
				}
			}))
			defer upstream.Close()
			identity := service.Identity{ID: "sdk-owner", Role: service.AuthRoleAdmin}
			externalWorkflowTestClient(app, upstream)
			config, err := app.customRelayConfigs.Create(identity.ID, "text", "SDK test", "http://sdk-model.example", "test-only-key", "openai", "")
			if err != nil {
				t.Fatal(err)
			}
			var progress string
			result, err := app.runAgentModel(context.Background(), identity, service.AgentModelRequest{Model: "test-model", Prompt: "SDK request", Messages: []map[string]any{{"role": "user", "content": "SDK request"}}, Metadata: map[string]any{"api_mode": "chat", "stream": stream, "relay_token_name": config.TokenName, "prompt_cache_key": "agent-test-session"}, OnText: func(text string) error { progress = text; return nil }})
			if err != nil || result["text_response"] != "SDK reply" {
				t.Fatalf("result=%v err=%v", result, err)
			}
			if stream && progress != "SDK reply" {
				t.Fatalf("stream progress=%q", progress)
			}
			tasks, err := app.tasks.ListTasksWithError(identity, nil)
			if err != nil || len(util.AsMapSlice(tasks["items"])) != 0 {
				t.Fatalf("model entered task queue: %v %v", tasks, err)
			}
		})
	}
}

func TestAgentModelCancellationClosesDirectUpstreamRequest(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	entered, closed := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
			return
		}
		close(entered)
		select {
		case <-r.Context().Done():
			close(closed)
		case <-time.After(5 * time.Second):
		}
	}))
	defer upstream.Close()
	identity := service.Identity{ID: "cancel-sdk", Role: service.AuthRoleAdmin}
	externalWorkflowTestClient(app, upstream)
	config, err := app.customRelayConfigs.Create(identity.ID, "text", "SDK cancel", "http://sdk-model.example", "test-only-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := app.runAgentModel(ctx, identity, service.AgentModelRequest{Model: "test-model", Messages: []map[string]any{{"role": "user", "content": "cancel this request"}}, Metadata: map[string]any{"api_mode": "chat", "stream": true, "relay_token_name": config.TokenName}})
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("model request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("model request ignored cancellation")
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request remained active")
	}
}

func TestCanvasAgentVideoCapabilitiesUseConfiguredAliasAndProfile(t *testing.T) {
	previous := protocol.ActiveVideoContracts()
	t.Cleanup(func() {
		if err := protocol.ReplaceVideoContracts(previous); err != nil {
			t.Fatal(err)
		}
	})
	contract, ok := protocol.VideoContractForModel("minimax-h3-768p")
	if !ok {
		t.Fatal("missing fixture contract")
	}
	contract.Name, contract.Models = "Custom video", []string{"minimax-h3-supper"}
	contract.Capability.AudioControl = "none"
	profile := protocol.VideoModelContractProfile{Model: "minimax-h3-supper", Capability: contract.Capability, Generation: contract.Generation, Rules: contract.Rules}
	profile.Capability.AudioControl = "always"
	contract.ModelProfiles = []protocol.VideoModelContractProfile{profile}
	if err := protocol.ReplaceVideoContracts(append(previous, contract)); err != nil {
		t.Fatal(err)
	}
	capabilities := canvasAgentVideoCapabilities("minimax-h3-supper")
	if capabilities["audioControl"] != "always" || capabilities["contractConfigured"] != true {
		t.Fatalf("configured alias/profile was guessed from its name or base contract: %v", capabilities)
	}
}

func TestCanvasAgentVideoCapabilitiesExposeMachineReadableDurationRange(t *testing.T) {
	previous := protocol.ActiveVideoContracts()
	t.Cleanup(func() {
		if err := protocol.ReplaceVideoContracts(previous); err != nil {
			t.Fatal(err)
		}
	})
	contract, ok := protocol.VideoContractForModel("minimax-h3-768p")
	if !ok {
		t.Fatal("missing fixture contract")
	}
	contract.Name, contract.Models = "Agent duration test", []string{"agent-duration-test"}
	contract.ModelProfiles = nil
	maximum := 30
	contract.Capability.Seconds = nil
	contract.Capability.DefaultSeconds = 6
	contract.Capability.SecondsRange = &protocol.VideoDurationRange{Min: 2, Max: &maximum, Step: 2}
	if err := protocol.ReplaceVideoContracts(append(previous, contract)); err != nil {
		t.Fatal(err)
	}
	capabilities := canvasAgentVideoCapabilities("agent-duration-test")
	duration := util.StringMap(capabilities["duration"])
	rangeSpec := util.StringMap(duration["secondsRange"])
	if util.ToInt(rangeSpec["min"], 0) != 2 || util.ToInt(rangeSpec["max"], 0) != 30 || util.ToInt(rangeSpec["step"], 0) != 2 {
		t.Fatalf("duration range was reduced to default-only values: %v", duration)
	}
}

func TestCanvasAgentHTTPToolKeepsSiteForBackgroundGeneration(t *testing.T) {
	t.Setenv("IMAGE_BASE_URL", "")
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
	if doc, err = app.canvas.SaveAtRevision(identityScope(*identity), doc); err != nil {
		t.Fatal(err)
	}
	gotBase := make(chan string, 1)
	app.canvasAgent.Close()
	app.canvasAgent = service.NewCanvasAgentService(app.ctx, app.agentExecutions, app.canvas, app.agentSkills, nil, func(ctx context.Context, _ service.Identity, _ service.CanvasNode, metadata map[string]any, _ func(int) error) (map[string]any, error) {
		gotBase <- util.Clean(metadata["media_base_url"])
		return map[string]any{"data": []map[string]any{{"url": "https://canvas.example.test/images/result.png"}}}, nil
	})
	input := service.CanvasAgentToolRequest{Context: service.CanvasAgentRequest{ID: "site-tool", SessionID: "s", AssistantID: "a", UserText: "生成一张图片", APIMode: "responses", Generation: map[string]any{"imageModel": "test", "autoGenerateMedia": true}}}
	input.Call.ID, input.Call.Name, input.Call.Arguments = "generate", "generate_image", map[string]any{"prompt": "A tree", "sourceNodeIds": []string{}, "size": "1:1", "count": 1}
	body, _ := json.Marshal(input)
	requestCtx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "https://canvas.example.test/api/canvas/agent-tools?project_id="+doc.ID, bytes.NewReader(body)).WithContext(requestCtx)
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	cancel()
	if response.Code != http.StatusOK {
		t.Fatalf("tool = %d %s", response.Code, response.Body.String())
	}
	select {
	case base := <-gotBase:
		if base != "https://canvas.example.test" {
			t.Fatalf("background site = %q", base)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("background generation did not run")
	}
}

func TestCanvasAgentVideoSubmissionHonorsWatermarkSettingsAndContract(t *testing.T) {
	watermarkOn, watermarkOff := true, false
	for _, tc := range []struct {
		name      string
		requested *bool
		supported bool
		forced    string
		want      bool
	}{
		{"enabled", &watermarkOn, true, "", true},
		{"disabled", &watermarkOff, true, "", false},
		{"unset", nil, true, "", false},
		{"forced_on", &watermarkOff, true, "true", true},
		{"forced_off", &watermarkOn, true, "false", false},
		{"unsupported", &watermarkOn, false, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
			contract := protocol.DefaultVideoContracts()[0]
			contract.Name = "Canvas watermark fixture"
			contract.Models = []string{"canvas-watermark-fixture"}
			contract.Capability.Watermark = tc.supported
			contract.Request.WatermarkField = ""
			if tc.supported {
				contract.Request.WatermarkField = "watermark"
			}
			contract.Rules = nil
			if tc.forced != "" {
				contract.Rules = []protocol.VideoModelContractRule{{
					When:        protocol.VideoModelContractRuleCondition{Field: "size", Operator: "equals", Value: contract.Capability.DefaultSize},
					ForceValues: map[string]string{"watermark": tc.forced},
					Message:     "Watermark fixture rule",
				}}
			}
			if _, err := app.videoContracts.Create(contract, true); err != nil {
				t.Fatal(err)
			}
			if _, err := app.config.Update(map[string]any{"video_models": contract.Models}); err != nil {
				t.Fatal(err)
			}
			dbURL := newHTTPTestNewAPIDatabase(t)
			insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
			insertHTTPTestNewAPIToken(t, dbURL, 1, 1, "video", "fixture-key", -1, 0, true)
			reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
			if err != nil {
				t.Fatal(err)
			}
			if app.newAPIKeys != nil {
				_ = app.newAPIKeys.Close()
			}
			app.newAPIKeys = reader
			received := make(chan map[string]any, 2)
			app.tasks.SetVideoHandler(func(_ context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
				received <- util.CopyMap(payload)
				return nil, errors.New("watermark fixture stopped after capture")
			})
			node := service.CanvasNode{
				ID: "video", Type: "video", Prompt: "Animate fixture", TaskID: "watermark-task",
				GenerationVideoModel: contract.Models[0], GenerationVideoSize: contract.Capability.DefaultSize,
				GenerationVideoSeconds: contract.Capability.DefaultSeconds, GenerationVideoResolution: contract.Capability.DefaultResolution,
				GenerationVideoWatermark: tc.requested,
			}
			owner := service.Identity{ID: "user-1", Role: service.AuthRoleUser, Name: "alice"}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := app.runCanvasAgentMedia(ctx, owner, node, nil, nil); err == nil || !strings.Contains(err.Error(), "watermark fixture stopped after capture") {
				t.Fatalf("fixture result = %v", err)
			}
			payload := <-received
			if value, present := payload["watermark"]; !present || value != tc.want {
				t.Fatalf("watermark = %#v (present %v), want %v", value, present, tc.want)
			}
			if _, err := app.runCanvasAgentMedia(ctx, owner, node, nil, nil); err == nil || !strings.Contains(err.Error(), "watermark fixture stopped after capture") {
				t.Fatalf("existing task result = %v", err)
			}
			if len(received) != 0 {
				t.Fatal("observing an existing task submitted a second generation")
			}
		})
	}
}
