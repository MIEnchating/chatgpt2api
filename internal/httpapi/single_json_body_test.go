package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestMutationEndpointsRejectTrailingJSONValues(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)
	identity, userToken := createPasswordUserSession(t, app, "single-json-user", "Password123!", "Single JSON User")

	assetsBefore, err := app.myAssets.List(identityScope(*identity))
	if err != nil {
		t.Fatalf("list assets before requests: %v", err)
	}
	providersBefore, err := app.storageFiles.UserProviders(identity.ID)
	if err != nil {
		t.Fatalf("list providers before requests: %v", err)
	}

	tests := []struct {
		name      string
		method    string
		path      string
		body      string
		token     string
		wantError string
	}{
		{name: "upsert asset", method: http.MethodPost, path: "/api/profile/assets", body: `{"item":{"id":"unexpected-asset","kind":"image","title":"Unexpected","url":"/images/unexpected.png","tags":[]}} {}`, token: userToken, wantError: "invalid json body"},
		{name: "delete asset", method: http.MethodDelete, path: "/api/profile/assets", body: `{"id":"unexpected-asset"} {}`, token: userToken, wantError: "invalid json body"},
		{name: "save user storage provider", method: http.MethodPost, path: "/api/profile/storage-provider", body: `{"provider":{}} {}`, token: userToken, wantError: "storage provider payload is invalid"},
		{name: "measure user storage provider", method: http.MethodPost, path: "/api/profile/storage-provider/measure", body: `{"provider":{"type":"webdav","endpoint":"https://example.invalid"}} {}`, token: userToken, wantError: "storage provider payload is invalid"},
		{name: "measure admin storage provider", method: http.MethodPost, path: "/api/settings/storage/measure", body: `{"index":0} {}`, token: adminToken, wantError: "storage provider payload is invalid"},
		{name: "register direct storage object", method: http.MethodPost, path: "/api/files/direct", body: `{"objectKey":"unexpected.mp4","mimeType":"video/mp4","bytes":1} {}`, token: userToken, wantError: "storage object payload is invalid"},
		{name: "delete storage object", method: http.MethodDelete, path: "/api/files/missing", body: `{"provider":null} {}`, token: userToken, wantError: "storage provider payload is invalid"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			setRequestAuthCookie(req, test.token)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), test.wantError) {
				t.Fatalf("status = %d body = %s, want 400 containing %q", res.Code, res.Body.String(), test.wantError)
			}
		})
	}

	assetsAfter, err := app.myAssets.List(identityScope(*identity))
	if err != nil {
		t.Fatalf("list assets after requests: %v", err)
	}
	if !reflect.DeepEqual(assetsAfter, assetsBefore) {
		t.Fatalf("asset state changed after rejected requests: before=%#v after=%#v", assetsBefore, assetsAfter)
	}
	providersAfter, err := app.storageFiles.UserProviders(identity.ID)
	if err != nil {
		t.Fatalf("list providers after requests: %v", err)
	}
	if !reflect.DeepEqual(providersAfter, providersBefore) {
		t.Fatalf("provider state changed after rejected requests: before=%#v after=%#v", providersBefore, providersAfter)
	}
}

func TestVideoContractEndpointsRejectTrailingJSONValues(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	items, err := app.videoContracts.List()
	if err != nil || len(items) == 0 {
		t.Fatalf("list video contracts = %#v, error = %v", items, err)
	}
	item := items[0]

	patchBody := fmt.Sprintf(`{"enabled":%t} {}`, !item.Enabled)
	assertRejectedJSONRequest(t, app, token, http.MethodPatch, "/api/admin/video-model-contracts/"+item.ID, patchBody, "invalid video model contract body")
	assertRejectedJSONRequest(t, app, token, http.MethodPost, "/api/admin/video-model-contracts/"+item.ID+"/rollback", `{"revision":1} {}`, "invalid video model contract revision")

	model := strings.ReplaceAll(item.Contract.Models[0], "*", "test")
	preview, err := json.Marshal(map[string]any{
		"contract":    item.Contract,
		"existing_id": item.ID,
		"input": map[string]any{
			"model": model, "prompt": "preview", "seconds": item.Contract.Capability.DefaultSeconds,
			"size": item.Contract.Capability.DefaultSize, "resolution": item.Contract.Capability.DefaultResolution,
		},
	})
	if err != nil {
		t.Fatalf("marshal preview: %v", err)
	}
	assertRejectedJSONRequest(t, app, token, http.MethodPost, "/api/admin/video-model-contracts/preview", string(preview)+` {}`, "invalid video model contract preview body")

	after, err := app.videoContracts.List()
	if err != nil {
		t.Fatalf("list video contracts after requests: %v", err)
	}
	for _, current := range after {
		if current.ID == item.ID {
			if current.Enabled != item.Enabled || current.Revision != item.Revision || util.Clean(current.UpdatedAt) != util.Clean(item.UpdatedAt) {
				t.Fatalf("video contract changed after rejected requests: before=%#v after=%#v", item, current)
			}
			return
		}
	}
	t.Fatalf("video contract %q disappeared after rejected requests", item.ID)
}

func assertRejectedJSONRequest(t *testing.T, app *App, token, method, path, body, wantError string) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), wantError) {
		t.Fatalf("%s %s status = %d body = %s, want 400 containing %q", method, path, res.Code, res.Body.String(), wantError)
	}
}
