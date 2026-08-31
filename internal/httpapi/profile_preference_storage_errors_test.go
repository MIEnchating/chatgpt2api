package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

type profileDocumentErrorBackend struct {
	storage.Backend
	loadValue any
	loadErr   error
	saveErr   error
}

func (b *profileDocumentErrorBackend) LoadJSONDocument(string) (any, error) {
	return b.loadValue, b.loadErr
}

func (b *profileDocumentErrorBackend) SaveJSONDocument(string, any) error {
	return b.saveErr
}

func (b *profileDocumentErrorBackend) DeleteJSONDocument(string) error {
	return nil
}

func TestProfilePreferenceStorageFailuresAreSanitized(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	storageFailure := errors.New("database unavailable at secret.internal.example")
	backend := &profileDocumentErrorBackend{loadErr: storageFailure}

	app.imagePreferences = service.NewImageGenerationPreferenceService(backend)
	response := authenticatedProfileRequest(app, token, http.MethodGet, "/api/profile/image-generation-preferences", "")
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), storageFailure.Error()) {
		t.Fatalf("image preferences response = %d %s", response.Code, response.Body.String())
	}

	app.customRelayConfigs = service.NewCustomRelayConfigService(backend)
	response = authenticatedProfileRequest(app, token, http.MethodGet, "/api/profile/custom-relay-configs", "")
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), storageFailure.Error()) {
		t.Fatalf("custom relay response = %d %s", response.Code, response.Body.String())
	}

	response = authenticatedProfileRequest(app, token, http.MethodGet, "/api/profile/relay-key?token_name="+service.CustomRelayTokenName("config-id"), "")
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), storageFailure.Error()) {
		t.Fatalf("relay key response = %d %s", response.Code, response.Body.String())
	}
}

func TestProfilePreferenceConflictsReturnConflict(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	backend := &profileDocumentErrorBackend{saveErr: storage.ErrConcurrentRowUpdate}

	app.imagePreferences = service.NewImageGenerationPreferenceService(backend)
	response := authenticatedProfileRequest(app, token, http.MethodPatch, "/api/profile/image-generation-preferences", `{"stream":true}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("image preference conflict = %d %s", response.Code, response.Body.String())
	}

	app.customRelayConfigs = service.NewCustomRelayConfigService(backend)
	response = authenticatedProfileRequest(app, token, http.MethodPost, "/api/profile/custom-relay-configs", `{"kind":"video","name":"测试线路","base_url":"https://api.example.test","api_key":"sk-test"}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("custom relay conflict = %d %s", response.Code, response.Body.String())
	}

	response = authenticatedProfileRequest(app, token, http.MethodPut, "/api/profile/custom-relay-configs/missing", `{"name":"测试线路","base_url":"https://api.example.test","api_key":"sk-test"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing custom relay = %d %s", response.Code, response.Body.String())
	}
}

func authenticatedProfileRequest(app *App, token, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	return response
}
