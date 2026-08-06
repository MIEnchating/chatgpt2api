package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func TestRelayAcquireImageTaskSlotUsesWholeRequestSlot(t *testing.T) {
	called := 0
	released := false
	payload := map[string]any{
		protocol.ImageOutputSlotAcquirerPayloadKey: func(ctx context.Context, index int) (func(), error) {
			if index != 0 {
				t.Fatalf("slot index = %d, want 0", index)
			}
			if err := ctx.Err(); err != nil {
				t.Fatalf("ctx err = %v", err)
			}
			called++
			return func() { released = true }, nil
		},
	}

	release, err := relayAcquireImageTaskSlot(context.Background(), payload)
	if err != nil {
		t.Fatalf("relayAcquireImageTaskSlot() error = %v", err)
	}
	if called != 1 {
		t.Fatalf("acquire calls = %d, want 1", called)
	}
	release()
	if !released {
		t.Fatal("release was not called")
	}
}

func TestRelayImageStreamReleasesSlotOnlyAfterStreamEnds(t *testing.T) {
	items := make(chan map[string]any)
	errs := make(chan error, 1)
	released := make(chan struct{})
	stream := relayImageStreamWithSlotRelease(
		context.Background(),
		&protocol.StreamResult{Items: items, Err: errs, Kind: "openai"},
		func() { close(released) },
	)

	go func() {
		items <- map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}
		close(items)
	}()
	if item := <-stream.Items; item == nil {
		t.Fatal("wrapped stream dropped image item")
	}
	select {
	case <-released:
		t.Fatal("slot released before upstream stream result arrived")
	default:
	}
	errs <- nil
	close(errs)
	if err := <-stream.Err; err != nil {
		t.Fatalf("wrapped stream error = %v", err)
	}
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("slot was not released after stream ended")
	}
}

func TestRelayImageStreamReleasesSlotWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	released := make(chan struct{})
	stream := relayImageStreamWithSlotRelease(
		ctx,
		&protocol.StreamResult{Items: make(chan map[string]any), Err: make(chan error), Kind: "openai"},
		func() { close(released) },
	)
	cancel()
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("slot was not released after stream context cancellation")
	}
	if _, ok := <-stream.Items; ok {
		t.Fatal("wrapped item channel remained open after cancellation")
	}
	if err, ok := <-stream.Err; !ok || err != context.Canceled {
		t.Fatalf("wrapped cancellation error = %v, open=%v", err, ok)
	}
}

func TestRelayImageTaskManagedMarkerCannotBeForgedByJSON(t *testing.T) {
	if relayImageTaskSlotIsManaged(map[string]any{relayImageTaskSlotManagedPayloadKey: true}) {
		t.Fatal("JSON boolean forged the internal managed-slot marker")
	}
	if !relayImageTaskSlotIsManaged(map[string]any{relayImageTaskSlotManagedPayloadKey: relayImageTaskSlotManagedMarker{}}) {
		t.Fatal("internal managed-slot marker was not recognized")
	}
}

func TestManagedRelayImageTaskDoesNotAcquireSecondSlot(t *testing.T) {
	acquireCalls := 0
	payload := map[string]any{
		"prompt":                            "draw",
		relayImageTaskSlotManagedPayloadKey: relayImageTaskSlotManagedMarker{},
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			acquireCalls++
			return func() {}, nil
		},
	}
	app := &App{}
	_, _, err := app.relayImageGenerations(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "upstream API key is required") {
		t.Fatalf("relayImageGenerations() error = %v", err)
	}
	if acquireCalls != 0 {
		t.Fatalf("managed creation task acquired %d extra slots", acquireCalls)
	}
}

