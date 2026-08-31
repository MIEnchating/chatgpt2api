package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

func TestCanvasClearRequiresExplicitProjectID(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
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
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("missing project id status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas?project_id="+url.QueryEscape(workspace.Document.ID)+"&revision="+strconv.FormatInt(workspace.Document.Revision, 10), nil)
	setRequestAuthCookie(req, authorization)
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

func TestCanvasClearRejectsStaleRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	updated := workspace.Document
	updated.Title = "更新后的画布"
	data, err := json.Marshal(updated)
	if err != nil {
		t.Fatalf("Marshal(canvas) error = %v", err)
	}
	req = httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(data))
	setRequestAuthCookie(req, authorization)
	req.Header.Set("Content-Type", "application/json")
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("save status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/canvas?project_id="+url.QueryEscape(workspace.Document.ID)+"&revision="+strconv.FormatInt(workspace.Document.Revision, 10), nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale clear status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestCanvasSaveRejectsStaleRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)

	req := httptest.NewRequest(http.MethodGet, "/api/canvas", nil)
	setRequestAuthCookie(req, authorization)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("workspace status = %d body = %s", res.Code, res.Body.String())
	}
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("workspace json: %v", err)
	}

	save := func(document service.CanvasDocument) *httptest.ResponseRecorder {
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatalf("Marshal(canvas) error = %v", err)
		}
		req := httptest.NewRequest(http.MethodPut, "/api/canvas", bytes.NewReader(data))
		setRequestAuthCookie(req, authorization)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	first := workspace.Document
	first.Title = "第一台设备"
	res = save(first)
	if res.Code != http.StatusOK {
		t.Fatalf("first save status = %d body = %s", res.Code, res.Body.String())
	}
	stale := workspace.Document
	stale.Title = "第二台设备"
	res = save(stale)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale save status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestDefaultUserCanvasImageUploadStoresPrivateGalleryImage(t *testing.T) {
	const imageBaseURL = "https://assets.example.test"

	t.Setenv("IMAGE_BASE_URL", imageBaseURL)
	app := newTestApp(t)
	defer app.Close()
	_, rawKey, err := createTestUserSession(app, "canvas-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	authorization := "Bearer " + rawKey

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
	setRequestAuthCookie(req, authorization)
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
	if !strings.HasPrefix(payload.URL, imageBaseURL+"/images/") || payload.Name != "reference.png" || payload.ContentType != "image/png" {
		t.Fatalf("upload payload = %#v", payload)
	}

	parsed, err := url.Parse(payload.URL)
	if err != nil {
		t.Fatalf("parse image url: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, parsed.Path, nil)
	setRequestAuthCookie(req, authorization)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.Len() == 0 {
		t.Fatalf("stored image status = %d bytes = %d", res.Code, res.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=mine", nil)
	setRequestAuthCookie(req, authorization)
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

func TestCanceledCanvasImageUploadDoesNotCreateImageOrThumbnail(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	authorization := adminSessionToken(t, app)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "canceled.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/canvas/images", body)
	setRequestAuthCookie(request, authorization)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request.WithContext(ctx))
	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("upload status = %d, want %d; body = %s", response.Code, http.StatusRequestTimeout, response.Body.String())
	}
	items, err := app.images.ListImages("", "", "", service.ImageAccessScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(items["items"].([]map[string]any)); got != 0 {
		t.Fatalf("canceled upload created %d images", got)
	}
	thumbnailEntries, err := os.ReadDir(app.config.ImageThumbnailsDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(thumbnailEntries) != 0 {
		t.Fatalf("canceled upload created thumbnails: %#v", thumbnailEntries)
	}
}
