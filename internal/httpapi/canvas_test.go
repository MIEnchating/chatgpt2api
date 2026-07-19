package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestCanvasImageUploadStoresPrivateGalleryImage(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "reference.png")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatalf("encode upload png: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/canvas/images", body)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body = %s", res.Code, res.Body.String())
	}

	var payload struct {
		URL         string `json:"url"`
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("upload json: %v", err)
	}
	if payload.URL == "" || payload.Name != "reference.png" || payload.ContentType != "image/png" {
		t.Fatalf("upload payload = %#v", payload)
	}

	parsed, err := url.Parse(payload.URL)
	if err != nil {
		t.Fatalf("parse image url: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, parsed.Path, nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.Len() == 0 {
		t.Fatalf("stored image status = %d bytes = %d", res.Code, res.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=mine", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("gallery status = %d body = %s", res.Code, res.Body.String())
	}
	var gallery struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &gallery); err != nil {
		t.Fatalf("gallery json: %v", err)
	}
	if len(gallery.Items) != 1 || gallery.Items[0]["visibility"] != "private" {
		t.Fatalf("gallery items = %#v", gallery.Items)
	}
}
