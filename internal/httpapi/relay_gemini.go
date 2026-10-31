package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func (a *App) relayGoogleGeminiImage(ctx context.Context, payload map[string]any, images []protocol.UploadedImage) (map[string]any, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body, err := googleGeminiImagePayload(payload, images)
	if err != nil {
		return nil, err
	}
	requestData, err := marshalGoogleGeminiInlineRequest(body)
	if err != nil {
		return nil, err
	}

	count := normalizedProtocolImageCount(payload["n"])
	results := make([][]map[string]any, count)
	var waitGroup sync.WaitGroup
	var firstErr error
	var errorMu sync.Mutex
	for index := 0; index < count; index++ {
		index := index
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			response, err := a.relayJSONDataAt(ctx, a.relayBaseURLFromPayload(payload), http.MethodPost, "/v1/chat/completions", apiKey, requestData)
			if err == nil {
				results[index], err = googleGeminiImageItems(response, util.Clean(payload["prompt"]))
			}
			if err != nil {
				errorMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errorMu.Unlock()
			}
		}()
	}
	waitGroup.Wait()
	data := make([]map[string]any, 0, count)
	for _, items := range results {
		for _, item := range items {
			if len(data) >= count {
				break
			}
			data = append(data, item)
		}
	}
	result := map[string]any{
		"created": time.Now().Unix(),
		"model":   util.Clean(payload["model"]),
		"data":    data,
	}
	if firstErr != nil {
		return result, firstErr
	}
	return result, nil
}

func marshalGoogleGeminiInlineRequest(payload map[string]any) ([]byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if len(data) > maxGoogleGeminiInlineRequestBytes {
		return nil, protocol.HTTPError{
			Status:  http.StatusRequestEntityTooLarge,
			Message: "Gemini 参考图请求超过 Google 内联图片 20 MB 限制，请减少图片数量或压缩图片",
		}
	}
	return data, nil
}

func validateGoogleGeminiInlineRequest(payload map[string]any, images []protocol.UploadedImage) error {
	if imagePayloadRoute(payload) != util.ImageModelRouteGoogleGemini {
		return nil
	}
	body, err := googleGeminiImagePayload(payload, images)
	if err != nil {
		return err
	}
	_, err = marshalGoogleGeminiInlineRequest(body)
	return err
}

func googleGeminiImagePayload(payload map[string]any, images []protocol.UploadedImage) (map[string]any, error) {
	model := util.Clean(payload["model"])
	prompt := strings.TrimSpace(util.Clean(payload["prompt"]))
	if prompt == "" {
		prompt = protocol.ExtractChatPrompt(payload)
	}
	if prompt == "" {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "prompt is required"}
	}

	messages := googleGeminiImageMessages(payload, prompt, images)
	body := map[string]any{
		"model":    model,
		"messages": messages,
	}
	if imageConfig := googleGeminiImageConfig(model, payload); len(imageConfig) > 0 {
		body["extra_body"] = map[string]any{
			"google": map[string]any{"image_config": imageConfig},
		}
	}
	return body, nil
}

func googleGeminiImageMessages(payload map[string]any, prompt string, images []protocol.UploadedImage) []map[string]any {
	messages := make([]map[string]any, 0)
	for _, raw := range util.AsMapSlice(payload["messages"]) {
		role := strings.ToLower(strings.TrimSpace(util.Clean(raw["role"])))
		if role != "system" && role != "user" && role != "assistant" {
			continue
		}
		content := raw["content"]
		if content == nil {
			continue
		}
		messages = append(messages, map[string]any{"role": role, "content": content})
	}

	lastUser := -1
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index]["role"] == "user" {
			lastUser = index
			break
		}
	}
	if lastUser < 0 {
		messages = append(messages, map[string]any{"role": "user", "content": prompt})
		lastUser = len(messages) - 1
	} else {
		messages[lastUser]["content"] = prompt
	}

	if len(images) == 0 {
		return messages
	}
	parts := []map[string]any{{"type": "text", "text": prompt}}
	for _, image := range images {
		if len(image.Data) == 0 {
			continue
		}
		contentType := strings.TrimSpace(image.ContentType)
		if contentType == "" {
			contentType = http.DetectContentType(image.Data)
		}
		if !strings.HasPrefix(contentType, "image/") {
			contentType = "image/png"
		}
		parts = append(parts, map[string]any{
			"type": "image_url",
			"image_url": map[string]any{
				"url": fmt.Sprintf("data:%s;base64,%s", contentType, base64.StdEncoding.EncodeToString(image.Data)),
			},
		})
	}
	messages[lastUser]["content"] = parts
	return messages
}

