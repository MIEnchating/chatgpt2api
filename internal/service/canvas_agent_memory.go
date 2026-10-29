package service

import (
	"strings"

	"chatgpt2api/internal/util"
)

// This is a context-planning estimate, not model-specific image billing. Image
// payload bytes are transport data; reserve a bounded visual cost per image.
const canvasAgentImageTokenEstimate = 3000

func estimateCanvasAgentTokens(value any) int {
	images := 0
	text := agentJSON(canvasAgentMemoryValue(value, false, &images))
	return (len(text)+2)/3 + images*canvasAgentImageTokenEstimate
}

// Historical summaries retain text and reference metadata, never encoded pixels
// or opaque reasoning payloads. The original active messages are not mutated.
func canvasAgentMemoryValue(value any, summary bool, images *int) any {
	switch v := value.(type) {
	case map[string]any:
		if v["type"] == "image_url" {
			*images += 1
			return map[string]any{"type": "text", "text": "[历史图片引用；原图保留在用户附件中]"}
		}
		out := make(map[string]any, len(v))
		for key, item := range v {
			if summary && (key == "reasoningContent" || key == "responseItems") {
				continue
			}
			out[key] = canvasAgentMemoryValue(item, summary, images)
		}
		return out
	case []map[string]any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = canvasAgentMemoryValue(item, summary, images)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = canvasAgentMemoryValue(item, summary, images)
		}
		return out
	case string:
		if strings.HasPrefix(v, "data:image/") {
			return "[图片数据]"
		}
	}
	return value
}

func canvasAgentCompleteToolRounds(messages []map[string]any) bool {
	pending := map[string]bool{}
	for _, message := range messages {
		if message["role"] == "assistant" {
			for _, call := range util.AsMapSlice(message["toolCalls"]) {
				id, _ := call["id"].(string)
				if id == "" || pending[id] {
					return false
				}
				pending[id] = true
			}
		}
		if message["role"] == "tool" {
			id, _ := message["toolCallId"].(string)
			if !pending[id] {
				return false
			}
			delete(pending, id)
		}
	}
	return len(pending) == 0
}

const canvasAgentMaxActiveImages = 8

// Keep durable references while bounding the images presented to the model.
// Older pixels can be loaded again with get_reference/get_node when needed.
func canvasAgentVisualWindow(messages []map[string]any, limit int) []map[string]any {
	count := 0
	for _, message := range messages {
		for _, part := range util.AsMapSlice(message["content"]) {
			if part["type"] == "image_url" {
				count++
			}
		}
	}
	remove := count - max(0, limit)
	if remove <= 0 {
		return messages
	}
	result := make([]map[string]any, len(messages))
	for i, message := range messages {
		clone := make(map[string]any, len(message))
		for key, value := range message {
			clone[key] = value
		}
		if parts := util.AsMapSlice(message["content"]); len(parts) > 0 {
			next := make([]map[string]any, len(parts))
			for j, part := range parts {
				next[j] = part
				if remove > 0 && part["type"] == "image_url" {
					next[j] = map[string]any{"type": "text", "text": "[此图暂不展示像素；对应 ID 与原图仍保留，可调用 get_reference/get_node 按需重新查看。]"}
					remove--
				}
			}
			clone["content"] = next
		}
		result[i] = clone
	}
	return result
}
