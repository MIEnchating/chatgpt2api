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

func (a *App) relayAPIKeyForIdentitySelection(ctx context.Context, identity service.Identity, group, name string) (string, error) {
	reader := a.relayTokenReader()
	if reader == nil {
		return "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "请先配置数据库连接，并创建指定分组的令牌"}
	}
	key, err := reader.KeyForIdentityGroupAndName(ctx, identity, group, name)
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
	return util.Clean(payload["api_key"])
}

func selectedRelayTokenGroupFromPayload(payload map[string]any) string {
	return util.Clean(payload["token_group"])
}

func selectedRelayTokenNameFromPayload(payload map[string]any) string {
	return util.Clean(payload["token_name"])
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
	normalizeImagePayloadForModel(payload)
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
	normalizeImagePayloadForModel(payload)
	if err := validateRelayImageReferenceCount(model, len(images), payload); err != nil {
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
	if util.IsXAIImageModel(model) {
		// Grok2API uses a JSON edit envelope instead of OpenAI's multipart
		// image upload contract. Keep the reference images as data URLs.
		editPayload := make(map[string]any, len(payload)+1)
		for key, value := range payload {
			if key != "images" {
				editPayload[key] = value
			}
		}
		imageURLs := make([]map[string]any, 0, len(images))
		for _, image := range images {
			if value := uploadedImageDataURL(image); value != "" {
				imageURLs = append(imageURLs, map[string]any{"url": value})
			}
		}
		editPayload["images"] = imageURLs
		result, stream, err := a.relayJSONMaybeStream(ctx, "/v1/images/edits", editPayload)
		if err != nil {
			if release != nil {
				release()
			}
			return result, stream, err
		}
		if stream != nil {
			stream = a.localizeRelayImageStream(ctx, editPayload, stream)
		}
		if stream != nil && release != nil {
			return result, relayImageStreamWithSlotRelease(ctx, stream, release), nil
		}
		if release != nil {
			release()
		}
		return result, stream, nil
	}
	if util.IsAgnesImageModel(model) {
		// Agnes follows the reference project's image-edit contract: reference
		// images are sent in extra_body.image while the endpoint remains image
		// generations. Uploaded inputs fall back to data URLs when no public URL
		// is available to this server.
		generationPayload := make(map[string]any, len(payload)+1)
		for key, value := range payload {
			if key != "images" {
				generationPayload[key] = value
			}
		}
		imageURLs := make([]string, 0, len(images))
		for _, image := range images {
			if value := uploadedImageDataURL(image); value != "" {
				imageURLs = append(imageURLs, value)
			}
		}
		generationPayload["extra_body"] = map[string]any{"image": imageURLs}
		result, stream, err := a.relayJSONMaybeStream(ctx, "/v1/images/generations", generationPayload)
		if err != nil {
			if release != nil {
				release()
			}
			return result, stream, err
		}
		if stream != nil {
			stream = a.localizeRelayImageStream(ctx, generationPayload, stream)
		}
		if stream != nil && release != nil {
			return result, relayImageStreamWithSlotRelease(ctx, stream, release), nil
		}
		if release != nil {
			release()
		}
		return result, stream, nil
	}
	result, stream, err := a.relayMultipartMaybeStream(ctx, relayImageEditPath(payload), payload, images)
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
	if err := validateKIEImageRequiredInput(model, payload, len(images)); err != nil {
		return err
	}
	if err := validateKIEImageReferenceURLs(model, payload); err != nil {
		return err
	}
	if err := validateAPIMartImageRequiredInput(model, payload, len(images)); err != nil {
		return err
	}
	return validateRelayImageMask(pathValue, model, payload, images)
}

// KIE image endpoints dereference reference fields server-side. Inline data
// URLs, localhost, private-network URLs, and overlong URLs therefore cannot
// work even when the surrounding OpenAI-compatible request accepts them.
func validateKIEImageReferenceURLs(model string, payload map[string]any) error {
	if !isKnownKIEImageModel(model) || payload == nil || isAPIMartImagePayload(payload) {
		return nil
	}
	for _, key := range []string{
		"image_url", "image_urls", "input_url", "input_urls", "images", "image", "image_input",
		"reference_image_url", "reference_image_urls", "mask_url", "mask_urls", "video_url", "video_urls",
	} {
		for _, value := range normalizeKIEReferenceArrayValue(payload[key]) {
			if !isPublicReferenceURL(value) {
				return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 的 %s 必须使用公网可访问的 http:// 或 https:// URL", model, key)}
			}
		}
	}
	return nil
}

func validateKIEImageRequiredInput(model string, payload map[string]any, uploaded int) error {
	name := strings.ToLower(strings.TrimSpace(model))
	if !isKnownKIEImageModel(name) || isAPIMartImagePayload(payload) {
		return nil
	}
	has := func(fields ...string) bool {
		for _, field := range fields {
			if len(normalizeKIEReferenceArrayValue(payload[field])) > 0 {
				return true
			}
		}
		return false
	}
	// A multipart upload satisfies the model's primary image input, but it does
	// not satisfy additional provider-native inputs such as a mask or a
	// character reference image. Keep those requirements explicit so strict
	// KIE schemas fail locally with an actionable message instead of returning
	// a generic upstream 422.
	hasBaseImage := uploaded > 0 || has("image_url", "image_urls", "input_urls", "input_url", "images", "image", "image_input", "reference_image")
	requireBase := func() error {
		if hasBaseImage {
			return nil
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 必须提供参考图片 URL 或上传图片", model)}
	}
	requireField := func(label string, fields ...string) error {
		if has(fields...) {
			return nil
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 必须提供 %s", model, label)}
	}
	switch {
	case name == "ideogram/v3-edit":
		if err := requireBase(); err != nil {
			return err
		}
		// The KIE endpoint requires a public mask_url. OpenAI's
		// input_image_mask multipart field is a different contract and is
		// intentionally not accepted as a substitute here.
		return requireField("mask_url", "mask_url", "mask_urls")
	case name == "ideogram/character-edit":
		if err := requireBase(); err != nil {
			return err
		}
		if err := requireField("mask_url", "mask_url", "mask_urls"); err != nil {
			return err
		}
		return requireField("reference_image_urls", "reference_image_urls")
	case name == "ideogram/character-remix":
		if err := requireBase(); err != nil {
			return err
		}
		return requireField("reference_image_urls", "reference_image_urls")
	case name == "ideogram/character":
		return requireField("reference_image_urls", "reference_image_urls")
	case strings.Contains(name, "qwen/image-to-image"), strings.Contains(name, "qwen/image-edit"), strings.Contains(name, "qwen2/image-edit"), strings.Contains(name, "ideogram/v3-remix"), strings.Contains(name, "seedream/5-pro-layer-decomposition"), strings.Contains(name, "image-to-image"), strings.Contains(name, "image-edit"), strings.Contains(name, "remix"):
		return requireBase()
	case strings.HasSuffix(name, "/extend"), strings.Contains(name, "upscale"), strings.Contains(name, "remove-background"):
		return requireBase()
	default:
		return nil
	}
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

func validateRelayImageReferenceCount(model string, count int, payloads ...map[string]any) error {
	if count <= 0 {
		return nil
	}
	if len(payloads) > 0 && isAPIMartImagePayload(payloads[0]) {
		contract := apimartImageContractForModel(model)
		if contract.imageRefField != "" && (contract.maxImageRefs == 0 || count <= contract.maxImageRefs) {
			return nil
		}
		if contract.imageRefField == "" {
			return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support APIMart reference images", model)}
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s supports at most %d APIMart reference images", model, contract.maxImageRefs)}
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

func (a *App) relayChatCompletions(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/chat/completions", payload)
}

func (a *App) relayResponses(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/responses", payload)
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
	// Gemini Omni's `audio_ids` are KIE-issued asset identifiers, not public
	// audio URLs. The shared creation API intentionally exposes URL references,
	// so fail early instead of forwarding a URL that the provider validates as
	// an ID and returns a confusing 422 response.
	if isGeminiOmniVideoModel(util.Clean(payload["model"])) && len(util.AsStringSlice(payload["reference_audio_urls"])) > 0 {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "Gemini Omni 参考音频必须使用已上传的 audio_* 音频 ID，当前视频接口仅支持公网音频 URL，因此暂不支持参考音频"}
	}
	request := officialVideoRequestPayload(payload)
	if err := validateVideoReferencePayloadURLs(request); err != nil {
		return nil, err
	}
	created, err := a.relayVideoSubmit(ctx, apiKey, request)
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

func isGeminiOmniVideoModel(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "gemini-omni") || strings.Contains(name, "omni-flash")
}

// Reference arrays are provider-native URL lists and cannot be represented by
// the single-file multipart compatibility field. Reject inline data URLs here
// with a useful client error instead of forwarding a multi-megabyte value that
// the official endpoint will reject as an overlong URL.
func validateVideoReferencePayloadURLs(request map[string]any) error {
	// Provider-native URL fields must stay URLs as well. In particular, KIE's
	// named-frame fields (`first_frame_url`/`last_frame_url`) are not the same
	// as the legacy multipart `input_reference` field and reject data URLs.
	// Keep `first_frame_image`/`last_frame_image` out of this list because the
	// official Veo adapter intentionally converts those local uploads to the
	// provider's inline image representation.
	for _, key := range []string{
		"reference_image_urls", "reference_video_urls", "reference_audio_urls",
		"image_url", "image_urls", "video_url", "video_urls", "audio_url", "audio_urls", "audio_ids",
		"first_frame_url", "last_frame_url", "end_image_url", "tail_image_url",
		"first_clip_url", "reference_image", "reference_video", "reference_voice",
		// Native APIMart/Wan adapters use these aliases instead of the
		// OpenAI-compatible *_urls names. They must receive the same public URL
		// validation or a data URL can bypass the guard and reach the provider.
		"image", "images", "input_urls", "video", "videos", "audio", "audios",
		"ref_images", "ref_videos", "reference_images",
		"image_with_roles", "video_list", "element_list",
	} {
		_, imageObject := request[key].(map[string]any)
		if key == "image_with_roles" || key == "video_list" || key == "ref_images" || key == "ref_videos" || key == "reference_images" || key == "element_list" || key == "image" && imageObject {
			if err := validateNestedVideoReferenceURLs(request[key]); err != nil {
				return err
			}
			continue
		}
		values := util.AsStringSlice(request[key])
		if value := util.Clean(request[key]); value != "" && len(values) == 0 {
			values = []string{value}
		}
		for _, value := range values {
			// A single local upload is carried separately as multipart
			// `input_reference`; the named frame alias is retained only for
			// compatibility and will not be used as the provider URL.
			inlineReference := strings.TrimSpace(util.Clean(request["input_reference"]))
			if strings.HasPrefix(strings.ToLower(inlineReference), "data:") {
				// A single local image is converted to multipart by
				// relayVideoSubmit. Do not reject the matching provider alias,
				// but still reject any additional data-URL references.
				if len(values) == 1 && strings.TrimSpace(values[0]) == inlineReference && isInlineFirstFrameReference(request) && (key == "image" || key == "image_url" || key == "first_frame_url" || key == "reference_image_urls") {
					continue
				}
			}
			if key == "audio_ids" {
				if !strings.HasPrefix(strings.TrimSpace(value), "audio_") {
					return protocol.HTTPError{Status: http.StatusBadRequest, Message: "Gemini Omni 参考音频必须使用 audio_ 开头的已上传音频 ID"}
				}
				continue
			}
			if !isPublicReferenceURL(value) {
				return protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频参考素材列表必须使用公网可访问的 http:// 或 https:// URL；单首帧图片可使用上传文件"}
			}
		}
	}
	// Provider adapters mirror native reference fields into metadata for
	// compatibility with older relays. Validate that copy as well; otherwise a
	// stale caller could bypass the URL guard by placing a Base64 reference only
	// in metadata and the upstream would return a confusing 422 URL-too-long
	// error.
	if metadata, ok := request["metadata"].(map[string]any); ok && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(util.Clean(request["input_reference"]))), "data:") {
		if err := validateNestedVideoReferenceURLs(metadata); err != nil {
			return err
		}
	}
	return nil
}

func validateNestedVideoReferenceURLs(value any) error {
	var walk func(any, string) error
	walk = func(current any, field string) error {
		switch typed := current.(type) {
		case []any:
			for _, item := range typed {
				if err := walk(item, field); err != nil {
					return err
				}
			}
		case []map[string]string:
			for _, item := range typed {
				if err := walk(item, field); err != nil {
					return err
				}
			}
		case []map[string]any:
			for _, item := range typed {
				if err := walk(item, field); err != nil {
					return err
				}
			}
		case []string:
			for _, item := range typed {
				if err := walk(item, field); err != nil {
					return err
				}
			}
		case map[string]string:
			for key, item := range typed {
				if err := walk(item, key); err != nil {
					return err
				}
			}
		case map[string]any:
			for key, item := range typed {
				if err := walk(item, key); err != nil {
					return err
				}
			}
		case string:
			if field == "url" || strings.Contains(field, "_url") || strings.HasSuffix(field, "urls") || field == "reference_voice" {
				if !isPublicReferenceURL(typed) {
					return protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频参考素材列表必须使用公网可访问的 http:// 或 https:// URL；单首帧图片可使用上传文件"}
				}
			}
		}
		return nil
	}
	return walk(value, "")
}

func (a *App) relayVideoSubmit(ctx context.Context, apiKey string, request map[string]any) (map[string]any, error) {
	if videoProviderAdapterForModel(strings.ToLower(util.Clean(request["model"]))).name == "veo" {
		if err := a.inlineVeoReferenceImage(ctx, request); err != nil {
			return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
		}
	}
	inputReference := strings.TrimSpace(util.Clean(request["input_reference"]))
	// Provider-native URL fields must never carry an inline data URL. For
	// direct API callers (legacy clients may still send one), reuse the
	// multipart upload path and remove the inline field from the form so the
	// upstream sees a real uploaded file instead of a 2K+ URL.
	inlineField := ""
	if inputReference == "" {
		for _, key := range []string{"first_frame_url", "first_frame_image", "image_url", "image"} {
			candidate := strings.TrimSpace(util.Clean(request[key]))
			if strings.HasPrefix(strings.ToLower(candidate), "data:") {
				inputReference = candidate
				inlineField = key
				break
			}
		}
	}
	// Some canvas/API callers only populate the canonical image array. Treat a
	// single data URL there as the same local first-frame upload, but never
	// reinterpret a multimodal reference request this way: those references
	// must remain public URLs because the provider expects URL arrays.
	if inputReference == "" && isInlineFirstFrameReference(request) {
		values := util.AsStringSlice(request["reference_image_urls"])
		if len(values) == 1 && strings.HasPrefix(strings.ToLower(strings.TrimSpace(values[0])), "data:") {
			inputReference = strings.TrimSpace(values[0])
		}
	}
	if !strings.HasPrefix(strings.ToLower(inputReference), "data:") {
		return a.relayJSON(ctx, http.MethodPost, "/v1/videos", apiKey, request)
	}
	// The compatibility payload may contain both input_reference and a
	// provider-native alias for the same image. Once the image is uploaded as a
	// multipart file, retaining that alias would send the complete Base64 value
	// as a URL and trigger the provider's 2083-character URL validation.
	if err := removeMultipartVideoReferenceAliases(request, inputReference); err != nil {
		return nil, err
	}
	data, contentType, err := imageDataURLBytes(inputReference)
	if err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频参考图必须是有效的 PNG、JPEG 或 WebP 图片"}
	}
	if err := validateVideoReferenceImage(util.Clean(request["model"]), util.Clean(request["size"]), data); err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	delete(request, "input_reference")
	if inlineField != "" {
		delete(request, inlineField)
	}
	req, err := relayVideoMultipartRequest(ctx, a.relayBaseURL(), apiKey, request, protocol.UploadedImage{
		Data:        data,
		Filename:    "input-reference." + videoReferenceImageExtension(contentType),
		ContentType: contentType,
	})
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

func removeMultipartVideoReferenceAliases(request map[string]any, inputReference string) error {
	clean := func(fields map[string]any) error {
		for _, key := range []string{"first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image", "end_image_url", "tail_image_url", "image_url", "image"} {
			value := strings.TrimSpace(util.Clean(fields[key]))
			if !strings.HasPrefix(strings.ToLower(value), "data:") {
				continue
			}
			if value != inputReference {
				return protocol.HTTPError{Status: http.StatusBadRequest, Message: "一次视频任务只能直接上传一张本地参考图；其他图片请先转换为公网可访问 URL"}
			}
			delete(fields, key)
		}
		if references := util.AsStringSlice(fields["reference_image_urls"]); len(references) > 0 {
			for _, value := range references {
				if strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "data:") && strings.TrimSpace(value) != inputReference {
					return protocol.HTTPError{Status: http.StatusBadRequest, Message: "一次视频任务只能直接上传一张本地参考图；其他图片请先转换为公网可访问 URL"}
				}
			}
			if len(references) == 1 && strings.TrimSpace(references[0]) == inputReference {
				delete(fields, "reference_image_urls")
			}
		}
		return nil
	}
	if err := clean(request); err != nil {
		return err
	}
	if metadata, ok := request["metadata"].(map[string]any); ok {
		if err := clean(metadata); err != nil {
			return err
		}
		if len(metadata) == 0 {
			delete(request, "metadata")
		}
	}
	return nil
}

func isInlineFirstFrameReference(request map[string]any) bool {
	if request == nil {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(util.Clean(request["reference_mode"])), "reference") {
		return false
	}
	mode := strings.ToLower(strings.TrimSpace(util.Clean(request["generation_mode"])))
	return mode == "" || mode == "image-to-video" || mode == "image" || mode == "first-frame"
}

func (a *App) inlineVeoReferenceImage(ctx context.Context, request map[string]any) error {
	metadata, _ := request["metadata"].(map[string]any)
	if metadata == nil {
		return nil
	}
	inline := func(value string) (string, error) {
		value = strings.TrimSpace(value)
		if value == "" || strings.HasPrefix(strings.ToLower(value), "data:") {
			return value, nil
		}
		data, contentType, err := relayImageItemBytes(ctx, a, map[string]any{"url": value})
		if err != nil {
			return "", fmt.Errorf("Veo 参考图下载失败：%w", err)
		}
		if len(data) > maxGoogleGeminiInlineRequestBytes {
			return "", fmt.Errorf("Veo 参考图不能超过 20 MiB")
		}
		return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
	}
	for _, field := range []string{"firstFrame", "lastFrame"} {
		value := util.Clean(metadata[field])
		if value == "" {
			continue
		}
		converted, err := inline(value)
		if err != nil {
			return err
		}
		metadata[field] = converted
	}
	images := util.AsStringSlice(metadata["referenceImages"])
	for index, value := range images {
		converted, err := inline(value)
		if err != nil {
			return err
		}
		images[index] = converted
	}
	if len(images) > 0 {
		metadata["referenceImages"] = images
	}
	return nil
}

// officialVideoRequestPayload maps official provider semantics onto the
// flattened /v1/videos compatibility contract exposed by the relay.
func officialVideoRequestPayload(payload map[string]any) map[string]any {
	model := protocol.CanonicalVideoModel(util.Clean(payload["model"]))
	name := strings.ToLower(model)
	seconds := util.ToInt(payload["seconds"], 0)
	refs := util.AsStringSlice(payload["reference_image_urls"])
	frameRefs := videoFrameAliases(payload)
	refs = removeVideoFrameAliases(refs, frameRefs)
	referenceVideoURLs := util.AsStringSlice(payload["reference_video_urls"])
	referenceAudioURLs := util.AsStringSlice(payload["reference_audio_urls"])
	referenceMode := normalizeVideoReferenceMode(util.Clean(payload["reference_mode"]))
	if referenceMode == "" {
		if len(referenceVideoURLs) > 0 || len(referenceAudioURLs) > 0 {
			referenceMode = "reference"
		} else {
			referenceMode = "first-frame"
		}
	}
	if strings.Contains(name, "reference-to-video") || strings.Contains(name, "-r2v") || strings.HasSuffix(name, "/r2v") {
		referenceMode = "reference"
	}
	// Keep direct /v1/videos callers consistent with the creation-task route.
	// A stale reference toggle is harmless for image-only models when it only
	// contains images, but must not force an unsupported multimodal payload.
	capability := protocol.VideoCapability(model)
	if referenceMode == "reference" && !capability.ReferenceMode && len(referenceVideoURLs) == 0 && len(referenceAudioURLs) == 0 && capability.FirstFrameImageLimit > 0 {
		referenceMode = "first-frame"
	}
	size := util.Clean(payload["size"])
	if strings.Contains(name, "/") {
		size = normalizeKIEAspectRatio(size)
	}
	request := map[string]any{
		"model":    model,
		"prompt":   payload["prompt"],
		"seconds":  payload["seconds"],
		"duration": seconds,
	}
	if size != "" {
		request["size"] = size
	}
	if len(frameRefs) > 0 {
		request["first_frame_url"] = frameRefs[0]
	}
	if len(frameRefs) > 1 {
		request["last_frame_url"] = frameRefs[1]
	}
	// Creation tasks persist the shared audio toggle as video_generate_audio
	// in metadata, while direct /v1 callers use generate_audio. Adapters should
	// see one vocabulary regardless of whether the request came from the
	// creator, canvas, or a queued task.
	adapterPayload := payload
	if _, hasGenerateAudio := payload["generate_audio"]; !hasGenerateAudio {
		if value, ok := payload["video_generate_audio"].(bool); ok {
			adapterPayload = make(map[string]any, len(payload)+1)
			for key, item := range payload {
				adapterPayload[key] = item
			}
			adapterPayload["generate_audio"] = value
		}
	}
	metadata := map[string]any{}
	if resolution := util.Clean(payload["resolution"]); resolution != "" {
		request["resolution"] = resolution
	}
	adapter := videoProviderAdapterForModel(name)
	adapterRefs := refs
	if len(frameRefs) > 0 && (referenceMode == "first-frame" || len(refs) == 0) {
		adapterRefs = frameRefs
	}
	adapter.apply(videoProviderAdapterInput{
		request: request, metadata: metadata, payload: adapterPayload,
		refs: adapterRefs, referenceVideoURLs: referenceVideoURLs, referenceAudioURLs: referenceAudioURLs,
		referenceMode: referenceMode, size: size, resolution: util.Clean(payload["resolution"]), model: model, seconds: seconds,
	})
	// KIE endpoints expose provider-native aspect/reference fields; the shared
	// `size` and multipart `input_reference` aliases are not part of their
	// schemas and must never survive the adapter boundary.
	if isKIEVideoModelName(name) {
		delete(request, "size")
		delete(request, "input_reference")
	}
	applyKIEVideoDefaults(request, name)
	applyAPIMartVideoDefaults(request, name)
	if isKIEVideoModelName(name) {
		normalizeKIEDurationRequest(request, name, seconds)
		normalizeKIEVideoDurationBounds(request, name)
		normalizeKIEVideoAspectRequest(request, name)
	}
	normalizeAPIMartVideoRequest(request, metadata, payload, name, seconds)
	if len(adapterRefs) > 0 && referenceMode != "reference" && !isKIEVideoModelName(name) && adapter.name != "sora" && adapter.name != "veo" && adapter.name != "wan" && adapter.name != "vidu" && adapter.name != "jimeng" && adapter.name != "cogvideox" && adapter.name != "agnes" && adapter.name != "kling" && adapter.name != "gemini-omni" && adapter.name != "pixverse" && adapter.name != "skyreels" && adapter.name != "happyhorse" && adapter.name != "infinitalk" && adapter.name != "flux-3-video" && adapter.name != "seedance" && adapter.name != "bytedance-v1" && adapter.name != "minimax" {
		request["input_reference"] = adapterRefs[0]
	}
	if len(metadata) > 0 {
		request["metadata"] = metadata
	}
	return request
}

// normalizeAPIMartVideoRequest removes compatibility-only fields after the
// provider adapter has shaped the request. APIMart's strict schemas use
// `duration` and provider-specific aspect fields; forwarding the shared
// `seconds`/`size` aliases can otherwise trigger validation errors.
func normalizeAPIMartVideoRequest(request, metadata, payload map[string]any, model string, seconds int) {
	if !isAPIMartVideoPayload(payload) || strings.Contains(model, "/") {
		return
	}
	name := strings.ToLower(strings.TrimSpace(model))
	delete(request, "seconds")
	if strings.Contains(name, "sora-2") {
		if reference := strings.TrimSpace(util.Clean(request["input_reference"])); reference != "" && !strings.HasPrefix(strings.ToLower(reference), "data:") {
			request["image_urls"] = []string{reference}
			delete(request, "input_reference")
		}
	}
	// APIMart has a per-model input contract. Normalize the shared aliases
	// only after the provider adapter has populated its native fields.
	contract := apimartVideoContractForModel(name)
	normalizeAPIMartKlingV3Advanced(request, metadata, payload, name)
	normalizeAPIMartAspectRequest(request, payload, contract)
	normalizeAPIMartResolutionRequest(request, payload, contract)
	normalizeAPIMartAudioRequest(request, payload, name)
	normalizeAPIMartVideoModeRequest(request, payload, contract)
	clearAPIMartConflictingReferences(request, name)
	clearAPIMartUnsupportedReferences(request, contract)
	if len(metadata) > 0 {
		normalizeAPIMartAspectRequest(metadata, nil, contract)
		normalizeAPIMartResolutionRequest(metadata, nil, contract)
		normalizeAPIMartAudioRequest(metadata, payload, name)
		normalizeAPIMartVideoModeRequest(metadata, payload, contract)
		clearAPIMartConflictingReferences(metadata, name)
		clearAPIMartUnsupportedReferences(metadata, contract)
	}

	noDuration := strings.Contains(name, "motion-control") ||
		name == "gemini-omni-flash-preview" ||
		strings.Contains(name, "ai-avatar") ||
		strings.Contains(name, "infinitalk") ||
		(strings.Contains(name, "omni-flash-ext") && hasAPIMartReferenceValue(request, "video_urls")) ||
		(strings.Contains(name, "topaz") && strings.Contains(name, "video"))
	if noDuration {
		delete(request, "duration")
	} else if _, ok := request["duration"]; !ok && seconds > 0 {
		request["duration"] = seconds
	}

	if name == "minimax-h3" {
		// Generic APIMart normalization lower-cases video resolutions. H3 has a
		// stricter enum and also requires one of its three generation modes, so
		// make this the final provider-specific guard after aliases are removed.
		normalizeMiniMaxH3Request(request, false)
	}
	if strings.HasPrefix(name, "sora-2") {
		if resolution := strings.TrimSpace(util.Clean(request["resolution"])); resolution != "" {
			switch strings.ToLower(resolution) {
			case "360", "360p", "480", "480p":
				request["quality"] = "480p"
			case "1080", "1080p", "2k", "4k":
				request["quality"] = "1080p"
			default:
				request["quality"] = "720p"
			}
		}
		delete(request, "resolution")
	}
	if (strings.Contains(name, "wan2-7") || strings.Contains(name, "wan2.7")) && !strings.Contains(name, "r2v") && !strings.Contains(name, "videoedit") && request["video_urls"] != nil {
		delete(request, "audio_url")
		if len(metadata) > 0 {
			delete(metadata, "audio_url")
		}
	}
	// The reference APIMart adapter submits one flat provider-native payload.
	// Metadata is only an internal compatibility staging area for the shared
	// relay adapters and must not become an extra APIMart request field.
	for key := range metadata {
		delete(metadata, key)
	}
}

// normalizeAPIMartKlingV3Advanced mirrors the reference project's APIMart
// adapter. The creator stores shared Kling controls in the compatibility
// envelope, but APIMart's kling-v3 schema expects the native top-level fields.
func normalizeAPIMartKlingV3Advanced(request, metadata, payload map[string]any, model string) {
	if strings.ToLower(strings.TrimSpace(model)) != "kling-v3" {
		return
	}
	if elements := normalizeAPIMartKlingV3Elements(firstNonNilRelayValue(payload["element_list"], metadata["element_list"])); len(elements) > 0 {
		request["element_list"] = elements
	} else {
		delete(request, "element_list")
	}
	value := payload["multi_shot"]
	if value == nil {
		value = payload["multi_shots"]
	}
	if value == nil {
		value = metadata["multi_shot"]
	}
	if value == nil {
		value = metadata["multi_shots"]
	}
	if !util.ToBool(value) {
		for _, key := range []string{"multi_shot", "multi_shots", "shot_type", "multi_prompt"} {
			delete(request, key)
		}
		return
	}
	request["multi_shot"] = true
	shotType := strings.ToLower(strings.TrimSpace(firstNonEmpty(util.Clean(payload["shot_type"]), util.Clean(metadata["shot_type"]))))
	if shotType != "customize" {
		request["shot_type"] = "intelligence"
		delete(request, "multi_prompt")
	} else {
		request["shot_type"] = "customize"
		if prompts := normalizeAPIMartKlingV3MultiPrompt(firstNonNilRelayValue(payload["multi_prompt"], metadata["multi_prompt"])); len(prompts) > 0 {
			request["multi_prompt"] = prompts
		} else {
			delete(request, "multi_prompt")
		}
	}
}

func normalizeAPIMartKlingV3MultiPrompt(value any) []map[string]any {
	items := util.AsMapSlice(value)
	if len(items) == 0 {
		items = []map[string]any{{"prompt": "", "duration": 1}}
	}
	result := make([]map[string]any, 0, len(items))
	for index, item := range items {
		duration := util.ToInt(item["duration"], 1)
		if duration < 1 {
			duration = 1
		}
		if duration > 15 {
			duration = 15
		}
		result = append(result, map[string]any{
			"index":    index + 1,
			"prompt":   strings.TrimSpace(util.Clean(item["prompt"])),
			"duration": duration,
		})
	}
	return result
}

func normalizeAPIMartKlingV3Elements(value any) []map[string]any {
	items := util.AsMapSlice(value)
	if len(items) == 0 {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		urls := util.AsStringSlice(item["element_input_urls"])
		for _, reference := range util.AsMapSlice(item["references"]) {
			if url := strings.TrimSpace(util.Clean(reference["url"])); url != "" {
				urls = append(urls, url)
			}
		}
		if len(urls) == 0 {
			continue
		}
		if len(urls) > 4 {
			urls = urls[:4]
		}
		result = append(result, map[string]any{
			"name":               strings.TrimSpace(util.Clean(item["name"])),
			"description":        strings.TrimSpace(util.Clean(item["description"])),
			"element_input_urls": urls,
		})
		if len(result) >= 3 {
			break
		}
	}
	return result
}

func normalizeAPIMartVideoModeRequest(request, payload map[string]any, contract apimartVideoContract) {
	if !contract.modeFromResolution {
		return
	}
	mode := strings.ToLower(strings.TrimSpace(util.Clean(request["mode"])))
	if mode != "" && mode != "normal" {
		return
	}
	resolution := firstNonEmpty(util.Clean(request["resolution"]), util.Clean(payload["resolution"]), util.Clean(payload["resolution_name"]))
	switch strings.ToLower(strings.TrimSpace(resolution)) {
	case "1080", "1080p", "2160", "2160p", "4k", "uhd", "pro":
		request["mode"] = "pro"
	default:
		request["mode"] = "std"
	}
}

type apimartVideoContract struct {
	aspectField        string
	dropAspectWithRefs bool
	hasResolution      bool
	maxResolution      string
	upperResolution    bool
	hasQuality         bool
	modeFromResolution bool
}

func apimartVideoContractForModel(name string) apimartVideoContract {
	c := apimartVideoContract{aspectField: "aspect_ratio", hasResolution: true}
	switch {
	case strings.Contains(name, "doubao-seedance-2"):
		c.aspectField = "size"
	case strings.Contains(name, "doubao-seedance-1-0"), strings.Contains(name, "doubao-seedance-1-5"), strings.Contains(name, "seedance-1"):
		c.aspectField = "aspect_ratio"
	case strings.Contains(name, "sora-2"):
		c.dropAspectWithRefs = true
		if !strings.Contains(name, "pro") {
			c.maxResolution = "720p"
		}
	case strings.Contains(name, "veo"):
		c.aspectField = "aspect_ratio"
	case name == "minimax-h3":
		c.aspectField = "aspect_ratio"
	case strings.Contains(name, "minimax"), strings.Contains(name, "hailuo"):
		c.aspectField = ""
	case strings.Contains(name, "skyreels"):
		c.aspectField = "aspect_ratio"
	case name == "kling-3-0-turbo":
		c.dropAspectWithRefs = true
	case strings.Contains(name, "happyhorse"):
		c.aspectField = "size"
		c.upperResolution = true
	case strings.Contains(name, "gemini-omni-flash-preview"):
		c.maxResolution = "720p"
	case strings.Contains(name, "wan2-7"), strings.Contains(name, "wan2.7"):
		c.aspectField = "size"
		c.upperResolution = true
	case strings.Contains(name, "wan2-6-i2v-flash"), strings.Contains(name, "wan2.6-i2v-flash"):
		c.aspectField = ""
	case strings.Contains(name, "wan2-5"), strings.Contains(name, "wan2.5"):
		c.aspectField = "size"
		c.dropAspectWithRefs = true
	case strings.Contains(name, "wan2-6"), strings.Contains(name, "wan2.6"):
		c.dropAspectWithRefs = true
	case strings.Contains(name, "motion-control"):
		c.aspectField = ""
		c.hasResolution = false
	case strings.Contains(name, "kling-v2-6"), strings.Contains(name, "kling-2-6"), strings.Contains(name, "kling-v3"), strings.Contains(name, "kling-video-o1"), strings.Contains(name, "kling"):
		c.hasResolution = false
		c.modeFromResolution = strings.Contains(name, "kling-v3-omni") || strings.Contains(name, "kling-video-o1")
	case strings.Contains(name, "vidu"):
		c.dropAspectWithRefs = name != "viduq3" && name != "viduq3-mix"
	case strings.Contains(name, "grok-imagine"):
		c.aspectField = "size"
		c.hasResolution = false
		c.hasQuality = true
	case strings.Contains(name, "pixverse"):
		c.aspectField = "size"
	case strings.Contains(name, "omni-flash"):
		c.aspectField = "aspect_ratio"
	case strings.Contains(name, "flux-3-video"):
		c.aspectField = "aspect_ratio"
	}
	return c
}

func normalizeAPIMartAspectRequest(request, payload map[string]any, contract apimartVideoContract) {
	if contract.aspectField == "" {
		for _, key := range []string{"size", "ratio", "aspect_ratio", "image_size"} {
			delete(request, key)
		}
		return
	}
	value := firstNonEmpty(util.Clean(request[contract.aspectField]), util.Clean(request["size"]), util.Clean(request["aspect_ratio"]), util.Clean(request["ratio"]), util.Clean(payload["size"]))
	if value != "" {
		value = normalizeKIEAspectRatio(value)
		request[contract.aspectField] = value
	}
	for _, key := range []string{"size", "ratio", "aspect_ratio", "image_size"} {
		if key != contract.aspectField {
			delete(request, key)
		}
	}
	if contract.dropAspectWithRefs && hasAPIMartRequestImageReference(request) {
		delete(request, contract.aspectField)
	}
}

func normalizeAPIMartResolutionRequest(request, payload map[string]any, contract apimartVideoContract) {
	value := firstNonEmpty(util.Clean(request["resolution"]), util.Clean(payload["resolution"]), util.Clean(payload["resolution_name"]), util.Clean(payload["image_resolution"]))
	if contract.hasQuality {
		if value != "" {
			request["quality"] = normalizeAPIMartVideoQuality(value)
		}
		delete(request, "resolution")
		return
	}
	if !contract.hasResolution {
		delete(request, "resolution")
		return
	}
	if value == "" {
		return
	}
	normalized := normalizeAPIMartVideoQuality(value)
	if contract.maxResolution == "720p" && (normalized == "1080p" || normalized == "4k") {
		normalized = "720p"
	}
	if contract.upperResolution {
		normalized = strings.ToUpper(normalized)
	}
	request["resolution"] = normalized
}

func normalizeAPIMartAudioRequest(request, payload map[string]any, name string) {
	value, ok := payload["generate_audio"].(bool)
	if !ok {
		if candidate, exists := payload["video_generate_audio"]; exists {
			value = util.ToBool(candidate)
			ok = true
		}
	}
	if !ok {
		return
	}
	switch {
	case strings.Contains(name, "doubao-seedance-2") || strings.Contains(name, "veo") && strings.Contains(name, "official"):
		request["generate_audio"] = value
	case strings.Contains(name, "kling-v3-omni"):
		if request["video_list"] == nil {
			request["audio"] = value
		} else {
			delete(request, "audio")
		}
	case strings.Contains(name, "doubao-seedance-1-5"), strings.Contains(name, "seedance-1-5"), isAPIMartWan26AudioModel(name), strings.Contains(name, "pixverse-v6"), isAPIMartViduQ3AudioModel(name):
		request["audio"] = value
	case strings.Contains(name, "kling-v3") && !strings.Contains(name, "omni"):
		request["audio"] = value
	case (strings.Contains(name, "kling-v2-6") || strings.Contains(name, "kling-2-6")) && !strings.Contains(name, "motion"):
		if !hasAPIMartRequestLastFrame(request) || !value {
			request["audio"] = value
			if value && util.Clean(request["mode"]) == "" {
				request["mode"] = "pro"
			}
		}
	}
	delete(request, "sound")
	delete(request, "video_generate_audio")
}

func isAPIMartWan26AudioModel(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	switch name {
	case "wan2-6", "wan2.6", "wan2-6-i2v-flash", "wan2.6-i2v-flash":
		return true
	default:
		return false
	}
}

func isAPIMartViduQ3AudioModel(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return strings.Contains(name, "viduq3-pro") ||
		strings.Contains(name, "vidu-q3-pro") ||
		strings.Contains(name, "viduq3-turbo")
}

func hasAPIMartRequestImageReference(request map[string]any) bool {
	for _, key := range []string{"image_urls", "image_with_roles", "first_frame_image", "last_frame_image", "img_references", "ref_images", "image_url", "image"} {
		if value := request[key]; value != nil && strings.TrimSpace(util.Clean(value)) != "" {
			return true
		}
	}
	return false
}

func hasAPIMartRequestLastFrame(request map[string]any) bool {
	for _, key := range []string{"last_frame_image", "last_frame_url", "tail_image_url", "image_tail"} {
		if value := request[key]; value != nil && strings.TrimSpace(util.Clean(value)) != "" {
			return true
		}
	}
	return false
}

// clearAPIMartConflictingReferences mirrors the provider-specific exclusions
// in the reference workbench. These fields are individually valid, but some
// APIMart endpoints reject a request when two reference modes are combined.
func clearAPIMartConflictingReferences(request map[string]any, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(name, "happyhorse-1-1") && hasAPIMartReferenceValue(request, "first_frame_image") {
		delete(request, "image_urls")
	}
	if strings.Contains(name, "doubao-seedance-2") && hasAPIMartReferenceValue(request, "image_with_roles") {
		delete(request, "image_urls")
		if hasAPIMartFirstLastImageRole(request) {
			delete(request, "video_urls")
			delete(request, "audio_urls")
		}
	}
	if (strings.Contains(name, "wan2-7") || strings.Contains(name, "wan2.7")) &&
		!strings.Contains(name, "r2v") && !strings.Contains(name, "videoedit") &&
		hasAPIMartReferenceValue(request, "video_urls") {
		delete(request, "audio_url")
	}
	if strings.Contains(name, "omni-flash-ext") && hasAPIMartReferenceValue(request, "video_urls") {
		delete(request, "duration")
	}
}

func hasAPIMartReferenceValue(request map[string]any, key string) bool {
	value, ok := request[key]
	if !ok || value == nil {
		return false
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) != ""
	case []string:
		for _, item := range typed {
			if strings.TrimSpace(item) != "" {
				return true
			}
		}
		return false
	case []any:
		return len(typed) > 0
	case []map[string]string:
		return len(typed) > 0
	case []map[string]any:
		return len(typed) > 0
	case map[string]any, map[string]string:
		return true
	default:
		return strings.TrimSpace(util.Clean(value)) != ""
	}
}

func hasAPIMartFirstLastImageRole(request map[string]any) bool {
	check := func(role string) bool {
		role = strings.TrimSpace(role)
		return role == "first_frame" || role == "last_frame"
	}
	switch typed := request["image_with_roles"].(type) {
	case []map[string]string:
		for _, item := range typed {
			if check(item["role"]) {
				return true
			}
		}
	case []map[string]any:
		for _, item := range typed {
			if check(util.Clean(item["role"])) {
				return true
			}
		}
	case []any:
		for _, item := range typed {
			if record, ok := item.(map[string]any); ok && check(util.Clean(record["role"])) {
				return true
			}
		}
	}
	return false
}

func clearAPIMartUnsupportedReferences(request map[string]any, contract apimartVideoContract) {
	// The adapter writes native fields; remove only shared aliases that the
	// APIMart schema never documents. Native fields remain model-specific.
	for _, key := range []string{"input_reference", "input_reference[]", "reference_image_urls", "reference_video_urls", "reference_audio_urls", "images", "image", "videos", "video", "audios", "input_urls", "input_url", "image_input", "reference_images", "reference_image_url", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url", "reference_video_url", "reference_audio_url", "input_video_url", "input_video_urls", "input_audio_url", "input_audio_urls", "video_reference", "video_reference[]", "audio_reference", "audio_reference[]", "image_tail"} {
		delete(request, key)
	}
	_ = contract
}

func isMiniMaxH3Model(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "h3") && (strings.Contains(name, "minimax") || strings.Contains(name, "hailuo"))
}

func validateVideoReferenceImage(model, size string, data []byte) error {
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return fmt.Errorf("视频参考图必须是有效的 PNG、JPEG 或 WebP 图片")
	}
	if isMiniMaxH3Model(model) {
		if len(data) > 30<<20 {
			return fmt.Errorf("MiniMax H3 官方参考图大小不能超过 30 MB")
		}
		if info.Width < 256 || info.Width > 5760 || info.Height < 256 || info.Height > 5760 {
			return fmt.Errorf("MiniMax H3 官方参考图宽高必须在 256 到 5760 像素之间")
		}
		ratio := float64(info.Width) / float64(info.Height)
		if ratio < 0.4 || ratio > 2.5 {
			return fmt.Errorf("MiniMax H3 官方参考图宽高比必须在 2:5 到 5:2 之间")
		}
	}
	name := strings.ToLower(strings.TrimSpace(model))
	if seedanceVideoProfile(name) != "" {
		if len(data) >= 30<<20 {
			return fmt.Errorf("Seedance 官方要求单张参考图小于 30 MB")
		}
		ratio := float64(info.Width) / float64(info.Height)
		if ratio < 0.4 || ratio > 2.5 {
			return fmt.Errorf("Seedance 官方参考图宽高比必须在 2:5 到 5:2 之间")
		}
	}
	if isKling3Model(name) {
		if info.ContentType != "image/png" && info.ContentType != "image/jpeg" {
			return fmt.Errorf("Kling 3.0 官方参考图仅支持 JPG、JPEG、PNG")
		}
		if len(data) > 50<<20 {
			return fmt.Errorf("Kling 3.0 官方参考图大小不能超过 50 MB")
		}
		if info.Width < 300 || info.Height < 300 {
			return fmt.Errorf("Kling 3.0 官方参考图宽高均不能小于 300 像素")
		}
		ratio := float64(info.Width) / float64(info.Height)
		if ratio < 0.4 || ratio > 2.5 {
			return fmt.Errorf("Kling 3.0 官方参考图宽高比必须在 1:2.5 到 2.5:1 之间")
		}
	}
	return nil
}

