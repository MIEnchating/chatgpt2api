package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestDefaultTranslationValidation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, test := range []struct {
		name, token, path, body string
		status                  int
	}{
		{"admin valid", token, "/api/settings/validate-translation", `{"source":"{models:{custom:{POST:{url:'/jobs'}}}}"}`, http.StatusOK},
		{"admin invalid rule", token, "/api/settings/validate-translation", `{"source":"invalid rule"}`, http.StatusBadRequest},
		{"admin invalid json", token, "/api/settings/validate-translation", `{`, http.StatusBadRequest},
		{"unauthenticated", "", "/api/settings/validate-translation", `{}`, http.StatusUnauthorized},
		{"removed personal endpoint", token, "/api/profile/custom-relay-configs/validate-translation", `{}`, http.StatusMethodNotAllowed},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			if test.token != "" {
				setRequestAuthCookie(req, test.token)
			}
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != test.status {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			if test.status == http.StatusOK && !strings.Contains(res.Body.String(), `"custom"`) {
				t.Fatalf("missing model: %s", res.Body.String())
			}
		})
	}
}

func TestPersonalChannelSkipsDefaultTranslationAndFreezesCredentials(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity := service.Identity{ID: "translation-owner", Role: service.AuthRoleAdmin}
	if _, err := app.config.Update(map[string]any{relayTranslationSourceKey: `{models:{custom:{POST:{url:"/default-only"}}}}`}); err != nil {
		t.Fatal(err)
	}
	saved, err := app.customRelayConfigs.Create(identityScope(identity), "image", "channel", "http://translate.example/v1", "old-key", "openai")
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"model": "custom", "token_name": saved.TokenName, relayTranslationSourceKey: "injected", relayTaskCredentialKey: map[string]any{"APIKey": "injected"}}
	if err := app.freezeRelayCredentialForTask(context.Background(), identity, body); err != nil {
		t.Fatal(err)
	}
	if _, err := app.customRelayConfigs.Update(identityScope(identity), saved.ID, "changed", "http://changed.example", "new-key", "openai"); err != nil {
		t.Fatal(err)
	}
	if err := app.attachRelayAPIKeyForIdentity(context.Background(), identity, body); err != nil {
		t.Fatal(err)
	}
	if body[relayTranslationSourceKey] != "" || body["api_key"] != "old-key" || body["relay_base_url"] != "http://translate.example/v1" {
		t.Fatalf("unexpected credential: %#v", body)
	}
	other := service.Identity{ID: "other-owner", Role: service.AuthRoleAdmin}
	if err := app.freezeRelayCredentialForTask(context.Background(), other, map[string]any{"token_name": saved.TokenName}); err == nil {
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
	req := httptest.NewRequest(http.MethodPost, "/api/settings/validate-translation", strings.NewReader(`{"source":"{}"}`))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("non-admin validation status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestTranslationVariablesNormalizeAspectRatio(t *testing.T) {
	for _, test := range []struct {
		name    string
		payload map[string]any
		want    string
	}{
		{"square pixels", map[string]any{"size": "1024x1024"}, "1:1"},
		{"landscape pixels", map[string]any{"size": "1536x1024"}, "3:2"},
		{"portrait pixels", map[string]any{"size": "1024X1536"}, "2:3"},
		{"unicode pixels", map[string]any{"size": "1920×1080"}, "16:9"},
		{"explicit ratio wins", map[string]any{"aspect_ratio": "9:16", "ratio": "4:3", "size": "1024x1024"}, "9:16"},
		{"ratio alias", map[string]any{"ratio": "4:3", "size": "1024x1024"}, "4:3"},
		{"auto", map[string]any{"size": "auto"}, ""},
		{"explicit auto", map[string]any{"aspect_ratio": "auto", "size": "1024x1024"}, ""},
		{"empty", map[string]any{}, ""},
		{"zero", map[string]any{"size": "0x1024"}, ""},
		{"negative", map[string]any{"size": "-1024x1024"}, ""},
		{"malformed", map[string]any{"size": "1024x1024x1024"}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := translationVariables(test.payload, nil, "image")
			if got["aspectRatio"] != test.want {
				t.Fatalf("aspectRatio=%v want=%q", got["aspectRatio"], test.want)
			}
			if got["size"] != test.payload["size"] {
				t.Fatalf("original size changed: %v", got["size"])
			}
		})
	}
}

func TestTranslatedInlineVideoIsStoredAsFile(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, test := range []struct{ mime, extension string }{
		{"video/mp4", ".mp4"}, {"video/webm", ".webm"}, {"video/quicktime", ".mov"},
	} {
		t.Run(test.mime, func(t *testing.T) {
			raw := []byte("binary video output")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				util.WriteJSON(w, http.StatusOK, map[string]any{"media": "data:" + test.mime + ";base64," + base64.StdEncoding.EncodeToString(raw)})
			}))
			defer server.Close()
			externalWorkflowTestClient(app, server)
			payload := map[string]any{"model": "custom", "prompt": "scene", "api_key": "key", "relay_base_url": "http://translate.example", relayCustomEndpointPayloadKey: true, relayTranslationSourceKey: `{models:{custom:{POST:{url:"/custom"},result:"media"}}}`}
			result, err := app.relayVideoTask(context.Background(), payload)
			if err != nil {
				t.Fatal(err)
			}
			items := util.AsMapSlice(result["data"])
			if len(items) != 1 {
				t.Fatalf("unexpected result: %#v", result)
			}
			url := util.Clean(items[0]["video_url"])
			if !strings.HasPrefix(url, "/videos/") || !strings.HasSuffix(url, test.extension) || items[0]["url"] != url {
				t.Fatalf("video was not persisted: %#v", result)
			}
			stored, err := os.ReadFile(filepath.Join(app.videoDir, strings.TrimPrefix(url, "/videos/")))
			if err != nil || string(stored) != string(raw) {
				t.Fatalf("stored=%q err=%v", stored, err)
			}
			encoded, err := json.Marshal(result)
			if err != nil || strings.Contains(string(encoded), "base64") {
				t.Fatalf("inline video leaked into task result: %s err=%v", encoded, err)
			}
		})
	}
}

func TestStoreTranslatedVideoRejectsInvalidDataWithoutLeavingFiles(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	before, err := os.ReadDir(app.videoDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{"data:video/mp4;base64,@@@", "data:video/mp4;base64,", "data:text/html;base64,dGVzdA==", "data:video/mp4,raw"} {
		if _, err := app.storeTranslatedVideo(data); err == nil {
			t.Errorf("accepted invalid video %q", data)
		}
	}
	after, err := os.ReadDir(app.videoDir)
	if err != nil || len(after) != len(before) {
		t.Fatalf("temporary files leaked: %v err=%v", after, err)
	}
}
