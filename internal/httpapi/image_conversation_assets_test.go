package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestImageConversationAssetsUploadAndPrivateAccess(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner, ownerToken := createPasswordUserSession(t, app, "asset-owner", "", "Alice")
	_, otherToken := createPasswordUserSession(t, app, "asset-other", "", "Bob")

	payload := uploadHTTPTestConversationAssets(t, app, ownerToken, 1, true)
	if len(payload.Items) != 1 {
		t.Fatalf("upload items = %#v", payload.Items)
	}
	asset := payload.Items[0]
	if asset.AssetPath == "" || !strings.HasPrefix(asset.URL, service.ImageConversationAssetURLPrefix) || asset.DataURL != asset.URL || asset.Type != "image/png" || asset.Size < 1 {
		t.Fatalf("uploaded asset = %#v", asset)
	}
	if strings.Contains(asset.AssetPath, owner.ID) {
		t.Fatalf("asset path exposes owner ID: %q", asset.AssetPath)
	}

	req := httptest.NewRequest(http.MethodGet, asset.URL, nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous asset status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	setRequestAuthCookie(req, "Bearer "+otherToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other owner asset status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	setRequestAuthCookie(req, "Bearer "+ownerToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.Len() == 0 || res.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("owner asset status = %d headers = %#v bytes = %d", res.Code, res.Header(), res.Body.Len())
	}
	etag := res.Header().Get("ETag")
	if !strings.Contains(etag, "sha256-") || res.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("asset cache headers = %#v", res.Header())
	}
	vary := strings.Join(res.Header().Values("Vary"), ",")
	if strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
		t.Fatalf("asset Vary header = %q", vary)
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	setRequestAuthCookie(req, "Bearer "+ownerToken)
	req.Header.Set("If-None-Match", etag)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotModified || res.Body.Len() != 0 {
		t.Fatalf("conditional asset status = %d bytes = %d", res.Code, res.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin asset status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=mine", nil)
	setRequestAuthCookie(req, "Bearer "+ownerToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner gallery status = %d body = %s", res.Code, res.Body.String())
	}
	var gallery struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &gallery); err != nil || len(gallery.Items) != 0 {
		t.Fatalf("conversation asset leaked into gallery: items=%#v error=%v", gallery.Items, err)
	}

	second := uploadHTTPTestConversationAssets(t, app, ownerToken, 1, true)
	if second.Items[0].AssetPath != asset.AssetPath {
		t.Fatalf("duplicate upload paths = %q, %q", asset.AssetPath, second.Items[0].AssetPath)
	}
	usage, err := app.conversationAssets.Governance()
	if err != nil {
		t.Fatalf("conversation asset governance: %v", err)
	}
	if usage.FileCount != 1 {
		t.Fatalf("duplicate upload governance = %#v", usage)
	}
	if _, err := app.myAssets.Upsert(context.Background(), owner.ID, false, service.MyAsset{ID: "prompt-asset", Kind: "text", Title: "镜头提示词", Content: "电影感近景", Visibility: service.MyAssetPrivate}); err != nil {
		t.Fatalf("save text asset: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/images/storage-governance", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("storage governance status = %d body = %s", res.Code, res.Body.String())
	}
	governancePayload := map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &governancePayload); err != nil {
		t.Fatalf("storage governance json: %v", err)
	}
	governance := governancePayload["governance"].(map[string]any)
	if governance["conversation_asset_count"] != float64(1) || governance["conversation_asset_bytes"].(float64) < float64(asset.Size) {
		t.Fatalf("storage governance = %#v", governance)
	}
	textAssets := governance["text_assets"].(map[string]any)
	if textAssets["count"] != float64(1) || textAssets["bytes"] != float64(len([]byte("电影感近景"))) {
		t.Fatalf("text asset governance = %#v", textAssets)
	}
}

func TestImageStorageRetentionCleanupRemovesConversationAssets(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := createTestUserSession(app, "retention-asset-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	payload := uploadHTTPTestConversationAssets(t, app, token, 1, true)
	asset := payload.Items[0]
	assetPath := filepath.Join(app.config.DataDir, "image_conversation_assets", filepath.FromSlash(asset.AssetPath))
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(assetPath, old, old); err != nil {
		t.Fatalf("Chtimes() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/images/storage-governance", strings.NewReader(`{"action":"retention","retention_days":1}`))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("retention cleanup status = %d body = %s", res.Code, res.Body.String())
	}
	var result struct {
		Cleanup struct {
			DeletedConversationAssets int `json:"deleted_conversation_assets"`
		} `json:"cleanup"`
		Governance struct {
			ConversationAssetCount int `json:"conversation_asset_count"`
		} `json:"governance"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatalf("retention cleanup json: %v", err)
	}
	if result.Cleanup.DeletedConversationAssets != 1 || result.Governance.ConversationAssetCount != 0 {
		t.Fatalf("retention cleanup result = %#v", result)
	}
	if _, err := os.Stat(assetPath); !os.IsNotExist(err) {
		t.Fatalf("expired conversation asset still exists: %v", err)
	}
}

func TestImageStorageGovernanceRejectsIncompleteFilesystemScan(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	_, ownerToken := createPasswordUserSession(t, app, "governance-scan-owner", "", "Scan Owner")
	payload := uploadHTTPTestConversationAssets(t, app, ownerToken, 1, true)
	assetPath := filepath.Join(app.config.DataDir, "image_conversation_assets", filepath.FromSlash(payload.Items[0].AssetPath))
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(assetPath, old, old); err != nil {
		t.Fatalf("age conversation asset: %v", err)
	}

	imagesDir := app.config.ImagesDir()
	if err := os.RemoveAll(imagesDir); err != nil {
		t.Fatalf("remove images directory: %v", err)
	}
	if err := os.WriteFile(imagesDir, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("replace images directory with file: %v", err)
	}

	requests := []struct {
		name    string
		method  string
		body    string
		cleanup bool
	}{
		{name: "governance", method: http.MethodGet},
		{name: "cleanup", method: http.MethodPost, body: `{"action":"retention","retention_days":1}`, cleanup: true},
	}
	for _, test := range requests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, "/api/images/storage-governance", strings.NewReader(test.body))
			setRequestAuthCookie(req, token)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)

			if res.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body = %s", res.Code, http.StatusServiceUnavailable, res.Body.String())
			}
			if strings.Contains(res.Body.String(), imagesDir) || strings.Contains(res.Body.String(), "not a directory") {
				t.Fatalf("response leaked filesystem error: %s", res.Body.String())
			}
			if test.cleanup {
				if _, err := os.Stat(assetPath); err != nil {
					t.Fatalf("conversation asset was deleted before image scan failed: %v", err)
				}
			}
		})
	}
}

func TestImageConversationAssetUploadValidatesFormatAndCount(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := createTestUserSession(app, "asset-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "fake.png")
	if err != nil {
		t.Fatalf("CreateFormFile(fake) error = %v", err)
	}
	_, _ = part.Write([]byte("not an image"))
	if err := writer.Close(); err != nil {
		t.Fatalf("Close(fake multipart) error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversation-assets", body)
	setRequestAuthCookie(req, "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("fake upload status = %d body = %s", res.Code, res.Body.String())
	}

	uploadHTTPTestConversationAssets(t, app, token, maxImageConversationAssetFiles+1, false)
}

func TestImageConversationAssetUploadPreflightsWholeBatchBeforeStoring(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := createTestUserSession(app, "asset-batch-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	valid, err := writer.CreateFormFile("images", "valid.png")
	if err != nil {
		t.Fatalf("CreateFormFile(valid) error = %v", err)
	}
	if err := encodeHTTPTestPNG(valid); err != nil {
		t.Fatalf("encodeHTTPTestPNG(valid) error = %v", err)
	}
	invalid, err := writer.CreateFormFile("images", "invalid.png")
	if err != nil {
		t.Fatalf("CreateFormFile(invalid) error = %v", err)
	}
	_, _ = invalid.Write([]byte("not an image"))
	if err := writer.Close(); err != nil {
		t.Fatalf("Close(multipart) error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversation-assets", body)
	setRequestAuthCookie(req, "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("partial-invalid upload status = %d body = %s", res.Code, res.Body.String())
	}
	usage, err := app.conversationAssets.Governance()
	if err != nil {
		t.Fatalf("conversation asset governance: %v", err)
	}
	if usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("partial-invalid upload left an orphan: %#v", usage)
	}
	if owners := app.conversationAssets.Owners(); len(owners) != 0 {
		t.Fatalf("partial-invalid upload left owner directories: %#v", owners)
	}
}

type httpTestConversationAssetPayload struct {
	Items []service.ImageConversationAsset `json:"items"`
}

func uploadHTTPTestConversationAssets(t *testing.T, app *App, token string, count int, wantCreated bool) httpTestConversationAssetPayload {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for index := 0; index < count; index++ {
		part, err := writer.CreateFormFile("image", "reference.png")
		if err != nil {
			t.Fatalf("CreateFormFile(%d) error = %v", index, err)
		}
		if err := encodeHTTPTestPNG(part); err != nil {
			t.Fatalf("encode upload png %d: %v", index, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversation-assets", body)
	setRequestAuthCookie(req, "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if wantCreated {
		if res.Code != http.StatusCreated {
			t.Fatalf("upload status = %d body = %s", res.Code, res.Body.String())
		}
		var payload httpTestConversationAssetPayload
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("upload json: %v", err)
		}
		return payload
	}
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid upload status = %d body = %s", res.Code, res.Body.String())
	}
	return httpTestConversationAssetPayload{}
}
