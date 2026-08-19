package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
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

func TestRelayAcquireDirectImageTaskSlotDefersReleaseAndMarksPayloadManaged(t *testing.T) {
	released := false
	payload := map[string]any{
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			return func() { released = true }, nil
		},
	}

	release, err := relayAcquireDirectImageTaskSlot(context.Background(), payload)
	if err != nil {
		t.Fatalf("relayAcquireDirectImageTaskSlot() error = %v", err)
	}
	if release == nil {
		t.Fatal("relayAcquireDirectImageTaskSlot() release = nil")
	}
	if released {
		t.Fatal("slot released before direct request completed")
	}
	if !relayImageTaskSlotIsManaged(payload) {
		t.Fatal("direct request payload was not marked as managed")
	}
	release()
	if !released {
		t.Fatal("slot was not released after direct request completed")
	}
	if relayImageTaskSlotIsManaged(payload) {
		t.Fatal("managed marker leaked after direct request completed")
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
	items := make(chan map[string]any)
	errs := make(chan error)
	drained := make(chan struct{})
	stream := relayImageStreamWithSlotRelease(
		ctx,
		&protocol.StreamResult{Items: items, Err: errs, Kind: "openai"},
		func() { close(released) },
	)
	cancel()
	go func() {
		items <- map[string]any{"type": "image_generation.partial_image", "b64_json": "preview"}
		close(items)
		errs <- context.Canceled
		close(errs)
		close(drained)
	}()
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
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled stream did not drain its upstream producer")
	}
}

func TestLocalizeRelayImageStreamCancellationDrainsUpstream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	items := make(chan map[string]any)
	errs := make(chan error)
	drained := make(chan struct{})
	stream := (&App{}).localizeRelayImageStream(ctx, map[string]any{}, &protocol.StreamResult{
		Items: items,
		Err:   errs,
		Kind:  "openai",
	})
	cancel()
	go func() {
		items <- map[string]any{"type": "image_generation.partial_image", "b64_json": "preview"}
		close(items)
		errs <- context.Canceled
		close(errs)
		close(drained)
	}()

	if _, ok := <-stream.Items; ok {
		t.Fatal("localized item channel remained open after cancellation")
	}
	if err, ok := <-stream.Err; !ok || err != context.Canceled {
		t.Fatalf("localized cancellation error = %v, open=%v", err, ok)
	}
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("localized stream did not drain its upstream producer")
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

