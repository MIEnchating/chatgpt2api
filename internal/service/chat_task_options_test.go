package service

import (
	"context"
	"encoding/json"
	"testing"

	"chatgpt2api/internal/util"
)

func TestChatTaskOptionsRejectInvalidValues(t *testing.T) {
	for _, metadata := range []map[string]any{{"api_mode": "auto"}, {"api_mode": true}, {"reasoning_enabled": "false"}, {"max_output_tokens": true}, {"max_output_tokens": 1.5}, {"max_output_tokens": json.Number("3.1")}, {"max_output_tokens": "4096"}, {"max_output_tokens": 0}, {"max_output_tokens": 128001}} {
		if err := ValidateChatTaskOptions(metadata); err == nil {
			t.Fatalf("accepted %#v", metadata)
		}
	}
}

func TestChatTaskOptionsSurviveTaskQueue(t *testing.T) {
	seen := make(chan map[string]any, 1)
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		seen <- payload
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "done", "finish_reason": "completed", "usage": map[string]any{"input_tokens": 12}}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "owner", Name: "Owner", Role: "user"}
	_, err := svc.SubmitChatWithMetadata(context.Background(), identity, "chat-options", "hello", "model", []map[string]any{{"role": "user", "content": "hello"}}, map[string]any{"api_mode": "responses", "reasoning_enabled": true, "max_output_tokens": json.Number("4096")})
	if err != nil {
		t.Fatal(err)
	}
	waitForTaskStatus(t, svc, identity, "chat-options", TaskStatusSuccess)
	got := <-seen
	if got["api_mode"] != "responses" || got["reasoning_enabled"] != true || util.ToInt(got["max_output_tokens"], 0) != 4096 {
		t.Fatalf("queue dropped options: %#v", got)
	}
	items := util.AsMapSlice(svc.ListTasks(identity, []string{"chat-options"})["items"])
	data := util.AsMapSlice(items[0]["data"])[0]
	if data["finish_reason"] != "completed" || data["usage"] == nil {
		t.Fatalf("queue dropped metadata: %#v", data)
	}
}
