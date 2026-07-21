package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"chatgpt2api/internal/service"
)

func TestCanvasClearRequiresExplicitProjectID(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminAuthHeader(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	req.Header.Set("Authorization", authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas", nil)
	req.Header.Set("Authorization", authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("missing project id status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas?project_id="+url.QueryEscape(workspace.Document.ID), nil)
	req.Header.Set("Authorization", authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("clear status = %d body = %s", res.Code, res.Body.String())
	}
	var payload struct {
		Document service.CanvasDocument `json:"document"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("clear json: %v", err)
	}
	if payload.Document.ID != workspace.Document.ID {
		t.Fatalf("cleared project id = %q, want %q", payload.Document.ID, workspace.Document.ID)
	}
}

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
