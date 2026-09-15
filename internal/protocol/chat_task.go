package protocol

import (
	"fmt"
	"strings"

	"chatgpt2api/internal/util"
)

// ChatTaskRequest maps the application's conversation contract to the selected API.
func ChatTaskRequest(payload map[string]any) (string, map[string]any, error) {
	body := util.CopyMap(payload)
	delete(body, "reasoning_enabled")
	delete(body, "max_output_tokens")
	mode := util.Clean(payload["api_mode"])
	if mode != "" && mode != "chat" && mode != "responses" {
		return "", nil, fmt.Errorf("unsupported chat API mode %q", mode)
	}
	effort := "none"
	if payload["reasoning_enabled"] == true {
		effort = "medium"
	}
	if mode != "responses" {
		messages := make([]map[string]any, 0)
		for _, message := range util.AsMapSlice(payload["messages"]) {
			item := util.CopyMap(message)
			delete(item, "response_items")
			messages = append(messages, item)
		}
		body["messages"] = messages
		if _, set := payload["reasoning_enabled"]; set {
			body["reasoning_effort"] = effort
		}
		if limit, set := payload["max_output_tokens"]; set {
			body["max_completion_tokens"] = limit
		}
		return "/v1/chat/completions", body, nil
	}
	delete(body, "messages")
	delete(body, "prompt")
	delete(body, "n")
	body["store"] = false
	body["include"] = []string{"reasoning.encrypted_content"}
	if _, set := payload["reasoning_enabled"]; set {
		body["reasoning"] = map[string]any{"effort": effort}
	}
	if limit, set := payload["max_output_tokens"]; set {
		body["max_output_tokens"] = limit
	}
	input := make([]map[string]any, 0)
	for _, message := range util.AsMapSlice(payload["messages"]) {
		role := util.Clean(message["role"])
		if role == "tool" {
			input = append(input, map[string]any{"type": "function_call_output", "call_id": message["tool_call_id"], "output": message["content"]})
			continue
		}
		if role != "system" && role != "user" && role != "assistant" {
			return "", nil, fmt.Errorf("unsupported conversation role %q", role)
		}
		if role == "assistant" {
			if items := util.AsMapSlice(message["response_items"]); len(items) > 0 {
				for _, item := range items {
					switch item["type"] {
					case "message", "function_call", "reasoning":
						input = append(input, util.CopyMap(item))
					default:
						return "", nil, fmt.Errorf("unsupported response history item")
					}
				}
				continue
			}
		}
		if content := message["content"]; content != nil && content != "" {
			converted, err := chatTaskResponseContent(content, role)
			if err != nil {
				return "", nil, err
			}
			input = append(input, map[string]any{"role": role, "content": converted})
		}
		if role == "assistant" {
			for _, call := range util.AsMapSlice(message["tool_calls"]) {
				function := util.StringMap(call["function"])
				input = append(input, map[string]any{"type": "function_call", "call_id": call["id"], "name": function["name"], "arguments": function["arguments"]})
			}
		}
	}
	body["input"] = input
	if tools := util.AsMapSlice(payload["tools"]); len(tools) > 0 {
		converted := make([]map[string]any, 0, len(tools))
		for _, tool := range tools {
			function := util.StringMap(tool["function"])
			if tool["type"] != "function" || util.Clean(function["name"]) == "" {
				return "", nil, fmt.Errorf("only named function tools are supported")
			}
			converted = append(converted, map[string]any{"type": "function", "name": function["name"], "description": function["description"], "parameters": function["parameters"], "strict": false})
		}
		body["tools"] = converted
	}
	if choice, ok := payload["tool_choice"].(map[string]any); ok {
		name := util.Clean(util.StringMap(choice["function"])["name"])
		if choice["type"] != "function" || name == "" {
			return "", nil, fmt.Errorf("invalid function tool choice")
		}
		body["tool_choice"] = map[string]any{"type": "function", "name": name}
	}
	return "/v1/responses", body, nil
}

func chatTaskResponseContent(content any, role string) (any, error) {
	if text, ok := content.(string); ok {
		return text, nil
	}
	parts := make([]map[string]any, 0)
	for _, part := range util.AsMapSlice(content) {
		switch part["type"] {
		case "text":
			kind := "input_text"
			if role == "assistant" {
				kind = "output_text"
			}
			parts = append(parts, map[string]any{"type": kind, "text": part["text"]})
		case "image_url":
			if role != "user" {
				return nil, fmt.Errorf("images require a user message")
			}
			parts = append(parts, map[string]any{"type": "input_image", "image_url": util.StringMap(part["image_url"])["url"]})
		default:
			return nil, fmt.Errorf("unsupported conversation content type")
		}
	}
	if len(parts) == 0 {
		return nil, fmt.Errorf("conversation content must be text or image parts")
	}
	return parts, nil
}

func ResponseChatTaskData(response map[string]any) (map[string]any, error) {
	status := util.Clean(response["status"])
	if status != "completed" && status != "incomplete" {
		message := util.Clean(util.StringMap(response["error"])["message"])
		if message == "" {
			message = "upstream response did not complete"
		}
		return nil, fmt.Errorf("%s", message)
	}
	var text, reasoning strings.Builder
	calls := make([]map[string]any, 0)
	items := make([]map[string]any, 0)
	for _, item := range util.AsMapSlice(response["output"]) {
		switch item["type"] {
		case "message":
			items = append(items, item)
			for _, part := range util.AsMapSlice(item["content"]) {
				if part["type"] == "output_text" {
					value, _ := part["text"].(string)
					text.WriteString(value)
				} else if part["type"] == "refusal" {
					value, _ := part["refusal"].(string)
					text.WriteString(value)
				}
			}
		case "function_call":
			items = append(items, item)
			calls = append(calls, map[string]any{"id": item["call_id"], "type": "function", "function": map[string]any{"name": item["name"], "arguments": item["arguments"]}})
		case "reasoning":
			items = append(items, item)
			for _, part := range util.AsMapSlice(item["summary"]) {
				value, _ := part["text"].(string)
				reasoning.WriteString(value)
			}
		}
	}
	data := map[string]any{"text_response": text.String(), "finish_reason": status, "response_items": items}
	if len(calls) > 0 {
		data["tool_calls"] = calls
	}
	if reasoning.Len() > 0 {
		data["reasoning_content"] = reasoning.String()
	}
	if usage, ok := response["usage"].(map[string]any); ok {
		data["usage"] = usage
	}
	return data, nil
}
