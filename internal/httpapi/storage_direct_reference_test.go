package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestStorageDirectRecordDeletionPreservesAssetReference(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"storage": model.StorageSetting{AllowUserProvider: true}}); err != nil {
		t.Fatal(err)
	}
	identity, token := createPasswordUserSession(t, app, "direct-reference", "Password123!", "Direct Reference")
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(r, token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, r)
		return response
	}
	registered := request(http.MethodPost, "/api/files/direct", fmt.Sprintf(`{"provider":{"enabled":true,"name":"User DAV","type":"webdav","endpoint":"https://dav.example.test","pathPrefix":"canvas","username":"dav-user","password":"dav-password"},"objectKey":%q,"mimeType":"image/png","bytes":10}`, "canvas/"+identity.ID+"/reference.png"))
	if registered.Code != http.StatusOK {
		t.Fatalf("register direct object status = %d body = %s", registered.Code, registered.Body.String())
	}
	var payload struct {
		Object struct {
			ID         string `json:"id"`
			URL        string `json:"url"`
			StorageKey string `json:"storageKey"`
		} `json:"object"`
	}
	if err := json.Unmarshal(registered.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	object := payload.Object
	if object.ID == "" || object.StorageKey == "" {
		t.Fatalf("invalid registered object: %s", registered.Body.String())
	}
	saved := request(http.MethodPost, "/api/profile/assets", fmt.Sprintf(`{"item":{"id":"direct-reference","kind":"image","title":"Direct reference","url":%q,"storageKey":%q,"mimeType":"image/png","tags":[]}}`, object.URL, object.StorageKey))
	if saved.Code != http.StatusOK {
		t.Fatalf("save asset status = %d body = %s", saved.Code, saved.Body.String())
	}
	deleted := request(http.MethodDelete, "/api/files/"+object.ID+"/record", "")
	info := request(http.MethodGet, "/api/files/"+object.ID, "")
	if deleted.Code != http.StatusConflict || info.Code != http.StatusOK {
		t.Fatalf("referenced record deletion status = %d body = %s; subsequent info status = %d body = %s", deleted.Code, deleted.Body.String(), info.Code, info.Body.String())
	}
	_, otherToken := createPasswordUserSession(t, app, "other-direct-reference", "Password123!", "Other Direct Reference")
	otherRequest := httptest.NewRequest(http.MethodDelete, "/api/files/"+object.ID+"/record", nil)
	setRequestAuthCookie(otherRequest, otherToken)
	otherResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(otherResponse, otherRequest)
	if otherResponse.Code != http.StatusForbidden {
		t.Fatalf("cross-owner record deletion status = %d body = %s", otherResponse.Code, otherResponse.Body.String())
	}
	removed := request(http.MethodDelete, "/api/profile/assets", `{"id":"direct-reference"}`)
	if removed.Code != http.StatusOK {
		t.Fatalf("remove asset reference status = %d body = %s", removed.Code, removed.Body.String())
	}
	deleted = request(http.MethodDelete, "/api/files/"+object.ID+"/record", "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("unreferenced record deletion status = %d body = %s", deleted.Code, deleted.Body.String())
	}
	if info = request(http.MethodGet, "/api/files/"+object.ID, ""); info.Code != http.StatusNotFound {
		t.Fatalf("deleted record info status = %d body = %s", info.Code, info.Body.String())
	}
	uploaded, err := app.storageFiles.Upload(context.Background(), identity.ID, false, "server.png", "image/png", []byte("image content"), nil)
	if err != nil {
		t.Fatal(err)
	}
	deleted = request(http.MethodDelete, "/api/files/"+uploaded.ID+"/record", "")
	if deleted.Code != http.StatusForbidden {
		t.Fatalf("server-managed record deletion status = %d body = %s", deleted.Code, deleted.Body.String())
	}
	if content := request(http.MethodGet, "/api/files/"+uploaded.ID+"/content", ""); content.Code != http.StatusOK || content.Body.String() != "image content" {
		t.Fatalf("server-managed file after rejected record deletion status = %d body = %s", content.Code, content.Body.String())
	}
}