func relayVideoMultipartRequest(ctx context.Context, baseURL, apiKey string, payload map[string]any, image protocol.UploadedImage) (*http.Request, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range payload {
		if value == nil {
			continue
		}
		fieldValue := strings.TrimSpace(util.Clean(value))
		switch value.(type) {
		case map[string]any, []any, []string:
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			fieldValue = string(encoded)
		}
		if fieldValue == "" {
			continue
		}
		if err := writer.WriteField(key, fieldValue); err != nil {
			return nil, err
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="input_reference"; filename="%s"`, escapeMultipartQuote(image.Filename)))
	header.Set("Content-Type", relayUploadImageContentType(image))
	part, err := writer.CreatePart(header)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(image.Data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/videos", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func videoReferenceImageExtension(contentType string) string {
	if strings.EqualFold(contentType, "image/jpeg") {
		return "jpg"
	}
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/")
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
	preserveXAIEditImages := pathValue == "/v1/images/edits" && util.IsXAIImageModel(util.Clean(payload["model"]))
	for key, value := range payload {
		if (shouldDropRelayPayloadKey(key) && !(preserveXAIEditImages && key == "images")) || value == nil {
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
	for _, key := range []string{"provider", "image_provider", "video_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		delete(out, key)
	}
	return out
}

func sanitizeRelayImagePayload(payload map[string]any) {
	delete(payload, "messages")
	model := util.Clean(payload["model"])
	isAPIMartImage := isAPIMartImagePayload(payload)
	isKIEImage := isKnownKIEImageModel(model)
	route := util.ImageModelRouteFor(model)
	if isKIEImage || isAPIMartImage {
		// KIE schemas are strict and each model has its own field contract. The
		// model normalizer has already selected those fields; do not run the
		// generic OpenAI size/stream cleanup over them.
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "response_format")
		delete(payload, "input_image_mask")
		delete(payload, "background")
		delete(payload, "moderation")
		delete(payload, "output_compression")
		return
	}
	if route == util.ImageModelRouteGoogleGemini {
		delete(payload, "image_resolution")
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "output_format")
		delete(payload, "output_compression")
		delete(payload, "response_format")
		return
	}
	if route == util.ImageModelRouteZhipu {
		delete(payload, "image_resolution")
		// GLM-Image/CogView use the OpenAI image envelope for size and
		// quality, but their adapters do not accept streaming, output-format,
		// mask, or response-format controls.
		if _, ok := payload["size"]; ok {
			if normalizedSize, ok := normalizeRelayImageSize(util.Clean(payload["size"])); ok && normalizedSize != "" {
				payload["size"] = normalizedSize
			} else {
				delete(payload, "size")
			}
		}
		if quality := util.NormalizeZhipuImageQuality(util.Clean(payload["model"]), util.Clean(payload["quality"])); quality != "" && quality != "auto" {
			payload["quality"] = quality
		} else {
			delete(payload, "quality")
		}
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
		return
	}
	if route == util.ImageModelRouteAgnes {
		delete(payload, "image_resolution")
		ratioSource := firstNonEmpty(util.Clean(payload["ratio"]), util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if strings.EqualFold(strings.ReplaceAll(strings.ReplaceAll(util.Clean(payload["model"]), "_", "-"), " ", "-"), "agnes-image-2.1-flash") {
			payload["size"] = agnesImageSize(util.Clean(payload["size"]), util.Clean(payload["image_resolution"]), util.Clean(payload["quality"]))
			if ratioSource != "" {
				if normalizedRatio := normalizeAgnesImageRatio(ratioSource); normalizedRatio != "" {
					payload["ratio"] = normalizedRatio
				}
			}
		}
		delete(payload, "quality")
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "output_format")
		delete(payload, "output_compression")
		delete(payload, "response_format")
		delete(payload, "input_image_mask")
		return
	}
	if route == util.ImageModelRouteXAI {
		delete(payload, "image_resolution")
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
		aspectRatioSource := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if aspectRatio, ok := util.NormalizeXAIImageAspectRatio(aspectRatioSource); ok && aspectRatio != "" && aspectRatio != "auto" {
			payload["aspect_ratio"] = aspectRatio
		} else {
			delete(payload, "aspect_ratio")
		}
		resolutionSource := firstNonEmpty(referenceGrokImageResolution(model, util.Clean(payload["quality"])), util.Clean(payload["resolution"]))
		if resolution, ok := util.NormalizeXAIImageResolution(resolutionSource); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		delete(payload, "quality")
		if util.ToBool(payload["stream"]) {
			payload["stream"] = true
			if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
				payload["partial_images"] = partialImages
			} else {
				payload["partial_images"] = 1
			}
		} else {
			delete(payload, "stream")
			delete(payload, "partial_images")
		}
		allowed := map[string]struct{}{
			"model":           {},
			"prompt":          {},
			"n":               {},
			"response_format": {},
			"aspect_ratio":    {},
			"resolution":      {},
			"stream":          {},
			"partial_images":  {},
			"images":          {},
		}
		for key := range payload {
			if _, ok := allowed[key]; !ok {
				delete(payload, key)
			}
		}
		return
	}
	if !isKIEImage {
		delete(payload, "image_resolution")
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
	normalizeRelayImageEnum(payload, "response_format", map[string]string{"b64_json": "b64_json"})

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

func isKnownKIEImageModel(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	if value == "z-image" || strings.Contains(value, "nano-banana") || strings.HasPrefix(value, "gpt-image-2-") {
		return true
	}
	if !strings.Contains(value, "/") {
		return false
	}
	for _, prefix := range []string{"bytedance/", "flux-2/", "google/", "gpt-image/", "grok-imagine/", "ideogram/", "qwen/", "qwen2/", "recraft/", "seedream/", "topaz/", "wan/2-7-image", "z-image"} {
		if strings.HasPrefix(value, prefix) || value == prefix[:len(prefix)-1] {
			return true
		}
	}
	return strings.Contains(value, "nano-banana") || strings.Contains(value, "imagen4")
}

// normalizeImagePayloadForModel keeps only fields supported by the selected
// provider API and maps application size metadata to provider-native fields.
func normalizeImagePayloadForModel(payload map[string]any) {
	if payload == nil {
		return
	}
	if normalizeAPIMartImagePayload(payload) {
		return
	}
	if normalizeKIEImagePayload(payload) {
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
		resolutionSource := firstNonEmpty(referenceGrokImageResolution(util.Clean(payload["model"]), util.Clean(payload["quality"])), util.Clean(payload["resolution"]), util.Clean(payload["image_resolution"]))
		if resolution, ok := util.NormalizeXAIImageResolution(resolutionSource); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
			payload["image_resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		delete(payload, "quality")
		for _, key := range []string{
			"background", "moderation", "output_format",
			"output_compression", "input_image_mask",
			"image_format", "storage_options", "user",
		} {
			delete(payload, key)
		}
		if util.ToBool(payload["stream"]) {
			payload["stream"] = true
			if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
				payload["partial_images"] = partialImages
			} else {
				payload["partial_images"] = 1
			}
		} else {
			delete(payload, "stream")
			delete(payload, "partial_images")
		}
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
	case util.ImageModelRouteZhipu:
		if quality := util.NormalizeZhipuImageQuality(util.Clean(payload["model"]), util.Clean(payload["quality"])); quality != "" && quality != "auto" {
			payload["quality"] = quality
		} else {
			delete(payload, "quality")
		}
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
	case util.ImageModelRouteAgnes:
		if ratio := firstNonEmpty(util.Clean(payload["ratio"]), util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"])); ratio != "" {
			if normalizedRatio := normalizeAgnesImageRatio(ratio); normalizedRatio != "" {
				payload["ratio"] = normalizedRatio
			}
		}
		if strings.EqualFold(strings.ReplaceAll(strings.ReplaceAll(util.Clean(payload["model"]), "_", "-"), " ", "-"), "agnes-image-2.1-flash") {
			payload["size"] = agnesImageSize(util.Clean(payload["size"]), util.Clean(payload["image_resolution"]), util.Clean(payload["quality"]))
		}
		delete(payload, "quality")
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
	}
}

// normalizeKIEImagePayload mirrors the reference project's model-specific
// image input contract. Only known KIE model IDs are handled here; unknown
// slash-qualified custom models retain the generic OpenAI-compatible payload.
func normalizeKIEImagePayload(payload map[string]any) bool {
	name := strings.ToLower(strings.TrimSpace(util.Clean(payload["model"])))
	// Bare `gpt-image-2` is the official OpenAI route. Only the KIE
	// `gpt-image-2-*` task IDs should enter this strict normalizer.
	if !strings.Contains(name, "/") && name != "z-image" && !strings.Contains(name, "nano-banana") && !strings.HasPrefix(name, "gpt-image-2-") {
		return false
	}
	imageSize := firstNonEmpty(util.Clean(payload["image_size"]), util.Clean(payload["size"]))
	resolution := firstNonEmpty(util.Clean(payload["image_resolution"]), util.Clean(payload["resolution"]))
	count := firstNonNilRelayValue(payload["n"], payload["num_images"], payload["max_images"], payload["actual_image_count"])
	delete(payload, "resolution")
	delete(payload, "image_resolution")
	delete(payload, "n")
	delete(payload, "num_images")
	delete(payload, "max_images")
	delete(payload, "actual_image_count")
	mapAspectRatio := func() {
		if imageSize == "" {
			return
		}
		if ratio := normalizeKIEAspectRatio(imageSize); ratio != "" {
			payload["aspect_ratio"] = ratio
		}
		delete(payload, "size")
	}
	mapImageSize := func() {
		if imageSize != "" {
			payload["image_size"] = normalizeKIEImageSizeName(imageSize)
		}
		delete(payload, "size")
	}
	mapResolution := func(field string) {
		if resolution != "" {
			payload[field] = normalizeKIEImageResolutionValue(resolution)
		}
		if field != "resolution" {
			delete(payload, "resolution")
		}
		if field != "image_resolution" {
			delete(payload, "image_resolution")
		}
	}
	mapImageResolutionFromSize := func(field string, maxResolution string) {
		if resolution != "" || imageSize == "" {
			return
		}
		derived := normalizeKIEImageResolutionFromSize(imageSize)
		if derived == "" {
			return
		}
		if maxResolution == "2K" && derived == "4K" {
			derived = "2K"
		}
		payload[field] = derived
	}
	mapQuality := func(allowed bool, modelPrefix string) {
		quality := strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"])))
		if quality == "" {
			return
		}
		if !allowed {
			resolutionValue := normalizeKIEQualityResolutionValue(quality)
			if resolutionValue != "" && resolution == "" {
				mapResolution("resolution")
				payload["resolution"] = resolutionValue
			}
			delete(payload, "quality")
			return
		}
		switch modelPrefix {
		case "gpt-image/1.5":
			if quality != "high" {
				quality = "medium"
			}
		case "seedream/4.5", "seedream/5-lite":
			if quality == "high" || quality == "4k" {
				quality = "high"
			} else {
				quality = "basic"
			}
		case "seedream/5-pro":
			if quality == "high" || quality == "2k" {
				quality = "high"
			} else {
				quality = "basic"
			}
		}
		payload["quality"] = quality
	}
	mapCount := func(field string, asString bool) {
		if count == nil {
			return
		}
		if asString {
			payload[field] = util.Clean(count)
		} else {
			payload[field] = count
		}
		if field != "n" {
			delete(payload, "n")
		}
	}
	mapReferenceFrom := func(field string, sources []string) {
		if _, exists := payload[field]; exists {
			return
		}
		for _, source := range sources {
			if value, ok := payload[source]; ok {
				if isKIEImageReferenceArrayFieldName(field) {
					payload[field] = normalizeKIEReferenceArrayValue(value)
				} else {
					values := normalizeKIEReferenceArrayValue(value)
					if len(values) > 0 {
						payload[field] = values[0]
					}
				}
				if source != field {
					delete(payload, source)
				}
				return
			}
		}
	}
	mapReference := func(field string) {
		mapReferenceFrom(field, []string{"input_urls", "image_urls", "input_url", "image_url", "images"})
	}

	switch {
	case name == "seedream/5-pro-layer-decomposition":
		// This endpoint is intentionally different from the other Seedream
		// variants in the reference project: it accepts one image_url, a
		// dedicated size enum, and always returns PNG layers.
		mapReference("image_url")
		layerSize := firstNonEmpty(imageSize, resolution)
		switch strings.ToLower(strings.TrimSpace(layerSize)) {
		case "1k", "1.5k", "2k":
			payload["size"] = strings.ToUpper(layerSize)
		case "auto":
			payload["size"] = "auto"
		default:
			switch strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"]))) {
			case "low":
				payload["size"] = "1K"
			case "medium":
				payload["size"] = "1.5K"
			case "high":
				payload["size"] = "2K"
			default:
				payload["size"] = "auto"
			}
		}
		payload["output_format"] = "png"
		for _, key := range []string{"quality", "ratio", "aspect_ratio", "image_size", "resolution", "image_resolution", "n", "num_images", "max_images", "actual_image_count", "requested_size"} {
			delete(payload, key)
		}
	case strings.Contains(name, "seedream/4.5"), strings.Contains(name, "gpt-image/1.5"):
		mapAspectRatio()
		// These endpoints expose quality, not a separate resolution field.
		// The reference project sends only aspect_ratio and quality here.
		delete(payload, "resolution")
		if strings.Contains(name, "seedream/4.5") && strings.Contains(name, "edit") {
			mapReference("image_urls")
		}
		if strings.Contains(name, "gpt-image/1.5") && strings.Contains(name, "image-to-image") {
			mapReference("input_urls")
		}
		if strings.Contains(name, "seedream/4.5") {
			mapQuality(true, "seedream/4.5")
		} else {
			mapQuality(true, "gpt-image/1.5")
		}
	case strings.Contains(name, "seedream"), strings.Contains(name, "seedance-4"):
		if name == "bytedance/seedream" {
			// The legacy Seedream endpoint accepts only the named image_size
			// enum; unlike v4 it has no image_resolution field.
			mapImageSize()
			delete(payload, "image_resolution")
		} else if strings.Contains(name, "seedream-v4") {
			mapImageSize()
			mapResolution("image_resolution")
			mapImageResolutionFromSize("image_resolution", "")
		} else if strings.Contains(name, "seedream/4") {
			mapAspectRatio()
		} else if strings.Contains(name, "seedream/5") {
			mapAspectRatio()
		}
		if strings.Contains(name, "layer-decomposition") {
			mapReference("image_url")
		} else if strings.Contains(name, "edit") || strings.Contains(name, "image-to-image") {
			mapReference("image_urls")
		}
		if strings.Contains(name, "v4") {
			mapCount("max_images", false)
		}
		if strings.Contains(name, "seedream/5-lite") {
			mapQuality(true, "seedream/5-lite")
		} else if strings.Contains(name, "seedream/5-pro") {
			mapQuality(true, "seedream/5-pro")
		} else if name == "bytedance/seedream" {
			// Legacy Seedream has neither quality nor resolution controls.
			delete(payload, "quality")
		} else {
			mapQuality(false, "")
		}
		if name == "bytedance/seedream" || strings.Contains(name, "seedream-v4") {
			delete(payload, "aspect_ratio")
		}
	case strings.Contains(name, "flux-2"), strings.Contains(name, "gpt-image-2"):
		mapAspectRatio()
		mapResolution("resolution")
		if strings.Contains(name, "flux-2") {
			mapImageResolutionFromSize("resolution", "2K")
			if value := normalizeKIEImageResolutionValue(util.Clean(payload["resolution"])); value == "4K" {
				payload["resolution"] = "2K"
			}
		} else {
			mapImageResolutionFromSize("resolution", "")
		}
		if strings.Contains(name, "image-to-image") {
			mapReference("input_urls")
		}
	case strings.Contains(name, "nano-banana"), strings.Contains(name, "google/nano-banana"):
		mapAspectRatio()
		if (strings.Contains(name, "nano-banana-2") && !strings.Contains(name, "nano-banana-2-lite")) || strings.Contains(name, "nano-banana-pro") {
			mapResolution("resolution")
			mapImageResolutionFromSize("resolution", "")
		} else {
			delete(payload, "resolution")
		}
		if strings.Contains(name, "nano-banana-2-lite") {
			mapReference("image_urls")
		} else if strings.Contains(name, "nano-banana-2") || strings.Contains(name, "nano-banana-pro") {
			mapReference("image_input")
		} else if strings.Contains(name, "edit") {
			mapReference("image_urls")
		}
		delete(payload, "size")
	case strings.Contains(name, "wan/2-7-image"):
		mapAspectRatio()
		mapResolution("resolution")
		mapImageResolutionFromSize("resolution", "")
		mapCount("n", false)
		mapReference("input_urls")
	case strings.Contains(name, "ideogram/"):
		if !strings.Contains(name, "character-edit") && !strings.Contains(name, "v3-edit") {
			mapImageSize()
		} else {
			delete(payload, "size")
		}
		if strings.Contains(name, "character") || strings.Contains(name, "v3-remix") {
			mapCount("num_images", true)
		}
		if strings.Contains(name, "v3-remix") {
			// Ideogram v3 Remix uses one source image under image_url. The
			// character-remix endpoint is the separate variant that accepts
			// reference_image_urls.
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images", "reference_image_urls"})
		} else if strings.Contains(name, "character-remix") {
			// Character Remix has two independent image inputs: the base
			// image_url and one or more character reference images. Do not
			// consume reference_image_urls as the base image when image_url is
			// absent; the provider validates both fields separately.
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images"})
			if values := normalizeKIEReferenceArrayValue(payload["reference_image_urls"]); len(values) > 0 {
				payload["reference_image_urls"] = values
			}
		} else if strings.Contains(name, "edit") {
			mapReference("image_url")
			mapReferenceFrom("mask_url", []string{"mask_urls", "mask_url", "mask"})
			// Character Edit has a second, independent reference_image_urls
			// input. Preserve it instead of consuming it as the base image.
			if strings.Contains(name, "character-edit") {
				if values := normalizeKIEReferenceArrayValue(payload["reference_image_urls"]); len(values) > 0 {
					payload["reference_image_urls"] = values
				}
			}
		} else if strings.Contains(name, "character") || strings.Contains(name, "remix") {
			mapReference("reference_image_urls")
		}
	case strings.Contains(name, "qwen"):
		if !strings.Contains(name, "image-to-image") {
			mapImageSize()
		} else {
			delete(payload, "size")
		}
		if strings.Contains(name, "image-to-image") || strings.Contains(name, "edit") {
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images", "reference_image_urls"})
		}
		if name == "qwen/image-edit" {
			mapCount("num_images", true)
		}
		// Qwen's image_size is an aspect-ratio enum. A generic resolution
		// value must not be coerced into that field.
		delete(payload, "resolution")
	case strings.Contains(name, "imagen4"), strings.Contains(name, "grok-imagine"):
		if strings.Contains(name, "imagen4") || strings.Contains(name, "text-to-image") {
			mapAspectRatio()
		} else {
			delete(payload, "size")
			delete(payload, "aspect_ratio")
		}
		if strings.Contains(name, "grok-imagine") {
			switch {
			case strings.Contains(name, "extend"):
				mapReference("image_url")
			case strings.Contains(name, "image-to-image"):
				mapReference("image_urls")
			}
		}
		delete(payload, "size")
	case strings.Contains(name, "recraft/"):
		mapReference("image")
		delete(payload, "size")
		delete(payload, "aspect_ratio")
	case strings.Contains(name, "topaz/"):
		if strings.Contains(name, "video-upscale") {
			mapReferenceFrom("video_url", []string{"video_urls", "video_url", "input_video_urls", "reference_video_urls"})
		} else {
			mapReference("image_url")
		}
		delete(payload, "size")
		delete(payload, "aspect_ratio")
	case name == "z-image":
		mapAspectRatio()
		delete(payload, "size")
	default:
		return false
	}
	clearKIEImageReferenceAliases(payload, name)
	if !supportsKIEImageOutputFormat(name) {
		delete(payload, "output_format")
	} else if format := strings.TrimSpace(util.Clean(payload["output_format"])); format != "" {
		payload["output_format"] = normalizeKIEOutputFormatValue(format)
	}
	if !supportsKIEImageQuality(name) {
		delete(payload, "quality")
	}
	delete(payload, "requested_size")
	return true
}

// KIE accepts one provider-native reference field per image model. Remove
// stale compatibility aliases after mapping so a caller that reuses a payload
// cannot accidentally send unrelated image/video/audio fields to a strict
// endpoint. This mirrors the reference handler's clearKIEReferenceAliases.
func clearKIEImageReferenceAliases(payload map[string]any, model string) {
	keep := map[string]bool{}
	name := strings.ToLower(strings.TrimSpace(model))
	keepField := func(fields ...string) {
		for _, field := range fields {
			keep[field] = true
		}
	}
	switch {
	case strings.Contains(name, "topaz/") && strings.Contains(name, "video-upscale"):
		keepField("video_url")
	case strings.Contains(name, "recraft/"):
		keepField("image")
	case strings.HasPrefix(name, "ideogram/"):
		switch {
		case strings.Contains(name, "v3-edit"):
			keepField("image_url", "mask_url")
		case strings.Contains(name, "character-edit"):
			keepField("image_url", "reference_image_urls", "mask_url")
		case strings.Contains(name, "character-remix"):
			keepField("image_url", "reference_image_urls")
		case strings.HasSuffix(name, "/character"):
			keepField("reference_image_urls")
		case strings.Contains(name, "v3-remix"):
			keepField("image_url")
		}
	case strings.Contains(name, "qwen"):
		if strings.Contains(name, "image-to-image") || strings.Contains(name, "edit") {
			keepField("image_url")
		}
	case strings.Contains(name, "nano-banana") || strings.Contains(name, "google/nano-banana"):
		if (strings.Contains(name, "nano-banana-2") && !strings.Contains(name, "nano-banana-2-lite")) || strings.Contains(name, "nano-banana-pro") {
			keepField("image_input")
		} else if strings.Contains(name, "nano-banana-2-lite") || strings.Contains(name, "edit") {
			keepField("image_urls")
		}
	case strings.Contains(name, "grok-imagine"):
		if strings.Contains(name, "extend") {
			keepField("image_url")
		} else if strings.Contains(name, "image-to-image") {
			keepField("image_urls")
		}
	case strings.Contains(name, "flux-2"), strings.Contains(name, "gpt-image-2"):
		if strings.Contains(name, "image-to-image") {
			keepField("input_urls")
		}
	case strings.Contains(name, "seedream/4.5"):
		if strings.Contains(name, "edit") {
			keepField("image_urls")
		}
	case strings.Contains(name, "seedream"):
		if strings.Contains(name, "layer-decomposition") {
			keepField("image_url")
		} else if strings.Contains(name, "edit") || strings.Contains(name, "image-to-image") {
			keepField("image_urls")
		}
	case strings.Contains(name, "wan/2-7-image"):
		keepField("input_urls")
	case strings.Contains(name, "topaz/"):
		keepField("image_url")
	}
	for _, key := range []string{
		"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input",
		"reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url",
		"video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "video_reference", "video_reference[]", "first_clip_url", "reference_video", "reference_videos", "reference_video_url", "reference_video_urls",
		"audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "reference_audio", "reference_audios", "reference_audio_url", "reference_audio_urls", "audio_reference", "audio_reference[]", "driving_audio_url", "reference_voice", "audio_ids",
		"mask", "mask_url", "mask_urls",
	} {
		if !keep[key] {
			delete(payload, key)
		}
	}
}

func normalizeKIEImageSizeName(value string) string {
	ratio := normalizeKIEAspectRatio(value)
	switch ratio {
	case "", "auto":
		return ratio
	case "1:1":
		return "square_hd"
	case "16:9":
		return "landscape_16_9"
	case "9:16":
		return "portrait_16_9"
	case "4:3":
		return "landscape_4_3"
	case "3:4":
		return "portrait_4_3"
	default:
		return ratio
	}
}

func firstNonNilRelayValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func normalizeKIEImageResolutionValue(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	switch strings.ToLower(normalized) {
	case "":
		return ""
	case "auto":
		return "auto"
	case "1", "1k", "1024", "1024p":
		return "1K"
	case "2", "2k", "2048", "2048p":
		return "2K"
	case "4", "4k", "4096", "4096p":
		return "4K"
	default:
		if strings.HasSuffix(strings.ToLower(normalized), "k") {
			return strings.ToUpper(normalized)
		}
		return normalized
	}
}

// Reference image models derive their resolution tier from a pixel size when
// the caller did not provide an explicit quality/resolution value. This is
// the same longest-edge bucketing used by the reference project's KIE
// handler: at least 900px is 1K, 1700px is 2K, and 3500px is 4K.
func normalizeKIEImageResolutionFromSize(value string) string {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	separator := "x"
	if strings.Contains(normalized, "*") {
		separator = "*"
	}
	parts := strings.Split(normalized, separator)
	if len(parts) != 2 {
		return ""
	}
	width, errWidth := strconv.Atoi(parts[0])
	height, errHeight := strconv.Atoi(parts[1])
	if errWidth != nil || errHeight != nil || width <= 0 || height <= 0 {
		return ""
	}
	longSide := width
	if height > longSide {
		longSide = height
	}
	switch {
	case longSide >= 3500:
		return "4K"
	case longSide >= 1700:
		return "2K"
	case longSide >= 900:
		return "1K"
	default:
		return ""
	}
}

func normalizeKIEQualityResolutionValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "standard", "1k":
		return "1K"
	case "medium", "hd", "2k":
		return "2K"
	case "high", "4k":
		return "4K"
	default:
		return ""
	}
}

func supportsKIEImageOutputFormat(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	return (strings.Contains(value, "nano-banana-2") && !strings.Contains(value, "nano-banana-2-lite")) || strings.Contains(value, "nano-banana-pro") ||
		value == "google/nano-banana" || value == "google/nano-banana-edit" ||
		value == "seedream/5-pro-layer-decomposition" ||
		strings.HasPrefix(value, "qwen/") || strings.HasPrefix(value, "qwen2/")
}

func supportsKIEImageQuality(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(value, "gpt-image/1.5") || strings.HasPrefix(value, "seedream/4.5") || strings.HasPrefix(value, "seedream/5-lite") || strings.HasPrefix(value, "seedream/5-pro")
}

func normalizeKIEOutputFormatValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "jpg", "jpeg":
		return "jpg"
	case "png":
		return "png"
	case "webp":
		return "png"
	default:
		return value
	}
}

func isKIEImageReferenceArrayFieldName(field string) bool {
	switch field {
	case "image_urls", "input_urls", "image_input", "reference_image_urls":
		return true
	default:
		return false
	}
}

func normalizeKIEReferenceArrayValue(value any) []string {
	values := make([]string, 0)
	appendValue := func(item any) {
		if text := strings.TrimSpace(util.Clean(item)); text != "" {
			values = append(values, text)
		}
	}
	switch typed := value.(type) {
	case []string:
		for _, item := range typed {
			appendValue(item)
		}
	case []any:
		for _, item := range typed {
			appendValue(item)
		}
	default:
		appendValue(value)
	}
	return values
}

func agnesImageSize(currentSize, resolution, quality string) string {
	for _, value := range []string{currentSize, resolution} {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1k", "2k", "3k", "4k":
			return strings.ToUpper(strings.TrimSpace(value))
		}
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low":
		return "2K"
	case "medium":
		return "3K"
	case "high":
		return "4K"
	default:
		return "1K"
	}
}

func normalizeAgnesImageRatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	if normalized == "auto" || normalized == "" {
		return "1:1"
	}
	if width, height, ok := parseRelayImageRatio(normalized); ok {
		return closestImageAspectRatio(width/height, []string{"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"})
	}
	if width, height, ok := parseRelayImageDimensions(normalized); ok {
		return closestImageAspectRatio(float64(width)/float64(height), []string{"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"})
	}
	return ""
}

func normalizeRelayImagePartialImages(value any) (int, bool) {
	partialImages, ok := util.StrictInt(value)
	if !ok || partialImages < 0 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func referenceGrokImageResolution(model, quality string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if !strings.HasPrefix(model, "grok-imagine-image") {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low":
		return "1k"
	case "medium", "high":
		if strings.Contains(model, "edit") {
			return "1k"
		}
		return "2k"
	default:
		return ""
	}
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
	case "2048x2048", "2048x1152", "1152x2048", "3136x1344",
		"3840x2160", "2160x3840", "6272x2688":
		// Preserve the exact high-resolution presets used by the reference
		// project. Generic dimensions still pass through the safety normalizer.
		return normalized, true
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
		"requested_size", "images", "api_mode",
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
		message := strings.TrimSpace(typed)
		// Some providers encode the useful validation object inside the
		// outer `message` string. Parse it once more so callers see the
		// actionable detail instead of the wrapper (`fail_to_fetch_task`).
		if strings.HasPrefix(message, "{") || strings.HasPrefix(message, "[") {
			var nested any
			if err := json.Unmarshal([]byte(message), &nested); err == nil {
				if extracted := relayErrorMessageFromValue(nested); extracted != "" {
					return extracted
				}
			}
		}
		return message
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
