package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func (a *App) attachRelayAPIKey(r *http.Request, body map[string]any) {
	if body == nil {
		return
	}
	if key := relayAPIKeyFromRequest(r, body); key != "" {
		body["api_key"] = key
	}
}

func relayAPIKeyFromRequest(r *http.Request, body map[string]any) string {
	for _, key := range []string{"api_key", "relay_api_key", "relayai_api_key", "upstream_api_key"} {
		if value := util.Clean(body[key]); value != "" {
			return value
		}
	}
	for _, header := range []string{"X-RelayAI-Key", "X-Relay-Key", "X-Upstream-API-Key"} {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			return value
		}
	}
	return ""
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
		delete(out, "messages")
		delete(out, "stream")
		delete(out, "partial_images")
	}
	return out
}

func shouldDropRelayPayloadKey(key string) bool {
	switch key {
	case "api_key", "relay_api_key", "relayai_api_key", "upstream_api_key",
		"owner_id", "owner_name", "base_url", "visibility", "client_task_id",
		"image_resolution", "requested_size", "images",
		"share_prompt_parameters", "share_reference_images",
		protocol.ImageOutputSlotAcquirerPayloadKey, protocol.ImageOutputChargePayloadKey,
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
			items <- item
		}
		errCh <- scanner.Err()
	}()
	return &protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"}
}

func relayAcquireImageTaskSlot(ctx context.Context, payload map[string]any) (func(), error) {
	acquire := relayImageOutputSlotAcquirer(payload)
	if acquire == nil {
		return nil, nil
	}
	return acquire(ctx, 1)
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
