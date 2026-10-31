package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) runLoggedImageTask(ctx context.Context, identity service.Identity, payload map[string]any, endpoint, summary string, run func(context.Context, map[string]any) (map[string]any, error)) (map[string]any, error) {
	start := time.Now()
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	model := firstNonEmpty(util.Clean(payload["model"]), a.defaultImageModel())
	if util.Clean(payload["model"]) == "" {
		payload["model"] = model
	}
	a.attachImageModelDefinition(payload)
	if err := validateRelayImageRequest(endpoint, model, payload, uploadedImagesFromPayload(payload["images"])); err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, payloadAuditCapture(payload))
		return nil, err
	}
	if util.Clean(payload["api_mode"]) == "" || util.Clean(payload["api_mode"]) == "images" {
		normalizeImagePayloadForModel(payload)
	}
	requestCapture := payloadAuditCapture(payload)
	managedSlot := relayImageOutputSlotAcquirer(payload) != nil
	release, err := relayAcquireImageTaskSlot(ctx, payload)
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return nil, err
	}
	if managedSlot {
		payload[relayImageTaskSlotManagedPayloadKey] = relayImageTaskSlotManagedMarker{}
		payload[service.ImageOutputCompletionReleasePayloadKey] = release
		defer delete(payload, relayImageTaskSlotManagedPayloadKey)
	}
	result, err := run(ctx, payload)
	if result != nil {
		if localizeErr := a.localizeRelayImageResult(ctx, identity, result, payload); localizeErr != nil {
			if err == nil {
				err = localizeErr
			} else {
				err = errors.Join(err, localizeErr)
			}
		}
	}
	urls := collectURLs(result)
	if recordErr := a.recordGeneratedImagesForPayload(identity, urls, util.Clean(payload["visibility"]), payload); recordErr != nil {
		persistErr := imageMetadataPersistenceError(recordErr)
		if err == nil {
			err = persistErr
		} else {
			err = errors.Join(err, persistErr)
		}
	}
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
		return result, err
	}
	if len(util.AsMapSlice(result["data"])) == 0 {
		message := firstNonEmpty(util.Clean(result["message"]), "图片任务没有返回图片数据，请检查上游返回、模型参数和日志详情")
		result["message"] = message
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", http.StatusBadGateway, message, urls, requestCapture)
		return result, protocol.HTTPError{Status: http.StatusBadGateway, Message: message}
	}
	a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "success", http.StatusOK, "", urls, requestCapture)
	return result, nil
}

func (a *App) localizeRelayImageResult(ctx context.Context, identity service.Identity, result map[string]any, payload map[string]any) error {
	if a == nil || a.images == nil || a.config == nil || result == nil {
		return nil
	}
	items := util.AsMapSlice(result["data"])
	if len(items) == 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx = relayContextForPayload(ctx, payload)
	localizeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), relayImageLocalizationTimeout)
	defer cancel()
	ownerID := identityScope(identity)
	ownerName := identityDisplayName(identity)
	changed := false
	for _, item := range items {
		if item == nil {
			continue
		}
		localURL, outputFormat, qualityCheck, err := a.localizeRelayImageItem(localizeCtx, ownerID, ownerName, item, payload)
		if err != nil {
			return err
		}
		if localURL == "" {
			continue
		}
		item["url"] = localURL
		delete(item, "b64_json")
		if outputFormat != "" {
			item["output_format"] = outputFormat
		}
		for key, value := range qualityCheck {
			item[key] = value
		}
		changed = true
	}
	if changed {
		result["data"] = items
	}
	return nil
}

