package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const (
	relayImageTaskSlotManagedPayloadKey = "relay_image_task_slot_managed"
	relayCustomEndpointPayloadKey       = "relay_custom_endpoint"
	relayStreamMaxTokenSize             = 64 * 1024 * 1024
	relayJSONSuccessMaxBytes            = 256 * 1024 * 1024
	relayJSONErrorMaxBytes              = 1 * 1024 * 1024
	maxGoogleGeminiInlineRequestBytes   = 20 * 1024 * 1024
	relayImageDimensionMultiple         = 16
)

type relayImageTaskSlotManagedMarker struct{}
type relayCustomEndpointContextKey struct{}

type relayBufferedReadCloser struct {
	*bufio.Reader
	io.Closer
}

type relayCredential struct {
	ParameterTranslation string
	APIKey               string
	BaseURL              string
	Custom               bool
	Protocol             string
}

func (a *App) attachRelayAPIKeyForIdentity(ctx context.Context, identity service.Identity, body map[string]any) error {
	if body == nil {
		return nil
	}
	credential, err := a.relayCredentialForTask(ctx, identity, body)
	if err != nil {
		return err
	}
	protocol.RecordAccountUsage(ctx, credential.APIKey)
	body["api_key"] = credential.APIKey
	body["relay_protocol"] = credential.Protocol
	body[relayTranslationSourceKey] = credential.ParameterTranslation
	if credential.Custom {
		body[relayCustomEndpointPayloadKey] = true
	} else {
		delete(body, relayCustomEndpointPayloadKey)
	}
	if credential.BaseURL != "" {
		body["relay_base_url"] = credential.BaseURL
	} else {
		delete(body, "relay_base_url")
	}
	return nil
}

func (a *App) validateRelayCredentialForIdentitySelection(ctx context.Context, identity service.Identity, group, name string) error {
	_, err := a.relayCredentialForIdentitySelection(ctx, identity, group, name)
	return err
}

func (a *App) relayCredentialForIdentitySelection(ctx context.Context, identity service.Identity, group, name string) (relayCredential, error) {
	if configID := service.CustomRelayConfigIDFromTokenName(name); configID != "" {
		if a.customRelayConfigs == nil {
			return relayCredential{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "自定义 API 配置存储不可用"}
		}
		config, err := a.customRelayConfigs.Config(identityScope(identity), configID)
		if err != nil {
			var storageErr *service.CustomRelayConfigStorageError
			if errors.As(err, &storageErr) {
				return relayCredential{}, protocol.HTTPError{Status: http.StatusServiceUnavailable, Message: "自定义 API 配置存储暂时不可用"}
			}
			return relayCredential{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "所选自定义 API 配置无效"}
		}
		if config.BaseURL == "" || config.APIKey == "" {
			return relayCredential{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "所选自定义 API 配置不完整，请重新配置 Base URL 和 Key"}
		}
		return relayCredential{APIKey: config.APIKey, BaseURL: config.BaseURL, Custom: true, Protocol: config.Protocol}, nil
	}
	reader, releaseRelayTokenReader := a.acquireRelayTokenReader()
	defer releaseRelayTokenReader()
	if reader == nil {
		return relayCredential{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "请先配置数据库连接，并创建指定分组的令牌"}
	}
	key, err := reader.KeyForIdentityGroupAndName(ctx, identity, group, name)
	if err != nil {
		return relayCredential{}, a.relayTokenSelectionHTTPError(err)
	}
	return relayCredential{APIKey: key, BaseURL: a.relayBaseURL()}, nil
}

func (a *App) relayTokenSelectionHTTPError(err error) protocol.HTTPError {
	var tokenErr service.NewAPITokenError
	if errors.As(err, &tokenErr) && tokenErr.Cause != nil {
		if a != nil && a.logger != nil {
			a.logger.Error("relay token lookup failed", "error", tokenErr.Cause)
		}
		return protocol.HTTPError{Status: http.StatusServiceUnavailable, Message: "令牌数据库暂时不可用，请稍后重试"}
	}
	return protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
}

func (a *App) relayBaseURL() string {
	if a != nil && a.config != nil {
		return a.config.RelayBaseURL()
	}
	return "http://newapi:3000"
}

