package httpapi

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func (a *App) relayImageCreationTask(ctx context.Context, payload map[string]any, images []protocol.UploadedImage, edit bool) (map[string]any, error) {
	switch util.Clean(payload["api_mode"]) {
	case "responses":
		request := imageResponsesRequest(payload, images, edit)
		result, stream, err := a.relayResponses(ctx, request)
		return responsesImageTaskResult(result, stream, err)
	case "chat":
		request := imageChatRequest(payload, images)
		result, stream, err := a.relayChatCompletions(ctx, request)
		if err != nil {
			return result, err
		}
		if stream != nil {
			return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "Chat Completions 图片模式返回了不支持的流式响应"}
		}
		return chatImageTaskResult(result)
	default:
		if edit {
			result, stream, err := a.relayImageEdits(ctx, payload, images)
			return relayImageTaskResult(payload, result, stream, err)
		}
		result, stream, err := a.relayImageGenerations(ctx, payload)
		return relayImageTaskResult(payload, result, stream, err)
	}
}

func imageResponsesRequest(payload map[string]any, images []protocol.UploadedImage, edit bool) map[string]any {
	prompt := util.Clean(payload["prompt"])
	input := any(prompt)
	if dataURLs := uploadedImageDataURLs(images); len(dataURLs) > 0 {
		content := []map[string]any{{"type": "input_text", "text": prompt}}
		for _, dataURL := range dataURLs {
			content = append(content, map[string]any{"type": "input_image", "image_url": dataURL})
		}
		input = []map[string]any{{"role": "user", "content": content}}
	}
	tool := map[string]any{
		"type":   "image_generation",
		"action": map[bool]string{false: "generate", true: "edit"}[edit],
		"size":   firstNonEmpty(util.Clean(payload["size"]), "auto"),
	}
	if quality := util.Clean(payload["quality"]); quality != "" {
		tool["quality"] = quality
	}
	if util.ToBool(payload["stream"]) {
		tool["partial_images"] = max(0, min(3, util.ToInt(payload["partial_images"], 1)))
	}
	request := map[string]any{
		"model":       payload["model"],
		"input":       input,
		"tools":       []map[string]any{tool},
		"tool_choice": "required",
	}
	if util.ToBool(payload["stream"]) {
		request["stream"] = true
	}
	copyRelayTaskCredentials(request, payload)
	return request
}

func imageChatRequest(payload map[string]any, images []protocol.UploadedImage) map[string]any {
	prompt := util.Clean(payload["prompt"])
	content := any(prompt)
	if dataURLs := uploadedImageDataURLs(images); len(dataURLs) > 0 {
		parts := []map[string]any{{"type": "text", "text": prompt}}
		for _, dataURL := range dataURLs {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": dataURL}})
		}
		content = parts
	}
	request := map[string]any{
		"model":      payload["model"],
		"messages":   []map[string]any{{"role": "user", "content": content}},
		"modalities": []string{"image", "text"},
		"stream":     false,
	}
	if config := referenceChatImageConfig(payload); len(config) > 0 {
		request["image_config"] = config
	}
	copyRelayTaskCredentials(request, payload)
	return request
}

func referenceChatImageConfig(payload map[string]any) map[string]any {
	config := map[string]any{}
	if ratio := referenceChatImageRatio(firstNonEmpty(util.Clean(payload["requested_size"]), util.Clean(payload["size"]))); ratio != "" {
		config["aspect_ratio"] = ratio
	}
	quality := strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"])))
	preset := strings.ToLower(util.Clean(payload["size"]) + " " + util.Clean(payload["requested_size"]))
	imageSize := ""
	switch quality {
	case "low":
		imageSize = "1K"
	case "medium":
		imageSize = "2K"
	case "high":
		imageSize = "4K"
	default:
		if strings.Contains(preset, "6272x2688") || strings.Contains(preset, "3840x2160") || strings.Contains(preset, "2160x3840") {
			imageSize = "4K"
		} else if strings.Contains(preset, "2048x") || strings.Contains(preset, "3136x1344") {
			imageSize = "2K"
		}
	}
	if !strings.Contains(strings.ToLower(util.Clean(payload["model"])), "2.5") && imageSize != "" {
		config["image_size"] = imageSize
	}
	return config
}

func referenceChatImageRatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	exact := map[string]string{
		"1:1": "1:1", "2048x2048": "1:1", "3:2": "3:2", "2:3": "2:3", "4:3": "4:3", "3:4": "3:4",
		"16:9": "16:9", "2048x1152": "16:9", "3840x2160": "16:9", "9:16": "9:16", "1152x2048": "9:16", "2160x3840": "9:16",
		"21:9": "21:9", "3136x1344": "21:9", "6272x2688": "21:9",
	}
	if ratio := exact[normalized]; ratio != "" {
		return ratio
	}
	if normalized == "" || normalized == "auto" {
		return ""
	}
	width, height, ok := parseRelayImageDimensions(normalized)
	if !ok {
		return "1:1"
	}
	return closestImageAspectRatio(float64(width)/float64(height), []string{"1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"})
}