func TestShouldRetryRelayImageWithoutStreamOnlyForNewAPIColonParseError(t *testing.T) {
	err := protocol.HTTPError{
		Status:  http.StatusInternalServerError,
		Message: "invalid character ':' looking for beginning of value (request id: req_test)",
	}
	if !shouldRetryRelayImageWithoutStream(map[string]any{"stream": true}, err) {
		t.Fatal("NewAPI stream parse error did not trigger non-stream fallback")
	}
	if shouldRetryRelayImageWithoutStream(map[string]any{"stream": false}, err) {
		t.Fatal("disabled stream triggered fallback")
	}
	if shouldRetryRelayImageWithoutStream(map[string]any{"stream": true}, errors.New("user quota exceeded")) {
		t.Fatal("unrelated upstream error triggered fallback")
	}
}

func TestRelayImageNonStreamPayloadDoesNotMutateOriginal(t *testing.T) {
	payload := map[string]any{
		"prompt":         "draw",
		"stream":         true,
		"partial_images": 2,
	}
	fallback := relayImageNonStreamPayload(payload)
	if _, ok := fallback["stream"]; ok {
		t.Fatalf("fallback stream = %#v, want omitted", fallback["stream"])
	}
	if _, ok := fallback["partial_images"]; ok {
		t.Fatalf("fallback partial_images = %#v, want omitted", fallback["partial_images"])
	}
	if payload["stream"] != true || payload["partial_images"] != 2 {
		t.Fatalf("original payload mutated: %#v", payload)
	}
}

func TestRelayImageGenerationsRetriesNewAPIColonParseErrorWithoutStream(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request %d: %v", requestCount, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch requestCount {
		case 1:
			if body["stream"] != true || body["partial_images"] != float64(2) {
				t.Errorf("first request body = %#v, want stream with partial images", body)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid character ':' looking for beginning of value (request id: 202607300220530891561808268d9d6K2BvRB98)"}}`))
		case 2:
			if _, ok := body["stream"]; ok {
				t.Errorf("fallback request retained stream: %#v", body)
			}
			if _, ok := body["partial_images"]; ok {
				t.Errorf("fallback request retained partial_images: %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"url":"https://image.example/result.png"}]}`))
		default:
			t.Errorf("unexpected request %d", requestCount)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	payload := map[string]any{
		"api_key":        "sk-test",
		"prompt":         "draw",
		"stream":         true,
		"partial_images": 2,
	}

	result, stream, err := app.relayImageGenerations(context.Background(), payload)
	if err != nil {
		t.Fatalf("relayImageGenerations() error = %v", err)
	}
	if stream != nil {
		t.Fatal("fallback returned an unexpected stream")
	}
	data := result["data"].([]any)
	if len(data) != 1 || util.Clean(util.StringMap(data[0])["url"]) != "https://image.example/result.png" {
		t.Fatalf("fallback result = %#v", result)
	}
	if requestCount != 2 {
		t.Fatalf("request count = %d, want 2", requestCount)
	}
	if payload["stream"] != true || payload["partial_images"] != 2 {
		t.Fatalf("original payload mutated: %#v", payload)
	}
}

func TestRelayMultipartRequestNormalizesOctetStreamImageContentType(t *testing.T) {
	req, err := relayMultipartRequest(
		context.Background(),
		"https://relay.example",
		"/v1/images/edits",
		"sk-test",
		map[string]any{"prompt": "edit"},
		[]protocol.UploadedImage{{
			Filename:    "source.png",
			ContentType: "application/octet-stream",
			Data:        []byte("\x89PNG\r\n\x1a\npng-bytes"),
		}},
	)
	if err != nil {
		t.Fatalf("relayMultipartRequest() error = %v", err)
	}
	reader, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader() error = %v", err)
	}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart() error = %v", err)
		}
		if part.FormName() != "image" {
			continue
		}
		if got := strings.TrimSpace(part.Header.Get("Content-Type")); got != "image/png" {
			t.Fatalf("image Content-Type = %q, want image/png", got)
		}
		return
	}
	t.Fatal("multipart image part not found")
}

