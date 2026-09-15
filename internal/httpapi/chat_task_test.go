package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestChatTaskSelectedAPIReachesUpstream(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		t.Run(mode, func(t *testing.T) {
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
				if mode == "responses" {
					if body["input"] == nil || body["messages"] != nil || util.StringMap(body["reasoning"])["effort"] != "medium" {
						t.Errorf("wrong Responses body: %#v", body)
					}
					util.WriteJSON(w, 200, map[string]any{"created_at": 123, "status": "completed", "usage": map[string]any{"input_tokens": 100}, "output": []map[string]any{{"type": "function_call", "call_id": "call-1", "name": "get_canvas_summary", "arguments": "{}"}}})
				} else {
					if body["messages"] == nil || body["input"] != nil || body["reasoning_effort"] != "medium" {
						t.Errorf("wrong Chat body: %#v", body)
					}
					util.WriteJSON(w, 200, map[string]any{"created": 123, "usage": map[string]any{"prompt_tokens": 100}, "choices": []map[string]any{{"finish_reason": "tool_calls", "message": map[string]any{"tool_calls": []map[string]any{{"id": "call-1", "type": "function", "function": map[string]any{"name": "get_canvas_summary", "arguments": "{}"}}}}}}})
				}
			}))
			defer upstream.Close()
			if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
				t.Fatal(err)
			}
			result, err := app.executeChatTaskRequest(context.Background(), map[string]any{"api_key": "test-key", "api_mode": mode, "owner_id": "owner", "model": "test-model", "reasoning_enabled": true, "max_output_tokens": 4000, "messages": []map[string]any{{"role": "user", "content": "read canvas"}}})
			if err != nil {
				t.Fatal(err)
			}
			data := chatCompletionTaskData(result)
			calls := util.AsMapSlice(data["tool_calls"])
			if len(calls) != 1 || calls[0]["id"] != "call-1" || data["usage"] == nil || data["finish_reason"] == nil {
				t.Fatalf("normalized data = %#v", data)
			}
		})
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
				return
			}
			if err != nil || chatCompletionTaskData(result)["text_response"] != "你好" {
				t.Fatalf("response = %#v, %v", result, err)
			}
		})
	}
}
