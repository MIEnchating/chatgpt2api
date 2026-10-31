package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func relayDecodeJSONResponse(resp *http.Response) (map[string]any, error) {
	return relayDecodeJSONResponseWithLimits(resp, relayJSONSuccessMaxBytes, relayJSONErrorMaxBytes)
}

func relayDecodeMaybeStreamResponse(ctx context.Context, resp *http.Response, pathValue string) (map[string]any, *protocol.StreamResult, error) {
	if resp == nil || resp.Body == nil {
		return nil, nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "upstream response body is unavailable"}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if relayResponseIsEventStream(resp) {
			return nil, relayStreamResultContext(ctx, resp.Body), nil
		}
		reader := bufio.NewReader(resp.Body)
		bufferedBody := &relayBufferedReadCloser{Reader: reader, Closer: resp.Body}
		resp.Body = bufferedBody
		if relayBufferedBodyIsEventStream(reader) {
			return nil, relayStreamResultContext(ctx, bufferedBody), nil
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
	return relayStreamResultContext(context.Background(), body)
}

// relayStreamResultContext stops forwarding and reports ctx.Err() once the
// consumer is gone, so the reader goroutine cannot block on a send forever.
func relayStreamResultContext(ctx context.Context, body io.ReadCloser) *protocol.StreamResult {
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
			if data == "[DONE]" {
				errCh <- nil
				return
			}
			if data == "" || strings.HasPrefix(data, ":") {
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
			select {
			case items <- item:
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
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
