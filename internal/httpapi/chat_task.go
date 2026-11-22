package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) executeChatTaskRequest(ctx context.Context, payload map[string]any) (map[string]any, error) {
	path, body, err := protocol.ChatTaskRequest(payload)
	if err != nil {
		return nil, err
	}
	result, stream, err := a.relayJSONMaybeStream(ctx, path, body)
	if err != nil {
		return nil, err
	}
	if path == "/v1/chat/completions" {
		if stream != nil {
			return collectRelayChatTaskStream(payload, stream)
		}
		return result, nil
	}
	if stream != nil {
		result, err = collectResponseChatTaskStream(payload, stream)
		if err != nil {
			return nil, err
		}
	}
	data, err := protocol.ResponseChatTaskData(result)
	if err != nil {
		if stream != nil {
			return nil, service.AgentModelStreamError{Err: err}
		}
		return nil, err
	}
	if callback, ok := payload[service.ReasoningSummaryCallbackPayloadKey].(func(string, string, bool)); ok {
		for index, item := range util.AsMapSlice(result["output"]) {
			if item["type"] != "reasoning" {
				continue
			}
			var parts []string
			for _, part := range util.AsMapSlice(item["summary"]) {
				if part["type"] == "summary_text" {
					if text, ok := part["text"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
			id := firstNonEmpty(util.Clean(item["id"]), fmt.Sprintf("reasoning-%d", index))
			if text := strings.Join(parts, "\n\n"); text != "" {
				callback(id, text, false)
			}
		}
	}
	return map[string]any{"created": result["created_at"], "output_type": "text", "data": []map[string]any{data}}, nil
}

func collectResponseChatTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	var response map[string]any
	var streamError error
	var text strings.Builder
	onProgress := relayTextTaskProgressCallback(payload)
	onSummary, _ := payload[service.ReasoningSummaryCallbackPayloadKey].(func(string, string, bool))
	summaries := map[string][]string{}
	summaryOrder := []string{}
	defer func() {
		if onSummary != nil {
			for _, id := range summaryOrder {
				onSummary(id, strings.Join(summaries[id], "\n\n"), false)
			}
		}
	}()
	for item := range stream.Items {
		switch item["type"] {
		case "response.reasoning_summary_text.delta":
			if onSummary == nil {
				continue
			}
			id, _ := item["item_id"].(string)
			delta, _ := item["delta"].(string)
			index, valid := util.StrictInt(item["summary_index"])
			if id == "" || len(id) > 512 || !valid || index < 0 || index >= 256 || delta == "" {
				continue
			}
			parts, exists := summaries[id]
			if !exists {
				if len(summaryOrder) >= 256 {
					continue
				}
				summaryOrder = append(summaryOrder, id)
			}
			for len(parts) <= index {
				parts = append(parts, "")
			}
			parts[index] += delta
			summaries[id] = parts
			onSummary(id, strings.Join(parts, "\n\n"), true)
		case "response.output_text.delta":
			if delta, ok := item["delta"].(string); ok {
				text.WriteString(delta)
				if onProgress != nil {
					onProgress(text.String())
				}
			}
		case "response.completed", "response.incomplete", "response.failed":
			response = util.StringMap(item["response"])
		case "error":
			message := util.Clean(item["message"])
			if message == "" {
				message = "upstream response stream failed"
			}
			streamError = errors.New(message)
		}
	}
	if err := <-stream.Err; err != nil {
		return nil, service.AgentModelStreamError{Err: err}
	}
	if streamError != nil {
		return nil, service.AgentModelStreamError{Err: streamError}
	}
	if response == nil {
		return nil, service.AgentModelStreamError{Err: errors.New("upstream response stream ended without a terminal event")}
	}
	return response, nil
}
