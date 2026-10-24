package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/videocontract"
)

func TestAdminVideoModelContractPluginGeneration(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	admin := adminSessionToken(t, app)
	_, user := createPasswordUserSession(t, app, "plugin-test-user", "", "Plugin test user")
	contract := dramayaVideoContract(t)
	options := videocontract.NewAPIVideoPluginOptions{Key: "contract-video", Version: "1.0.0", BaseURL: "https://video.example.com", AuthMode: "bearer", DownloadMode: "signed_url", ResultFields: []string{"video_url"}}
	input := map[string]any{"contract": contract, "options": options}
	before, err := app.videoContracts.List()
	if err != nil {
		t.Fatal(err)
	}
	request := func(token, method string, body any) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, "/api/admin/video-model-contracts/newapi-plugin", bytes.NewReader(data))
		if token != "" {
			setRequestAuthCookie(req, token)
		}
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	for _, test := range []struct {
		name, token, method string
		status              int
	}{
		{"anonymous", "", http.MethodPost, http.StatusUnauthorized},
		{"user", user, http.MethodPost, http.StatusForbidden},
		{"method", admin, http.MethodGet, http.StatusMethodNotAllowed},
		{"admin", admin, http.MethodPost, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			res := request(test.token, test.method, input)
			if res.Code != test.status {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			if res.Code == http.StatusOK {
				var result videocontract.NewAPIVideoPluginResult
				if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Filename != "contract-video-1.0.0.js" || !strings.Contains(result.Source, "export function buildContentRequest") || !strings.Contains(result.Source, "grok-imagine-video-1.5") {
					t.Fatal("incomplete generated source")
				}
			}
		})
	}
	bad := map[string]any{"contract": contract, "options": map[string]any{"api_key": "not-a-real-key"}}
	if res := request(admin, http.MethodPost, bad); res.Code != http.StatusBadRequest {
		t.Fatalf("unexpected secret field accepted: %d", res.Code)
	}
	options.DownloadMode = ""
	if res := request(admin, http.MethodPost, map[string]any{"contract": contract, "options": options}); res.Code != http.StatusBadRequest {
		t.Fatalf("missing download mode accepted: %d", res.Code)
	}
	after, err := app.videoContracts.List()
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("generation changed stored contracts")
	}
}
