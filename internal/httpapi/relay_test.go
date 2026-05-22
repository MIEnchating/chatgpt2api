package httpapi

import (
	"context"
	"io"
	"strings"
	"testing"

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