func googleGeminiImageItems(response map[string]any, prompt string) ([]map[string]any, error) {
	if message := firstNonEmpty(
		relayErrorMessageFromValue(response["error"]),
		relayErrorMessageFromValue(response["detail"]),
	); message != "" {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: message}
	}
	items := make([]map[string]any, 0)
	details := make([]string, 0)
	for _, choice := range util.AsMapSlice(response["choices"]) {
		message := util.StringMap(choice["message"])
		content := message["content"]
		for _, image := range protocol.ExtractImagesFromMessageContent(content) {
			if len(image.Data) == 0 {
				continue
			}
			contentType := strings.TrimSpace(image.ContentType)
			if contentType == "" {
				contentType = "image/png"
			}
			items = append(items, map[string]any{
				"b64_json":       base64.StdEncoding.EncodeToString(image.Data),
				"revised_prompt": prompt,
				"output_format":  strings.TrimPrefix(contentType, "image/"),
			})
		}
		for _, imageURL := range protocol.ExtractMarkdownImageURLs(protocol.ExtractPromptFromMessageContent(content)) {
			items = append(items, map[string]any{
				"url":            imageURL,
				"revised_prompt": prompt,
			})
		}
		if text, ok := content.(string); ok {
			if text = strings.TrimSpace(text); text != "" && !strings.Contains(text, "data:image/") {
				details = append(details, text)
			}
		} else if text := protocol.ExtractPromptFromMessageContent(content); text != "" {
			details = append(details, text)
		}
		if refusal := strings.TrimSpace(util.Clean(message["refusal"])); refusal != "" {
			details = append(details, refusal)
		}
		if reason := strings.TrimSpace(util.Clean(choice["finish_reason"])); reason != "" && !strings.EqualFold(reason, "stop") {
			details = append(details, "finish_reason: "+reason)
		}
	}
	if len(items) > 0 {
		return items, nil
	}
	for _, key := range []string{"prompt_feedback", "promptFeedback"} {
		feedback := util.StringMap(response[key])
		if reason := strings.TrimSpace(util.Clean(feedback["block_reason"])); reason != "" {
			details = append(details, "block_reason: "+reason)
		}
		if reason := strings.TrimSpace(util.Clean(feedback["blockReason"])); reason != "" {
			details = append(details, "block_reason: "+reason)
		}
	}
	details = dedupe(details)
	if len(details) == 0 {
		return nil, protocol.HTTPError{
			Status:  http.StatusBadGateway,
			Message: "Google Gemini 未返回图片，响应可能被内容安全策略拦截",
		}
	}
	return nil, protocol.HTTPError{
		Status:  http.StatusBadGateway,
		Message: "Google Gemini 未返回图片：" + strings.Join(details, "；"),
	}
}

func googleGeminiImageConfig(model string, payload map[string]any) map[string]any {
	config := map[string]any{}
	if d, ok := configuredImageDefinition(payload); ok {
		if ratio := configuredImageAspectRatio(payload, d); ratio != "" {
			config["aspect_ratio"] = ratio
		}
		resolution := strings.ToLower(firstNonEmpty(util.Clean(payload["image_resolution"]), util.Clean(payload["resolution"])))
		if resolution != "" && resolution != "auto" {
			config["image_size"] = strings.ToUpper(resolution)
		}
		return config
	}
	if aspectRatio := googleGeminiAspectRatio(model, util.Clean(payload["size"])); aspectRatio != "" {
		config["aspect_ratio"] = aspectRatio
	}
	if imageSize := googleGeminiImageSize(model, payload); imageSize != "" {
		config["image_size"] = imageSize
	}
	return config
}

func googleGeminiAspectRatio(model, size string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(size, "×", "x")))
	if normalized == "" || normalized == "auto" {
		return ""
	}
	var width, height float64
	if parsedWidth, parsedHeight, ok := parseRelayImageDimensions(normalized); ok {
		width, height = float64(parsedWidth), float64(parsedHeight)
	} else if parsedWidth, parsedHeight, ok := parseRelayImageRatio(normalized); ok {
		width, height = parsedWidth, parsedHeight
	} else {
		return ""
	}
	return closestImageAspectRatio(width/height, googleGeminiSupportedAspectRatios(model))
}

func googleGeminiSupportedAspectRatios(model string) []string {
	if util.IsGoogleGemini31FlashImageModel(model) {
		return []string{"1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"}
	}
	// Gemini 3.1 Flash Lite, Gemini 3 Pro, and Gemini 2.5 Flash Image use
	// Google's standard ten ratios.
	return []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
}

func closestImageAspectRatio(target float64, supported []string) string {
	if target <= 0 || len(supported) == 0 {
		return ""
	}
	best := supported[0]
	bestDistance := math.Inf(1)
	for _, value := range supported {
		width, height, ok := parseRelayImageRatio(value)
		if !ok {
			continue
		}
		distance := math.Abs(width/height - target)
		if distance < bestDistance {
			best, bestDistance = value, distance
		}
	}
	return best
}

func googleGeminiImageSize(model string, payload map[string]any) string {
	value := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(value, "2.5") {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"]))) {
	case "low":
		return "1K"
	case "medium":
		return "2K"
	case "high":
		return "4K"
	}
	preset := strings.ToLower(strings.Join([]string{
		util.Clean(payload["requested_size"]),
		util.Clean(payload["size"]),
	}, " "))
	if strings.Contains(preset, "6272x2688") || strings.Contains(preset, "3840x2160") || strings.Contains(preset, "2160x3840") {
		return "4K"
	}
	if strings.Contains(preset, "2048x") || strings.Contains(preset, "3136x1344") {
		return "2K"
	}
	return ""
}
