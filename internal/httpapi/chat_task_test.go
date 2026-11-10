package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestChatTaskSelectedAPIReachesUpstream(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", mode, stream), func(t *testing.T) {
				app := newTestApp(t)
				defer app.Close()
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					wantPath := "/v1/chat/completions"
					if mode == "responses" {
						wantPath = "/v1/responses"
					}
					if r.URL.Path != wantPath {
						t.Errorf("path = %s", r.URL.Path)
					}
					var body map[string]any
					if err := util.DecodeJSON(r.Body, &body); err != nil {
						t.Error(err)
					}
					if body["api_key"] != nil || body["api_mode"] != nil || body["owner_id"] != nil || body["reasoning_enabled"] != nil {
						t.Errorf("internal fields leaked: %#v", body)
					}
					if body["prompt_cache_key"] != "stable-agent-session" {
						t.Error("selected API dropped the stable cache key")
					}
					if body["stream"] != stream {
						t.Errorf("stream lost: %#v", body)
					}
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						if mode == "responses" {
							fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80,"cache_write_tokens":20}},"output":[{"type":"function_call","call_id":"call-1","name":"get_canvas_summary","arguments":"{}"}]}}`+"\n\n")
						} else {
							fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"get_canvas_summary","arguments":"{"}}]}}]}`+"\n\n")
							fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80,"cache_write_tokens":20}}}`+"\n\ndata: [DONE]\n\n")
						}
						return
					}
					if mode == "responses" {
						if body["input"] == nil || body["messages"] != nil || util.StringMap(body["reasoning"])["effort"] != "medium" {
							t.Errorf("wrong Responses body: %#v", body)
						}
						util.WriteJSON(w, 200, map[string]any{"created_at": 123, "status": "completed", "usage": map[string]any{"input_tokens": 100, "input_tokens_details": map[string]any{"cached_tokens": 80, "cache_write_tokens": 20}}, "output": []map[string]any{{"type": "function_call", "call_id": "call-1", "name": "get_canvas_summary", "arguments": "{}"}}})
					} else {
						if body["messages"] == nil || body["input"] != nil || body["reasoning_effort"] != "medium" {
							t.Errorf("wrong Chat body: %#v", body)
						}
						util.WriteJSON(w, 200, map[string]any{"created": 123, "usage": map[string]any{"prompt_tokens": 100, "prompt_tokens_details": map[string]any{"cached_tokens": 80, "cache_write_tokens": 20}}, "choices": []map[string]any{{"finish_reason": "tool_calls", "message": map[string]any{"tool_calls": []map[string]any{{"id": "call-1", "type": "function", "function": map[string]any{"name": "get_canvas_summary", "arguments": "{}"}}}}}}})
					}
				}))
				defer upstream.Close()
				if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
					t.Fatal(err)
				}
				result, err := app.executeChatTaskRequest(context.Background(), map[string]any{"api_key": "test-key", "api_mode": mode, "stream": stream, "prompt_cache_key": "stable-agent-session", "owner_id": "owner", "model": "test-model", "reasoning_enabled": true, "max_output_tokens": 4000, "messages": []map[string]any{{"role": "user", "content": "read canvas"}}})
				if err != nil {
					t.Fatal(err)
				}
				data := chatCompletionTaskData(result)
				usage := util.StringMap(data["usage"])
				detailKey := "prompt_tokens_details"
				if mode == "responses" {
					detailKey = "input_tokens_details"
				}
				details := util.StringMap(usage[detailKey])
				if util.ToInt(details["cached_tokens"], -1) != 80 || util.ToInt(details["cache_write_tokens"], -1) != 20 {
					t.Fatalf("upstream cache usage was lost: %#v", usage)
				}
				calls := util.AsMapSlice(data["tool_calls"])
				if len(calls) != 1 || calls[0]["id"] != "call-1" || util.StringMap(calls[0]["function"])["arguments"] != "{}" || data["usage"] == nil || data["finish_reason"] == nil {
					t.Fatalf("normalized data = %#v", data)
				}
			})
		}
	}
}

func TestChatTaskResponsesStreamRequiresTerminalEvent(t *testing.T) {
	for _, terminal := range []bool{true, false} {
		t.Run(fmt.Sprint(terminal), func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n")
				if terminal {
					fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"你好\"}]}]}}\n\n")
				}
			}))
			defer upstream.Close()
			if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
				t.Fatal(err)
			}
			var progress []string
			result, err := app.executeChatTaskRequest(context.Background(), map[string]any{"api_key": "test-key", "api_mode": "responses", "stream": true, "model": "test-model", "messages": []map[string]any{{"role": "user", "content": "hello"}}, service.TextOutputCallbackPayloadKey: func(text string) { progress = append(progress, text) }})
			if !reflect.DeepEqual(progress, []string{"你", "你好"}) {
				t.Fatalf("progress = %#v", progress)
			}
			if !terminal {
				if err == nil {
					t.Fatal("truncated stream accepted")
				}
				if !service.AgentModelRetryable(err) {
					t.Fatalf("truncated stream cannot retry: %v", err)
				}
				return
			}
			if err != nil || chatCompletionTaskData(result)["text_response"] != "你好" {
				t.Fatalf("response = %#v, %v", result, err)
			}
		})
	}
}

func TestChatTaskStreamingMetadata(t *testing.T) {
	for _, stream := range []bool{false, true} {
		metadata := chatTaskRequestMetadata(map[string]any{"stream": stream})
		if metadata["stream"] != stream {
			t.Fatalf("stream lost: %#v", metadata)
		}
	}
	if _, set := chatTaskRequestMetadata(map[string]any{})["stream"]; set {
		t.Fatal("unspecified stream was set")
	}
}

func TestLoggedChatTaskPreservesStreamingWithTools(t *testing.T) {
	for _, withTools := range []bool{false, true} {
		for _, stream := range []any{nil, false, true} {
			t.Run(fmt.Sprintf("tools=%t/stream=%v", withTools, stream), func(t *testing.T) {
				app := newTestApp(t)
				defer app.Close()
				wantStream := stream != false
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body map[string]any
					if err := util.DecodeJSON(r.Body, &body); err != nil {
						t.Error(err)
					}
					if body["stream"] != wantStream {
						t.Errorf("stream = %v, want %t", body["stream"], wantStream)
					}
					response := map[string]any{"status": "completed", "output": []map[string]any{{"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": "完成"}}}}}
					if wantStream {
						w.Header().Set("Content-Type", "text/event-stream")
						data, _ := json.Marshal(map[string]any{"type": "response.completed", "response": response})
						fmt.Fprintf(w, "data: %s\n\n", data)
						return
					}
					util.WriteJSON(w, http.StatusOK, response)
				}))
				defer upstream.Close()
				payload := map[string]any{
					"api_mode": "responses", "model": "test-model", "messages": []map[string]any{{"role": "user", "content": "read canvas"}},
					relayTaskCredentialKey: frozenTaskCredential{relayCredential{APIKey: "test-key", BaseURL: upstream.URL}},
				}
				if stream != nil {
					payload["stream"] = stream
				}
				if withTools {
					payload["tools"] = []map[string]any{{"type": "function", "function": map[string]any{"name": "get_canvas_summary", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}}
				}
				result, err := app.runLoggedChatTask(context.Background(), service.Identity{ID: "stream-test"}, payload)
				if err != nil {
					t.Fatal(err)
				}
				data := util.AsMapSlice(result["data"])
				if len(data) != 1 || data[0]["text_response"] != "完成" {
					t.Fatalf("result=%v, error=%v", result, err)
				}
			})
		}
	}
}

func TestChatTaskStreamRejectsMissingFinishReason(t *testing.T) {
	for _, delta := range []string{
		`{"content":"partial reply"}`,
		`{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"delete_nodes","arguments":"{}"}}]}`,
	} {
		for _, ending := range []string{"", "data: [DONE]\n\n"} {
			stream := relayStreamResult(io.NopCloser(strings.NewReader("data: {\"choices\":[{\"delta\":" + delta + "}]}\n\n" + ending)))
			result, err := collectRelayChatTaskStream(map[string]any{}, stream)
			if err == nil || result != nil {
				t.Fatalf("accepted unfinished stream: %#v, %v", result, err)
			}
			if !service.AgentModelRetryable(err) {
				t.Fatalf("unfinished stream cannot retry: %v", err)
			}
		}
	}
}

func TestChatTaskStreamErrorsRetryClassification(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		for _, tc := range []struct {
			name string
			data string
			want bool
		}{
			{"disconnect", `{"error":{"message":"stream disconnected before completion"}}`, true},
			{"invalid_json", `{broken`, true},
			{"rate_limited", `{"type":"error","status":429,"message":"rate limited"}`, true},
			{"unauthorized", `{"type":"error","status":401,"message":"invalid API key"}`, false},
			{"invalid_parameter", `{"type":"error","status":400,"message":"invalid parameter"}`, false},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				stream := relayStreamResult(io.NopCloser(strings.NewReader("data: " + tc.data + "\n\n")))
				collect := collectRelayChatTaskStream
				if mode == "responses" {
					collect = collectResponseChatTaskStream
				}
				result, err := collect(map[string]any{}, stream)
				if err == nil || result != nil || service.AgentModelRetryable(err) != tc.want {
					t.Fatalf("result=%#v, err=%v, retryable=%v, want=%v", result, err, service.AgentModelRetryable(err), tc.want)
				}
			})
		}
	}
}

func TestChatTaskFailedResponsesStreamCanRetry(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"generation interrupted\"}}}\n\n")
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatal(err)
	}
	result, err := app.executeChatTaskRequest(context.Background(), map[string]any{"api_key": "test-key", "api_mode": "responses", "stream": true, "model": "test-model", "messages": []map[string]any{{"role": "user", "content": "hello"}}})
	if result != nil || err == nil || !strings.Contains(err.Error(), "generation interrupted") || !service.AgentModelRetryable(err) {
		t.Fatalf("result=%#v, err=%v", result, err)
	}
}
