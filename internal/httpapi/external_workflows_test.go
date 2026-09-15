package httpapi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func externalWorkflowTestClient(app *App, server *httptest.Server) {
	app.newSafeRelayHTTPClient = func(timeout time.Duration) *http.Client {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		return &http.Client{Transport: transport, Timeout: timeout}
	}
}

func TestArkVideoRuntimeUsesNativePathsContentAndResult(t *testing.T) {
	for _, basePath := range []string{"/api/v3", "/api/plan/v3"} {
		t.Run(basePath, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			var submitted map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer ark-key" {
					t.Errorf("auth = %q", r.Header.Get("Authorization"))
				}
				switch r.URL.Path {
				case basePath + "/contents/generations/tasks":
					if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
						t.Errorf("submit = %s %s", r.Method, r.Header.Get("Content-Type"))
					}
					_ = json.NewDecoder(r.Body).Decode(&submitted)
					util.WriteJSON(w, 200, map[string]any{"id": "task-a", "status": "queued"})
				case basePath + "/contents/generations/tasks/task-a":
					util.WriteJSON(w, 200, map[string]any{"id": "task-a", "status": "succeeded", "content": map[string]any{"video_url": "https://cdn.example/output.mp4"}})
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			externalWorkflowTestClient(app, server)
			contract := protocol.DefaultVideoContracts()[0]
			payload := map[string]any{"model": contract.Models[0], "prompt": "scene", "seconds": 5, "size": "16:9", "api_key": "ark-key", "relay_base_url": "http://ark.example" + basePath, "relay_protocol": "ark", relayCustomEndpointPayloadKey: true, "first_frame_url": "https://cdn.example/first.png", "last_frame_url": "https://cdn.example/last.png", protocol.VideoContractSnapshotPayloadKey: contract}
			result, err := app.relayVideoTask(context.Background(), payload)
			if err != nil {
				t.Fatal(err)
			}
			if submitted["prompt"] != nil || submitted["image_url"] != nil || submitted["duration"] != float64(5) {
				t.Fatalf("native request = %#v", submitted)
			}
			content := util.AsMapSlice(submitted["content"])
			if len(content) != 3 || content[1]["role"] != "first_frame" || content[2]["role"] != "last_frame" {
				t.Fatalf("native content = %#v", content)
			}
			data := util.AsMapSlice(result["data"])
			if len(data) != 1 || data[0]["video_url"] != "https://cdn.example/output.mp4" {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestAutoDLRuntimeUsesSelectedProtocolForAudioAndVideo(t *testing.T) {
	for _, kind := range []string{"audio", "video"} {
		t.Run(kind, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/workflows/") {
					rules := map[string]any{"prompt": map[string]any{"type": "string"}, "duration": map[string]any{"type": "integer", "default": 5}}
					if kind == "audio" {
						rules = map[string]any{"prompt_text": map[string]any{"type": "string", "required": true}, "prompt_simple": map[string]any{"type": "string", "required": true}}
					}
					util.WriteJSON(w, 200, map[string]any{"code": "Success", "data": map[string]any{"uuid": "workflow", "kind": kind, "input_rules": rules}})
					return
				}
				if r.URL.Path != "/api/v1/comfyui/comfyui_workflow/workflow" || r.Method != http.MethodPost {
					t.Errorf("unexpected task request %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "autodl-key" {
					t.Errorf("raw auth = %q", r.Header.Get("Authorization"))
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["model"] != nil || body["voice"] != nil {
					t.Errorf("unsupported request fields = %#v", body)
				}
				if kind == "audio" && body["prompt_simple"] != "https://cdn.example/voice.mp3" {
					t.Errorf("audio reference = %#v", body)
				}
				util.WriteJSON(w, 200, map[string]any{"code": "Success", "data": map[string]any{"task_id": "done", "status": "completed", "results": []map[string]any{{"type": kind, "file_type": map[string]string{"audio": "mp3", "video": "mp4"}[kind], "url": "https://cdn.example/output", "output_type": "output"}}}})
			}))
			defer server.Close()
			externalWorkflowTestClient(app, server)
			identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"}
			status, err := app.customRelayConfigs.Create(identityScope(identity), kind, "AutoDL", "http://autodl.example", "autodl-key", "autodl")
			if err != nil {
				t.Fatal(err)
			}
			payload := map[string]any{"model": "workflow", "prompt": "scene", "input": "scene", "token_name": status.TokenName, "workflow_inputs": map[string]any{"prompt_simple": "https://cdn.example/voice.mp3"}}
			if kind == "video" {
				delete(payload, "workflow_inputs")
			}
			if err := app.attachRelayAPIKeyForIdentity(context.Background(), identity, payload); err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if kind == "audio" {
				result, err = app.relayAudioSpeech(context.Background(), payload)
			} else {
				contract := protocol.DefaultVideoContracts()[0]
				contract.Models = []string{"workflow"}
				payload[protocol.VideoContractSnapshotPayloadKey] = contract
				result, err = app.relayVideoTask(context.Background(), payload)
			}
			if err != nil || result["output_type"] != kind {
				t.Fatalf("result = %#v, %v", result, err)
			}
		})
	}
}

func TestAutoDLMetadataRouteRequiresAuthenticationAndUsesSavedEndpoint(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/profile/autodl-workflows", nil))
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d", res.Code)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		util.WriteJSON(w, 200, map[string]any{"code": "Success", "data": map[string]any{"list": []map[string]any{{"uuid": "flow", "name": "工作流"}}, "max_page": 1}})
	}))
	defer server.Close()
	externalWorkflowTestClient(app, server)
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"}
	status, err := app.customRelayConfigs.Create(identityScope(identity), "video", "AutoDL", "http://autodl.example", "hidden-secret", "autodl")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/profile/autodl-workflows?token_name="+status.TokenName, nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"uuid":"flow"`) || strings.Contains(res.Body.String(), "hidden-secret") {
		t.Fatalf("metadata = %d %s", res.Code, res.Body.String())
	}
	other, err := app.customRelayConfigs.Create(identityScope(identity), "video", "普通线路", "http://autodl.example", "key", "openai")
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/profile/autodl-workflows?token_name="+other.TokenName, nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("non-AutoDL metadata status = %d", res.Code)
	}
}

func TestArkAgentPlanModelListReportsUnsupportedEndpoint(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/plan/v3/models" {
			t.Errorf("unexpected models path %s", r.URL.Path)
		}
		util.WriteJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"message": "not found"}})
	}))
	defer server.Close()
	externalWorkflowTestClient(app, server)
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"}
	status, err := app.customRelayConfigs.Create(identityScope(identity), "video", "方舟", "http://ark.example/api/plan/v3", "key", "ark")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/profile/upstream-models?token_name="+status.TokenName, nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "手动填写") {
		t.Fatalf("models = %d %s", res.Code, res.Body.String())
	}
}
