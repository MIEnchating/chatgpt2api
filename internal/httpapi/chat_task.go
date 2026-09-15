package httpapi

import (
	"context"
	"errors"
	"strings"

	"chatgpt2api/internal/protocol"
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
		return nil, err
	}
	return map[string]any{"created": result["created_at"], "output_type": "text", "data": []map[string]any{data}}, nil
}

func collectResponseChatTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	var response map[string]any
	var streamError error
	var text strings.Builder
	onProgress := relayTextTaskProgressCallback(payload)
	for item := range stream.Items {
		switch item["type"] {
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
		return nil, err
	}
	if streamError != nil {
		return nil, streamError
	}
	if response == nil {
		return nil, errors.New("upstream response stream ended without a terminal event")
	}
	return response, nil
}
