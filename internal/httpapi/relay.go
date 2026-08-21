package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const (
	relayImageTaskSlotManagedPayloadKey = "relay_image_task_slot_managed"
	relayStreamMaxTokenSize             = 64 * 1024 * 1024
	relayJSONSuccessMaxBytes            = 256 * 1024 * 1024
	relayJSONErrorMaxBytes              = 1 * 1024 * 1024
	maxGoogleGeminiInlineRequestBytes   = 20 * 1024 * 1024
)

type relayImageTaskSlotManagedMarker struct{}

type relayBufferedReadCloser struct {
	*bufio.Reader
	io.Closer
}

func (a *App) attachRelayAPIKeyForIdentity(ctx context.Context, identity service.Identity, body map[string]any) error {
	if body == nil {
		return nil
	}
	key, err := a.relayAPIKeyForIdentitySelection(ctx, identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body))
	if err != nil {
		return err
	}
	protocol.RecordAccountUsage(ctx, key)
	body["api_key"] = key
	return nil
}

func (a *App) relayAPIKeyForIdentity(ctx context.Context, identity service.Identity) (string, error) {
	return a.relayAPIKeyForIdentitySelection(ctx, identity, "", "")
}

func (a *App) relayAPIKeyForIdentityGroup(ctx context.Context, identity service.Identity, group string) (string, error) {
	return a.relayAPIKeyForIdentitySelection(ctx, identity, group, "")
}

func (a *App) relayAPIKeyForIdentitySelection(ctx context.Context, identity service.Identity, group, name string) (string, error) {
	if a == nil || a.newAPIKeys == nil {
		return "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "请先配置云棉数据库连接，并在云棉创建指定分组的令牌"}
	}
	key, err := a.newAPIKeys.KeyForIdentityGroupAndName(ctx, identity, group, name)
	if err != nil {
		return "", protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	return key, nil
}

func (a *App) relayBaseURL() string {
	if a != nil && a.config != nil {
		return a.config.RelayBaseURL()
	}
	return "http://newapi:3000"
}

func relayAPIKeyFromPayload(payload map[string]any) string {
	for _, key := range []string{"api_key", "relay_api_key", "relayai_api_key", "upstream_api_key"} {
		if value := util.Clean(payload[key]); value != "" {
			return value
		}
	}
	return ""
}

func selectedRelayTokenGroupFromPayload(payload map[string]any) string {
	for _, key := range []string{"token_group", "newapi_token_group", "relay_token_group"} {
		if value := util.Clean(payload[key]); value != "" {
			return value
		}
	}
	return ""
}

func selectedRelayTokenNameFromPayload(payload map[string]any) string {
	for _, key := range []string{"token_name", "newapi_token_name", "relay_token_name"} {
		if value := util.Clean(payload[key]); value != "" {
			return value
		}
	}
	return ""
}

func (a *App) relayListModels(ctx context.Context, apiKey string) (map[string]any, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		models := dedupe(append(a.configuredImageModels(), a.configuredChatModels()...))
		data := make([]map[string]any, 0, len(models))
		for _, model := range models {
			data = append(data, map[string]any{
				"id": model, "object": "model", "created": 0,
				"owned_by": "relayai", "permission": []any{}, "root": model, "parent": nil,
			})
		}
		return map[string]any{"object": "list", "data": data}, nil
	}
	return a.relayJSON(ctx, http.MethodGet, "/v1/models", apiKey, nil)
}

func (a *App) relayImageGenerations(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	if strings.TrimSpace(util.Clean(payload["prompt"])) == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "prompt is required"}
	}
	if err := validateRelayImageRequest("/v1/images/generations", util.Clean(payload["model"]), payload, nil); err != nil {
		return nil, nil, err
	}
	var release func()
	var err error
	if !relayImageTaskSlotIsManaged(payload) {
		release, err = relayAcquireImageTaskSlot(ctx, payload)
		if err != nil {
			return nil, nil, err
		}
	}
	if util.IsGoogleGeminiImageModel(util.Clean(payload["model"])) {
		result, err := a.relayGoogleGeminiImage(ctx, payload, nil)
		if release != nil {
			release()
		}
		return result, nil, err
	}
	result, stream, err := a.relayJSONMaybeStream(ctx, "/v1/images/generations", payload)
	if err != nil {
		if release != nil {
			release()
		}
		return result, stream, err
	}
	if stream != nil {
		stream = a.localizeRelayImageStream(ctx, payload, stream)
	}
	if stream != nil && release != nil {
		return result, relayImageStreamWithSlotRelease(ctx, stream, release), nil
	}
	if release != nil {
		release()
	}
	return result, stream, err
}

func (a *App) relayImageEdits(ctx context.Context, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	if len(images) == 0 {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "image file is required"}
	}
	if strings.TrimSpace(util.Clean(payload["prompt"])) == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "prompt is required"}
	}
	model := util.Clean(payload["model"])
	if err := validateRelayImageRequest("/v1/images/edits", model, payload, images); err != nil {
		return nil, nil, err
	}
	if err := validateRelayImageReferenceCount(model, len(images)); err != nil {
		return nil, nil, err
	}
	var release func()
	var err error
	if !relayImageTaskSlotIsManaged(payload) {
		release, err = relayAcquireImageTaskSlot(ctx, payload)
		if err != nil {
			return nil, nil, err
		}
	}
	if util.IsGoogleGeminiImageModel(model) {
		result, err := a.relayGoogleGeminiImage(ctx, payload, images)
		if release != nil {
			release()
		}
		return result, nil, err
	}
	result, stream, err := a.relayMultipartMaybeStream(ctx, "/v1/images/edits", payload, images)
	if err != nil {
		if release != nil {
			release()
		}
		return result, stream, err
	}
	if stream != nil {
		stream = a.localizeRelayImageStream(ctx, payload, stream)
	}
	if stream != nil && release != nil {
		return result, relayImageStreamWithSlotRelease(ctx, stream, release), nil
	}
	if release != nil {
		release()
	}
	return result, stream, err
}