func (a *App) localizeRelayImageStream(ctx context.Context, payload map[string]any, stream *protocol.StreamResult) *protocol.StreamResult {
	if a == nil || stream == nil {
		return stream
	}
	items := make(chan map[string]any)
	errorsOut := make(chan error, 1)
	go func() {
		defer close(items)
		defer close(errorsOut)
		ownerID := strings.TrimSpace(util.Clean(payload["owner_id"]))
		ownerName := strings.TrimSpace(util.Clean(payload["owner_name"]))
	streamItems:
		for {
			var item map[string]any
			var ok bool
			select {
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errorsOut <- ctx.Err()
				return
			case item, ok = <-stream.Items:
				if !ok {
					break streamItems
				}
			}
			if err := ctx.Err(); err != nil {
				go drainProtocolStream(stream)
				errorsOut <- err
				return
			}
			if item == nil || !isRelayImageCompletedEvent(item) || isRelayImagePartialEvent(item) {
				select {
				case <-ctx.Done():
					go drainProtocolStream(stream)
					errorsOut <- ctx.Err()
					return
				case items <- item:
				}
				continue
			}
			localized, err := a.localizeRelayImageStreamItem(ctx, ownerID, ownerName, item, payload)
			if err != nil {
				errorsOut <- err
				go drainProtocolStream(stream)
				return
			}
			select {
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errorsOut <- ctx.Err()
				return
			case items <- localized:
			}
		}
		select {
		case err := <-stream.Err:
			errorsOut <- err
		case <-ctx.Done():
			go drainProtocolStream(stream)
			errorsOut <- ctx.Err()
		}
	}()
	return &protocol.StreamResult{Items: items, Err: errorsOut, Kind: stream.Kind}
}

func (a *App) localizeRelayImageStreamItem(ctx context.Context, ownerID, ownerName string, event, payload map[string]any) (map[string]any, error) {
	data := relayImageStreamItemData(event)
	if len(data) == 0 {
		return event, nil
	}
	localized := make([]map[string]any, 0, len(data))
	for _, imageItem := range data {
		next := util.CopyMap(imageItem)
		localURL, outputFormat, qualityCheck, err := a.localizeRelayImageItem(ctx, ownerID, ownerName, next, payload)
		if err != nil {
			return nil, err
		}
		if localURL != "" {
			next["url"] = localURL
			delete(next, "b64_json")
		}
		if outputFormat != "" {
			next["output_format"] = outputFormat
		}
		for key, value := range qualityCheck {
			next[key] = value
		}
		localized = append(localized, next)
	}
	out := util.CopyMap(event)
	if _, exists := event["data"]; exists || len(localized) != 1 {
		out["data"] = localized
		delete(out, "url")
		delete(out, "b64_json")
		return out, nil
	}
	for _, key := range []string{"url", "b64_json", "revised_prompt", "output_format", "requested_size", "actual_size", "quality_warning"} {
		delete(out, key)
		if value, ok := localized[0][key]; ok {
			out[key] = value
		}
	}
	return out, nil
}

func drainProtocolStream(stream *protocol.StreamResult) {
	if stream == nil {
		return
	}
	for range stream.Items {
	}
	<-stream.Err
}

func (a *App) localizeRelayImageItem(ctx context.Context, ownerID, ownerName string, item map[string]any, payload map[string]any) (string, string, map[string]any, error) {
	if a.isLocalImageURL(util.Clean(item["url"])) {
		return "", "", nil, nil
	}
	data, contentType, err := relayImageItemBytes(ctx, a, item)
	if err != nil || len(data) == 0 {
		return "", "", nil, err
	}
	outputFormat := relayStoredImageFormat(item, payload, contentType, util.Clean(item["url"]), data)
	qualityCheck := relayImageQualityCheck(data, outputFormat, payload)
	if a == nil || a.images == nil || a.config == nil {
		return "", "", nil, errors.New("image storage is unavailable")
	}
	url, err := a.images.SaveImageBytes(ctx, data, a.config.BaseURL(), ownerID, ownerName)
	return url, outputFormat, qualityCheck, err
}

