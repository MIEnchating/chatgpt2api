package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestLoginInitializesRelayKeysByGroup(t *testing.T) {
	for _, scenario := range []string{"reuse", "create", "denied", "failed", "mismatched-user", "sso-enabled-create", "sso-to-password"} {
		t.Run(scenario, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			dbURL := newHTTPTestNewAPIDatabase(t)
			insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
			if scenario == "reuse" {
				insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, "shared", "arbitrary-a", "key-a", -1, 0, true)
				insertHTTPTestNewAPITokenNamed(t, dbURL, 2, 1, "shared", "arbitrary-b", "key-b", -1, 0, true)
			}
			reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
			if err != nil {
				t.Fatal(err)
			}
			app.swapRelayTokenReader(reader)
			var calls, creates atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if scenario == "reuse" {
					t.Error("reuse contacted upstream")
					w.WriteHeader(500)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/user/login/encryption-key":
					w.Write([]byte(`{"success":true,"data":{"enabled":false}}`))
				case "/api/user/login":
					var payload map[string]string
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["username"] != "alice" || payload["password"] != "Password123" {
						t.Errorf("invalid login payload")
					}
					id := 1
					if scenario == "mismatched-user" {
						id = 2
					}
					json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"access_token": "test-dashboard-token", "user": map[string]any{"id": id}}})
				case "/api/user/self/groups":
					if scenario == "denied" {
						w.Write([]byte(`{"success":true,"data":{"other":{}}}`))
					} else {
						w.Write([]byte(`{"success":true,"data":{"shared":{}}}`))
					}
				case "/api/token/":
					if r.Header.Get("Authorization") != "Bearer test-dashboard-token" {
						t.Error("wrong dashboard auth")
					}
					if r.Method == http.MethodGet {
						w.Write([]byte(`{"success":true,"data":{"total":0,"items":[]}}`))
						return
					}
					creates.Add(1)
					if scenario == "failed" {
						w.WriteHeader(503)
						return
					}
					var payload struct {
						Name  string `json:"name"`
						Group string `json:"group"`
					}
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Group != "shared" || payload.Name == "" || payload.Name == "shared" {
						t.Errorf("creation payload = %#v", payload)
					}
					insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, payload.Group, payload.Name, "created-key", -1, 0, true)
					w.Write([]byte(`{"success":true}`))
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer upstream.Close()
			if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL, "relay_text_group": "shared", "relay_image_group": "shared", "relay_video_group": "", "relay_audio_group": ""}); err != nil {
				t.Fatal(err)
			}
			if scenario == "sso-enabled-create" || scenario == "sso-to-password" {
				t.Setenv("CHATGPT2API_SSO_SECRET", "sso-password-test-shared-secret-123456")
				t.Setenv("CHATGPT2API_SSO_ORIGIN", "https://studio.example.test")
				t.Setenv("NEWAPI_SSO_ORIGINS", "https://platform.example.test")
			}
			var previousSSOToken string
			if scenario == "sso-to-password" {
				_, previousSSOToken, err = app.auth.UpsertNewAPISession(service.NewAPIUser{
					ID: 1, Username: "alice", Email: "alice@example.test", Provider: service.AuthProviderNewAPI,
					SubjectPrefix: service.AuthProviderNewAPI, SSOReference: "previous-sso-reference",
					SSOIssuer: "https://platform.example.test", SSOExpiresAt: time.Now().Add(time.Hour).Unix(),
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			login := func() map[string]any {
				req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"alice","password":"Password123"}`))
				res := httptest.NewRecorder()
				app.Handler().ServeHTTP(res, req)
				if res.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
				}
				var payload map[string]any
				if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
					t.Fatal(err)
				}
				if scenario == "sso-enabled-create" || scenario == "sso-to-password" {
					cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
					if cookie == nil || cookie.Value == "" {
						t.Fatal("password login did not issue a session cookie")
					}
					identity := app.auth.Authenticate(cookie.Value)
					if identity == nil || identity.OwnerID != "newapi:1" || identity.SSOReference != "" || identity.SSOIssuer != "" {
						t.Fatalf("password identity retained SSO binding: %#v", identity)
					}
					if previousSSOToken != "" && app.auth.Authenticate(previousSSOToken) != nil {
						t.Fatal("previous SSO session remained valid after password login")
					}
					for _, path := range []string{"/auth/session", "/api/profile/image-generation-preferences"} {
						req := httptest.NewRequest(http.MethodGet, path, nil)
						setRequestAuthCookie(req, cookie.Value)
						res := httptest.NewRecorder()
						app.Handler().ServeHTTP(res, req)
						if res.Code != http.StatusOK {
							t.Fatalf("password session path=%s status=%d body=%s", path, res.Code, res.Body.String())
						}
					}
				}
				return payload
			}
			payload := login()
			preferences, err := app.imagePreferences.Preferences("newapi:1")
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "reuse":
				if calls.Load() != 0 || !reflect.DeepEqual(preferences.DefaultTextRelayTokens, []string{"arbitrary-a", "arbitrary-b"}) {
					t.Fatalf("calls=%d preferences=%#v", calls.Load(), preferences)
				}
			case "create", "sso-enabled-create", "sso-to-password":
				if creates.Load() != 1 || len(preferences.DefaultTextRelayTokens) != 1 {
					t.Fatalf("creates=%d preferences=%#v", creates.Load(), preferences)
				}
				previous := calls.Load()
				login()
				if calls.Load() != previous {
					t.Fatal("repeated login created/queried again")
				}
			default:
				if payload["relay_onboarding_warnings"] == nil || len(preferences.DefaultTextRelayTokens) != 0 {
					t.Fatalf("payload=%v preferences=%#v", payload, preferences)
				}
				if scenario != "failed" && creates.Load() != 0 {
					t.Fatalf("unauthorized creation: %d", creates.Load())
				}
				if scenario == "failed" && creates.Load() != 1 {
					t.Fatalf("repeated failed creation: %d", creates.Load())
				}
			}
			if !reflect.DeepEqual(preferences.DefaultTextRelayTokens, preferences.DefaultImageRelayTokens) {
				t.Fatal("shared categories did not reuse the same keys")
			}
		})
	}
}
