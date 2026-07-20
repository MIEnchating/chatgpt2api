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

func TestReadMultipartImageBodyRejectsMoreThanFourImages(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for index := 0; index < maxRelayInputImages+1; index++ {
		part, err := writer.CreateFormFile("image[]", "reference.png")
		if err != nil {
			t.Fatalf("CreateFormFile() error = %v", err)
		}
		if _, err := part.Write([]byte("not read after count validation")); err != nil {
			t.Fatalf("write multipart file: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	_, images, err := readMultipartImageBody(res, req)
	if !errors.Is(err, errTooManyRelayImages) || images != nil {
		t.Fatalf("readMultipartImageBody() images=%#v error=%v", images, err)
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
	release, acquired := app.acquireImageUpload(context.Background())
	if !acquired {
		t.Fatal("first upload did not acquire the slot")
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	secondRelease, secondAcquired := app.acquireImageUpload(ctx)
	if secondAcquired || secondRelease != nil {
		t.Fatal("canceled second upload acquired the full slot")
	}
}
