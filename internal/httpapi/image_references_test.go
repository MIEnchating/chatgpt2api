package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestImageReferenceManifestPreservesMixedOrderInBothAPIs(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range map[string]string{
		"api_mode": "responses", "prompt": "combine", "model": "test-image",
		"image_references": `[{"url":"https://images.example.com/a.png"},{"upload_index":0},{"url":"https://images.example.com/c.png"}]`,
	} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("image", "b.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(httpTestPNGBytes(t)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/creation-tasks/image-edits", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	payload, images, err := readMultipartImageBody(httptest.NewRecorder(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 3 || images[0].URL != "https://images.example.com/a.png" || len(images[1].Data) == 0 || images[2].URL != "https://images.example.com/c.png" {
		t.Fatalf("lost reference order: %#v", images)
	}
	for _, request := range []map[string]any{imageResponsesRequest(payload, images, true), imageChatRequest(payload, images)} {
		encoded, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		text := string(encoded)
		a, b, c := strings.Index(text, images[0].URL), strings.Index(text, "data:image/png;base64,"), strings.Index(text, images[2].URL)
		if a < 0 || b <= a || c <= b {
			t.Fatalf("request lost mixed reference order: %s", text)
		}
	}
}

func TestImageReferenceManifestRejectsInvalidStructureAndUploads(t *testing.T) {
	for _, raw := range []string{
		`null`, `[]`, `{}`, `[{"url":"https://cdn.example.com/a"}] {}`,
		`[{"url":"https://cdn.example.com/a","upload_index":0}]`,
		`[{"upload_index":0.5}]`, `[{"upload_index":-1}]`, `[{"upload_index":1}]`,
		`[{"upload_index":0},{"upload_index":0}]`, `[{"unknown":"a"}]`,
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := orderedImageReferences(raw, []protocol.UploadedImage{{Data: []byte("png")}}, map[string]any{"api_mode": "responses"}, "app.example.com"); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
	for _, payload := range []map[string]any{{"api_mode": "images"}, {"api_mode": "chat", "input_image_mask": "mask"}} {
		if _, err := orderedImageReferences(`[{"url":"https://cdn.example.com/a.png"}]`, nil, payload, "app.example.com"); err == nil {
			t.Fatal("unsupported URL mode accepted")
		}
	}
	_, err := orderedImageReferences(`[{"url":"https://cdn.example.com/a.png"}]`, []protocol.UploadedImage{{Data: []byte("png")}}, map[string]any{"api_mode": "responses"}, "app.example.com")
	if err == nil || !strings.Contains(err.Error(), "must include every uploaded image") {
		t.Fatalf("unused upload was not rejected: %v", err)
	}
}

func TestImageReferenceManifestRejectsUnsafeURLsWithoutUnusedUploads(t *testing.T) {
	for _, value := range []string{
		"http://127.0.0.1/a", "http://10.0.0.1/a", "http://127.1/a", "http://0177.0.0.1/a", "http://0x7f.0.0.1/a",
		"http://127.0.0.0x1/a", "http://2130706433/a", "http://0x7f000001/a", "http://１２７.０.０.１/a", "http://127。0。0。1/a",
		"http://[::1]/a", "http://[::ffff:127.0.0.1]/a", "https://user:secret@cdn.example.com/a",
		"https://app.example.com/api/files/one/content", "https://app.example.com/image.png",
		"https://other.example.com/api/files/one/content", "data:image/png;base64,YQ==",
	} {
		t.Run(value, func(t *testing.T) {
			encoded, err := json.Marshal([]map[string]string{{"url": value}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = orderedImageReferences(string(encoded), nil, map[string]any{"api_mode": "responses"}, "app.example.com")
			if err == nil || !strings.Contains(err.Error(), "public external HTTP(S)") {
				t.Fatalf("URL boundary did not reject %q: %v", value, err)
			}
		})
	}
}

func TestImageReferenceManifestAcceptsRemoteOnlyURLsInBothModes(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		images, err := orderedImageReferences(`[{"url":"https://cdn.example.com/a.png"},{"url":"https://cdn.example.com/b.png"}]`, nil, map[string]any{"api_mode": mode}, "app.example.com")
		if err != nil {
			t.Fatal(err)
		}
		if len(images) != 2 || images[0].URL != "https://cdn.example.com/a.png" || images[1].URL != "https://cdn.example.com/b.png" {
			t.Fatalf("remote order changed: %#v", images)
		}
	}
}
