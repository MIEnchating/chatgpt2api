package httpapi

import (
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func relayImageTaskResult(payload map[string]any, result map[string]any, stream *protocol.StreamResult, err error) (map[string]any, error) {
	if err != nil || stream == nil {
		return result, err
	}
	return collectRelayImageTaskStream(payload, stream)
}

func collectRelayImageTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	created := time.Now().Unix()
	model := ""
	message := ""
	outputLimit := normalizedProtocolImageCount(payload["n"])
	accumulator := newRelayImageStreamAccumulator(outputLimit)
	onProgress := relayImageTaskProgressCallback(payload)

	for item := range stream.Items {
		if item == nil {
			continue
		}
		if value := util.ToInt(firstNonEmpty(util.Clean(item["created"]), util.Clean(item["created_at"])), 0); value > 0 {
			created = int64(value)
		}
		if model == "" {
			model = util.Clean(item["model"])
		}
		if text := util.Clean(item["message"]); text != "" {
			message = text
		} else if text := util.Clean(item["progress_text"]); text != "" {
			message += text
		}
		data := relayImageStreamItemData(item)
		if len(data) == 0 {
			continue
		}
		accumulator.apply(item, data)
		if onProgress != nil {
			onProgress(accumulator.progressData())
		}
	}

	data := accumulator.finalData()
	out := map[string]any{"created": created, "data": data}
	if model != "" {
		out["model"] = model
	}
	if len(data) == 0 && strings.TrimSpace(message) != "" {
		out["message"] = strings.TrimSpace(message)
	}
	if err := <-stream.Err; err != nil {
		if out["message"] == nil {
			out["message"] = err.Error()
		}
		return out, err
	}
	return out, nil
}

type relayImageStreamAccumulator struct {
	final    []map[string]any
	previews []map[string]any
}

func newRelayImageStreamAccumulator(outputLimit int) *relayImageStreamAccumulator {
	outputLimit = normalizedRelayImageStreamOutputLimit(outputLimit)
	return &relayImageStreamAccumulator{
		final:    make([]map[string]any, outputLimit),
		previews: make([]map[string]any, outputLimit),
	}
}

func (a *relayImageStreamAccumulator) apply(event map[string]any, data []map[string]any) {
	if a == nil || len(data) == 0 {
		return
	}
	partial := isRelayImagePartialEvent(event)
	if !partial && !isRelayImageCompletedEvent(event) {
		return
	}
	start, indexed := relayImageEventOutputIndex(event)
	for _, item := range data {
		if !indexed {
			start = a.nextFinalSlot()
		}
		if start < 0 || start >= len(a.final) {
			return
		}
		clone := cloneRelayImageData([]map[string]any{item})
		if len(clone) == 0 {
			continue
		}
		if partial {
			if a.final[start] == nil {
				clone[0]["preview"] = true
				a.previews[start] = clone[0]
			}
		} else {
			delete(clone[0], "preview")
			a.final[start] = clone[0]
			a.previews[start] = nil
		}
		start++
	}
}

func (a *relayImageStreamAccumulator) nextFinalSlot() int {
	if a == nil {
		return -1
	}
	for index, item := range a.final {
		if item == nil {
			return index
		}
	}
	return -1
}

func (a *relayImageStreamAccumulator) progressData() []map[string]any {
	if a == nil {
		return nil
	}
	length := 0
	for index := range a.final {
		if a.final[index] != nil || a.previews[index] != nil {
			length = index + 1
		}
	}
	data := make([]map[string]any, length)
	for index := range data {
		switch {
		case a.final[index] != nil:
			data[index] = cloneRelayImageData([]map[string]any{a.final[index]})[0]
		case a.previews[index] != nil:
			data[index] = cloneRelayImageData([]map[string]any{a.previews[index]})[0]
		default:
			data[index] = map[string]any{}
		}
	}
	return data
}

func (a *relayImageStreamAccumulator) finalData() []map[string]any {
	if a == nil {
		return nil
	}
	length := 0
	for index, item := range a.final {
		if item != nil {
			length = index + 1
		}
	}
	data := make([]map[string]any, length)
	for index := range data {
		if a.final[index] == nil {
			data[index] = map[string]any{}
			continue
		}
		data[index] = cloneRelayImageData([]map[string]any{a.final[index]})[0]
	}
	return data
}

func relayImageEventOutputIndex(event map[string]any) (int, bool) {
	for _, key := range []string{"output_index", "index"} {
		if _, exists := event[key]; !exists {
			continue
		}
		index := util.ToInt(event[key], -1)
		return index, index >= 0
	}
	return -1, false
}

func isRelayImagePartialEvent(event map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(util.Clean(event["type"])))
	return strings.HasSuffix(eventType, ".partial_image")
}

func isRelayImageCompletedEvent(event map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(util.Clean(event["type"])))
	return strings.HasSuffix(eventType, ".completed")
}

func relayImageTaskProgressCallback(payload map[string]any) protocol.ImageOutputProgressCallback {
	switch callback := payload["image_output_callback"].(type) {
	case protocol.ImageOutputProgressCallback:
		return callback
	case func([]map[string]any):
		return callback
	default:
		return nil
	}
}

func relayImageStreamItemData(item map[string]any) []map[string]any {
	if data := util.AsMapSlice(item["data"]); len(data) > 0 {
		return cloneRelayImageData(data)
	}
	data := map[string]any{}
	for _, key := range []string{"url", "b64_json", "revised_prompt", "text_response"} {
		if value, ok := item[key]; ok && util.Clean(value) != "" {
			data[key] = value
		}
	}
	if len(data) == 0 {
		return nil
	}
	return []map[string]any{data}
}

func cloneRelayImageData(items []map[string]any) []map[string]any {
	if len(items) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item == nil {
			continue
		}
		clone := make(map[string]any, len(item))
		for key, value := range item {
			clone[key] = value
		}
		out = append(out, clone)
	}
	return out
}
