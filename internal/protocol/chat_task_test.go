package protocol

import (
	"reflect"
	"testing"

	"chatgpt2api/internal/util"
)

func TestChatTaskResponsesPreservesToolRoundAndImages(t *testing.T) {
	response := map[string]any{"status": "completed", "usage": map[string]any{"input_tokens": 321}, "output": []map[string]any{
		{"type": "reasoning", "id": "rs-test", "encrypted_content": "opaque-context", "summary": []map[string]any{{"type": "summary_text", "text": "检查节点"}}},
		{"type": "function_call", "id": "fc-test", "call_id": "call-test", "name": "get_node", "arguments": `{"nodeId":"n1"}`},
	}}
	data, err := ResponseChatTaskData(response)
	if err != nil || data["reasoning_content"] != "检查节点" || len(util.AsMapSlice(data["tool_calls"])) != 1 {
		t.Fatalf("normalized = %#v, %v", data, err)
	}
	payload := map[string]any{"api_mode": "responses", "model": "test-model", "prompt": "hello", "n": 1, "reasoning_enabled": true, "max_output_tokens": 4000,
		"messages": []map[string]any{
			{"role": "system", "content": "Use canvas tools."},
			{"role": "user", "content": []map[string]any{{"type": "text", "text": "检查这个节点"}, {"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,test"}}}},
			{"role": "assistant", "content": nil, "response_items": data["response_items"], "tool_calls": data["tool_calls"]},
			{"role": "tool", "tool_call_id": "call-test", "content": `{"ok":true}`},
		},
		"tools":       []map[string]any{{"type": "function", "function": map[string]any{"name": "get_node", "parameters": map[string]any{"type": "object"}}}},
		"tool_choice": map[string]any{"type": "function", "function": map[string]any{"name": "get_node"}},
	}
	path, body, err := ChatTaskRequest(payload)
	if err != nil || path != "/v1/responses" {
		t.Fatalf("request = %s, %v", path, err)
	}
	if body["messages"] != nil || body["prompt"] != nil || body["n"] != nil || body["reasoning_enabled"] != nil || body["store"] != false || body["max_output_tokens"] != 4000 {
		t.Fatalf("invalid Responses request: %#v", body)
	}
	input := util.AsMapSlice(body["input"])
	if len(input) != 5 || input[2]["encrypted_content"] != "opaque-context" || input[3]["call_id"] != "call-test" || input[4]["call_id"] != "call-test" || input[4]["output"] != `{"ok":true}` {
		t.Fatalf("tool round lost or duplicated: %#v", input)
	}
	parts := util.AsMapSlice(input[1]["content"])
	if parts[0]["type"] != "input_text" || parts[1]["type"] != "input_image" || parts[1]["image_url"] != "data:image/png;base64,test" {
		t.Fatalf("multimodal conversion: %#v", parts)
	}
	if util.StringMap(body["reasoning"])["effort"] != "medium" || util.StringMap(body["tool_choice"])["name"] != "get_node" || util.AsMapSlice(body["tools"])[0]["strict"] != false {
		t.Fatalf("options not mapped: %#v", body)
	}
	if payload["prompt"] != "hello" || payload["n"] != 1 {
		t.Fatal("request conversion mutated original payload")
	}
	payload["api_mode"] = "chat"
	payload["reasoning_enabled"] = false
	path, body, err = ChatTaskRequest(payload)
	if err != nil || path != "/v1/chat/completions" || body["reasoning_effort"] != "none" || body["max_completion_tokens"] != 4000 || body["max_output_tokens"] != nil {
		t.Fatalf("Chat options = %#v, %v", body, err)
	}
	assistant := util.AsMapSlice(body["messages"])[2]
	if assistant["response_items"] != nil || !reflect.DeepEqual(assistant["tool_calls"], data["tool_calls"]) {
		t.Fatalf("Chat history = %#v", assistant)
	}
}

func TestChatTaskResponsesTruncationAndRefusal(t *testing.T) {
	data, err := ResponseChatTaskData(map[string]any{"status": "incomplete", "output": []map[string]any{{"type": "function_call", "call_id": "call-1", "name": "get_node", "arguments": `{"nodeId":`}}})
	if err != nil || data["finish_reason"] != "incomplete" {
		t.Fatalf("truncation not exposed = %#v, %v", data, err)
	}
	data, err = ResponseChatTaskData(map[string]any{"status": "completed", "output": []map[string]any{{"type": "message", "content": []map[string]any{{"type": "refusal", "refusal": "无法完成这个请求"}}}}})
	if err != nil || data["text_response"] != "无法完成这个请求" {
		t.Fatalf("refusal lost = %#v, %v", data, err)
	}
	for _, status := range []string{"", "failed", "cancelled", "in_progress"} {
		if _, err := ResponseChatTaskData(map[string]any{"status": status}); err == nil {
			t.Fatalf("nonterminal or failure accepted: %s", status)
		}
	}
}