func TestRelayHTTPClientUsesConfiguredImageTaskTimeout(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"image_task_timeout_seconds": 420}); err != nil {
		t.Fatalf("update image task timeout: %v", err)
	}
	if got := app.relayHTTPClient().Timeout; got != 420*time.Second {
		t.Fatalf("relay HTTP timeout = %s, want %s", got, 420*time.Second)
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

func TestRelayPayloadForGrokUsesOfficialGenerationParameters(t *testing.T) {
	grok := relayPayloadForPath("/v1/images/generations", map[string]any{
		"model":              "grok-imagine-image-2.0",
		"prompt":             "draw",
		"n":                  2,
		"size":               "1024x1024",
		"quality":            "medium",
		"stream":             true,
		"partial_images":     2,
		"aspect_ratio":       "16:9",
		"resolution":         "2k",
		"image_format":       "png",
		"storage_options":    map[string]any{"ttl": 3600},
		"user":               "user-1",
		"response_format":    "B64_JSON",
		"output_format":      "webp",
		"background":         "opaque",
		"moderation":         "low",
		"output_compression": 80,
	})
	for _, key := range []string{
		"size", "stream", "partial_images",
		"image_format", "storage_options", "user", "output_format", "background",
		"moderation", "output_compression",
	} {
		if _, ok := grok[key]; ok {
			t.Fatalf("Grok retained unsupported %s: %#v", key, grok)
		}
	}
	if grok["model"] != "grok-imagine-image-2.0" || grok["prompt"] != "draw" || grok["n"] != 2 {
		t.Fatalf("Grok dropped a supported field: %#v", grok)
	}
	if grok["response_format"] != "b64_json" || grok["aspect_ratio"] != "16:9" || grok["resolution"] != "2k" || grok["quality"] != "medium" {
		t.Fatalf("Grok official parameters were not retained: %#v", grok)
	}
}

func TestOfficialVideoRequestPayloadUsesProviderFields(t *testing.T) {
	tests := []struct {
		name   string
		model  string
		input  map[string]any
		want   map[string]any
		absent []string
	}{
		{
			name:   "grok",
			model:  "grok-imagine-video-1.5",
			input:  map[string]any{"seconds": 10, "size": "16:9", "resolution": "1080p", "generate_audio": true, "watermark": true},
			want:   map[string]any{"duration": 10, "aspect_ratio": "16:9", "resolution": "1080p"},
			absent: []string{"generate_audio", "watermark"},
		},
		{
			name:   "minimax",
			model:  "MiniMax-Hailuo-2.3",
			input:  map[string]any{"seconds": 6, "resolution": "768P", "watermark": true},
			want:   map[string]any{"duration": 6, "resolution": "768P", "aigc_watermark": true},
			absent: []string{"ratio", "generate_audio"},
		},
		{
			name:  "seedance",
			model: "doubao-seedance-2-5-260628",
			input: map[string]any{"seconds": 30, "size": "adaptive", "resolution": "1080p", "generate_audio": true, "watermark": false},
			want:  map[string]any{"duration": 30, "ratio": "adaptive", "resolution": "1080p", "generate_audio": true, "watermark": false},
		},
		{
			name:  "kling",
			model: "kling-v3",
			input: map[string]any{"seconds": 5, "size": "1:1", "generate_audio": true},
			want:  map[string]any{"duration": 5, "aspect_ratio": "1:1", "sound": true},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"model": test.model, "prompt": "make a video"}
			for key, value := range test.input {
				payload[key] = value
			}
			got := officialVideoRequestPayload(payload)
			for key, value := range test.want {
				if got[key] != value {
					t.Fatalf("%s = %#v, want %#v (payload %#v)", key, got[key], value, got)
				}
			}
			for _, key := range test.absent {
				if _, ok := got[key]; ok {
					t.Fatalf("unexpected provider field %q in %#v", key, got)
				}
			}
		})
	}
}

func TestRelayGrokImageGenerationUsesNewAPIImageRouteAndAllowlist(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" {
			t.Errorf("upstream path = %q, want /v1/images/generations", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("Authorization = %q, want Bearer sk-test", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode Grok request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": 123,
			"data":    []map[string]any{{"url": "https://image.example/grok.jpg"}},
		})
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key":         "sk-test",
		"model":           "grok-imagine-image-2.0",
		"prompt":          "draw",
		"n":               2,
		"response_format": "b64_json",
		"aspect_ratio":    "16:9",
		"resolution":      "2k",
		"quality":         "medium",
		"stream":          true,
	})
	if err != nil || stream != nil {
		t.Fatalf("relayImageGenerations() result=%#v stream=%#v error=%v", result, stream, err)
	}
	if data := util.AsMapSlice(result["data"]); len(data) != 1 || data[0]["url"] != "https://image.example/grok.jpg" {
		t.Fatalf("Grok result = %#v", result)
	}
	want := map[string]any{
		"model":           "grok-imagine-image-2.0",
		"prompt":          "draw",
		"n":               float64(2),
		"response_format": "b64_json",
		"aspect_ratio":    "16:9",
		"resolution":      "2k",
		"quality":         "medium",
	}
	if !reflect.DeepEqual(received, want) {
		t.Fatalf("Grok upstream payload = %#v, want %#v", received, want)
	}
}

func TestRelayImageJSONResultErrorRequiresUsableImageData(t *testing.T) {
	tests := []struct {
		name    string
		result  map[string]any
		wantErr string
	}{
		{name: "URL", result: map[string]any{"data": []any{map[string]any{"url": "https://image.example/result.png"}}}},
		{name: "base64", result: map[string]any{"data": []any{map[string]any{"b64_json": "encoded"}}}},
		{name: "top-level error", result: map[string]any{"error": map[string]any{"message": "provider rejected request"}, "data": []any{map[string]any{"url": "https://image.example/result.png"}}}, wantErr: "provider rejected request"},
		{name: "metadata-only item", result: map[string]any{"data": []any{map[string]any{"revised_prompt": "draw"}}}, wantErr: "returned no image data"},
		{name: "blank image fields", result: map[string]any{"data": []any{map[string]any{"url": " ", "b64_json": ""}}}, wantErr: "returned no image data"},
		{name: "non-string image fields", result: map[string]any{"data": []any{map[string]any{"url": 123, "b64_json": true}}}, wantErr: "returned no image data"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := relayImageJSONResultError(test.result)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("relayImageJSONResultError() error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("relayImageJSONResultError() error = %v, want %q", err, test.wantErr)
			}
		})
	}
}

