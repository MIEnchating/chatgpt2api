package httpapi

import (
	"bytes"
	"encoding/base64"
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

	owner := service.AuthOwner{ID: "linuxdo:asset-owner", Name: "Alice", Provider: service.AuthProviderLinuxDo}
	_, ownerToken, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(owner) error = %v", err)
	}
	other := service.AuthOwner{ID: "linuxdo:asset-other", Name: "Bob", Provider: service.AuthProviderLinuxDo}
	_, otherToken, err := app.auth.UpsertLinuxDoSession(other)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(other) error = %v", err)
	}

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
	req.Header.Set("Authorization", "Bearer "+otherToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other owner asset status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	req.Header.Set("Authorization", "Bearer "+ownerToken)
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
	if !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
		t.Fatalf("asset Vary header = %q", vary)
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.Header.Set("If-None-Match", etag)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotModified || res.Body.Len() != 0 {
		t.Fatalf("conditional asset status = %d bytes = %d", res.Code, res.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, asset.URL, nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin asset status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=mine", nil)
	req.Header.Set("Authorization", "Bearer "+ownerToken)
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
	if usage := app.conversationAssets.Governance(); usage.FileCount != 1 {
		t.Fatalf("duplicate upload governance = %#v", usage)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/images/storage-governance", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
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
}

func TestImageConversationAssetUploadValidatesFormatAndCount(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := app.auth.CreateAPIKey(service.AuthRoleUser, "asset-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
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
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("fake upload status = %d body = %s", res.Code, res.Body.String())
	}

	uploadHTTPTestConversationAssets(t, app, token, maxImageConversationAssetFiles+1, false)
}

func TestImageConversationAssetUploadRequiresImageEditPermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	restrictedRole, err := app.auth.CreateRole(map[string]any{
		"name":            "models only",
		"menu_paths":      []string{"/image"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodGet, "/v1/models")},
	})
	if err != nil {
		t.Fatalf("CreateRole(restricted) error = %v", err)
	}
	if _, err := app.auth.CreatePasswordUser("asset-restricted", "Password123", "Restricted", restrictedRole["id"].(string), true); err != nil {
		t.Fatalf("CreatePasswordUser(restricted) error = %v", err)
	}
	_, restrictedToken, err := app.auth.LoginPassword("asset-restricted", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(restricted) error = %v", err)
	}

	upload := func(token string) *httptest.ResponseRecorder {
		t.Helper()
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, err := writer.CreateFormFile("image", "reference.png")
		if err != nil {
			t.Fatalf("CreateFormFile() error = %v", err)
		}
		if err := encodeHTTPTestPNG(part); err != nil {
			t.Fatalf("encodeHTTPTestPNG() error = %v", err)
		}
		if err := writer.Close(); err != nil {
			t.Fatalf("multipart close: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversation-assets", body)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	res := upload(restrictedToken)
	if res.Code != http.StatusForbidden {
		t.Fatalf("restricted user upload status = %d body = %s", res.Code, res.Body.String())
	}
	if usage := app.conversationAssets.Governance(); usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("forbidden upload stored assets: %#v", usage)
	}

	if _, err := app.auth.CreatePasswordUser("asset-default", "Password123", "Default", service.DefaultManagedRoleID, true); err != nil {
		t.Fatalf("CreatePasswordUser(default) error = %v", err)
	}
	_, defaultToken, err := app.auth.LoginPassword("asset-default", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(default) error = %v", err)
	}
	res = upload(defaultToken)
	if res.Code != http.StatusCreated {
		t.Fatalf("default user upload status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestImageConversationAssetUploadPreflightsWholeBatchBeforeStoring(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := app.auth.CreateAPIKey(service.AuthRoleUser, "asset-batch-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
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
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("partial-invalid upload status = %d body = %s", res.Code, res.Body.String())
	}
	if usage := app.conversationAssets.Governance(); usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("partial-invalid upload left an orphan: %#v", usage)
	}
	if owners := app.conversationAssets.Owners(); len(owners) != 0 {
		t.Fatalf("partial-invalid upload left owner directories: %#v", owners)
	}
}

func TestProfileImageConversationAssetizationAndDeleteCleanup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner := service.AuthOwner{ID: "linuxdo:history-asset-owner", Name: "Alice", Provider: service.AuthProviderLinuxDo}
	_, token, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	var imageData bytes.Buffer
	if err := encodeHTTPTestPNG(&imageData); err != nil {
		t.Fatalf("encodeHTTPTestPNG() error = %v", err)
	}
	conversation := map[string]any{
		"id": "http-history-asset", "revision": 1, "title": "asset",
		"createdAt": "2026-07-20T12:00:00Z", "updatedAt": "2026-07-20T12:00:00Z",
		"turns": []any{map[string]any{
			"id": "turn-http-history-asset", "status": "success", "images": []any{},
			"referenceImages": []any{map[string]any{
				"name": "reference.png", "type": "image/png",
				"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageData.Bytes()),
			}},
		}},
	}
	requestBody, err := json.Marshal(map[string]any{"item": conversation})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", bytes.NewReader(requestBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("history save status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations/http-history-asset", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("history detail status = %d body = %s", res.Code, res.Body.String())
	}
	var detail struct {
		Item map[string]any `json:"item"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail json: %v", err)
	}
	turn := detail.Item["turns"].([]any)[0].(map[string]any)
	reference := turn["referenceImages"].([]any)[0].(map[string]any)
	managedURL, _ := reference["dataUrl"].(string)
	if !strings.HasPrefix(managedURL, service.ImageConversationAssetURLPrefix) || strings.Contains(res.Body.String(), "data:image") {
		t.Fatalf("detail reference was not assetized: %#v", reference)
	}
	access, err := app.conversationAssets.Access(managedURL, owner.ID, false)
	if err != nil {
		t.Fatalf("Access() error = %v", err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(access.Path, old, old); err != nil {
		t.Fatalf("Chtimes() error = %v", err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/image-conversations/http-history-asset?response=minimal", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("history delete status = %d body = %s", res.Code, res.Body.String())
	}
	waitForHTTPTestCondition(t, func() bool {
		_, statErr := os.Stat(access.Path)
		return os.IsNotExist(statErr)
	})
}

func TestImageDeleteDelegationCannotCrossOwnerBoundary(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	role, err := app.auth.CreateRole(map[string]any{
		"name":            "owner image delete",
		"menu_paths":      []string{"/image-manager"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodDelete, "/api/images")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if _, err := app.auth.CreatePasswordUser("delete-owner-a", "Password123", "Alice", role["id"].(string), true); err != nil {
		t.Fatalf("CreatePasswordUser(owner A) error = %v", err)
	}
	identityA, tokenA, err := app.auth.LoginPassword("delete-owner-a", "Password123")
	if err != nil || identityA == nil {
		t.Fatalf("LoginPassword(owner A) identity=%#v error=%v", identityA, err)
	}
	if _, err := app.auth.CreatePasswordUser("delete-owner-b", "Password123", "Bob", role["id"].(string), true); err != nil {
		t.Fatalf("CreatePasswordUser(owner B) error = %v", err)
	}
	identityB, tokenB, err := app.auth.LoginPassword("delete-owner-b", "Password123")
	if err != nil || identityB == nil {
		t.Fatalf("LoginPassword(owner B) identity=%#v error=%v", identityB, err)
	}
	ownerA := service.AuthOwner{ID: identityScope(*identityA), Name: identityDisplayName(*identityA)}
	ownerB := service.AuthOwner{ID: identityScope(*identityB), Name: identityDisplayName(*identityB)}
	pathA := "owner-a.png"
	pathB := "owner-b.png"
	fileA := filepath.Join(app.config.ImagesDir(), pathA)
	fileB := filepath.Join(app.config.ImagesDir(), pathB)
	if err := writeHTTPTestPNG(fileA); err != nil {
		t.Fatalf("write owner A image: %v", err)
	}
	if err := writeHTTPTestPNG(fileB); err != nil {
		t.Fatalf("write owner B image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{pathA}, ownerA.ID, ownerA.Name, service.ImageVisibilityPrivate)
	app.images.RecordGeneratedImages([]string{pathB}, ownerB.ID, ownerB.Name, service.ImageVisibilityPrivate)

	deleteImage := func(token, imagePath string) map[string]any {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"paths": []string{imagePath}})
		req := httptest.NewRequest(http.MethodDelete, "/api/images", bytes.NewReader(body))
		req.Header.Set("Authorization", token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("delete %s status = %d body = %s", imagePath, res.Code, res.Body.String())
		}
		payload := map[string]any{}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("delete json: %v", err)
		}
		return payload
	}

	denied := deleteImage("Bearer "+tokenB, pathA)
	if denied["deleted"] != float64(0) || denied["missing"] != float64(1) {
		t.Fatalf("cross-owner delete result = %#v", denied)
	}
	if _, err := os.Stat(fileA); err != nil {
		t.Fatalf("owner A image was removed by owner B: %v", err)
	}
	owned := deleteImage("Bearer "+tokenA, pathA)
	if owned["deleted"] != float64(1) || owned["missing"] != float64(0) {
		t.Fatalf("owner delete result = %#v", owned)
	}
	if _, err := os.Stat(fileA); !os.IsNotExist(err) {
		t.Fatalf("owner A image still exists: %v", err)
	}
	admin := deleteImage(adminAuthHeader(t, app), pathB)
	if admin["deleted"] != float64(1) || admin["missing"] != float64(0) {
		t.Fatalf("admin delete result = %#v", admin)
	}
	if _, err := os.Stat(fileB); !os.IsNotExist(err) {
		t.Fatalf("owner B image still exists after admin delete: %v", err)
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
	req.Header.Set("Authorization", "Bearer "+token)
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
