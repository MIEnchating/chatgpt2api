package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
	"chatgpt2api/internal/videocontract"
)

func TestStudioAgentAdjustsParametersGeneratesAndResumesWithoutDuplicatePayment(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"text_models": []string{"studio-text"}, "image_models": []string{"gpt-image-2.6-sunburst"}}); err != nil {
		t.Fatal(err)
	}
	token := adminSessionToken(t, app)
	owner := *app.auth.Authenticate(token)
	var pixels bytes.Buffer
	_ = png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	encoded := base64.StdEncoding.EncodeToString(pixels.Bytes())
	var modelCalls, mediaCalls atomic.Int32
	var taskID atomic.Value
	interrupt := atomic.Bool{}
	interrupt.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/images/generations" {
			mediaCalls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["size"] != "1536x1024" || body["quality"] != "high" || body["n"] != float64(1) {
				t.Errorf("adjusted parameters lost: %v", body)
			}
			util.WriteJSON(w, 200, map[string]any{"data": []map[string]any{{"b64_json": encoded}}})
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		messages := util.AsMapSlice(body["messages"])
		for _, message := range messages {
			if message["role"] == "tool" && message["name"] == "generate_image" {
				var output map[string]any
				_ = json.Unmarshal([]byte(util.Clean(message["content"])), &output)
				if tasks := util.AsMapSlice(output["tasks"]); len(tasks) > 0 {
					taskID.Store(util.Clean(tasks[0]["id"]))
				}
			}
		}
		call := modelCalls.Add(1)
		name, args := "get_history", map[string]any{}
		switch call {
		case 1:
		case 2:
			name = "get_generation_config"
		case 3:
			name, args = "set_generation_parameters", map[string]any{"parameters": map[string]any{"size": "1536x1024", "quality": "high", "n": 1}}
		case 4:
			name, args = "generate_image", map[string]any{"prompt": "海边产品海报", "reference_ids": []string{}}
		default:
			if interrupt.Load() {
				util.WriteError(w, 400, "simulated model interruption")
				return
			}
			if call == 6 {
				name, args = "get_generation_task", map[string]any{"task_id": taskID.Load()}
			} else {
				name, args = "finish_task", map[string]any{"text": "已完成横版海报"}
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := map[string]any{"choices": []map[string]any{{"delta": map[string]any{"tool_calls": []map[string]any{{"index": 0, "id": fmt.Sprintf("studio-call-%d", call), "type": "function", "function": map[string]any{"name": name, "arguments": agentJSONValue(args)}}}}, "finish_reason": "tool_calls"}}}
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", agentJSONValue(chunk))
	}))
	defer upstream.Close()
	externalWorkflowTestClient(app, upstream)
	textConfig, err := app.customRelayConfigs.Create(identityScope(owner), "text", "test text", "http://studio-model.example", "studio-test-secret", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	imageConfig, err := app.customRelayConfigs.Create(identityScope(owner), "image", "test image", "http://studio-model.example", "studio-image-secret", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	turn := map[string]any{"id": "turn", "prompt": "横版海报", "model": "gpt-image-2.6-sunburst", "mode": "generate", "count": 1, "size": "1024x1024", "apiMode": "images", "tokenName": imageConfig.TokenName, "referenceImages": []any{}, "images": []any{}, "status": "queued", "studioAgent": map[string]any{"runId": "turn-agent"}}
	conversation := map[string]any{"id": "conversation", "title": "test", "createdAt": util.NowISO(), "updatedAt": util.NowISO(), "turns": []any{turn}, "composerMode": "image"}
	if _, _, err = app.history.MergeWithAcknowledgementsMinimal(context.Background(), identityScope(owner), []map[string]any{conversation}); err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		setRequestAuthCookie(r, token)
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		return w
	}
	body := agentJSONValue(studioAgentInput{ConversationID: "conversation", TurnID: "turn", RunID: "turn-agent", Model: "studio-text", TokenName: textConfig.TokenName})
	if response := request("POST", "/api/creation-tasks/agent", body); response.Code != 200 {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	wait := func() service.AgentExecution {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for time.Now().Before(deadline) {
			run, err := app.agentExecutions.Snapshot(owner, "turn-agent", "studio")
			if err != nil {
				t.Fatal(err)
			}
			if run.Status != "running" {
				return run
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("Agent did not settle")
		return service.AgentExecution{}
	}
	run := wait()
	if run.Status != "error" || mediaCalls.Load() != 1 {
		t.Fatalf("interrupted run=%+v media=%d", run, mediaCalls.Load())
	}
	public := request("GET", "/api/agent-runs?id=turn-agent", "").Body.String()
	for _, secret := range []string{"studio-test-secret", "studio-image-secret", "frozen_task_credential", "\"sdk\"", "\"receipts\""} {
		if strings.Contains(public, secret) {
			t.Fatalf("private state leaked: %s", secret)
		}
	}
	interrupt.Store(false)
	if response := request("POST", "/api/agent-runs?id=turn-agent", ""); response.Code != 200 {
		t.Fatalf("resume: %s", response.Body.String())
	}
	run = wait()
	if run.Status != "success" || mediaCalls.Load() != 1 {
		t.Fatalf("resumed run=%+v media=%d", run, mediaCalls.Load())
	}
	if response := request("POST", "/api/creation-tasks/agent", body); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if mediaCalls.Load() != 1 {
		t.Fatal("repeated start submitted new paid media")
	}
	_, otherToken := createPasswordUserSession(t, app, "studio-other", "", "Other")
	r := httptest.NewRequest("POST", "/api/creation-tasks/agent", strings.NewReader(body))
	setRequestAuthCookie(r, otherToken)
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if w.Code != 404 && w.Code != 403 {
		t.Fatalf("conversation owner isolation: %d %s", w.Code, w.Body.String())
	}
}

func TestStudioHistoryExcludesFutureAndCurrentOutputsAndRetainsManualReferences(t *testing.T) {
	conversation := map[string]any{"turns": []any{
		map[string]any{"id": "old", "prompt": "red coat", "images": []any{map[string]any{"status": "success", "url": "https://example.test/old.png"}}},
		map[string]any{"id": "now", "prompt": "change background", "referenceImages": []any{map[string]any{"dataUrl": "/api/files/owned/content"}}, "images": []any{map[string]any{"status": "success", "url": "https://example.test/current.png"}}},
		map[string]any{"id": "future", "prompt": "not visible"},
	}}
	history, refs := studioAgentHistory(conversation, "now", nil)
	if len(history) != 2 || len(refs) != 2 || refs["now-reference-1"] != "/api/files/owned/content" || refs["old-result-1"] == "" {
		t.Fatalf("history=%v refs=%v", history, refs)
	}
}

func TestStudioParametersRejectInvalidCountsAndModelQuality(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, _ = app.config.Update(map[string]any{"image_models": []string{"gpt-image-2.6-sunburst"}})
	for _, changes := range []map[string]any{{"n": 0}, {"n": 1.5}, {"n": 16}, {"quality": "invented"}, {"quality": false}, {"size": "9999x9999"}, {"size": 1024}, {"output_compression": 101}, {"output_format": "exe"}} {
		settings := map[string]any{"model": "gpt-image-2.6-sunburst", "n": 1, "size": "1024x1024", "api_mode": "images"}
		for k, v := range changes {
			settings[k] = v
		}
		if err := app.validateStudioSettings(settings, false); err == nil {
			t.Fatalf("accepted invalid parameters: %v", changes)
		}
	}
}

func TestStudioVideoSubmissionPreservesContractParametersAndOwnership(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	contract := newAPIExampleVideoContracts(t)["seedance2.0"]
	contract.Capability.Parameters = []protocol.VideoModelParameter{{Name: "seed", Label: "Seed", Field: "seed", Type: "integer"}}
	contract.Polling.IntervalSeconds = 1
	if _, _, err := app.videoContracts.Import([]videocontract.ImportedVideoModelContract{{Contract: contract, Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.config.Update(map[string]any{"video_models": []string{"seedance2.0"}}); err != nil {
		t.Fatal(err)
	}
	owner := *app.auth.Authenticate(adminSessionToken(t, app))
	var submissions atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/videos":
			submissions.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["seconds"] != "8" && body["seconds"] != float64(8) {
				t.Errorf("duration lost: %#v", body)
			}
			if videoJSONPathValue(body, "metadata.generate_audio") != false || videoJSONPathValue(body, "metadata.watermark") != false {
				t.Errorf("explicit false lost: %#v", body)
			}
			if body["seed"] != float64(0) {
				t.Errorf("explicit zero lost: %#v", body)
			}
			util.WriteJSON(w, 200, map[string]any{"id": "studio-video", "status": "queued"})
		case "GET /v1/videos/studio-video":
			util.WriteJSON(w, 200, map[string]any{"id": "studio-video", "status": "completed"})
		case "GET /v1/videos/studio-video/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("test-video-content"))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	externalWorkflowTestClient(app, upstream)
	config, err := app.customRelayConfigs.Create(identityScope(owner), "video", "video", "http://studio-video.example", "studio-video-secret", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"model": "seedance2.0", "prompt": "A boat", "n": 1, "size": contract.Capability.DefaultSize, "seconds": 8, "generate_audio": false, "watermark": false, "parameters": map[string]any{"seed": 0}}
	if err := app.validateStudioSettings(settings, true); err != nil {
		t.Fatal(err)
	}
	if _, err := app.submitStudioMedia(context.Background(), owner, "studio-video-paid", settings, nil, true, config.TokenName); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	item, err := service.WaitCanvasAgentTask(ctx, app.tasks, owner, "studio-video-paid", nil, nil)
	if err != nil || item["status"] != "success" || submissions.Load() != 1 {
		t.Fatalf("result=%#v err=%v calls=%d", item, err, submissions.Load())
	}
	if strings.Contains(agentJSONValue(settings), "studio-video-secret") || settings["generate_audio"] != false || settings["watermark"] != false {
		t.Fatalf("unsafe or lossy public settings: %#v", settings)
	}
	settings["first_frame_url"] = "/api/files/not-owned/content"
	if _, err := app.submitStudioMedia(ctx, owner, "studio-video-invalid", settings, nil, true, config.TokenName); err == nil {
		t.Fatal("unowned media accepted")
	}
	if submissions.Load() != 1 {
		t.Fatal("invalid material incurred a paid submission")
	}
}
