package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
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
