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
	"sync/atomic"
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

func TestXZAPIVideoContractsImportAndMapReferenceInputs(t *testing.T) {
	data, err := os.ReadFile("../../integrations/newapi/xzapi/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var document videoModelContractTransferDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	created, updated, err := app.videoContracts.Import(document.Contracts)
	if err != nil || created != 1 || updated != 0 {
		t.Fatalf("import: created=%d updated=%d error=%v", created, updated, err)
	}
	models := 0
	for _, item := range document.Contracts {
		for _, model := range item.Contract.Models {
			models++
			contract, ok := protocol.VideoContractForModel(model)
			if !ok {
				t.Fatalf("missing imported model %s", model)
			}
			payload := map[string]any{"model": model, "prompt": "A moving cloud", "seconds": 5, "reference_mode": "reference", "reference_image_urls": []string{"https://media.example.com/image.jpg"}}
			if err := normalizeVideoContractInput(payload, contract); err != nil {
				t.Fatalf("%s: %v", model, err)
			}
			request := declaredCanonicalVideoContractRequestPayload(payload, contract)
			if request["duration"] != 5 || request["resolution"] != contract.Capability.DefaultResolution || request["seconds"] != nil || request["client_task_id"] != nil {
				t.Fatalf("%s: invalid gateway request %#v", model, request)
			}
			images := util.AsStringSlice(videoJSONPathValue(request, "references.images"))
			if len(images) != 1 || images[0] != "https://media.example.com/image.jpg" {
				t.Fatalf("%s: reference was lost: %#v", model, request)
			}
			if got := videoContractErrorMessage(map[string]any{"metadata": map[string]any{"fail_reason": "provider failure"}}, contract); got != "provider failure" {
				t.Fatalf("provider failure reason lost: %s", got)
			}
		}
	}
	if models != 23 {
		t.Fatalf("imported %d models, want 23", models)
	}
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

func TestVideoTaskRecoveryRouteUsesOriginalConnectionAndNeverGenerates(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin}
	cfg, err := app.customRelayConfigs.Create("admin", "video", "recovery", "https://relay.example", "fixture-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	submissions := 0
	app.tasks.SetVideoHandler(func(_ context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
		submissions++
		payload[service.VideoTaskProgressCallbackPayloadKey].(func(service.VideoTaskProgressUpdate))(service.VideoTaskProgressUpdate{
			Status: service.TaskStatusRunning, UpstreamStatus: "completed", UpstreamTaskID: "video-existing",
			Recovery: &service.VideoTaskRecovery{TaskID: "video-existing", URL: "https://relay.example/v1/videos/video-existing/content", BaseURL: "https://relay.example", TokenName: cfg.TokenName},
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
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/recover-content/video-recovery", strings.NewReader("{}"))
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
		if rec.Code != http.StatusOK && rec.Code != http.StatusAccepted {
			t.Fatalf("recover status=%d body=%s", rec.Code, rec.Body.String())
		}
		var task map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		if task["status"] == service.TaskStatusError || strings.Contains(rec.Body.String(), "fixture-key") || strings.Contains(rec.Body.String(), "video_recovery") {
			t.Fatalf("unsafe recovery response: %s", rec.Body.String())
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			current, readErr := app.tasks.ListTasksWithError(identity, []string{"recover-content"})
			if readErr != nil {
				t.Fatal(readErr)
			}
			items := util.AsMapSlice(current["items"])
			if len(items) == 1 && items[0]["status"] == service.TaskStatusSuccess {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("recovery did not complete")
			}
			time.Sleep(time.Millisecond)
		}
	}
	if submissions != 1 || downloads != 1 {
		t.Fatalf("submissions=%d downloads=%d", submissions, downloads)
	}
}

func TestVideoTaskRecoveryFallsBackToNewAPIArtifactEndpoint(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin}
	cfg, err := app.customRelayConfigs.Create("admin", "video", "recovery-artifact", "https://relay.example", "fixture-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	contract, err := json.Marshal(protocol.VideoModelContract{
		Driver:   protocol.VideoContractDriverOpenAI,
		Artifact: protocol.VideoModelContractArtifact{Mode: "task_content"},
	})
	if err != nil {
		t.Fatal(err)
	}
	primaryAttempts, artifactAttempts := 0, 0
	app.newSafeRelayHTTPClient = func(time.Duration) *http.Client {
		return &http.Client{Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer fixture-key" {
				t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
			}
			switch r.URL.Path {
			case "/v1/videos/video-existing/content":
				primaryAttempts++
				return &http.Response{StatusCode: http.StatusBadGateway, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("gateway failure"))}, nil
			case "/v1/tasks/video-existing/artifacts/video/content":
				artifactAttempts++
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"video/mp4"}}, Body: io.NopCloser(strings.NewReader("existing-video")), ContentLength: 14}, nil
			default:
				t.Fatalf("unexpected recovery path %s", r.URL.Path)
				return nil, nil
			}
		})}
	}
	result, err := app.runRecoveredVideoTask(context.Background(), identity, map[string]any{
		service.VideoTaskRecoveryPayloadKey: &service.VideoTaskRecovery{
			TaskID: "video-existing", URL: "https://relay.example/v1/videos/video-existing/content", BaseURL: "https://relay.example", Contract: contract,
			TokenName: cfg.TokenName,
		},
		"client_task_id": "recover-content", "model": "video-model",
	})
	if err != nil {
		t.Fatalf("runRecoveredVideoTask() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if primaryAttempts != 3 || artifactAttempts != 1 || len(data) != 1 || !strings.HasPrefix(util.Clean(data[0]["url"]), "/videos/") {
		t.Fatalf("primary_attempts=%d artifact_attempts=%d result=%#v", primaryAttempts, artifactAttempts, result)
	}
}

