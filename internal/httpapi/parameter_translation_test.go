package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestTranslatedMediaUsesFrozenChannelAndRejectsInjectedCredentials(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity := service.Identity{ID: "translation-owner", Role: service.AuthRoleAdmin}
	source := `{models:{custom:{POST:{url:"/original",body:{prompt,images}},result:"data"}}}`
	saved, err := app.customRelayConfigs.Create(identityScope(identity), "image", "channel", "http://translate.example/v1", "old-key", "openai", source)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"model": "custom", "prompt": "hello", "token_name": saved.TokenName, relayTaskCredentialKey: map[string]any{"APIKey": "injected"}}
	if err := app.freezeRelayCredentialForTask(context.Background(), identity, body); err != nil {
		t.Fatal(err)
	}
	if _, err := app.customRelayConfigs.Update(identityScope(identity), saved.ID, "changed", "http://changed.example", "new-key", "openai", ""); err != nil {
		t.Fatal(err)
	}
	if err := app.attachRelayAPIKeyForIdentity(context.Background(), identity, body); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/original" || r.Header.Get("Authorization") != "Bearer old-key" {
			t.Errorf("snapshot lost: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		refs := util.AsStringSlice(request["images"])
		if len(refs) != 2 || !strings.HasPrefix(refs[0], "data:image/png;") {
			t.Errorf("lost references: %#v", request)
		}
		io.WriteString(w, `{"data":[{"url":"https://cdn.example/out.png"}]}`)
	}))
	defer server.Close()
	externalWorkflowTestClient(app, server)
	result, err := app.relayImageCreationTask(context.Background(), body, []protocol.UploadedImage{{ContentType: "image/png", Data: []byte("a")}, {ContentType: "image/png", Data: []byte("b")}}, true)
	if err != nil || len(util.AsMapSlice(result["data"])) != 1 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	audit, _ := json.Marshal(cleanAuditPayloadMap(body))
	if strings.Contains(string(audit), "original") || strings.Contains(string(audit), relayTaskCredentialKey) {
		t.Fatal("script or credential snapshot exposed in audit")
	}
	other := service.Identity{ID: "other-owner", Role: service.AuthRoleAdmin}
	if err := app.freezeRelayCredentialForTask(context.Background(), other, map[string]any{"model": "custom", "token_name": saved.TokenName}); err == nil {
		t.Fatal("cross account channel accepted")
	}
}

func TestTranslatedMediaFailureDoesNotFallBack(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(400)
		io.WriteString(w, `{"error":"bad request"}`)
	}))
	defer server.Close()
	externalWorkflowTestClient(app, server)
	payload := map[string]any{"model": "custom", "prompt": "test", "api_key": "key", "relay_base_url": "http://translate.example", relayCustomEndpointPayloadKey: true, relayTranslationSourceKey: `{models:{custom:{POST:{url:"/custom"}}}}`}
	if _, err := app.relayImageCreationTask(context.Background(), payload, nil, false); err == nil || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestTranslatedAudioAndVideoUseCreationResults(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"media":"https://cdn.example/result"}`)
	}))
	defer server.Close()
	externalWorkflowTestClient(app, server)
	for _, kind := range []string{"audio", "video"} {
		payload := map[string]any{"model": "custom", "input": "speech", "prompt": "scene", "api_key": "key", "relay_base_url": "http://translate.example", relayCustomEndpointPayloadKey: true, relayTranslationSourceKey: `{models:{custom:{POST:{url:"/custom"},result:"media"}}}`}
		var result map[string]any
		var err error
		if kind == "audio" {
			result, err = app.relayAudioSpeech(context.Background(), payload)
		} else {
			result, err = app.relayVideoTask(context.Background(), payload)
		}
		if err != nil {
			t.Fatal(err)
		}
		items := util.AsMapSlice(result["data"])
		if len(items) != 1 || items[0][kind+"_url"] != "https://cdn.example/result" {
			t.Fatalf("bad %s result: %#v", kind, result)
		}
	}
}

func TestTranslatedTaskInternalsAreExcludedFromRequestsAndAudit(t *testing.T) {
	payload := map[string]any{
		"model": "custom", "prompt": "hello",
		relayTaskCredentialKey:                      frozenTaskCredential{relayCredential{APIKey: "secret"}},
		relayTranslationSourceKey:                   "private rule",
		service.MediaTaskProgressCallbackPayloadKey: func(int) {},
	}
	for name, result := range map[string]map[string]any{
		"image": relayPayloadForPath("/v1/images/generations", payload),
		"chat":  relayPayloadForPath("/v1/chat/completions", payload),
		"audit": cleanAuditPayloadMap(payload),
	} {
		for _, key := range []string{relayTaskCredentialKey, relayTranslationSourceKey, service.MediaTaskProgressCallbackPayloadKey} {
			if _, ok := result[key]; ok {
				t.Errorf("%s leaked internal field %s", name, key)
			}
		}
		if _, err := json.Marshal(result); err != nil {
			t.Errorf("%s is not serializable: %v", name, err)
		}
	}
}

func TestTranslatedDefaultRulesAreAdminOnly(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	source := `{models:{custom:{POST:{url:"/private-rule"}}}}`
	if _, err := app.config.Update(map[string]any{relayTranslationSourceKey: source}); err != nil {
		t.Fatal(err)
	}
	role, err := app.auth.CreateRole(map[string]any{
		"name": "Settings Operator", "menu_paths": []string{"/settings"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodGet, "/api/settings"), service.APIPermissionKey(http.MethodPost, "/api/settings")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.auth.CreatePasswordUser("translation_operator", "Password123!", "Operator", util.Clean(role["id"]), true); err != nil {
		t.Fatal(err)
	}
	_, token, err := app.auth.LoginPassword("translation_operator", "Password123!")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, body string
		status       int
	}{
		{http.MethodGet, "", http.StatusOK},
		{http.MethodPost, `{}`, http.StatusOK},
		{http.MethodPost, `{"relay_parameter_translation":""}`, http.StatusForbidden},
	} {
		req := httptest.NewRequest(test.method, "/api/settings", strings.NewReader(test.body))
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != test.status || strings.Contains(res.Body.String(), "private-rule") || strings.Contains(res.Body.String(), relayTranslationSourceKey) {
			t.Fatalf("%s status=%d body=%s", test.method, res.Code, res.Body.String())
		}
	}
	if app.settingsConfig(true)[relayTranslationSourceKey] != source {
		t.Fatal("admin rule was hidden or modified")
	}
}