func validateRelayImageRequest(pathValue, model string, payload map[string]any, images []protocol.UploadedImage) error {
	if err := validateRelayImageIntegerParameter(payload, "partial_images", 0, 3); err != nil {
		return err
	}
	if err := validateRelayImageIntegerParameter(payload, "output_compression", 0, 100); err != nil {
		return err
	}
	return validateRelayImageMask(pathValue, model, payload, images)
}

func validateRelayImageIntegerParameter(payload map[string]any, key string, minimum, maximum int) error {
	if payload == nil || payload[key] == nil || strings.TrimSpace(util.Clean(payload[key])) == "" {
		return nil
	}
	value, ok := util.StrictInt(payload[key])
	if !ok || value < minimum || value > maximum {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s must be an integer between %d and %d", key, minimum, maximum)}
	}
	return nil
}

func validateRelayImageMask(pathValue, model string, payload map[string]any, images []protocol.UploadedImage) error {
	if payload == nil || !hasRelayImageMask(payload["input_image_mask"]) {
		return nil
	}
	if pathValue != "/v1/images/edits" && pathValue != "/api/creation-tasks/image-edits" {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask is only supported by the image edits endpoint"}
	}
	if util.ImageModelRouteFor(model) != util.ImageModelRouteOpenAI {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support mask editing through NewAPI", model)}
	}
	if len(images) == 0 {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask requires an input image"}
	}
	mask, maskInfo, err := relayImageMask(payload["input_image_mask"])
	if err != nil {
		return err
	}
	firstInfo, err := util.InspectRasterImage(images[0].Data, "image/png")
	if err != nil {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "the first input image must be a PNG when a mask is provided"}
	}
	if firstInfo.Width != maskInfo.Width || firstInfo.Height != maskInfo.Height {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask and first input image must have the same dimensions"}
	}
	payload["input_image_mask"] = uploadedImageDataURL(mask)
	return nil
}

func hasRelayImageMask(value any) bool {
	if value == nil {
		return false
	}
	if item := util.StringMap(value); len(item) > 0 {
		return strings.TrimSpace(util.Clean(item["image_url"])) != "" || strings.TrimSpace(util.Clean(item["file_id"])) != ""
	}
	return strings.TrimSpace(util.Clean(value)) != ""
}

func relayImageMask(value any) (protocol.UploadedImage, util.RasterImageInfo, error) {
	raw := strings.TrimSpace(util.Clean(value))
	if item := util.StringMap(value); len(item) > 0 {
		raw = strings.TrimSpace(util.Clean(item["image_url"]))
	}
	if raw == "" {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask data is required"}
	}

	var (
		data        []byte
		contentType string
		err         error
	)
	if strings.HasPrefix(strings.ToLower(raw), "data:") {
		data, contentType, err = imageDataURLBytes(raw)
	} else {
		if len(raw) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
			return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusRequestEntityTooLarge, Message: "mask file is too large"}
		}
		data, err = base64.StdEncoding.DecodeString(raw)
		contentType = "image/png"
	}
	if err != nil {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask must be a valid base64-encoded PNG"}
	}
	if len(data) > maxRelayImageBytes {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusRequestEntityTooLarge, Message: "mask file is too large"}
	}
	info, err := util.InspectRasterImage(data, "image/png")
	if err != nil || !strings.EqualFold(contentType, "image/png") {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask must be a PNG image"}
	}
	if !pngHasAlphaChannel(data) {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask PNG must contain an alpha channel"}
	}
	return protocol.UploadedImage{Data: data, Filename: "mask.png", ContentType: "image/png"}, info, nil
}