func TestRejectedVideoSubmissionReportsStageWithoutRecovery(t *testing.T) {
	var posts, polls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		} else {
			polls.Add(1)
		}
		util.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"message": "服务暂时不可用，请稍后重试"}})
	}))
	defer upstream.Close()
	app := newTestApp(t)
	defer app.Close()
	app.tasks.SetVideoHandler(func(ctx context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
		payload["api_key"], payload["relay_base_url"] = "fixture-only", upstream.URL
		return app.relayVideoTask(ctx, payload)
	})
	identity := service.Identity{ID: "video-submit-regression", Role: service.AuthRoleAdmin}
	_, err := app.tasks.SubmitVideo(context.Background(), identity, "rejected-submit-regression", "A paper boat", "minimax-h3-768p", "16:9", 8, "720p", false, false, "text", nil, nil, nil, map[string]any{protocol.VideoContractSnapshotPayloadKey: protocol.DefaultVideoContracts()[0]})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		result, err := app.tasks.ListTasksWithError(identity, []string{"rejected-submit-regression"})
		if err != nil {
			t.Fatal(err)
		}
		items := util.AsMapSlice(result["items"])
		if len(items) != 1 {
			t.Fatalf("original local task missing: %#v", result)
		}
		task := items[0]
		if task["status"] == service.TaskStatusError {
			if task["error"] != "视频提交请求失败（HTTP 503）: 服务暂时不可用，请稍后重试" || util.ToBool(task["can_recover_video"]) || posts.Load() != 1 || polls.Load() != 0 {
				t.Fatalf("posts=%d polls=%d task=%#v", posts.Load(), polls.Load(), task)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("video submission did not settle")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAcceptedVideoTaskSurvivesTransientSupplierQueryFailure(t *testing.T) {
	var posts, polls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			util.WriteJSON(w, http.StatusOK, map[string]any{"id": "accepted-video", "status": "in_progress", "progress": 30})
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/v1/videos/accepted-video" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if polls.Add(1) == 1 {
			util.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"message": "temporary fixture outage"}})
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"id": "accepted-video", "status": "completed", "video_url": "https://cdn.example.com/result.mp4"})
	}))
	defer upstream.Close()
	app := newTestApp(t)
	defer app.Close()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Artifact = protocol.VideoModelContractArtifact{Mode: "response_url", Auth: "none"}
	contract.Polling.IntervalSeconds, contract.Polling.TimeoutSeconds = 1, 5
	app.tasks.SetVideoHandler(func(ctx context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
		payload["api_key"], payload["relay_base_url"] = "fixture-only", upstream.URL
		return app.relayVideoTask(ctx, payload)
	})
	identity := service.Identity{ID: "video-query-regression", Role: service.AuthRoleAdmin}
	_, err := app.tasks.SubmitVideo(context.Background(), identity, "accepted-query-regression", "A paper boat", "minimax-h3-768p", "16:9", 8, "720p", false, false, "text", nil, nil, nil, map[string]any{protocol.VideoContractSnapshotPayloadKey: contract})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		result, err := app.tasks.ListTasksWithError(identity, []string{"accepted-query-regression"})
		if err != nil {
			t.Fatal(err)
		}
		items := util.AsMapSlice(result["items"])
		if len(items) != 1 {
			t.Fatalf("original local task missing: %#v", result)
		}
		task := items[0]
		if task["status"] == service.TaskStatusError || task["status"] == service.TaskStatusCancelled {
			t.Fatalf("query outage became terminal: %#v", task)
		}
		if task["status"] == service.TaskStatusSuccess {
			data := util.AsMapSlice(task["data"])
			if posts.Load() != 1 || polls.Load() != 2 || len(data) != 1 || data[0]["url"] != "https://cdn.example.com/result.mp4" {
				t.Fatalf("posts=%d polls=%d task=%#v", posts.Load(), polls.Load(), task)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("original video task did not complete")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestVideoTaskRecoveryQueriesPersistedContractAfterAuthenticationFailure(t *testing.T) {
	for _, terminal := range []string{"completed", "failed"} {
		t.Run(terminal, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin}
			cfg, err := app.customRelayConfigs.Create("admin", "video", "query-recovery", "https://relay.example", "fixture-key", "openai", "")
			if err != nil {
				t.Fatal(err)
			}
			contract := protocol.DefaultVideoContracts()[0]
			contract.Artifact = protocol.VideoModelContractArtifact{Mode: "response_url", Auth: "none"}
			contract.Polling.StatusFields = []string{"original_phase"}
			contract.Polling.IntervalSeconds, contract.Polling.TimeoutSeconds = 1, 5
			var posts, gets atomic.Int32
			var authorized atomic.Bool
			app.newSafeRelayHTTPClient = func(time.Duration) *http.Client {
				return &http.Client{Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
					status, body := http.StatusOK, ""
					if r.Header.Get("Authorization") != "Bearer fixture-key" {
						t.Error("wrong original credential")
					}
					switch r.Method {
					case http.MethodPost:
						posts.Add(1)
						body = `{"id":"original-upstream","original_phase":"in_progress"}`
					case http.MethodGet:
						gets.Add(1)
						if r.URL.Path != "/v1/videos/original-upstream" {
							t.Errorf("query path changed: %s", r.URL.Path)
						}
						if !authorized.Load() {
							status = http.StatusUnauthorized
							body = `{"error":{"message":"expired fixture credential"}}`
						} else {
							body = fmt.Sprintf(`{"id":"original-upstream","original_phase":%q,"status":"ignored_new_contract_field","video_url":"https://cdn.example/result.mp4","error":{"message":"provider rejected fixture"}}`, terminal)
							if terminal == "completed" {
								body = `{"id":"original-upstream","original_phase":"completed","status":"failed","video_url":"https://cdn.example/result.mp4"}`
							}
						}
					default:
						t.Errorf("unexpected request %s", r.Method)
					}
					return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
			}
			app.tasks.SetVideoHandler(func(ctx context.Context, _ service.Identity, payload map[string]any) (map[string]any, error) {
				payload["api_key"], payload["relay_base_url"], payload["token_name"], payload[relayCustomEndpointPayloadKey] = "fixture-key", "https://relay.example", cfg.TokenName, true
				return app.relayVideoTask(ctx, payload)
			})
			_, err = app.tasks.SubmitVideo(context.Background(), identity, "original-local", "animate", contract.Models[0], "16:9", 8, "720p", false, false, "text", nil, nil, nil, map[string]any{protocol.VideoContractSnapshotPayloadKey: contract})
			if err != nil {
				t.Fatal(err)
			}
			wait := func(want string) map[string]any {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					result, readErr := app.tasks.ListTasksWithError(identity, []string{"original-local"})
					if readErr != nil {
						t.Fatal(readErr)
					}
					items := util.AsMapSlice(result["items"])
					if len(items) == 1 && items[0]["status"] == want {
						return items[0]
					}
					time.Sleep(time.Millisecond)
				}
				t.Fatalf("task did not reach %s", want)
				return nil
			}
			task := wait(service.TaskStatusError)
			if !util.ToBool(task["can_recover_video"]) {
				t.Fatal("query authentication failure lost original task")
			}
			// Reopen the task store and change the current handler. Recovery must use
			// persisted coordinates and its original response-field contract.
			if err := app.tasks.Close(); err != nil {
				t.Fatal(err)
			}
			// The app's durable backend remains open when only the task service closes.
			backend, err := app.config.StorageBackend()
			if err != nil {
				t.Fatal(err)
			}
			app.tasks = service.NewStoredImageTaskService(backend, nil, nil, nil, func() int { return 30 })
			app.tasks.SetVideoHandler(func(context.Context, service.Identity, map[string]any) (map[string]any, error) {
				t.Error("regenerated a paid video")
				return nil, fmt.Errorf("must not generate")
			})
			app.tasks.SetVideoRecoveryHandler(app.runRecoveredVideoTask)
			authorized.Store(true)
			if _, err := app.tasks.RecoverVideoTask(identity, "original-local"); err != nil {
				t.Fatal(err)
			}
			want := service.TaskStatusSuccess
			if terminal == "failed" {
				want = service.TaskStatusError
			}
			task = wait(want)
			if util.ToBool(task["can_recover_video"]) {
				t.Fatalf("terminal %s must not offer recovery: %#v", terminal, task)
			}
			if posts.Load() != 1 || gets.Load() != 2 {
				t.Fatalf("posts=%d gets=%d", posts.Load(), gets.Load())
			}
		})
	}
}