func TestMarshalGoogleGeminiInlineRequestRejectsPayloadOverOfficialLimit(t *testing.T) {
	_, err := marshalGoogleGeminiInlineRequest(map[string]any{
		"payload": strings.Repeat("x", maxGoogleGeminiInlineRequestBytes),
	})
	if err == nil {
		t.Fatal("oversized Gemini request was accepted")
	}
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("oversized Gemini request error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized Gemini request status = %d, want %d", httpErr.Status, http.StatusRequestEntityTooLarge)
	}
	if !strings.Contains(httpErr.Message, "20 MB") {
		t.Fatalf("oversized Gemini request message = %q, want official limit", httpErr.Message)
	}
}

func TestRelayJSONPreservesEncodedRequestBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body["prompt"] != "draw" {
			t.Errorf("request body = %#v, want prompt", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, err := app.relayJSON(context.Background(), http.MethodPost, "/v1/test", "sk-test", map[string]any{"prompt": "draw"})
	if err != nil {
		t.Fatalf("relayJSON() error = %v", err)
	}
	if result["ok"] != true {
		t.Fatalf("relayJSON() result = %#v", result)
	}
}

func TestRelayImageStreamConvertsCompleteJSONResponseWithoutAnotherRequest(t *testing.T) {
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body["stream"] != true {
			t.Errorf("request body = %#v, want stream=true", body)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"created":1710000000,"model":"gpt-image-2","data":[{"url":"https://image.example/one.png"},{"b64_json":"second"}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err != nil {
		t.Fatalf("relayJSONMaybeStream() error = %v", err)
	}
	if result != nil || stream == nil {
		t.Fatalf("relayJSONMaybeStream() result=%#v stream=%#v, want converted stream", result, stream)
	}
	var items []map[string]any
	for item := range stream.Items {
		items = append(items, item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("converted stream error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("converted stream items = %#v, want two", items)
	}
	if items[0]["type"] != "image_generation.completed" || items[0]["output_index"] != 0 || items[0]["url"] != "https://image.example/one.png" {
		t.Fatalf("first converted stream item = %#v", items[0])
	}
	if items[1]["type"] != "image_generation.completed" || items[1]["output_index"] != 1 || items[1]["b64_json"] != "second" {
		t.Fatalf("second converted stream item = %#v", items[1])
	}
	if requestCount.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requestCount.Load())
	}
}

func TestRelayImageStreamSniffsSSEWhenProxyUsesJSONContentType(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte{0xef, 0xbb, 0xbf})
		_, _ = io.WriteString(w, " \r\n")
		_, _ = io.WriteString(w, ": keepalive\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"image_generation.completed\",\"output_index\":0,\"b64_json\":\"image\"}\n\n")
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err != nil || result != nil || stream == nil {
		t.Fatalf("relayJSONMaybeStream() = result %#v, stream %#v, error %v", result, stream, err)
	}
	item, ok := <-stream.Items
	if !ok || item["type"] != "image_generation.completed" || item["b64_json"] != "image" {
		t.Fatalf("stream item = %#v, %v", item, ok)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("stream error = %v", err)
	}
}

func TestRelayImageNonStreamRejectsEmptyImageData(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 123, "data": []any{}})
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
	})
	if err == nil || !strings.Contains(err.Error(), "returned no image data") {
		t.Fatalf("relayImageGenerations() error = %v, want empty image data failure", err)
	}
	if result == nil || stream != nil {
		t.Fatalf("relayImageGenerations() result=%#v stream=%#v", result, stream)
	}
}

func TestRelayImageStreamReturnsEmbeddedJSONError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"detail":{"message":"upstream quota exhausted"}}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err == nil || !strings.Contains(err.Error(), "upstream quota exhausted") {
		t.Fatalf("relayJSONMaybeStream() error = %v, want embedded upstream message", err)
	}
	if result != nil || stream != nil {
		t.Fatalf("embedded error returned result=%#v stream=%#v", result, stream)
	}
}

