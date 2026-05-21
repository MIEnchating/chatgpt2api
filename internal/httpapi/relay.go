package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) attachRelayAPIKeyForIdentity(ctx context.Context, identity service.Identity, body map[string]any) error {
	if body == nil {
		return nil
	}
	key, err := a.relayAPIKeyForIdentity(ctx, identity)
	if err != nil {
		return err
	}
	body["api_key"] = key
	return nil
}

func (a *App) relayAPIKeyForIdentity(ctx context.Context, identity service.Identity) (string, error) {
	if a == nil || a.newAPIKeys == nil {
		return "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "请先配置 NewAPI 数据库连接，并在 NewAPI 创建指定分组的令牌"}
	}
	key, err := a.newAPIKeys.KeyForIdentity(ctx, identity)
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
	release, err := relayAcquireImageTaskSlot(ctx, payload)
	if err != nil {
		return nil, nil, err
	}
	result, stream, err := a.relayJSONMaybeStream(ctx, "/v1/images/generations", payload)
	if err != nil {
		if release != nil {
			release()
		}
		return result, stream, err
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
	release, err := relayAcquireImageTaskSlot(ctx, payload)
	if err != nil {
		return nil, nil, err
	}
	result, stream, err := a.relayMultipartMaybeStream(ctx, "/v1/images/edits", payload, images)
	if err != nil {
		if release != nil {
			release()
		}
		return result, stream, err
	}
	if release != nil {
		release()
	}
	return result, stream, err
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
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "RelayAI API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	if util.ToBool(body["stream"]) {
		stream, err := a.relayJSONStream(ctx, path, apiKey, body)
		return nil, stream, err
	}
	result, err := a.relayJSON(ctx, http.MethodPost, path, apiKey, body)
	return result, nil, err
}

func (a *App) relayMultipartMaybeStream(ctx context.Context, path string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "RelayAI API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	if util.ToBool(body["stream"]) {
		stream, err := a.relayMultipartStream(ctx, path, apiKey, body, images)
		return nil, stream, err
	}
	result, err := a.relayMultipart(ctx, path, apiKey, body, images)
	return result, nil, err
}

func (a *App) relayJSON(ctx context.Context, method, pathValue, apiKey string, payload map[string]any) (map[string]any, error) {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.relayBaseURL()+pathValue, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

func (a *App) relayJSONStream(ctx context.Context, pathValue, apiKey string, payload map[string]any) (*protocol.StreamResult, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.relayBaseURL()+pathValue, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		_, err := relayDecodeJSONResponse(resp)
		return nil, err
	}
	return relayStreamResult(resp.Body), nil
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

func (a *App) relayMultipartStream(ctx context.Context, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (*protocol.StreamResult, error) {
	req, err := relayMultipartRequest(ctx, a.relayBaseURL(), pathValue, apiKey, payload, images)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		_, err := relayDecodeJSONResponse(resp)
		return nil, err
	}
	return relayStreamResult(resp.Body), nil
}

func relayMultipartRequest(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (*http.Request, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range payload {
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
		part, err := writer.CreateFormFile("image", filename)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(image.Data); err != nil {
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

func (a *App) relayHTTPClient() *http.Client {
	if a != nil && a.proxy != nil {
		return a.proxy.HTTPClient(300 * time.Second)
	}
	return &http.Client{Timeout: 300 * time.Second}
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
	delete(payload, "stream")
	delete(payload, "partial_images")

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
	compression, ok := relayImageInt(value)
	if !ok || compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func relayImageInt(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		if math.Trunc(v) != v {
			return 0, false
		}
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, false
		}
		return int(n), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
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
		"owner_id", "owner_name", "base_url", "visibility", "client_task_id",
		"image_resolution", "requested_size", "images",
		"share_prompt_parameters", "share_reference_images",
		protocol.ImageOutputSlotAcquirerPayloadKey,
		"image_output_callback", "text_output_callback":
		return true
	default:
		return false
	}
}

func relayDecodeJSONResponse(resp *http.Response) (map[string]any, error) {
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, protocol.HTTPError{Status: resp.StatusCode, Message: relayErrorMessage(data, resp.Status)}
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("RelayAI response is not valid JSON: %w", err)
	}
	return payload, nil
}

func relayErrorMessage(data []byte, fallback string) string {
	var payload map[string]any
	if json.Unmarshal(data, &payload) == nil {
		for _, value := range []any{
			util.StringMap(payload["error"])["message"],
			payload["message"],
			util.StringMap(payload["detail"])["message"],
			payload["detail"],
		} {
			if message := util.Clean(value); message != "" {
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
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" || data == "[DONE]" {
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

func relayStreamItemError(item map[string]any) error {
	if item == nil {
		return nil
	}
	message := ""
	if _, ok := item["error"]; ok {
		message = relayErrorMessageFromValue(item["error"])
	}
	if message == "" && strings.EqualFold(util.Clean(item["type"]), "error") {
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
	default:
		return ""
	}
}

func relayAcquireImageTaskSlot(ctx context.Context, payload map[string]any) (func(), error) {
	acquire := relayImageOutputSlotAcquirer(payload)
	if acquire == nil {
		return nil, nil
	}
	return acquire(ctx, 0)
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