func TestNormalizeUploadedImageContentTypeRejectsOctetStream(t *testing.T) {
	if got := normalizeUploadedImageContentType("application/octet-stream"); got != "" {
		t.Fatalf("normalizeUploadedImageContentType(octet-stream) = %q, want empty", got)
	}
	if got := normalizeUploadedImageContentType("image/jpeg; charset=binary"); got != "image/jpeg" {
		t.Fatalf("normalizeUploadedImageContentType(jpeg) = %q, want image/jpeg", got)
	}
}

func TestRelayStreamResultAcceptsImageFrameBeyondLegacyScannerLimit(t *testing.T) {
	encodedImage := strings.Repeat("a", 5*1024*1024)
	stream := relayStreamResult(io.NopCloser(strings.NewReader(
		`data: {"type":"image_generation.completed","b64_json":"` + encodedImage + `"}` + "\n\n",
	)))

	item, ok := <-stream.Items
	if !ok {
		t.Fatalf("stream closed before large image frame: %v", <-stream.Err)
	}
	if got := len(item["b64_json"].(string)); got != len(encodedImage) {
		t.Fatalf("large image length = %d, want %d", got, len(encodedImage))
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("relayStreamResult() error = %v", err)
	}

	required := base64.StdEncoding.EncodedLen(40*1024*1024) + 1024
	if relayStreamMaxTokenSize < required {
		t.Fatalf("scanner limit = %d, need at least %d bytes for a 40 MiB image frame", relayStreamMaxTokenSize, required)
	}
}

func TestRelayStreamResultIgnoresWrappedHeartbeatAndDuplicateDataPrefix(t *testing.T) {
	stream := relayStreamResult(io.NopCloser(strings.NewReader(strings.Join([]string{
		"data: : PING",
		"",
		`data: data: {"type":"image_generation.completed","b64_json":"image"}`,
		"",
		"data: [DONE]",
		"",
	}, "\n"))))

	item, ok := <-stream.Items
	if !ok {
		t.Fatalf("stream closed before completed image: %v", <-stream.Err)
	}
	if item["type"] != "image_generation.completed" || item["b64_json"] != "image" {
		t.Fatalf("stream item = %#v", item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("relayStreamResult() error = %v", err)
	}
}

func TestRelayDecodeJSONResponseLimitsSuccessfulBody(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Body:       io.NopCloser(strings.NewReader(`{"data":"` + strings.Repeat("a", 32) + `"}`)),
	}
	_, err := relayDecodeJSONResponseWithLimits(resp, 16, 8)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponseWithLimits() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusBadGateway || httpErr.Message != "upstream response is too large" {
		t.Fatalf("oversized success error = %#v", httpErr)
	}

	required := int64(4*base64.StdEncoding.EncodedLen(40*1024*1024) + 1*1024*1024)
	if relayJSONSuccessMaxBytes < required {
		t.Fatalf("success response limit = %d, need at least %d bytes for four 40 MiB images", relayJSONSuccessMaxBytes, required)
	}
}

func TestRelayDecodeJSONResponsePreservesNewAPIErrorMessage(t *testing.T) {
	const message = "upstream rejected the image request (request id: req_test_123)"
	resp := &http.Response{
		StatusCode: http.StatusBadGateway,
		Status:     "502 Bad Gateway",
		Body: io.NopCloser(strings.NewReader(
			`{"error":{"message":"` + message + `","type":"openai_error","param":"","code":"bad_response"}}`,
		)),
	}

	_, err := relayDecodeJSONResponse(resp)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponse() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusBadGateway || httpErr.Message != message {
		t.Fatalf("NewAPI upstream error = %#v", httpErr)
	}
}

func TestRelayDecodeJSONResponseLimitsErrorBody(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Status:     "429 Too Many Requests",
		Body:       io.NopCloser(strings.NewReader(strings.Repeat("x", 17))),
	}
	_, err := relayDecodeJSONResponseWithLimits(resp, 64, 16)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponseWithLimits() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusTooManyRequests || httpErr.Message != "upstream error response is too large" {
		t.Fatalf("oversized upstream error = %#v", httpErr)
	}
}