func TestRelayImageEditJSONResponseUsesEditCompletedEvent(t *testing.T) {
	stream := relayImageJSONResultStream(map[string]any{
		"created": 1710000000,
		"data":    []map[string]any{{"url": "https://image.example/edit.png"}},
	}, "/v1/images/edits")
	item, ok := <-stream.Items
	if !ok {
		t.Fatal("converted edit stream closed before its completed event")
	}
	if item["type"] != "image_edit.completed" || item["created_at"] != 1710000000 {
		t.Fatalf("converted edit event = %#v", item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("converted edit stream error = %v", err)
	}
}

func TestRelayErrorMessageSupportsNewAPIShapes(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "OpenAI object", body: `{"error":{"message":"blocked by upstream"}}`, want: "blocked by upstream"},
		{name: "string error", body: `{"error":"provider unavailable"}`, want: "provider unavailable"},
		{name: "detail object", body: `{"detail":{"message":"invalid image"}}`, want: "invalid image"},
		{name: "top-level message", body: `{"message":"quota exhausted"}`, want: "quota exhausted"},
		{name: "detail list", body: `{"detail":[{"message":"field is required"}]}`, want: "field is required"},
		{name: "SSE error", body: "event: error\ndata: {\"error\":{\"message\":\"stream rejected\"}}\n\n", want: "stream rejected"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := relayErrorMessage([]byte(test.body), "fallback"); got != test.want {
				t.Fatalf("relayErrorMessage() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRelayStreamResultRecognizesTypedUpstreamErrorMessage(t *testing.T) {
	stream := relayStreamResult(io.NopCloser(strings.NewReader(
		"event: upstream_error\n" +
			`data: {"type":"upstream_error","message":"provider stream failed"}` + "\n\n",
	)))
	if item, ok := <-stream.Items; ok {
		t.Fatalf("typed upstream error was emitted as data: %#v", item)
	}
	err := <-stream.Err
	if err == nil || !strings.Contains(err.Error(), "provider stream failed") {
		t.Fatalf("typed upstream stream error = %v", err)
	}
}

func TestGoogleGeminiImagePayloadBuildsNewAPIChatRequest(t *testing.T) {
	body, err := googleGeminiImagePayload(map[string]any{
		"model":            "gemini-3.1-flash-image",
		"prompt":           "edit this image",
		"size":             "1536x864",
		"image_resolution": "2k",
		"stream":           true,
		"partial_images":   2,
	}, []protocol.UploadedImage{{Data: []byte("image-bytes"), ContentType: "image/png"}})
	if err != nil {
		t.Fatalf("googleGeminiImagePayload() error = %v", err)
	}
	if body["model"] != "gemini-3.1-flash-image" {
		t.Fatalf("model = %#v", body["model"])
	}
	messages := util.AsMapSlice(body["messages"])
	if len(messages) != 1 {
		t.Fatalf("messages = %#v", body["messages"])
	}
	content, ok := messages[0]["content"].([]map[string]any)
	if !ok || len(content) != 2 || content[1]["type"] != "image_url" {
		t.Fatalf("Gemini image content = %#v", messages[0]["content"])
	}
	extraBody := util.StringMap(body["extra_body"])
	google := util.StringMap(extraBody["google"])
	imageConfig := util.StringMap(google["image_config"])
	if imageConfig["aspect_ratio"] != "16:9" || imageConfig["image_size"] != "2K" {
		t.Fatalf("Gemini image config = %#v", imageConfig)
	}
	for _, key := range []string{"stream", "partial_images", "output_format"} {
		if _, ok := body[key]; ok {
			t.Fatalf("Gemini chat body retained image-route field %s: %#v", key, body)
		}
	}
}

func TestGoogleGeminiImageSizePrefersExplicitResolution(t *testing.T) {
	payload := map[string]any{
		"image_resolution": "2k",
		"quality":          "high",
	}
	if got := googleGeminiImageSize("gemini-3.1-flash-image", payload); got != "2K" {
		t.Fatalf("googleGeminiImageSize() = %q, want explicit 2K resolution", got)
	}
}

func TestGoogleGeminiImageSizeIgnoresQuality(t *testing.T) {
	payload := map[string]any{"quality": "high"}
	if got := googleGeminiImageSize("gemini-3.1-flash-image", payload); got != "" {
		t.Fatalf("googleGeminiImageSize() = %q, want quality to be ignored", got)
	}
}

func TestGoogleGeminiFlashLiteImageSizeStaysAt1K(t *testing.T) {
	payload := map[string]any{"image_resolution": "4k"}
	if got := googleGeminiImageSize("gemini-3.1-flash-lite-image", payload); got != "1K" {
		t.Fatalf("googleGeminiImageSize() = %q, want 1K", got)
	}
}

func TestGoogleGeminiImageSizeLimits512ToFlash31(t *testing.T) {
	payload := map[string]any{"size": "512x512"}
	if got := googleGeminiImageSize("gemini-3.1-flash-image", payload); got != "512" {
		t.Fatalf("Gemini 3.1 Flash image size = %q, want 512", got)
	}
	if got := googleGeminiImageSize("gemini-3-pro-image", payload); got != "1K" {
		t.Fatalf("Gemini 3 Pro image size = %q, want 1K", got)
	}
}

func TestGoogleGeminiImageSizeUsesPixelAreaForOfficialPanoramicDimensions(t *testing.T) {
	tests := []struct {
		name  string
		model string
		size  string
		want  string
	}{
		{name: "1K 1:8", model: "gemini-3.1-flash-image", size: "384x3072", want: "1K"},
		{name: "1K 1:4", model: "gemini-3.1-flash-image", size: "512x2048", want: "1K"},
		{name: "1K 21:9", model: "gemini-3.1-flash-image", size: "1584x672", want: "1K"},
		{name: "2K 21:9", model: "gemini-3.1-flash-image", size: "3168x1344", want: "2K"},
		{name: "Pro 1K 21:9", model: "gemini-3-pro-image", size: "1584x672", want: "1K"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := googleGeminiImageSize(test.model, map[string]any{"size": test.size}); got != test.want {
				t.Fatalf("googleGeminiImageSize(%q, %q) = %q, want %q", test.model, test.size, got, test.want)
			}
		})
	}
}

func TestNormalizeImagePayloadForModelDropsUnforwardedProviderMetadata(t *testing.T) {
	tests := []struct {
		name     string
		model    string
		retained []string
		dropped  []string
		response any
	}{
		{
			name:     "Gemini keeps image configuration and internal conversation data",
			model:    "GEMINI-3.1-FLASH-IMAGE",
			retained: []string{"size", "image_resolution", "requested_size", "messages", "token_name"},
			dropped:  []string{"quality", "background", "moderation", "stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"},
		},
		{
			name:     "Grok maps application settings to official xAI fields",
			model:    "GROK-IMAGINE-IMAGE-2.0",
			retained: []string{"size", "image_resolution", "requested_size", "messages", "token_name", "response_format", "aspect_ratio", "resolution"},
			dropped: []string{
				"background", "moderation",
				"stream", "partial_images", "output_format", "output_compression", "input_image_mask",
				"image_format", "storage_options", "user",
			},
			response: "b64_json",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{
				"model": test.model, "size": "1024x1024", "image_resolution": "2k", "requested_size": "1024x1024",
				"quality": "medium", "background": "opaque", "moderation": "low", "stream": true,
				"partial_images": 2, "output_format": "webp", "output_compression": 80,
				"response_format": "B64_JSON", "input_image_mask": "mask", "messages": []any{"history"},
				"token_name": "current-user-key", "aspect_ratio": "16:9", "resolution": "2k",
				"image_format": "png", "storage_options": map[string]any{"ttl": 3600}, "user": "user-1",
			}
			normalizeImagePayloadForModel(payload)
			for _, key := range test.retained {
				if _, ok := payload[key]; !ok {
					t.Errorf("payload dropped %s: %#v", key, payload)
				}
			}
			for _, key := range test.dropped {
				if _, ok := payload[key]; ok {
					t.Errorf("payload retained %s: %#v", key, payload)
				}
			}
			if test.response != nil && payload["response_format"] != test.response {
				t.Errorf("response_format = %#v, want %#v", payload["response_format"], test.response)
			}
			if test.name == "Grok maps application settings to official xAI fields" {
				if payload["aspect_ratio"] != "16:9" || payload["resolution"] != "2k" || payload["quality"] != "medium" {
					t.Errorf("Grok official parameters = %#v", payload)
				}
			}
		})
	}
}

func TestGoogleGeminiAspectRatioUsesModelSpecificOfficialSet(t *testing.T) {
	if got := googleGeminiAspectRatio("gemini-3.1-flash-image", "1:8"); got != "1:8" {
		t.Fatalf("Gemini 3.1 Flash aspect ratio = %q, want 1:8", got)
	}
	if got := googleGeminiAspectRatio("gemini-3.1-flash-lite-image", "1:8"); got == "1:8" {
		t.Fatalf("Gemini Flash Lite retained unsupported extreme ratio %q", got)
	}
	if got := googleGeminiAspectRatio("gemini-3.1-flash-lite-image", "4:5"); got != "4:5" {
		t.Fatalf("Gemini Flash Lite standard aspect ratio = %q, want 4:5", got)
	}
	if got := googleGeminiAspectRatio("gemini-3-pro-image", "4:1"); got == "4:1" {
		t.Fatalf("Gemini Pro retained unsupported extreme ratio %q", got)
	}
}

func TestGoogleGeminiImageItemsExtractsInlineImages(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	items, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{
			"message": map[string]any{"content": "![image](data:image/webp;base64," + encoded + ")"},
		}},
	}, "draw")
	if err != nil {
		t.Fatalf("googleGeminiImageItems() error = %v", err)
	}
	if len(items) != 1 || items[0]["b64_json"] != encoded || items[0]["output_format"] != "webp" {
		t.Fatalf("Gemini image items = %#v", items)
	}
}

