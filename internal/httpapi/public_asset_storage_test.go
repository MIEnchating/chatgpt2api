package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatgpt2api/internal/service"
)

func TestPublicAssetStorageReadAndRevocation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner, ownerToken := createPasswordUserSession(t, app, "public-owner", "Password123!", "Owner")
	viewer, viewerToken := createPasswordUserSession(t, app, "public-viewer", "Password123!", "Viewer")
	ctx := context.Background()
	object, err := app.storageFiles.Upload(ctx, owner.ID, false, "shared.png", "image/png", []byte("shared image fixture"), nil)
	if err != nil {
		t.Fatal(err)
	}
	asset := service.MyAsset{ID: "shared", Kind: "image", Title: "Shared", StorageKey: object.StorageKey, URL: object.URL, Visibility: service.MyAssetPrivate}
	if _, err := app.myAssets.Upsert(ctx, owner.ID, false, asset); err != nil {
		t.Fatal(err)
	}
	request := func(method, suffix, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/api/files/"+object.ID+suffix, nil)
		if token != "" {
			setRequestAuthCookie(req, token)
		}
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s %s status = %d, want %d; body=%s", method, suffix, res.Code, status, res.Body.String())
		}
		return res
	}
	request(http.MethodGet, "/content", viewerToken, http.StatusForbidden)
	request(http.MethodGet, "", viewerToken, http.StatusForbidden)
	asset.Visibility = service.MyAssetPublic
	if _, err := app.myAssets.Upsert(ctx, owner.ID, false, asset); err != nil {
		t.Fatal(err)
	}
	request(http.MethodGet, "", viewerToken, http.StatusOK)
	if res := request(http.MethodGet, "/content", viewerToken, http.StatusOK); res.Body.String() != "shared image fixture" {
		t.Fatalf("unexpected public content: %q", res.Body.String())
	}
	if res := request(http.MethodHead, "/content", viewerToken, http.StatusOK); res.Body.Len() != 0 {
		t.Fatal("HEAD returned a body")
	}
	request(http.MethodGet, "/content", "", http.StatusUnauthorized)
	request(http.MethodDelete, "", viewerToken, http.StatusForbidden)
	request(http.MethodDelete, "/record", viewerToken, http.StatusForbidden)
	request(http.MethodGet, "/content", ownerToken, http.StatusOK)
	if _, err := app.myAssets.Upsert(ctx, viewer.ID, false, asset); err == nil {
		t.Fatal("viewer could register another owner's object")
	}
	asset.Visibility = service.MyAssetPrivate
	if _, err := app.myAssets.Upsert(ctx, owner.ID, false, asset); err != nil {
		t.Fatal(err)
	}
	request(http.MethodGet, "", viewerToken, http.StatusForbidden)
	request(http.MethodGet, "/content", viewerToken, http.StatusForbidden)
	request(http.MethodGet, "/content", ownerToken, http.StatusOK)
}