func uploadedImageDataURLs(images []protocol.UploadedImage) []string {
	values := make([]string, 0, len(images))
	for _, image := range images {
		if len(image.Data) == 0 {
			continue
		}
		contentType := strings.TrimSpace(image.ContentType)
		if !strings.HasPrefix(contentType, "image/") {
			contentType = http.DetectContentType(image.Data)
		}
		if !strings.HasPrefix(contentType, "image/") {
			contentType = "image/png"
		}
		values = append(values, fmt.Sprintf("data:%s;base64,%s", contentType, base64.StdEncoding.EncodeToString(image.Data)))
	}
	return values
}

func copyRelayTaskCredentials(target, source map[string]any) {
	if value, ok := source["api_key"]; ok {
		target["api_key"] = value
	}
}

func chatImageTaskResult(result map[string]any) (map[string]any, error) {
	data := make([]map[string]any, 0)
	for _, choice := range util.AsMapSlice(result["choices"]) {
		message := util.StringMap(choice["message"])
		for _, raw := range util.AsMapSlice(message["images"]) {
			imageURL := raw["image_url"]
			url := util.Clean(imageURL)
			if item := util.StringMap(imageURL); len(item) > 0 {
				url = util.Clean(item["url"])
			}
			if url == "" {
				continue
			}
			if b64, ok := imageDataURLBase64(url); ok {
				data = append(data, map[string]any{"b64_json": b64})
			} else {
				data = append(data, map[string]any{"url": url})
			}
		}
	}
	if len(data) == 0 {
		return result, protocol.HTTPError{Status: http.StatusBadGateway, Message: "Chat Completions 没有返回图片"}
	}
	return map[string]any{"created": result["created"], "model": result["model"], "data": data}, nil
}

func responsesImageTaskResult(result map[string]any, stream *protocol.StreamResult, err error) (map[string]any, error) {
	if err != nil {
		return result, err
	}
	if stream != nil {
		result, err = collectResponsesImageTaskStream(stream)
		if err != nil {
			return result, err
		}
	}
	data := responsesImageData(result)
	if len(data) == 0 {
		return result, protocol.HTTPError{Status: http.StatusBadGateway, Message: "Responses API 没有返回图片"}
	}
	return map[string]any{"created": firstNonEmpty(util.Clean(result["created_at"]), util.Clean(result["created"])), "model": result["model"], "data": data}, nil
}

func collectResponsesImageTaskStream(stream *protocol.StreamResult) (map[string]any, error) {
	result := map[string]any{"created_at": time.Now().Unix(), "output": []map[string]any{}}
	items := make([]map[string]any, 0)
	partials := map[int]string{}
	for event := range stream.Items {
		if response := util.StringMap(event["response"]); len(response) > 0 {
			result = response
		}
		if item := util.StringMap(event["item"]); util.Clean(item["type"]) == "image_generation_call" {
			items = append(items, item)
		}
		if util.Clean(event["type"]) == "response.image_generation_call.partial_image" {
			if b64 := util.Clean(event["partial_image_b64"]); b64 != "" {
				partials[util.ToInt(event["output_index"], 0)] = b64
			}
		}
	}
	if len(util.AsMapSlice(result["output"])) == 0 && len(items) > 0 {
		result["output"] = items
	}
	if len(responsesImageData(result)) == 0 && len(partials) > 0 {
		output := make([]map[string]any, 0, len(partials))
		for index := 0; index <= len(partials); index++ {
			if b64 := partials[index]; b64 != "" {
				output = append(output, map[string]any{"type": "image_generation_call", "result": b64})
			}
		}
		result["output"] = output
	}
	if err := <-stream.Err; err != nil {
		return result, err
	}
	return result, nil
}

func responsesImageData(result map[string]any) []map[string]any {
	data := make([]map[string]any, 0)
	seen := map[string]struct{}{}
	for _, item := range util.AsMapSlice(result["output"]) {
		if util.Clean(item["type"]) != "image_generation_call" {
			continue
		}
		for _, value := range collectResponsesImageStrings(item, 0) {
			if _, exists := seen[value]; exists {
				continue
			}
			seen[value] = struct{}{}
			if b64, ok := imageDataURLBase64(value); ok {
				value = b64
			}
			data = append(data, map[string]any{"b64_json": value})
		}
	}
	return data
}

func collectResponsesImageStrings(value any, depth int) []string {
	if depth > 5 || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) != "" {
			return []string{strings.TrimSpace(typed)}
		}
	case []any:
		values := make([]string, 0)
		for _, item := range typed {
			values = append(values, collectResponsesImageStrings(item, depth+1)...)
		}
		return values
	case map[string]any:
		values := make([]string, 0)
		for _, key := range []string{"result", "b64_json", "base64", "image", "image_data", "data"} {
			values = append(values, collectResponsesImageStrings(typed[key], depth+1)...)
		}
		return values
	}
	return nil
}

func imageDataURLBase64(value string) (string, bool) {
	if !strings.HasPrefix(value, "data:image/") {
		return "", false
	}
	_, encoded, ok := strings.Cut(value, ",")
	return encoded, ok && encoded != ""
}