func TestGoogleGeminiImageItemsPreservesEmbeddedUpstreamError(t *testing.T) {
	_, err := googleGeminiImageItems(map[string]any{
		"error": map[string]any{"message": "Gemini quota exhausted"},
	}, "draw")
	if err == nil || !strings.Contains(err.Error(), "Gemini quota exhausted") {
		t.Fatalf("googleGeminiImageItems() error = %v, want embedded upstream message", err)
	}
}

func TestGoogleGeminiImageItemsReportsBlockedResponse(t *testing.T) {
	_, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{
			"finish_reason": "SAFETY",
			"message":       map[string]any{"role": "assistant", "content": ""},
		}},
		"prompt_feedback": map[string]any{"block_reason": "PROHIBITED_CONTENT"},
	}, "draw")
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadGateway {
		t.Fatalf("blocked Gemini response error = %T %v, want HTTP 502", err, err)
	}
	if !strings.Contains(httpErr.Message, "SAFETY") || !strings.Contains(httpErr.Message, "PROHIBITED_CONTENT") {
		t.Fatalf("blocked Gemini response message = %q", httpErr.Message)
	}
}

func TestValidProtocolImageCountUsesModelLimit(t *testing.T) {
	for _, value := range []any{nil, 1, float64(10), "2"} {
		if !validProtocolImageCount(value, "gpt-image-2") {
			t.Errorf("validProtocolImageCount(%#v, gpt-image-2) = false, want true", value)
		}
	}
	for _, value := range []any{0, 11, 1.5, "invalid"} {
		if validProtocolImageCount(value, "gpt-image-2") {
			t.Errorf("validProtocolImageCount(%#v, gpt-image-2) = true, want false", value)
		}
	}
	if validProtocolImageCount(5, "gemini-3.1-flash-image") {
		t.Fatal("Gemini image request accepted more than the application limit")
	}
}