func relayImageItemBytes(ctx context.Context, app *App, item map[string]any) ([]byte, string, error) {
	if b64 := util.Clean(item["b64_json"]); b64 != "" {
		if len(b64) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
			return nil, "", errors.New("image is too large")
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
		if err != nil {
			if decoded, fallbackErr := util.B64Decode(b64); fallbackErr == nil {
				info, inspectErr := util.InspectRasterImage(decoded, "image/png", "image/jpeg", "image/webp")
				if inspectErr != nil {
					return nil, "", inspectErr
				}
				return decoded, info.ContentType, nil
			}
			return nil, "", err
		}
		info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
		if err != nil {
			return nil, "", err
		}
		return data, info.ContentType, nil
	}
	imageURL := util.Clean(item["url"])
	if imageURL == "" {
		return nil, "", errors.New("image url is empty")
	}
	if isImageDataURL(imageURL) {
		return imageDataURLBytes(imageURL)
	}
	parsed, err := url.Parse(imageURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, "", errors.New("image url is not absolute")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "", errors.New("image url scheme is not supported")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "image/*")
	resp, err := app.relayImageDownloadClient(ctx).Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("image download failed: %s", resp.Status)
	}
	limited := io.LimitReader(resp.Body, maxRelayImageBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxRelayImageBytes {
		return nil, "", errors.New("image is too large")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return nil, "", err
	}
	declaredType := strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	if declaredType != "" && !strings.EqualFold(declaredType, "application/octet-stream") && !strings.EqualFold(declaredType, info.ContentType) {
		return nil, "", util.ErrRasterImageTypeMismatch
	}
	return data, info.ContentType, nil
}

func imageDataURLBytes(value string) ([]byte, string, error) {
	header, dataPart, ok := strings.Cut(strings.TrimSpace(value), ",")
	if !ok || !strings.HasPrefix(strings.ToLower(header), "data:") {
		return nil, "", errors.New("image data url is invalid")
	}
	contentType := strings.TrimSpace(strings.TrimPrefix(strings.Split(header, ";")[0], "data:"))
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil, "", errors.New("image data url is not an image")
	}
	if !strings.Contains(strings.ToLower(header), ";base64") {
		return nil, "", errors.New("image data url must be base64")
	}
	if len(dataPart) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
		return nil, "", errors.New("image is too large")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataPart))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", errors.New("image data is empty")
	}
	if len(data) > maxRelayImageBytes {
		return nil, "", errors.New("image is too large")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return nil, "", err
	}
	if !strings.EqualFold(contentType, info.ContentType) {
		return nil, "", util.ErrRasterImageTypeMismatch
	}
	return data, info.ContentType, nil
}

func (a *App) isLocalImageURL(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if strings.HasPrefix(text, "/images/") {
		return true
	}
	if a == nil || a.config == nil || a.config.BaseURL() == "" {
		return false
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	base, err := url.Parse(a.config.BaseURL())
	if err != nil || base.Scheme == "" || base.Host == "" {
		return false
	}
	return parsed.Scheme == base.Scheme && parsed.Host == base.Host && strings.HasPrefix(parsed.EscapedPath(), "/images/")
}

func (a *App) shouldImportVisibilityImage(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" || a.isLocalImageURL(text) || isManagedImageVisibilityPath(text) {
		return false
	}
	return isImageDataURL(text)
}

func isAbsoluteHTTPURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return false
	}
	return parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func isImageDataURL(value string) bool {
	text := strings.TrimSpace(value)
	return strings.HasPrefix(strings.ToLower(text), "data:image/") && strings.Contains(strings.ToLower(text), ";base64,")
}

func isManagedImageVisibilityPath(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		return strings.Contains(pathValue, "/images/") || strings.Contains(pathValue, "/image-thumbnails/")
	}
	return strings.Contains(text, "/images/") || strings.Contains(text, "/image-thumbnails/")
}

