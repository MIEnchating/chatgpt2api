package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestVideoMaterialUploadCredentialAdminAPIIsWriteOnly(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	items, err := app.videoContracts.List()
	if err != nil || len(items) < 2 {
		t.Fatalf("contracts: %v", err)
	}
	token := adminSessionToken(t, app)
	const base = "https://uploads.example.com"
	endpoint := "/api/admin/video-model-contracts/" + items[0].ID + "/upload-credential"
	request := func(method, path string, body any, auth bool) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if auth {
			setRequestAuthCookie(req, token)
		}
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	unauth := request(http.MethodPut, endpoint, map[string]any{"base_url": base, "api_key": "private-upload-secret"}, false)
	if unauth.Code == http.StatusOK {
		t.Fatal("unauthenticated credential mutation accepted")
	}
	res := request(http.MethodPut, endpoint, map[string]any{"base_url": base, "api_key": "private-upload-secret"}, true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"configured":true`) {
		t.Fatalf("save: %d %s", res.Code, res.Body.String())
	}
	for _, path := range []string{endpoint + "?base_url=" + base, "/api/admin/video-model-contracts", "/api/admin/video-model-contracts/" + items[0].ID + "/versions"} {
		res := request(http.MethodGet, path, nil, true)
		if res.Code != 200 || strings.Contains(res.Body.String(), "private-upload-secret") || strings.Contains(res.Body.String(), "upload_credentials") {
			t.Fatalf("response exposed private configuration: status %d", res.Code)
		}
	}
	other := request(http.MethodGet, "/api/admin/video-model-contracts/"+items[1].ID+"/upload-credential?base_url="+base, nil, true)
	if !strings.Contains(other.Body.String(), `"configured":false`) {
		t.Fatal("other contract inherited credential status")
	}
	other = request(http.MethodGet, endpoint+"?base_url=https://different.example.com", nil, true)
	if !strings.Contains(other.Body.String(), `"configured":false`) {
		t.Fatal("changed address inherited credential status")
	}
	res = request(http.MethodPut, endpoint, map[string]any{"base_url": base, "api_key": ""}, true)
	if res.Code != http.StatusBadRequest {
		t.Fatal("blank key silently cleared credential")
	}
	if key, _ := app.videoContracts.MaterialUploadAPIKey(items[0].ID, base); key != "private-upload-secret" {
		t.Fatal("blank input replaced saved key")
	}
	res = request(http.MethodDelete, endpoint, map[string]any{"base_url": base}, true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"configured":false`) {
		t.Fatal("credential clear failed")
	}
}