func TestRelayImageGenerationsUsesChatCompletionsForGemini(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path = %q, want /v1/chat/completions", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode Gemini request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["model"] != "gemini-3.1-flash-image" || len(util.AsMapSlice(body["messages"])) == 0 {
			t.Errorf("Gemini request body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"gemini-3.1-flash-image","choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "draw",
		"n":       2,
	})
	if err != nil {
		t.Fatalf("relayImageGenerations() error = %v", err)
	}
	if stream != nil {
		t.Fatal("Gemini image route returned an unexpected image SSE stream")
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 2 || data[0]["b64_json"] != encoded || data[1]["b64_json"] != encoded {
		t.Fatalf("Gemini relay result = %#v", result)
	}
	if requestCount.Load() != 2 {
		t.Fatalf("Gemini request count = %d, want 2", requestCount.Load())
	}
}

func TestRelayGoogleGeminiBatchFailurePreservesSuccessfulSiblingsBeforeReleasingSlot(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("successful-image"))
	var requestCount atomic.Int32
	secondStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch requestCount.Add(1) {
		case 1:
			<-secondStarted
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"message":"Gemini upstream failed"}}`))
		case 2:
			close(secondStarted)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"model":"gemini-3.1-flash-image","choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
		default:
			t.Errorf("unexpected Gemini request count: %d", requestCount.Load())
		}
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	released := make(chan struct{})
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "draw",
		"n":       2,
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			return func() { close(released) }, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "Gemini upstream failed") {
		t.Fatalf("relayImageGenerations() error = %v, want upstream failure", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["b64_json"] != encoded || stream != nil {
		t.Fatalf("partial Gemini batch result = %#v, stream = %#v", result, stream)
	}
	if requestCount.Load() != 2 {
		t.Fatalf("Gemini request count = %d, want 2", requestCount.Load())
	}
	select {
	case <-released:
	default:
		t.Fatal("Gemini batch slot was not released after all requests exited")
	}
}

func TestRelayImageEditsSendsFourteenGeminiReferencesThroughNewAPIChat(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("edited-image"))
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path = %q, want /v1/chat/completions", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode Gemini edit request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		messages := util.AsMapSlice(body["messages"])
		if len(messages) != 1 {
			t.Errorf("Gemini edit messages = %#v", body["messages"])
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		content := util.AsMapSlice(messages[0]["content"])
		imageCount := 0
		for _, part := range content {
			if part["type"] == "image_url" {
				imageCount++
			}
		}
		if imageCount != 14 {
			t.Errorf("Gemini edit image parts = %d, want 14 in %#v", imageCount, content)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	images := make([]protocol.UploadedImage, 14)
	for index := range images {
		images[index] = protocol.UploadedImage{
			Filename:    fmt.Sprintf("reference-%02d.png", index+1),
			ContentType: "image/png",
			Data:        []byte(fmt.Sprintf("image-%02d", index+1)),
		}
	}
	result, stream, err := app.relayImageEdits(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "combine these references",
		"n":       1,
	}, images)
	if err != nil {
		t.Fatalf("relayImageEdits() error = %v", err)
	}
	if stream != nil {
		t.Fatal("Gemini edit route returned an unexpected stream")
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["b64_json"] != encoded {
		t.Fatalf("Gemini edit relay result = %#v", result)
	}
	if requestCount.Load() != 1 {
		t.Fatalf("Gemini edit request count = %d, want 1", requestCount.Load())
	}
}

func TestRelayImageEditsRejectsProviderModelsWithoutEditSupport(t *testing.T) {
	model := "grok-imagine-image-2.0"
	_, _, err := (&App{}).relayImageEdits(context.Background(), map[string]any{
		"model":  model,
		"prompt": "edit",
	}, []protocol.UploadedImage{{Data: []byte("image")}})
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
		t.Fatalf("relayImageEdits(%q) error = %T %v, want 400", model, err, err)
	}
}

func TestValidateRelayImageReferenceCountUsesModelCapabilities(t *testing.T) {
	tests := []struct {
		name    string
		model   string
		count   int
		wantErr bool
	}{
		{name: "Gemini accepts fourteen", model: "gemini-3.1-flash-image", count: 14},
		{name: "Gemini rejects fifteen", model: "gemini-3.1-flash-image", count: 15, wantErr: true},
		{name: "OpenAI accepts ten", model: "gpt-image-2", count: 10},
		{name: "OpenAI rejects eleven", model: "gpt-image-2", count: 11, wantErr: true},
		{name: "NewAPI legacy Grok rejects references", model: "grok-2-image-1212", count: 1, wantErr: true},
		{name: "NewAPI built-in Grok rejects references", model: "grok-imagine-image", count: 1, wantErr: true},
		{name: "Grok rejects references through NewAPI", model: "grok-imagine-image-2.0", count: 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRelayImageReferenceCount(test.model, test.count)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateRelayImageReferenceCount(%q, %d) error = %v, wantErr %v", test.model, test.count, err, test.wantErr)
			}
			if err != nil {
				var httpErr protocol.HTTPError
				if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
					t.Fatalf("validation error = %T %v, want HTTP 400", err, err)
				}
			}
		})
	}
}

func TestRelayImageGenerationsReturnsNewAPIColonParseErrorWithoutRetry(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request %d: %v", requestCount, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["stream"] != true || body["partial_images"] != float64(2) {
			t.Errorf("request body = %#v, want stream with partial images", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid character ':' looking for beginning of value (request id: 202607300220530891561808268d9d6K2BvRB98)"}}`))
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
	if err == nil || !strings.Contains(err.Error(), "invalid character ':' looking for beginning of value") {
		t.Fatalf("relayImageGenerations() error = %v, want original upstream error", err)
	}
	if stream != nil {
		t.Fatal("failed request returned an unexpected stream")
	}
	if result != nil {
		t.Fatalf("failed request result = %#v, want nil", result)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want 1", requestCount)
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

func TestRelayMultipartRequestForwardsMaskAsFile(t *testing.T) {
	maskData := httpTestAlphaPNGBytes(t, 12, 12)
	req, err := relayMultipartRequest(
		context.Background(),
		"https://relay.example",
		"/v1/images/edits",
		"sk-test",
		map[string]any{
			"prompt":           "edit",
			"input_image_mask": "data:image/png;base64," + base64.StdEncoding.EncodeToString(maskData),
		},
		[]protocol.UploadedImage{{Filename: "source.png", ContentType: "image/png", Data: httpTestPNGBytes(t)}},
	)
	if err != nil {
		t.Fatalf("relayMultipartRequest() error = %v", err)
	}
	reader, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader() error = %v", err)
	}
	foundMask := false
	for {
		part, nextErr := reader.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			t.Fatalf("NextPart() error = %v", nextErr)
		}
		if part.FormName() == "input_image_mask" {
			t.Fatal("legacy input_image_mask field was forwarded upstream")
		}
		if part.FormName() != "mask" {
			continue
		}
		foundMask = true
		if part.FileName() != "mask.png" || part.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("mask headers = filename %q content-type %q", part.FileName(), part.Header.Get("Content-Type"))
		}
		got, readErr := io.ReadAll(part)
		if readErr != nil {
			t.Fatalf("read mask: %v", readErr)
		}
		if !bytes.Equal(got, maskData) {
			t.Fatal("forwarded mask bytes differ from request")
		}
	}
	if !foundMask {
		t.Fatal("multipart mask file was not forwarded")
	}
}