func relayStoredImageFormat(item, payload map[string]any, contentType, imageURL string, data []byte) string {
	if info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp"); err == nil {
		return info.Format
	}
	for _, value := range []string{util.Clean(item["output_format"]), util.Clean(payload["output_format"])} {
		if format, ok := normalizeRelayImageOutputFormat(value); ok {
			return format
		}
	}
	switch strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])) {
	case "image/jpeg", "image/jpg":
		return "jpeg"
	case "image/webp":
		return "webp"
	case "image/png":
		return "png"
	}
	if parsed, err := url.Parse(imageURL); err == nil {
		switch strings.ToLower(filepath.Ext(parsed.Path)) {
		case ".jpg", ".jpeg":
			return "jpeg"
		case ".webp":
			return "webp"
		case ".png":
			return "png"
		}
	}
	switch http.DetectContentType(data) {
	case "image/jpeg":
		return "jpeg"
	case "image/webp":
		return "webp"
	default:
		return "png"
	}
}

func relayImageQualityCheck(data []byte, outputFormat string, payload map[string]any) map[string]any {
	check := map[string]any{}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	actualFormat := ""
	if err == nil {
		actualFormat = info.Format
		actualSize := fmt.Sprintf("%dx%d", info.Width, info.Height)
		check["width"] = info.Width
		check["height"] = info.Height
		check["resolution"] = actualSize
		check["actual_size"] = actualSize
	}
	actualOutputFormat := normalizeActualImageFormat(firstNonEmpty(actualFormat, outputFormat))
	if actualOutputFormat != "" {
		check["actual_output_format"] = actualOutputFormat
	}

	requestedSize := requestedRelayImageSize(payload)
	requestedOutputFormat := requestedRelayImageOutputFormat(payload)
	warnings := []string{}
	qualityCheck := map[string]any{
		"requested_size":          requestedSize,
		"actual_size":             util.Clean(check["actual_size"]),
		"requested_output_format": requestedOutputFormat,
		"actual_output_format":    actualOutputFormat,
	}
	if requestedWidth, requestedHeight, ok := parseImageQualityDimensions(requestedSize); ok {
		actualWidth := util.ToInt(check["width"], 0)
		actualHeight := util.ToInt(check["height"], 0)
		sizeMatched := actualWidth == requestedWidth && actualHeight == requestedHeight
		qualityCheck["size_matched"] = sizeMatched
		if !sizeMatched && actualWidth > 0 && actualHeight > 0 {
			warnings = append(warnings, fmt.Sprintf("请求尺寸 %dx%d，实际尺寸 %dx%d", requestedWidth, requestedHeight, actualWidth, actualHeight))
		}
	} else if requestedSize != "" && requestedSize != "auto" {
		warnings = append(warnings, "请求尺寸不是精确宽高，已记录实际尺寸供人工核对")
	}
	if requestedOutputFormat != "" && actualOutputFormat != "" {
		formatMatched := requestedOutputFormat == actualOutputFormat
		qualityCheck["output_format_matched"] = formatMatched
		if !formatMatched {
			warnings = append(warnings, fmt.Sprintf("请求格式 %s，实际格式 %s", requestedOutputFormat, actualOutputFormat))
		}
	}
	qualityCheck["warnings"] = warnings
	check["quality_check"] = qualityCheck
	return check
}

func requestedRelayImageSize(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if requestedSize := util.Clean(payload["requested_size"]); requestedSize != "" {
		if normalized, ok := normalizeRelayImageSize(requestedSize); ok && normalized != "" {
			return normalized
		}
		return requestedSize
	}
	size := util.Clean(payload["size"])
	if normalized, ok := normalizeRelayImageSize(size); ok && normalized != "" {
		return normalized
	}
	return size
}

func requestedRelayImageOutputFormat(payload map[string]any) string {
	if payload != nil {
		if format, ok := normalizeRelayImageOutputFormat(util.Clean(payload["output_format"])); ok {
			return format
		}
	}
	return ""
}

func normalizeActualImageFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpg", "jpeg":
		return "jpeg"
	case "png":
		return "png"
	case "webp":
		return "webp"
	default:
		return ""
	}
}

func parseImageQualityDimensions(value string) (int, int, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, " ", "")
	normalized = strings.ReplaceAll(normalized, "×", "x")
	parts := strings.Split(normalized, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width := util.ToInt(parts[0], 0)
	height := util.ToInt(parts[1], 0)
	return width, height, width > 0 && height > 0
}