func pngHasAlphaChannel(data []byte) bool {
	return len(data) > 25 &&
		bytes.Equal(data[:8], []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'}) &&
		string(data[12:16]) == "IHDR" &&
		(data[25] == 4 || data[25] == 6)
}

func validateRelayImageReferenceCount(model string, count int) error {
	if count <= 0 {
		return nil
	}
	limit := util.MaxImageReferenceImages(model)
	if count <= limit {
		return nil
	}
	if limit == 0 {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support reference image editing through NewAPI", model)}
	}
	return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s supports at most %d reference images through NewAPI", model, limit)}
}

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

	count := normalizedProtocolImageCount(payload["n"], util.Clean(payload["model"]))
	results := make([][]map[string]any, count)
	var waitGroup sync.WaitGroup
	var firstErr error
	var errorMu sync.Mutex
	for index := 0; index < count; index++ {
		index := index
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			response, err := a.relayJSONData(ctx, http.MethodPost, "/v1/chat/completions", apiKey, requestData)
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
	if !util.IsGoogleGeminiImageModel(util.Clean(payload["model"])) {
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
	if !util.IsGoogleGemini3ImageModel(value) {
		return ""
	}
	isFlashLiteImage := util.IsGoogleGeminiFlashLiteImageModel(value)
	isFlash31Image := util.IsGoogleGemini31FlashImageModel(value)
	for _, candidate := range []string{util.Clean(payload["image_resolution"]), util.Clean(payload["size"])} {
		switch strings.ToLower(strings.TrimSpace(candidate)) {
		case "4k":
			if isFlashLiteImage {
				return "1K"
			}
			return "4K"
		case "2k":
			if isFlashLiteImage {
				return "1K"
			}
			return "2K"
		case "1080p", "1k":
			return "1K"
		case "512", "512px", "0.5k":
			if isFlash31Image {
				return "512"
			}
			return "1K"
		}
	}
	if width, height, ok := parseRelayImageDimensions(strings.ToLower(util.Clean(payload["size"]))); ok {
		pixels := int64(width) * int64(height)
		switch {
		case isFlashLiteImage:
			return "1K"
		case pixels <= int64(768*768) && isFlash31Image:
			return "512"
		case pixels <= int64(1536*1536):
			return "1K"
		case pixels <= int64(3072*3072):
			return "2K"
		default:
			return "4K"
		}
	}
	return ""
}

func (a *App) relayChatCompletions(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/chat/completions", payload)
}

func (a *App) relayResponses(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/responses", payload)
}

func (a *App) relayMessages(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/messages", payload)
}

func (a *App) relayJSONMaybeStream(ctx context.Context, path string, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	if util.ToBool(body["stream"]) {
		return a.relayJSONStream(ctx, path, apiKey, body)
	}
	result, err := a.relayJSON(ctx, http.MethodPost, path, apiKey, body)
	if err == nil && relayImagePath(path) {
		err = relayImageJSONResultError(result)
	}
	return result, nil, err
}

func (a *App) relayMultipartMaybeStream(ctx context.Context, path string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	if util.ToBool(body["stream"]) {
		return a.relayMultipartStream(ctx, path, apiKey, body, images)
	}
	result, err := a.relayMultipart(ctx, path, apiKey, body, images)
	if err == nil && relayImagePath(path) {
		err = relayImageJSONResultError(result)
	}
	return result, nil, err
}

func relayImagePath(path string) bool {
	return path == "/v1/images/generations" || path == "/v1/images/edits"
}

func (a *App) relayJSON(ctx context.Context, method, pathValue, apiKey string, payload map[string]any) (map[string]any, error) {
	var data []byte
	if payload != nil {
		var err error
		data, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	return a.relayJSONData(ctx, method, pathValue, apiKey, data)
}

func (a *App) relayJSONData(ctx context.Context, method, pathValue, apiKey string, data []byte) (map[string]any, error) {
	var body io.Reader
	if data != nil {
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.relayBaseURL()+pathValue, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "application/json")
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

// relayVideoTask submits an OpenAI-compatible asynchronous video request to
// the configured relay and polls it until a playable URL is available.
func (a *App) relayVideoTask(ctx context.Context, payload map[string]any) (map[string]any, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频任务缺少上游令牌"}
	}
	request := officialVideoRequestPayload(payload)
	created, err := a.relayJSON(ctx, http.MethodPost, "/v1/videos", apiKey, request)
	if err != nil {
		return created, err
	}
	taskID := firstNonEmpty(util.Clean(created["id"]), util.Clean(created["task_id"]))
	if taskID == "" {
		if message := videoUpstreamErrorMessage(created); message != "" {
			return created, protocol.HTTPError{Status: http.StatusBadGateway, Message: message}
		}
		return created, protocol.HTTPError{Status: http.StatusBadGateway, Message: "视频上游没有返回任务 ID"}
	}
	interval := 2 * time.Second
	timeout := 5 * time.Minute
	if a != nil && a.config != nil {
		timeout = time.Duration(a.config.ImageTaskTimeoutSeconds()) * time.Second
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		state, pollErr := a.relayJSON(ctx, http.MethodGet, "/v1/videos/"+url.PathEscape(taskID), apiKey, nil)
		if pollErr != nil {
			return state, pollErr
		}
		status := strings.ToLower(strings.TrimSpace(util.Clean(state["status"])))
		if status == "completed" || status == "succeeded" || status == "success" {
			videoURL := videoResultURL(state, a.relayBaseURL(), taskID)
			if videoURL == "" {
				return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: "视频已完成但上游没有返回视频地址"}
			}
			if strings.Contains(videoURL, "/v1/videos/") && strings.HasSuffix(videoURL, "/content") {
				if localURL, saveErr := a.downloadRelayVideo(ctx, videoURL, apiKey, util.Clean(payload["owner_id"]), taskID); saveErr == nil {
					videoURL = localURL
				}
			}
			return map[string]any{"created": state["created_at"], "data": []map[string]any{{"url": videoURL, "type": "video", "mime_type": "video/mp4", "video_url": videoURL}}, "output_type": "video", "model": payload["model"]}, nil
		}
		if status == "failed" || status == "cancelled" || status == "error" {
			return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: videoErrorMessage(state)}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, protocol.HTTPError{Status: http.StatusGatewayTimeout, Message: "视频生成超时，请稍后重试"}
}

// officialVideoRequestPayload keeps the application API stable while adding
// the parameter names used by the providers' official video APIs. The
// OpenAI-compatible aliases remain for relays that expose a common schema.
func officialVideoRequestPayload(payload map[string]any) map[string]any {
	model := util.Clean(payload["model"])
	name := strings.ToLower(model)
	seconds := util.ToInt(payload["seconds"], 0)
	request := map[string]any{
		"model":    model,
		"prompt":   payload["prompt"],
		"seconds":  payload["seconds"],
		"duration": seconds,
		"size":     payload["size"],
	}
	if resolution := util.Clean(payload["resolution"]); resolution != "" {
		request["resolution"] = resolution
	}
	size := util.Clean(payload["size"])
	switch {
	case strings.Contains(name, "grok"):
		if size != "" {
			request["aspect_ratio"] = size
		}
		// xAI's video API does not expose audio or watermark controls.
	case strings.Contains(name, "kling"):
		if size != "" {
			request["aspect_ratio"] = size
		}
		if value, ok := payload["generate_audio"].(bool); ok {
			// Kling's official request names this switch sound.
			request["sound"] = value
		}
	case strings.Contains(name, "minimax") || strings.Contains(name, "hailuo") || strings.HasPrefix(name, "t2v-") || strings.HasPrefix(name, "i2v-") || strings.HasPrefix(name, "s2v-"):
		if size != "" {
			request["ratio"] = size
		}
		if value, ok := payload["watermark"].(bool); ok {
			request["aigc_watermark"] = value
		}
	case strings.Contains(name, "seedance") || strings.Contains(name, "doubao-seedance"):
		if size != "" {
			request["ratio"] = size
		}
		if value, ok := payload["generate_audio"].(bool); ok {
			request["generate_audio"] = value
		}
		if value, ok := payload["watermark"].(bool); ok {
			request["watermark"] = value
		}
	default:
		if value, ok := payload["generate_audio"].(bool); ok {
			request["generate_audio"] = value
		}
		if value, ok := payload["watermark"].(bool); ok {
			request["watermark"] = value
		}
	}
	if refs := util.AsStringSlice(payload["reference_image_urls"]); len(refs) > 0 {
		request["input_reference"] = refs[0]
	}
	return request
}

func (a *App) downloadRelayVideo(ctx context.Context, videoURL, apiKey, owner, taskID string) (string, error) {
	if a == nil || strings.TrimSpace(a.videoDir) == "" {
		return "", fmt.Errorf("video storage is unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, videoURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("video content returned status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return "", err
	}
	name := util.SHA1Short(owner+":"+taskID, 24) + ".mp4"
	if err := os.WriteFile(filepath.Join(a.videoDir, name), data, 0o644); err != nil {
		return "", err
	}
	return "/videos/" + name, nil
}

func videoResultURL(state map[string]any, baseURL, taskID string) string {
	if metadata, ok := state["metadata"].(map[string]any); ok {
		if value := util.Clean(metadata["url"]); value != "" {
			return absoluteRelayURL(baseURL, value)
		}
		if value := util.Clean(metadata["video_url"]); value != "" {
			return absoluteRelayURL(baseURL, value)
		}
	}
	for _, key := range []string{"url", "video_url", "result_url", "content_url"} {
		if value := util.Clean(state[key]); value != "" {
			return absoluteRelayURL(baseURL, value)
		}
	}
	return strings.TrimRight(baseURL, "/") + "/v1/videos/" + url.PathEscape(taskID) + "/content"
}

func absoluteRelayURL(baseURL, value string) string {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "data:") {
		return value
	}
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(value, "/")
}

func videoErrorMessage(state map[string]any) string {
	return firstNonEmpty(videoUpstreamErrorMessage(state), "视频生成失败，请查看上游错误详情")
}

func videoUpstreamErrorMessage(state map[string]any) string {
	if state == nil {
		return ""
	}
	return firstNonEmpty(
		relayErrorMessageFromValue(state["error"]),
		relayErrorMessageFromValue(state["detail"]),
		relayErrorMessageFromValue(state["message"]),
		relayErrorMessageFromValue(state["last_error"]),
		relayErrorMessageFromValue(state["failure_reason"]),
	)
}

func (a *App) relayJSONStream(ctx context.Context, pathValue, apiKey string, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.relayBaseURL()+pathValue, bytes.NewReader(data))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, nil, err
	}
	return relayDecodeMaybeStreamResponse(resp, pathValue)
}

func (a *App) relayMultipart(ctx context.Context, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, error) {
	req, err := relayMultipartRequest(ctx, a.relayBaseURL(), pathValue, apiKey, payload, images)
	if err != nil {
		return nil, err
	}
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

func (a *App) relayMultipartStream(ctx context.Context, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	req, err := relayMultipartRequest(ctx, a.relayBaseURL(), pathValue, apiKey, payload, images)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, nil, err
	}
	return relayDecodeMaybeStreamResponse(resp, pathValue)
}

func relayMultipartRequest(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (*http.Request, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	var mask *protocol.UploadedImage
	if hasRelayImageMask(payload["input_image_mask"]) {
		parsed, _, err := relayImageMask(payload["input_image_mask"])
		if err != nil {
			return nil, err
		}
		mask = &parsed
	}
	for key, value := range payload {
		if key == "input_image_mask" {
			continue
		}
		if value == nil {
			continue
		}
		text := util.Clean(value)
		if text == "" {
			continue
		}
		if err := writer.WriteField(key, text); err != nil {
			return nil, err
		}
	}
	for _, image := range images {
		filename := strings.TrimSpace(image.Filename)
		if filename == "" {
			filename = "image.png"
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename="%s"`, escapeMultipartQuote(filename)))
		header.Set("Content-Type", relayUploadImageContentType(image))
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(image.Data); err != nil {
			return nil, err
		}
	}
	if mask != nil {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="mask"; filename="mask.png"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(mask.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+pathValue, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func relayUploadImageContentType(image protocol.UploadedImage) string {
	contentType := normalizeRelayUploadImageContentType(image.ContentType)
	if contentType != "" {
		return contentType
	}
	if detected := normalizeRelayUploadImageContentType(http.DetectContentType(image.Data)); detected != "" {
		return detected
	}
	return "image/png"
}

func normalizeRelayUploadImageContentType(contentType string) string {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return contentType
	default:
		return ""
	}
}

func escapeMultipartQuote(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(value)
}

func (a *App) relayHTTPClient() *http.Client {
	timeout := 300 * time.Second
	if a != nil && a.config != nil {
		timeout = time.Duration(a.config.ImageTaskTimeoutSeconds()) * time.Second
	}
	if a != nil && a.proxy != nil {
		return a.proxy.HTTPClient(timeout)
	}
	return &http.Client{Timeout: timeout}
}

func relayPayloadForPath(pathValue string, payload map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range payload {
		if shouldDropRelayPayloadKey(key) || value == nil {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
			continue
		}
		out[key] = value
	}
	switch pathValue {
	case "/v1/chat/completions":
		if len(util.AsMapSlice(out["messages"])) == 0 {
			if prompt := strings.TrimSpace(util.Clean(payload["prompt"])); prompt != "" {
				out["messages"] = []map[string]any{{"role": "user", "content": prompt}}
			}
		}
		delete(out, "prompt")
	case "/v1/images/generations", "/v1/images/edits":
		sanitizeRelayImagePayload(out)
	}
	return out
}

func sanitizeRelayImagePayload(payload map[string]any) {
	delete(payload, "messages")
	model := util.Clean(payload["model"])
	route := util.ImageModelRouteFor(model)
	if route == util.ImageModelRouteGoogleGemini {
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "output_format")
		delete(payload, "output_compression")
		delete(payload, "response_format")
		return
	}
	if route == util.ImageModelRouteXAI {
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
		if aspectRatio, ok := util.NormalizeXAIImageAspectRatio(util.Clean(payload["aspect_ratio"])); ok && aspectRatio != "" && aspectRatio != "auto" {
			payload["aspect_ratio"] = aspectRatio
		} else {
			delete(payload, "aspect_ratio")
		}
		if resolution, ok := util.NormalizeXAIImageResolution(util.Clean(payload["resolution"])); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		if util.SupportsXAIImageQuality(model) {
			normalizeRelayImageEnum(payload, "quality", map[string]string{"low": "low", "medium": "medium"})
		} else {
			delete(payload, "quality")
		}
		allowed := map[string]struct{}{
			"model":           {},
			"prompt":          {},
			"n":               {},
			"response_format": {},
			"aspect_ratio":    {},
			"resolution":      {},
			"quality":         {},
		}
		for key := range payload {
			if _, ok := allowed[key]; !ok {
				delete(payload, key)
			}
		}
		return
	}
	if util.ToBool(payload["stream"]) {
		payload["stream"] = true
		if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
			payload["partial_images"] = partialImages
		} else {
			delete(payload, "partial_images")
		}
	} else {
		delete(payload, "stream")
		delete(payload, "partial_images")
	}

	if _, ok := payload["size"]; ok {
		if normalizedSize, ok := normalizeRelayImageSize(util.Clean(payload["size"])); ok && normalizedSize != "" {
			payload["size"] = normalizedSize
		} else {
			delete(payload, "size")
		}
	}
	normalizeRelayImageEnum(payload, "quality", map[string]string{"auto": "auto", "low": "low", "medium": "medium", "high": "high"})
	normalizeRelayImageEnum(payload, "background", map[string]string{"auto": "auto", "opaque": "opaque"})
	normalizeRelayImageEnum(payload, "moderation", map[string]string{"auto": "auto", "low": "low"})
	delete(payload, "response_format")

	outputFormat := ""
	if _, ok := payload["output_format"]; ok {
		if format, ok := normalizeRelayImageOutputFormat(util.Clean(payload["output_format"])); ok {
			payload["output_format"] = format
			outputFormat = format
		} else {
			delete(payload, "output_format")
		}
	}
	if compression, ok := normalizeRelayImageOutputCompression(payload["output_compression"]); ok && relayImageOutputFormatSupportsCompression(outputFormat) {
		payload["output_compression"] = compression
	} else {
		delete(payload, "output_compression")
	}
}

// normalizeImagePayloadForModel keeps only fields supported by the selected
// provider API and maps application size metadata to provider-native fields.
func normalizeImagePayloadForModel(payload map[string]any) {
	if payload == nil {
		return
	}
	switch util.ImageModelRouteFor(util.Clean(payload["model"])) {
	case util.ImageModelRouteGoogleGemini:
		for _, key := range []string{
			"quality", "background", "moderation", "stream", "partial_images",
			"output_format", "output_compression", "response_format", "input_image_mask",
		} {
			delete(payload, key)
		}
	case util.ImageModelRouteXAI:
		if !util.IsOfficialXAIImageModel(util.Clean(payload["model"])) {
			for _, key := range []string{
				"size", "requested_size", "image_resolution", "quality", "background",
				"moderation", "stream", "partial_images", "output_format",
				"output_compression", "input_image_mask", "aspect_ratio", "resolution",
				"image_format", "storage_options", "user",
			} {
				delete(payload, key)
			}
			normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
			return
		}
		aspectRatioSource := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if aspectRatio, ok := util.NormalizeXAIImageAspectRatio(aspectRatioSource); ok && aspectRatio != "" && aspectRatio != "auto" {
			payload["aspect_ratio"] = aspectRatio
			payload["size"] = aspectRatio
		} else {
			delete(payload, "aspect_ratio")
		}
		resolutionSource := firstNonEmpty(util.Clean(payload["resolution"]), util.Clean(payload["image_resolution"]))
		if resolution, ok := util.NormalizeXAIImageResolution(resolutionSource); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
			payload["image_resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		if util.SupportsXAIImageQuality(util.Clean(payload["model"])) {
			normalizeRelayImageEnum(payload, "quality", map[string]string{"low": "low", "medium": "medium"})
		} else {
			delete(payload, "quality")
		}
		for _, key := range []string{
			"background", "moderation", "stream", "partial_images", "output_format",
			"output_compression", "input_image_mask",
			"image_format", "storage_options", "user",
		} {
			delete(payload, key)
		}
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
	}
}

func normalizeRelayImagePartialImages(value any) (int, bool) {
	partialImages, ok := util.StrictInt(value)
	if !ok || partialImages < 1 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func normalizeRelayImageEnum(payload map[string]any, key string, allowed map[string]string) {
	if _, ok := payload[key]; !ok {
		return
	}
	normalized := strings.ToLower(strings.TrimSpace(util.Clean(payload[key])))
	if value, ok := allowed[normalized]; ok {
		payload[key] = value
		return
	}
	delete(payload, key)
}

func normalizeRelayImageOutputFormat(format string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "png":
		return "png", true
	case "jpg", "jpeg":
		return "jpeg", true
	case "webp":
		return "webp", true
	default:
		return "", false
	}
}

func relayImageOutputFormatSupportsCompression(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "webp":
		return true
	default:
		return false
	}
}

func normalizeRelayImageOutputCompression(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression, ok := util.StrictInt(value)
	if !ok || compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func normalizeRelayImageSize(size string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(size))
	normalized = strings.ReplaceAll(normalized, " ", "")
	normalized = strings.ReplaceAll(normalized, "×", "x")
	if normalized == "" || normalized == "auto" {
		return "", true
	}
	switch normalized {
	case "1080p":
		return normalizeRelayImageDimensions(1080, 1080), true
	case "2k":
		return normalizeRelayImageDimensions(2048, 2048), true
	case "4k":
		return normalizeRelayImageDimensions(3840, 3840), true
	}
	if width, height, ok := parseRelayImageDimensions(normalized); ok {
		if width < 128 && height < 128 {
			return relayImageSizeFromRatio(float64(width), float64(height)), true
		}
		return normalizeRelayImageDimensions(width, height), true
	}
	if ratioWidth, ratioHeight, ok := parseRelayImageRatio(normalized); ok {
		return relayImageSizeFromRatio(ratioWidth, ratioHeight), true
	}
	return "", false
}

func parseRelayImageDimensions(value string) (int, int, bool) {
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err := strconv.Atoi(parts[0])
	if err != nil || width <= 0 {
		return 0, 0, false
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func parseRelayImageRatio(value string) (float64, float64, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || width <= 0 {
		return 0, 0, false
	}
	height, err := strconv.ParseFloat(parts[1], 64)
	if err != nil || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func relayImageSizeFromRatio(ratioWidth, ratioHeight float64) string {
	if ratioWidth <= 0 || ratioHeight <= 0 {
		return ""
	}
	if ratioWidth == ratioHeight {
		return normalizeRelayImageDimensions(1024, 1024)
	}
	if ratioWidth > ratioHeight {
		return normalizeRelayImageDimensions(1536, int(float64(1536)*ratioHeight/ratioWidth+0.5))
	}
	return normalizeRelayImageDimensions(int(float64(1536)*ratioWidth/ratioHeight+0.5), 1536)
}

func normalizeRelayImageDimensions(width, height int) string {
	const (
		multiple  = 16
		maxEdge   = 3840
		maxRatio  = 3
		minPixels = 655360
		maxPixels = 8294400
	)
	normalizedWidth := roundToRelayImageMultiple(width, multiple)
	normalizedHeight := roundToRelayImageMultiple(height, multiple)

	scaleToFit := func(scale float64) {
		normalizedWidth = floorToRelayImageMultiple(float64(normalizedWidth)*scale, multiple)
		normalizedHeight = floorToRelayImageMultiple(float64(normalizedHeight)*scale, multiple)
	}
	scaleToFill := func(scale float64) {
		normalizedWidth = ceilToRelayImageMultiple(float64(normalizedWidth)*scale, multiple)
		normalizedHeight = ceilToRelayImageMultiple(float64(normalizedHeight)*scale, multiple)
	}

	for range 4 {
		if max(normalizedWidth, normalizedHeight) > maxEdge {
			scaleToFit(float64(maxEdge) / float64(max(normalizedWidth, normalizedHeight)))
		}
		if normalizedWidth > normalizedHeight*maxRatio {
			normalizedWidth = floorToRelayImageMultiple(float64(normalizedHeight*maxRatio), multiple)
		} else if normalizedHeight > normalizedWidth*maxRatio {
			normalizedHeight = floorToRelayImageMultiple(float64(normalizedWidth*maxRatio), multiple)
		}
		pixels := normalizedWidth * normalizedHeight
		if pixels > maxPixels {
			scaleToFit(math.Sqrt(float64(maxPixels) / float64(pixels)))
		} else if pixels < minPixels {
			scaleToFill(math.Sqrt(float64(minPixels) / float64(pixels)))
		}
	}
	return fmt.Sprintf("%dx%d", normalizedWidth, normalizedHeight)
}

func roundToRelayImageMultiple(value, multiple int) int {
	return max(multiple, ((value+multiple/2)/multiple)*multiple)
}

func floorToRelayImageMultiple(value float64, multiple int) int {
	return max(multiple, int(value/float64(multiple))*multiple)
}

func ceilToRelayImageMultiple(value float64, multiple int) int {
	return max(multiple, int(math.Ceil(value/float64(multiple)))*multiple)
}

func shouldDropRelayPayloadKey(key string) bool {
	switch key {
	case "api_key", "relay_api_key", "relayai_api_key", "upstream_api_key",
		"token_group", "newapi_token_group", "relay_token_group",
		"token_name", "newapi_token_name", "relay_token_name",
		"owner_id", "owner_name", "base_url", "visibility", "client_task_id",
		"image_resolution", "requested_size", "images",
		"share_prompt_parameters", "share_reference_images",
		relayImageTaskSlotManagedPayloadKey,
		service.ImageOutputCompletionReleasePayloadKey,
		protocol.ImageOutputSlotAcquirerPayloadKey,
		"image_output_callback", "text_output_callback":
		return true
	default:
		return false
	}
}

func relayDecodeJSONResponse(resp *http.Response) (map[string]any, error) {
	return relayDecodeJSONResponseWithLimits(resp, relayJSONSuccessMaxBytes, relayJSONErrorMaxBytes)
}

func relayDecodeMaybeStreamResponse(resp *http.Response, pathValue string) (map[string]any, *protocol.StreamResult, error) {
	if resp == nil || resp.Body == nil {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "upstream response body is unavailable"}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if relayResponseIsEventStream(resp) {
			return nil, relayStreamResult(resp.Body), nil
		}
		reader := bufio.NewReader(resp.Body)
		bufferedBody := &relayBufferedReadCloser{Reader: reader, Closer: resp.Body}
		resp.Body = bufferedBody
		if relayBufferedBodyIsEventStream(reader) {
			return nil, relayStreamResult(bufferedBody), nil
		}
	}
	defer resp.Body.Close()
	result, err := relayDecodeJSONResponse(resp)
	if err != nil {
		return nil, nil, err
	}
	if err := relayStreamItemError(result); err != nil {
		return nil, nil, err
	}
	if pathValue == "/v1/images/generations" || pathValue == "/v1/images/edits" {
		if err := relayImageJSONResultError(result); err != nil {
			return nil, nil, err
		}
		return nil, relayImageJSONResultStream(result, pathValue), nil
	}
	return result, nil, nil
}

func relayBufferedBodyIsEventStream(reader *bufio.Reader) bool {
	if reader == nil {
		return false
	}
	for skipped := 0; skipped < 64; {
		first, err := reader.Peek(1)
		if err != nil || len(first) == 0 {
			return false
		}
		if first[0] == 0xef {
			prefix, err := reader.Peek(3)
			if err != nil || !bytes.Equal(prefix, []byte{0xef, 0xbb, 0xbf}) {
				return false
			}
			_, _ = reader.Discard(3)
			skipped += 3
			continue
		}
		if first[0] == ' ' || first[0] == '\t' || first[0] == '\r' || first[0] == '\n' {
			_, _ = reader.Discard(1)
			skipped++
			continue
		}
		break
	}
	first, err := reader.Peek(1)
	if err != nil || len(first) == 0 {
		return false
	}
	switch first[0] {
	case ':':
		return true
	case 'd':
		prefix, err := reader.Peek(len("data:"))
		return err == nil && string(prefix) == "data:"
	case 'e':
		prefix, err := reader.Peek(len("event:"))
		return err == nil && string(prefix) == "event:"
	case 'i':
		prefix, err := reader.Peek(len("id:"))
		return err == nil && string(prefix) == "id:"
	case 'r':
		prefix, err := reader.Peek(len("retry:"))
		return err == nil && string(prefix) == "retry:"
	default:
		return false
	}
}

func relayImageJSONResultError(result map[string]any) error {
	message := ""
	if result != nil {
		message = firstNonEmpty(
			relayErrorMessageFromValue(result["error"]),
			relayErrorMessageFromValue(result["detail"]),
			relayErrorMessageFromValue(result["message"]),
		)
		if message == "" {
			for _, image := range util.AsMapSlice(result["data"]) {
				urlValue, _ := image["url"].(string)
				base64Value, _ := image["b64_json"].(string)
				if strings.TrimSpace(urlValue) != "" || strings.TrimSpace(base64Value) != "" {
					return nil
				}
			}
		}
	}
	message = firstNonEmpty(message, "upstream image API returned no image data")
	return protocol.HTTPError{Status: http.StatusBadGateway, Message: message}
}

func relayResponseIsEventStream(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && strings.EqualFold(mediaType, "text/event-stream")
}

func relayImageJSONResultStream(result map[string]any, pathValue string) *protocol.StreamResult {
	data := util.AsMapSlice(result["data"])
	items := make(chan map[string]any, len(data))
	errs := make(chan error, 1)
	go func() {
		defer close(items)
		defer close(errs)
		eventType := "image_generation.completed"
		if pathValue == "/v1/images/edits" {
			eventType = "image_edit.completed"
		}
		created := result["created_at"]
		if created == nil {
			created = result["created"]
		}
		model := util.Clean(result["model"])
		usage := result["usage"]
		for index, image := range data {
			event := util.CopyMap(image)
			event["type"] = eventType
			event["output_index"] = index
			if created != nil && util.Clean(created) != "" {
				event["created_at"] = created
			}
			if model != "" {
				event["model"] = model
			}
			if usage != nil {
				event["usage"] = usage
			}
			items <- event
		}
		errs <- nil
	}()
	return &protocol.StreamResult{Items: items, Err: errs, Kind: "openai"}
}

func relayDecodeJSONResponseWithLimits(resp *http.Response, successLimit, errorLimit int64) (map[string]any, error) {
	if resp == nil || resp.Body == nil {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "upstream response body is unavailable"}
	}
	maxBytes := successLimit
	tooLargeStatus := http.StatusBadGateway
	tooLargeMessage := "upstream response is too large"
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		maxBytes = errorLimit
		tooLargeStatus = resp.StatusCode
		tooLargeMessage = "upstream error response is too large"
	}
	if maxBytes < 1 {
		return nil, protocol.HTTPError{Status: tooLargeStatus, Message: tooLargeMessage}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, protocol.HTTPError{Status: tooLargeStatus, Message: tooLargeMessage}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, protocol.HTTPError{Status: resp.StatusCode, Message: relayErrorMessage(data, resp.Status)}
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("upstream response is not valid JSON: %w", err)
	}
	return payload, nil
}

func relayErrorMessage(data []byte, fallback string) string {
	var payload any
	if json.Unmarshal(data, &payload) == nil {
		if message := relayErrorMessageFromValue(payload); message != "" {
			return message
		}
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		value, ok := relayStreamData(scanner.Text())
		if !ok || value == "" || value == "[DONE]" || strings.HasPrefix(value, ":") {
			continue
		}
		var event any
		if json.Unmarshal([]byte(value), &event) == nil {
			if message := relayErrorMessageFromValue(event); message != "" {
				return message
			}
		}
	}
	if text := strings.TrimSpace(string(data)); text != "" {
		return text
	}
	return fallback
}

func relayStreamResult(body io.ReadCloser) *protocol.StreamResult {
	items := make(chan map[string]any)
	errCh := make(chan error, 1)
	go func() {
		defer close(items)
		defer close(errCh)
		defer body.Close()
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 64*1024), relayStreamMaxTokenSize)
		for scanner.Scan() {
			data, ok := relayStreamData(scanner.Text())
			if !ok {
				continue
			}
			if data == "" || data == "[DONE]" || strings.HasPrefix(data, ":") {
				continue
			}
			var item map[string]any
			if err := json.Unmarshal([]byte(data), &item); err != nil {
				errCh <- err
				return
			}
			if err := relayStreamItemError(item); err != nil {
				errCh <- err
				return
			}
			items <- item
		}
		errCh <- scanner.Err()
	}()
	return &protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"}
}

func relayStreamData(line string) (string, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		return "", false
	}
	data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	for strings.HasPrefix(data, "data:") {
		data = strings.TrimSpace(strings.TrimPrefix(data, "data:"))
	}
	return data, true
}

func relayStreamItemError(item map[string]any) error {
	if item == nil {
		return nil
	}
	message := ""
	if _, ok := item["error"]; ok {
		message = relayErrorMessageFromValue(item["error"])
	}
	eventType := strings.ToLower(strings.TrimSpace(util.Clean(item["type"])))
	if message == "" && (eventType == "error" || strings.HasSuffix(eventType, "_error") || strings.HasSuffix(eventType, ".error")) {
		message = firstNonEmpty(relayErrorMessageFromValue(item["message"]), relayErrorMessageFromValue(item["detail"]))
	}
	if message == "" {
		return nil
	}
	status := util.ToInt(firstNonEmpty(util.Clean(item["status"]), util.Clean(item["status_code"])), http.StatusBadGateway)
	if status < 400 {
		status = http.StatusBadGateway
	}
	return protocol.HTTPError{Status: status, Message: message}
}

func relayErrorMessageFromValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		return firstNonEmpty(
			relayErrorMessageFromValue(typed["message"]),
			relayErrorMessageFromValue(typed["error"]),
			relayErrorMessageFromValue(typed["detail"]),
		)
	case []any:
		for _, item := range typed {
			if message := relayErrorMessageFromValue(item); message != "" {
				return message
			}
		}
	default:
		return ""
	}
	return ""
}

func relayAcquireImageTaskSlot(ctx context.Context, payload map[string]any) (func(), error) {
	acquire := relayImageOutputSlotAcquirer(payload)
	if acquire == nil {
		return nil, nil
	}
	return acquire(ctx, 0)
}

func relayAcquireDirectImageTaskSlot(ctx context.Context, payload map[string]any) (func(), error) {
	release, err := relayAcquireImageTaskSlot(ctx, payload)
	if err != nil || release == nil {
		return release, err
	}
	payload[relayImageTaskSlotManagedPayloadKey] = relayImageTaskSlotManagedMarker{}
	return func() {
		delete(payload, relayImageTaskSlotManagedPayloadKey)
		release()
	}, nil
}

func relayImageTaskSlotIsManaged(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	_, ok := payload[relayImageTaskSlotManagedPayloadKey].(relayImageTaskSlotManagedMarker)
	return ok
}

func relayImageStreamWithSlotRelease(ctx context.Context, stream *protocol.StreamResult, release func()) *protocol.StreamResult {
	if stream == nil || release == nil {
		return stream
	}
	items := make(chan map[string]any)
	errs := make(chan error, 1)
	go func() {
		defer close(items)
		defer close(errs)
		defer release()
	streamItems:
		for {
			var item map[string]any
			var ok bool
			select {
			case item, ok = <-stream.Items:
				if !ok {
					break streamItems
				}
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errs <- ctx.Err()
				return
			}
			if err := ctx.Err(); err != nil {
				go drainProtocolStream(stream)
				errs <- err
				return
			}
			select {
			case items <- item:
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errs <- ctx.Err()
				return
			}
		}
		select {
		case err, ok := <-stream.Err:
			if ok {
				errs <- err
			}
		case <-ctx.Done():
			go drainProtocolStream(stream)
			errs <- ctx.Err()
		}
	}()
	return &protocol.StreamResult{Items: items, Err: errs, Kind: stream.Kind}
}

func relayImageOutputSlotAcquirer(payload map[string]any) protocol.ImageOutputSlotAcquirer {
	switch acquire := payload[protocol.ImageOutputSlotAcquirerPayloadKey].(type) {
	case protocol.ImageOutputSlotAcquirer:
		return acquire
	case func(context.Context, int) (func(), error):
		return acquire
	default:
		return nil
	}
}