func TestValidateRelayImageMaskUsesOfficialEditConstraints(t *testing.T) {
	images := []protocol.UploadedImage{{Filename: "source.png", ContentType: "image/png", Data: httpTestPNGBytes(t)}}
	mask := "data:image/png;base64," + base64.StdEncoding.EncodeToString(httpTestAlphaPNGBytes(t, 12, 12))

	payload := map[string]any{"input_image_mask": mask}
	if err := validateRelayImageMask("/v1/images/edits", "gpt-image-2", payload, images); err != nil {
		t.Fatalf("valid GPT Image mask error = %v", err)
	}
	if !strings.HasPrefix(util.Clean(payload["input_image_mask"]), "data:image/png;base64,") {
		t.Fatalf("normalized mask = %#v", payload["input_image_mask"])
	}

	tests := []struct {
		name   string
		path   string
		model  string
		images []protocol.UploadedImage
		mask   string
		want   string
	}{
		{name: "generation route", path: "/v1/images/generations", model: "gpt-image-2", mask: mask, want: "only supported"},
		{name: "Gemini route", path: "/v1/images/edits", model: "gemini-3.1-flash-image", images: images, mask: mask, want: "does not support mask"},
		{name: "Grok route", path: "/v1/images/edits", model: "grok-imagine-image", images: images, mask: mask, want: "does not support mask"},
		{name: "dimension mismatch", path: "/v1/images/edits", model: "gpt-image-2", images: images, mask: "data:image/png;base64," + base64.StdEncoding.EncodeToString(httpTestAlphaPNGBytes(t, 4, 4)), want: "same dimensions"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRelayImageMask(test.path, test.model, map[string]any{"input_image_mask": test.mask}, test.images)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validateRelayImageMask() error = %v, want %q", err, test.want)
			}
			var httpErr protocol.HTTPError
			if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
				t.Fatalf("validation error = %T %v, want HTTP 400", err, err)
			}
		})
	}
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
