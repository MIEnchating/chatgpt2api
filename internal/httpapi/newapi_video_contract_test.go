package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func newAPIExampleVideoContracts(t *testing.T) map[string]protocol.VideoModelContract {
	t.Helper()
	data, err := os.ReadFile("../../docs/examples/newapi-video-contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var document videoModelContractTransferDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 4 {
		t.Fatalf("contract version = %d", document.Version)
	}
	contracts := make(map[string]protocol.VideoModelContract)
	for _, item := range document.Contracts {
		contract, err := protocol.NormalizeVideoModelContract(item.Contract)
		if err != nil {
			t.Fatal(err)
		}
		for _, model := range contract.Models {
			contracts[model] = contract
		}
	}
	return contracts
}

func TestNewAPIVideoContractRequestsMatchPluginFixtures(t *testing.T) {
	contracts := newAPIExampleVideoContracts(t)
	data, err := os.ReadFile("testdata/newapi-video-contract-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string         `json:"name"`
		Input   map[string]any `json:"input"`
		Request map[string]any `json:"request"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		t.Run(test.Name, func(t *testing.T) {
			contract, ok := contracts[util.Clean(test.Input["model"])]
			if !ok {
				t.Fatal("missing example contract")
			}
			request := declaredVideoContractRequestPayload(test.Input, contract)
			if contract.Driver == protocol.VideoContractDriverVolcengine {
				request, err = newAPIDoubaoVideoRequest(request, test.Input, contract)
				if err != nil {
					t.Fatal(err)
				}
			}
			actual, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(test.Request)
			if string(actual) != string(want) {
				t.Fatalf("request = %s, want %s", actual, want)
			}
		})
	}
}

func TestNewAPIVideoContractDownloadsAuthenticatedContentWithoutResultURL(t *testing.T) {
	for model, contract := range newAPIExampleVideoContracts(t) {
		t.Run(model, func(t *testing.T) {
			contract.Polling.IntervalSeconds = 1
			const content = "test-video-content"
			polls, downloads := 0, 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-only" {
					t.Error("missing authenticated New API request")
				}
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/videos":
					if contract.Driver == protocol.VideoContractDriverVolcengine {
						var posted map[string]any
						if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
							t.Error(err)
						}
						content := util.AsMapSlice(videoJSONPathValue(posted, "metadata.content"))
						if len(content) != 2 || content[0]["role"] != "first_frame" || content[1]["role"] != "last_frame" {
							t.Errorf("Seedance frame roles were lost: %#v", posted)
						}
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "object": "video", "status": "queued", "progress": 0})
				case "GET /v1/videos/video_public":
					polls++
					status, progress := "in_progress", 37
					if polls > 1 {
						status, progress = "completed", 100
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "object": "video", "status": status, "progress": progress})
				case "GET /v1/videos/video_public/content":
					downloads++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte(content))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			app := newTestApp(t)
			defer app.Close()
			var updates []service.VideoTaskProgressUpdate
			result, err := app.relayVideoTask(context.Background(), map[string]any{
				"model": model, "prompt": "A paper boat", "seconds": 8, "size": "16:9", "resolution": "720p",
				"api_key": "test-only", "relay_base_url": upstream.URL, "client_task_id": "local-video", "owner_id": "test-owner",
				"first_frame_url": "https://media.example/first.png", "last_frame_url": "https://media.example/last.png",
				protocol.VideoContractSnapshotPayloadKey:    contract,
				service.VideoTaskProgressCallbackPayloadKey: func(update service.VideoTaskProgressUpdate) { updates = append(updates, update) },
			})
			if err != nil {
				t.Fatal(err)
			}
			items := util.AsMapSlice(result["data"])
			if len(items) != 1 || downloads != 1 || len(updates) != 4 {
				t.Fatalf("result=%#v downloads=%d updates=%#v", result, downloads, updates)
			}
			for _, update := range updates {
				if update.UpstreamTaskID != "video_public" {
					t.Fatalf("missing recoverable task ID: %#v", update)
				}
			}
			if updates[0].Status != service.TaskStatusQueued || updates[1].Status != service.TaskStatusRunning || updates[2].Status != service.TaskStatusRunning {
				t.Fatalf("completed video must stay running while saving: %#v", updates)
			}
			url := util.Clean(items[0]["video_url"])
			if !strings.HasPrefix(url, "/videos/") {
				t.Fatalf("video URL = %q", url)
			}
			stored, err := os.ReadFile(filepath.Join(app.videoDir, filepath.Base(url)))
			if err != nil || string(stored) != content {
				t.Fatalf("stored video = %q, err = %v", stored, err)
			}
		})
	}
}

func TestNewAPIVideoCompletedErrorPreservesProviderReason(t *testing.T) {
	contract := newAPIExampleVideoContracts(t)["grok-imagine-video"]
	const reason = "The generated video was blocked by content moderation."
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "status": "queued"})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/content") {
			t.Error("attempted to download a missing artifact")
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "status": "completed", "error": map[string]any{"code": "moderation_blocked", "message": reason}})
	}))
	defer upstream.Close()
	app := newTestApp(t)
	defer app.Close()
	_, err := app.relayVideoTask(context.Background(), map[string]any{
		"model": "grok-imagine-video", "prompt": "A paper boat", "api_key": "test-only", "relay_base_url": upstream.URL,
		protocol.VideoContractSnapshotPayloadKey: contract,
	})
	if err == nil || !strings.Contains(err.Error(), reason) {
		t.Fatalf("error = %v", err)
	}
}

func TestVideoContentRecoveryRouteUsesOriginalConnectionAndNeverGenerates(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin}
	cfg, err := app.customRelayConfigs.Create("admin", "video", "recovery", "https://relay.example", "fixture-key", "openai")
	if err != nil {
		t.Fatal(err)
	}
	submissions := 0
	app.tasks.SetVideoHandler(func(_ context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
		submissions++
		payload[service.VideoTaskProgressCallbackPayloadKey].(func(service.VideoTaskProgressUpdate))(service.VideoTaskProgressUpdate{
			Status: service.TaskStatusRunning, UpstreamStatus: "completed", UpstreamTaskID: "video-existing",
			Recovery: &service.VideoContentRecovery{TaskID: "video-existing", URL: "https://relay.example/v1/videos/video-existing/content", BaseURL: "https://relay.example", TokenName: cfg.TokenName},
		})
		return nil, fmt.Errorf("视频已生成但保存失败: HTTP 502")
	})
	if _, err := app.tasks.SubmitVideo(context.Background(), identity, "recover-content", "animate", "video-model", "16:9", 5, "720p", false, false, "text", nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		tasks, err := app.tasks.ListTasksWithError(identity, []string{"recover-content"})
		if err != nil {
			t.Fatal(err)
		}
		if items := util.AsMapSlice(tasks["items"]); len(items) == 1 && items[0]["status"] == service.TaskStatusError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("task did not fail")
		}
		time.Sleep(time.Millisecond)
	}
	downloads := 0
	app.newSafeRelayHTTPClient = func(time.Duration) *http.Client {
		return &http.Client{Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
			downloads++
			if r.Method != http.MethodGet || r.URL.String() != "https://relay.example/v1/videos/video-existing/content" || r.Header.Get("Authorization") != "Bearer fixture-key" {
				t.Errorf("wrong recovery request method or coordinates")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"video/mp4"}}, Body: io.NopCloser(strings.NewReader("existing-video")), ContentLength: 14}, nil
		})}
	}
	token := adminSessionToken(t, app)
	for _, authenticated := range []bool{false, true, true} {
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/recover-content/video-content", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		if authenticated {
			setRequestAuthCookie(req, token)
		}
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, req)
		if !authenticated {
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated status %d", rec.Code)
			}
			continue
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("recover status=%d body=%s", rec.Code, rec.Body.String())
		}
		var task map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		if task["status"] != service.TaskStatusSuccess || strings.Contains(rec.Body.String(), "fixture-key") || strings.Contains(rec.Body.String(), "video_recovery") {
			t.Fatalf("unsafe recovery response: %s", rec.Body.String())
		}
	}
	if submissions != 1 || downloads != 1 {
		t.Fatalf("submissions=%d downloads=%d", submissions, downloads)
	}
}