func (a *App) relayBaseURLFromPayload(payload map[string]any) string {
	if value := strings.TrimRight(strings.TrimSpace(util.Clean(payload["relay_base_url"])), "/"); value != "" {
		return value
	}
	return a.relayBaseURL()
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

func (a *App) relayListModelsAt(ctx context.Context, baseURL, apiKey string) (map[string]any, error) {
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
	return a.relayJSONAt(ctx, baseURL, http.MethodGet, "/v1/models", apiKey, nil)
}

func (a *App) relayImageGenerations(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	a.attachImageModelDefinition(payload)
	ctx = relayContextForPayload(ctx, payload)
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
	if imagePayloadRoute(payload) == util.ImageModelRouteGoogleGemini {
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
	a.attachImageModelDefinition(payload)
	ctx = relayContextForPayload(ctx, payload)
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
	if imagePayloadRoute(payload) == util.ImageModelRouteGoogleGemini {
		result, err := a.relayGoogleGeminiImage(ctx, payload, images)
		if release != nil {
			release()
		}
		return result, nil, err
	}
	if imagePayloadRoute(payload) == util.ImageModelRouteXAI {
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
	if imagePayloadRoute(payload) == util.ImageModelRouteAgnes {
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

func (a *App) relayChatCompletions(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/chat/completions", payload)
}

func (a *App) relayResponses(ctx context.Context, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	return a.relayJSONMaybeStream(ctx, "/v1/responses", payload)
}

func (a *App) relayJSONMaybeStream(ctx context.Context, path string, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	ctx = relayContextForPayload(ctx, payload)
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	baseURL := a.relayBaseURLFromPayload(payload)
	if util.ToBool(body["stream"]) {
		return a.relayJSONStreamAt(ctx, baseURL, path, apiKey, body)
	}
	result, err := a.relayJSONAt(ctx, baseURL, http.MethodPost, path, apiKey, body)
	if err == nil && relayImagePath(path) {
		err = relayImageJSONResultError(result)
	}
	return result, nil, err
}

func (a *App) relayMultipartMaybeStream(ctx context.Context, path string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	ctx = relayContextForPayload(ctx, payload)
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body := relayPayloadForPath(path, payload)
	baseURL := a.relayBaseURLFromPayload(payload)
	if util.ToBool(body["stream"]) {
		return a.relayMultipartStreamAt(ctx, baseURL, path, apiKey, body, images)
	}
	result, err := a.relayMultipartAt(ctx, baseURL, path, apiKey, body, images)
	if err == nil && relayImagePath(path) {
		err = relayImageJSONResultError(result)
	}
	return result, nil, err
}

func relayImagePath(path string) bool {
	return path == "/v1/images/generations" || path == "/v1/images/edits"
}

func (a *App) relayJSONAt(ctx context.Context, baseURL, method, pathValue, apiKey string, payload map[string]any) (map[string]any, error) {
	var data []byte
	if payload != nil {
		var err error
		data, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	return a.relayJSONDataAt(ctx, baseURL, method, pathValue, apiKey, data)
}

func (a *App) relayJSONDataAt(ctx context.Context, baseURL, method, pathValue, apiKey string, data []byte) (map[string]any, error) {
	req, err := protocol.NewRelayJSONRequest(ctx, baseURL, method, pathValue, apiKey, "application/json", data)
	if err != nil {
		return nil, err
	}
	resp, err := a.relayHTTPClientForContext(ctx).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

// videoContractSnapshot keeps request construction and response parsing on
// the same contract revision for the lifetime of a queued task.
func (a *App) relayJSONStreamAt(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any) (map[string]any, *protocol.StreamResult, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	req, err := protocol.NewRelayJSONRequest(ctx, baseURL, http.MethodPost, pathValue, apiKey, "text/event-stream", data)
	if err != nil {
		return nil, nil, err
	}
	resp, err := a.relayHTTPClientForContext(ctx).Do(req)
	if err != nil {
		return nil, nil, err
	}
	return relayDecodeMaybeStreamResponse(ctx, resp, pathValue)
}

func (a *App) relayMultipartAt(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, error) {
	req, err := relayMultipartRequest(ctx, baseURL, pathValue, apiKey, payload, images)
	if err != nil {
		return nil, err
	}
	resp, err := a.relayHTTPClientForContext(ctx).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

func (a *App) relayMultipartStreamAt(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (map[string]any, *protocol.StreamResult, error) {
	req, err := relayMultipartRequest(ctx, baseURL, pathValue, apiKey, payload, images)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := a.relayHTTPClientForContext(ctx).Do(req)
	if err != nil {
		return nil, nil, err
	}
	return relayDecodeMaybeStreamResponse(ctx, resp, pathValue)
}

func (a *App) relayHTTPClient() *http.Client {
	timeout := 300 * time.Second
	if a != nil && a.config != nil {
		timeout = time.Duration(a.config.ImageTaskTimeoutSeconds()) * time.Second
	}
	var proxy *service.ProxyService
	if a != nil {
		proxy = a.proxy
	}
	return proxy.HTTPClient(timeout)
}

func relayContextForPayload(ctx context.Context, payload map[string]any) context.Context {
	if !util.ToBool(payload[relayCustomEndpointPayloadKey]) {
		return ctx
	}
	return context.WithValue(ctx, relayCustomEndpointContextKey{}, true)
}

func withCustomRelayContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, relayCustomEndpointContextKey{}, true)
}

func (a *App) relayHTTPClientForContext(ctx context.Context) *http.Client {
	if custom, _ := ctx.Value(relayCustomEndpointContextKey{}).(bool); custom {
		timeout := 300 * time.Second
		if a != nil && a.config != nil {
			timeout = time.Duration(a.config.ImageTaskTimeoutSeconds()) * time.Second
		}
		if a != nil && a.newSafeRelayHTTPClient != nil {
			return a.newSafeRelayHTTPClient(timeout)
		}
		return service.SafeOutboundHTTPClient(timeout)
	}
	return a.relayHTTPClient()
}

// relayImageDownloadClient fetches image URLs returned by an upstream. Those
// URLs are untrusted, so the resolved target IP is validated at dial time, or
// before the request goes through the administrator-configured proxy.
func (a *App) relayImageDownloadClient(ctx context.Context) *http.Client {
	if custom, _ := ctx.Value(relayCustomEndpointContextKey{}).(bool); custom {
		return a.relayHTTPClientForContext(ctx)
	}
	timeout := 300 * time.Second
	if a != nil && a.config != nil {
		timeout = time.Duration(a.config.ImageTaskTimeoutSeconds()) * time.Second
	}
	if a != nil && a.newImageDownloadClient != nil {
		return a.newImageDownloadClient(timeout)
	}
	var proxy *service.ProxyService
	if a != nil {
		proxy = a.proxy
	}
	return proxy.SafeDownloadClient(timeout)
}

func relayPayloadForPath(pathValue string, payload map[string]any) map[string]any {
	out := map[string]any{}
	preserveXAIEditImages := pathValue == "/v1/images/edits" && imagePayloadRoute(payload) == util.ImageModelRouteXAI
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
	delete(out, imageModelDefinitionPayloadKey)
	return out
}
