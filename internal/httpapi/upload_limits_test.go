package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadLimitedUploadDataRejectsOversizedInput(t *testing.T) {
	data, err := readLimitedUploadData(strings.NewReader("12345"), 4)
	if !errors.Is(err, errRelayImageTooLarge) || data != nil {
		t.Fatalf("readLimitedUploadData() data=%q error=%v", data, err)
	}
}

func TestUploadedImageContentTypeUsesDecodedFormat(t *testing.T) {
	var imageData bytes.Buffer
	if err := encodeHTTPTestPNG(&imageData); err != nil {
		t.Fatalf("encodeHTTPTestPNG() error = %v", err)
	}
	contentType, err := uploadedImageContentType(imageData.Bytes())
	if err != nil || contentType != "image/png" {
		t.Fatalf("uploadedImageContentType() = %q, %v", contentType, err)
	}
	if _, err := uploadedImageContentType([]byte("not an image")); !errors.Is(err, errUnsupportedRelayImage) {
		t.Fatalf("invalid uploadedImageContentType() error = %v", err)
	}
}

func TestReadMultipartImageBodyDoesNotApplyAProviderReferenceLimit(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for index := 0; index < 15; index++ {
		part, err := writer.CreateFormFile("image[]", "reference.png")
		if err != nil {
			t.Fatalf("CreateFormFile() error = %v", err)
		}
		if err := encodeHTTPTestPNG(part); err != nil {
			t.Fatalf("encodeHTTPTestPNG() error = %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	_, images, err := readMultipartImageBody(res, req)
	if err != nil || len(images) != 15 {
		t.Fatalf("readMultipartImageBody() images=%#v error=%v", images, err)
	}
}

func TestReadMultipartImageBodyUsesConfiguredDefaultWhenModelIsMissing(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("prompt", "edit this image"); err != nil {
		t.Fatalf("WriteField(prompt) error = %v", err)
	}
	part, err := writer.CreateFormFile("image", "source.png")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatalf("encodeHTTPTestPNG() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	parsed, images, err := readMultipartImageBody(res, req)
	if err != nil {
		t.Fatalf("readMultipartImageBody() error = %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("readMultipartImageBody() images = %d, want 1", len(images))
	}
	if model, _ := parsed["model"].(string); model != "" {
		t.Fatalf("parsed model = %q, want empty before configured default is applied", model)
	}

	app := newTestApp(t)
	defer app.Close()
	if model := app.applyDefaultImageModel(parsed); model != app.defaultImageModel() {
		t.Fatalf("default model = %q, want %q", model, app.defaultImageModel())
	}
	if _, err := app.config.Update(map[string]any{"image_models": []any{"auto", "codex-gpt-image-2"}}); err != nil {
		t.Fatalf("Update(image_models) error = %v", err)
	}
	parsed["model"] = "auto"
	if model := app.applyDefaultImageModel(parsed); model != "codex-gpt-image-2" {
		t.Fatalf("auto model fallback = %q, want codex-gpt-image-2", model)
	}
	if model := app.modelConfig()["default_image_model"]; model != "codex-gpt-image-2" {
		t.Fatalf("model config default = %#v, want codex-gpt-image-2", model)
	}
}

func TestReadMultipartImageBodyAcceptsOfficialMaskFile(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("prompt", "edit the selected area"); err != nil {
		t.Fatalf("WriteField(prompt) error = %v", err)
	}
	if err := writer.WriteField("model", "gpt-image-2"); err != nil {
		t.Fatalf("WriteField(model) error = %v", err)
	}
	imagePart, err := writer.CreateFormFile("image", "source.png")
	if err != nil {
		t.Fatalf("CreateFormFile(image) error = %v", err)
	}
	if _, err := imagePart.Write(httpTestPNGBytes(t)); err != nil {
		t.Fatalf("write image: %v", err)
	}
	maskPart, err := writer.CreateFormFile("mask", "mask.png")
	if err != nil {
		t.Fatalf("CreateFormFile(mask) error = %v", err)
	}
	if _, err := maskPart.Write(httpTestAlphaPNGBytes(t, 12, 12)); err != nil {
		t.Fatalf("write mask: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	parsed, images, err := readMultipartImageBody(res, req)
	if err != nil {
		t.Fatalf("readMultipartImageBody() error = %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("images = %d, want 1", len(images))
	}
	if err := validateRelayImageMask("/v1/images/edits", "gpt-image-2", parsed, images); err != nil {
		t.Fatalf("validateRelayImageMask() error = %v", err)
	}
	if !strings.HasPrefix(parsed["input_image_mask"].(string), "data:image/png;base64,") {
		t.Fatalf("normalized mask = %#v", parsed["input_image_mask"])
	}
}

func TestReadMultipartImageBodyRejectsMultipleMaskFiles(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for index := 0; index < 2; index++ {
		part, err := writer.CreateFormFile("mask", "mask.png")
		if err != nil {
			t.Fatalf("CreateFormFile(mask) error = %v", err)
		}
		if _, err := part.Write([]byte("not read after count validation")); err != nil {
			t.Fatalf("write mask: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	_, _, err := readMultipartImageBody(res, req)
	if !errors.Is(err, errTooManyRelayMasks) {
		t.Fatalf("multiple mask error = %v", err)
	}
}

func TestLoginRejectsOversizedJSONBody(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	body := io.MultiReader(
		strings.NewReader(`{"username":"`),
		io.LimitReader(repeatingByteReader('a'), maxLoginRequestBodyBytes),
		strings.NewReader(`","password":"x"}`),
	)
	req := httptest.NewRequest(http.MethodPost, "/auth/login", body)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized login status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestAPIRouterRejectsDeclaredBodyAboveGlobalLimit(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{}`))
	req.ContentLength = maxAPIRequestBodyBytes + 1
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("global body limit status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestImageUploadSlotsBoundConcurrentHeavyReads(t *testing.T) {
	app := &App{imageUploadSlots: make(chan struct{}, 1)}
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	canceledRelease, canceledAcquired := app.acquireImageUpload(canceledCtx)
	if canceledAcquired || canceledRelease != nil || len(app.imageUploadSlots) != 0 {
		t.Fatal("canceled upload acquired an available slot")
	}

	release, acquired := app.acquireImageUpload(context.Background())
	if !acquired {
		t.Fatal("first upload did not acquire the slot")
	}
	defer release()

	secondCtx, secondCancel := context.WithCancel(context.Background())
	secondCancel()
	secondRelease, secondAcquired := app.acquireImageUpload(secondCtx)
	if secondAcquired || secondRelease != nil {
		t.Fatal("canceled second upload acquired the full slot")
	}
}
