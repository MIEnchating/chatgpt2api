package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) runLoggedChatTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	return a.runLoggedChatTaskWithContext(ctx, identity, payload, "/api/creation-tasks/chat-completions", "文本生成")
}

func (a *App) runLoggedChatTaskWithContext(ctx context.Context, identity service.Identity, payload map[string]any, endpoint, summary string) (map[string]any, error) {
	ctx, _ = protocol.WithAccountUsageTracker(ctx)
	start := time.Now()
	requestCapture := payloadAuditCapture(payload)
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	if len(util.AsMapSlice(payload["tools"])) > 0 {
		payload["stream"] = false
	} else {
		payload["stream"] = true
	}
	model := firstNonEmpty(util.Clean(payload["model"]), a.defaultChatModel())
	if err := a.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return nil, err
	}
	result, err := a.executeChatTaskRequest(ctx, payload)
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return result, err
	}
	data := chatCompletionTaskData(result)
	if util.Clean(data["text_response"]) == "" && len(util.AsMapSlice(data["tool_calls"])) == 0 && data["finish_reason"] != "length" && data["finish_reason"] != "incomplete" {
		err = errors.New("模型没有返回文本内容或工具调用")
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", http.StatusBadGateway, err.Error(), nil, requestCapture)
		return result, err
	}
	a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "success", http.StatusOK, "", nil, requestCapture)
	return map[string]any{
		"created":     result["created"],
		"output_type": "text",
		"data":        []map[string]any{data},
	}, nil
}

func chatCompletionTaskData(result map[string]any) map[string]any {
	for _, item := range util.AsMapSlice(result["data"]) {
		data := map[string]any{}
		for _, key := range []string{"finish_reason", "usage", "response_items"} {
			if value, ok := item[key]; ok {
				data[key] = value
			}
		}
		if text, ok := item["text_response"].(string); ok && text != "" {
			data["text_response"] = text
		}
		if reasoning, ok := item["reasoning_content"].(string); ok {
			data["reasoning_content"] = reasoning
		}
		if calls := util.AsMapSlice(item["tool_calls"]); len(calls) > 0 {
			data["tool_calls"] = calls
		}
		if len(data) > 0 {
			return data
		}
	}
	for _, choice := range util.AsMapSlice(result["choices"]) {
		message := util.StringMap(choice["message"])
		data := map[string]any{}
		if value, ok := choice["finish_reason"]; ok {
			data["finish_reason"] = value
		}
		if value, ok := result["usage"]; ok {
			data["usage"] = value
		}
		if text := chatCompletionContentRawText(message["content"]); text != "" {
			data["text_response"] = text
		}
		if reasoning, ok := message["reasoning_content"].(string); ok {
			data["reasoning_content"] = reasoning
		}
		if calls := util.AsMapSlice(message["tool_calls"]); len(calls) > 0 {
			data["tool_calls"] = calls
		}
		if len(data) > 0 {
			return data
		}
	}
	return map[string]any{}
}

func collectRelayChatTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	created := time.Now().Unix()
	model := ""
	var text strings.Builder
	var reasoning strings.Builder
	var finishReason string
	var usage any
	toolCalls := map[int]*chatCompletionToolCallParts{}
	onProgress := relayTextTaskProgressCallback(payload)

	for item := range stream.Items {
		if item == nil {
			continue
		}
		if value, ok := item["usage"]; ok && value != nil {
			usage = value
		}
		if value := util.ToInt(item["created"], 0); value > 0 {
			created = int64(value)
		}
		if model == "" {
			model = util.Clean(item["model"])
		}
		if delta := chatCompletionStreamTextDelta(item); delta != "" {
			text.WriteString(delta)
			if onProgress != nil {
				onProgress(text.String())
			}
		}
		for _, choice := range util.AsMapSlice(item["choices"]) {
			if value := util.Clean(choice["finish_reason"]); value != "" {
				finishReason = value
			}
			delta := util.StringMap(choice["delta"])
			if value, ok := delta["reasoning_content"].(string); ok {
				reasoning.WriteString(value)
			}
			appendChatCompletionToolCallParts(toolCalls, delta["tool_calls"], false)
			message := util.StringMap(choice["message"])
			if value, ok := message["reasoning_content"].(string); ok && reasoning.Len() == 0 {
				reasoning.WriteString(value)
			}
			appendChatCompletionToolCallParts(toolCalls, message["tool_calls"], true)
		}
	}
	if err := <-stream.Err; err != nil {
		return nil, err
	}
	if finishReason == "" {
		return nil, errors.New("upstream chat stream ended without a finish reason")
	}
	content := text.String()
	data := map[string]any{}
	if finishReason != "" {
		data["finish_reason"] = finishReason
	}
	if usage != nil {
		data["usage"] = usage
	}
	if content != "" {
		data["text_response"] = content
	}
	if reasoning.Len() > 0 {
		data["reasoning_content"] = reasoning.String()
	}
	if calls := completedChatCompletionToolCalls(toolCalls); len(calls) > 0 {
		data["tool_calls"] = calls
	}
	if strings.TrimSpace(content) == "" && len(util.AsMapSlice(data["tool_calls"])) == 0 && finishReason != "length" {
		return nil, errors.New("模型没有返回文本内容或工具调用")
	}
	return map[string]any{
		"created":     created,
		"model":       model,
		"output_type": "text",
		"data":        []map[string]any{data},
	}, nil
}

type chatCompletionToolCallParts struct {
	id        string
	typeName  string
	name      string
	arguments strings.Builder
}

func appendChatCompletionToolCallParts(target map[int]*chatCompletionToolCallParts, value any, replace bool) {
	for fallbackIndex, raw := range util.AsMapSlice(value) {
		index := util.ToInt(raw["index"], fallbackIndex)
		parts := target[index]
		if parts == nil {
			parts = &chatCompletionToolCallParts{}
			target[index] = parts
		}
		if id := util.Clean(raw["id"]); id != "" {
			parts.id = id
		}
		if typeName := util.Clean(raw["type"]); typeName != "" {
			parts.typeName = typeName
		}
		function := util.StringMap(raw["function"])
		if name := util.Clean(function["name"]); name != "" {
			parts.name = name
		}
		if arguments, ok := function["arguments"].(string); ok {
			if replace {
				parts.arguments.Reset()
			}
			parts.arguments.WriteString(arguments)
		}
	}
}

func completedChatCompletionToolCalls(parts map[int]*chatCompletionToolCallParts) []map[string]any {
	if len(parts) == 0 {
		return nil
	}
	indexes := make([]int, 0, len(parts))
	for index := range parts {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	calls := make([]map[string]any, 0, len(indexes))
	for _, index := range indexes {
		item := parts[index]
		if item == nil || strings.TrimSpace(item.name) == "" {
			continue
		}
		id := item.id
		if id == "" {
			id = fmt.Sprintf("tool-call-%d", index)
		}
		typeName := item.typeName
		if typeName == "" {
			typeName = "function"
		}
		calls = append(calls, map[string]any{
			"id":   id,
			"type": typeName,
			"function": map[string]any{
				"name":      item.name,
				"arguments": item.arguments.String(),
			},
		})
	}
	return calls
}

func relayTextTaskProgressCallback(payload map[string]any) func(string) {
	if callback, ok := payload[service.TextOutputCallbackPayloadKey].(func(string)); ok {
		return callback
	}
	return nil
}

func chatCompletionStreamTextDelta(item map[string]any) string {
	var parts []string
	for _, choice := range util.AsMapSlice(item["choices"]) {
		delta := util.StringMap(choice["delta"])
		if text := chatCompletionContentRawText(delta["content"]); text != "" {
			parts = append(parts, text)
		}
		if text := util.Clean(delta["text"]); text != "" {
			parts = append(parts, text)
		}
		message := util.StringMap(choice["message"])
		if text := chatCompletionContentRawText(message["content"]); text != "" {
			parts = append(parts, text)
		}
		if text := util.Clean(choice["text"]); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

func chatCompletionContentRawText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	var parts []string
	for _, item := range anyList(content) {
		block := util.StringMap(item)
		if text, ok := block["text"].(string); ok {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}
