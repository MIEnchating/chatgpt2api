package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
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
	var taskID, partialRequest atomic.Value
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
		if call == 4 {
			partialRequest.Store(agentJSONValue(body))
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"studio-call-4","type":"function","function":{"name":"generate_image","arguments":"{\"prompt\":\""}}]},"finish_reason":null}]}`+"\n\n")
			w.(http.Flusher).Flush()
			return
		}
		if call == 5 {
			if agentJSONValue(body) != partialRequest.Load() || mediaCalls.Load() != 0 {
				t.Error("interrupted tool arguments changed the retried model request or submitted media")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"studio-call-4","type":"function","function":{"name":"generate_image","arguments":"{\"prompt\":\""}}]},"finish_reason":null}]}`+"\n\n")
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"海边产品海报\",\"reference_ids\":[]}"}}]},"finish_reason":null}]}`+"\n\n")
			fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		if call > 5 {
			call--
		}
		name, args := "get_history", map[string]any{}
		switch call {
		case 1:
		case 2:
			name = "get_generation_config"
		case 3:
			name, args = "set_generation_parameters", map[string]any{"parameters": map[string]any{"size": "1536x1024", "quality": "high", "n": 1}}
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
	if modelCalls.Load() != 6 || !strings.Contains(agentJSONValue(run.Events), `"stage":"retrying"`) {
		t.Fatalf("partial model stream did not retry as expected: model=%d events=%v", modelCalls.Load(), run.Events)
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

func TestStudioAgentReadsConversationAssetAndSubmitsEdit(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"text_models": []string{"studio-text"}, "image_models": []string{"gpt-image-2.6-sunburst"}}); err != nil {
		t.Fatal(err)
	}
	token := adminSessionToken(t, app)
	owner := *app.auth.Authenticate(token)
	asset := uploadHTTPTestConversationAssets(t, app, token, 1, true).Items[0]
	var pixels bytes.Buffer
	if err := encodeHTTPTestPNG(&pixels); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(pixels.Bytes())
	var modelCalls, mediaCalls atomic.Int32
	var taskID atomic.Value
	var sawVisual atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/images/edits" {
			mediaCalls.Add(1)
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				util.WriteError(w, 400, "invalid multipart body")
				return
			}
			defer r.MultipartForm.RemoveAll()
			count := 0
			for _, files := range r.MultipartForm.File {
				for _, file := range files {
					count++
					reader, err := file.Open()
					if err != nil {
						t.Error(err)
						continue
					}
					data, err := io.ReadAll(reader)
					reader.Close()
					if err != nil || !bytes.Equal(data, pixels.Bytes()) {
						t.Error("edit did not receive the uploaded conversation image")
					}
				}
			}
			if count != 1 {
				t.Errorf("edit received %d files, want one reference image", count)
			}
			util.WriteJSON(w, 200, map[string]any{"data": []map[string]any{{"b64_json": encoded}}})
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		for _, message := range util.AsMapSlice(body["messages"]) {
			for _, part := range util.AsMapSlice(message["content"]) {
				if part["type"] == "image_url" && util.StringMap(part["image_url"])["url"] == "data:image/png;base64,"+encoded {
					sawVisual.Store(true)
				}
			}
			if message["role"] == "tool" && message["name"] == "edit_image" {
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
		case 3, 4, 5:
			name, args = "read_image", map[string]any{"reference_id": "turn-reference-1"}
		case 6:
			messages := util.AsMapSlice(body["messages"])
			if !strings.Contains(agentJSONValue(messages), "repeatedReadReminder") {
				t.Error("third identical image read did not remind the model")
			}
			name, args = "edit_image", map[string]any{"prompt": "Make this image a cartoon", "reference_ids": []string{"turn-reference-1"}}
		case 7:
			name, args = "get_generation_task", map[string]any{"task_id": taskID.Load()}
		default:
			name, args = "finish_task", map[string]any{"text": "已完成卡通图"}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := map[string]any{"choices": []map[string]any{{"delta": map[string]any{"tool_calls": []map[string]any{{"index": 0, "id": fmt.Sprintf("asset-call-%d", call), "type": "function", "function": map[string]any{"name": name, "arguments": agentJSONValue(args)}}}}, "finish_reason": "tool_calls"}}}
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", agentJSONValue(chunk))
	}))
	defer upstream.Close()
	externalWorkflowTestClient(app, upstream)
	textConfig, err := app.customRelayConfigs.Create(identityScope(owner), "text", "text", "http://studio-model.example", "test-text-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	imageConfig, err := app.customRelayConfigs.Create(identityScope(owner), "image", "image", "http://studio-model.example", "test-image-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	turn := map[string]any{"id": "turn", "prompt": "Make a cartoon", "model": "gpt-image-2.6-sunburst", "mode": "image", "count": 1, "size": "1024x1024", "apiMode": "images", "tokenName": imageConfig.TokenName, "referenceImages": []any{map[string]any{"name": asset.Name, "type": asset.Type, "dataUrl": asset.DataURL}}, "images": []any{}, "status": "queued", "studioAgent": map[string]any{"runId": "turn-agent"}}
	conversation := map[string]any{"id": "conversation", "createdAt": util.NowISO(), "updatedAt": util.NowISO(), "turns": []any{turn}, "composerMode": "image"}
	if _, _, err := app.history.MergeWithAcknowledgementsMinimal(context.Background(), identityScope(owner), []map[string]any{conversation}); err != nil {
		t.Fatal(err)
	}
	body := agentJSONValue(studioAgentInput{ConversationID: "conversation", TurnID: "turn", RunID: "turn-agent", Model: "studio-text", TokenName: textConfig.TokenName})
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/agent", strings.NewReader(body))
	setRequestAuthCookie(req, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	run, err := app.waitAgentExecution(ctx, owner, "turn-agent", nil)
	if err != nil || run.Status != "success" || mediaCalls.Load() != 1 || !sawVisual.Load() {
		t.Fatalf("run=%+v err=%v media=%d visual=%v", run, err, mediaCalls.Load(), sawVisual.Load())
	}
	for _, event := range run.Events {
		if event["status"] == "error" {
			t.Errorf("tool failed: %#v", event)
		}
	}
}

func TestStudioAgentRejectsOtherMediaToolsBeforeSubmitting(t *testing.T) {
	for _, scenario := range []struct{ mode, wrongTool, tool string }{
		{"generate", "generate_video", "generate_image"},
		{"image", "generate_video", "edit_image"},
		{"edit", "generate_video", "edit_image"},
		{"video", "generate_image", "generate_video"},
		{"video", "edit_image", "generate_video"},
	} {
		t.Run(scenario.mode+"/"+scenario.wrongTool, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
			contract := newAPIExampleVideoContracts(t)["seedance2.0"]
			contract.Polling.IntervalSeconds = 1
			if _, _, err := app.videoContracts.Import([]videocontract.ImportedVideoModelContract{{Contract: contract, Enabled: true}}); err != nil {
				t.Fatal(err)
			}
			if _, err := app.config.Update(map[string]any{"text_models": []string{"studio-text"}, "image_models": []string{"gpt-image-2.6-sunburst"}, "video_models": []string{"seedance2.0"}}); err != nil {
				t.Fatal(err)
			}
			token := adminSessionToken(t, app)
			owner := *app.auth.Authenticate(token)
			var pixels bytes.Buffer
			if err := encodeHTTPTestPNG(&pixels); err != nil {
				t.Fatal(err)
			}
			var modelCalls, imageCalls, videoCalls atomic.Int32
			var taskID atomic.Value
			mediaType, model, prompt := "image", "gpt-image-2.6-sunburst", "只生成一张海边海报图片，不要视频"
			if scenario.mode == "video" {
				mediaType, model, prompt = "video", "seedance2.0", "生成一段海浪运动的视频，不要静态图片"
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/images/generations", "POST /v1/images/edits":
					imageCalls.Add(1)
					util.WriteJSON(w, 200, map[string]any{"data": []map[string]any{{"b64_json": base64.StdEncoding.EncodeToString(pixels.Bytes())}}})
					return
				case "POST /v1/videos":
					videoCalls.Add(1)
					util.WriteJSON(w, 200, map[string]any{"id": "media-video", "status": "queued"})
					return
				case "GET /v1/videos/media-video":
					util.WriteJSON(w, 200, map[string]any{"id": "media-video", "status": "completed"})
					return
				case "GET /v1/videos/media-video/content":
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("test-video-content"))
					return
				case "POST /v1/chat/completions":
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				for _, message := range util.AsMapSlice(body["messages"]) {
					if message["role"] != "tool" {
						continue
					}
					var output map[string]any
					_ = json.Unmarshal([]byte(util.Clean(message["content"])), &output)
					switch message["name"] {
					case "get_generation_config":
						if output["media_type"] != mediaType {
							t.Errorf("model was not told current media type: got %v, want %s", output["media_type"], mediaType)
						}
					case scenario.wrongTool:
						if output["ok"] != false || output["message"] != "工具与本轮媒体类型不一致" {
							t.Errorf("wrong media tool was not explicitly rejected: %#v", output)
						}
					case scenario.tool:
						if tasks := util.AsMapSlice(output["tasks"]); len(tasks) == 1 {
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
					name, args = scenario.wrongTool, map[string]any{"prompt": prompt, "reference_ids": []string{}}
				case 4:
					if imageCalls.Load() != 0 || videoCalls.Load() != 0 {
						t.Error("wrong media tool caused an upstream submission")
					}
					refs := []string{}
					if scenario.tool == "edit_image" {
						refs = append(refs, "turn-reference-1")
					}
					name, args = scenario.tool, map[string]any{"prompt": prompt, "reference_ids": refs}
				case 5:
					name, args = "get_generation_task", map[string]any{"task_id": taskID.Load()}
				default:
					name, args = "finish_task", map[string]any{"text": "已按请求完成"}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				chunk := map[string]any{"choices": []map[string]any{{"delta": map[string]any{"tool_calls": []map[string]any{{"index": 0, "id": fmt.Sprintf("media-call-%d", call), "type": "function", "function": map[string]any{"name": name, "arguments": agentJSONValue(args)}}}}, "finish_reason": "tool_calls"}}}
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", agentJSONValue(chunk))
			}))
			defer upstream.Close()
			externalWorkflowTestClient(app, upstream)
			textConfig, err := app.customRelayConfigs.Create(identityScope(owner), "text", "text", "http://studio-model.example", "test-text-key", "openai", "")
			if err != nil {
				t.Fatal(err)
			}
			mediaConfig, err := app.customRelayConfigs.Create(identityScope(owner), mediaType, "media", "http://studio-model.example", "test-media-key", "openai", "")
			if err != nil {
				t.Fatal(err)
			}
			turn := map[string]any{"id": "turn", "prompt": prompt, "model": model, "mode": scenario.mode, "count": 1, "size": "1024x1024", "apiMode": "images", "tokenName": mediaConfig.TokenName, "referenceImages": []any{}, "images": []any{}, "status": "queued", "studioAgent": map[string]any{"runId": "turn-agent"}}
			if mediaType == "video" {
				turn["size"], turn["videoSeconds"] = contract.Capability.DefaultSize, 8
			}
			if scenario.tool == "edit_image" {
				asset := uploadHTTPTestConversationAssets(t, app, token, 1, true).Items[0]
				turn["referenceImages"] = []any{map[string]any{"name": asset.Name, "type": asset.Type, "dataUrl": asset.DataURL}}
			}
			conversation := map[string]any{"id": "conversation", "createdAt": util.NowISO(), "updatedAt": util.NowISO(), "turns": []any{turn}, "composerMode": mediaType}
			if _, _, err := app.history.MergeWithAcknowledgementsMinimal(context.Background(), identityScope(owner), []map[string]any{conversation}); err != nil {
				t.Fatal(err)
			}
			if _, err := app.agentExecutions.Start(owner, "turn-agent", "studio", studioAgentInput{ConversationID: "conversation", TurnID: "turn", RunID: "turn-agent", Model: "studio-text", TokenName: textConfig.TokenName}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			run, err := app.waitAgentExecution(ctx, owner, "turn-agent", nil)
			if err != nil || run.Status != "success" {
				t.Fatalf("run status=%s error=%v events=%v", run.Status, err, run.Events)
			}
			wantImage, wantVideo := int32(1), int32(0)
			if mediaType == "video" {
				wantImage, wantVideo = 0, 1
			}
			if imageCalls.Load() != wantImage || videoCalls.Load() != wantVideo || len(util.AsMapSlice(util.StringMap(run.Result)["tasks"])) != 1 {
				t.Fatalf("image submissions=%d video submissions=%d result=%v", imageCalls.Load(), videoCalls.Load(), run.Result)
			}
		})
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
