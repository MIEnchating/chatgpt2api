package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestSSOConfigurationPreservesPasswordLogin(t *testing.T) {
	for _, scenario := range []string{"username", "email", "existing-session", "wrong-password", "invalid-sso-config"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("CHATGPT2API_SSO_SECRET", "")
			t.Setenv("CHATGPT2API_SSO_ORIGIN", "")
			t.Setenv("NEWAPI_SSO_ORIGINS", "")
			app := newTestApp(t)
			defer app.Close()
			dbURL := newHTTPTestNewAPIDatabase(t)
			insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
			insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, "shared", "existing-key", "private-key", -1, 0, true)
			reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
			if err != nil {
				t.Fatal(err)
			}
			app.swapRelayTokenReader(reader)
			if _, err := app.config.Update(map[string]any{"relay_text_group": "shared", "relay_image_group": "shared", "relay_video_group": "", "relay_audio_group": ""}); err != nil {
				t.Fatal(err)
			}
			var ssoCalls atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ssoCalls.Add(1)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer upstream.Close()
			previousTransport := http.DefaultTransport
			http.DefaultTransport = upstream.Client().Transport
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			enableSSO := func() {
				t.Setenv("CHATGPT2API_SSO_SECRET", "sso-password-test-shared-secret-123456")
				t.Setenv("CHATGPT2API_SSO_ORIGIN", "https://studio.example.test")
				t.Setenv("NEWAPI_SSO_ORIGINS", upstream.URL)
				if scenario == "invalid-sso-config" {
					t.Setenv("CHATGPT2API_SSO_SECRET", "invalid")
				}
			}
			if scenario != "existing-session" {
				enableSSO()
			}
			username, password := "alice", "Password123"
			if scenario == "email" {
				username = "alice@example.test"
			}
			if scenario == "wrong-password" {
				password = "WrongPassword123"
			}
			body, err := json.Marshal(map[string]string{"username": username, "password": password})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(string(body)))
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
			if scenario == "wrong-password" {
				if res.Code != http.StatusUnauthorized || cookie != nil && cookie.Value != "" || ssoCalls.Load() != 0 {
					t.Fatalf("wrong password status=%d cookie=%#v sso_calls=%d", res.Code, cookie, ssoCalls.Load())
				}
				return
			}
			if res.Code != http.StatusOK || cookie == nil || cookie.Value == "" {
				t.Fatalf("password login status=%d body=%s cookie=%#v", res.Code, res.Body.String(), cookie)
			}
			identity := app.auth.Authenticate(cookie.Value)
			if identity == nil || identity.OwnerID != "newapi:1" || identity.Username != "alice" || identity.SSOReference != "" || identity.SSOIssuer != "" {
				t.Fatalf("password identity=%#v", identity)
			}
			if scenario == "existing-session" {
				enableSSO()
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
			preferences, err := app.imagePreferences.Preferences("newapi:1")
			if err != nil || !reflect.DeepEqual(preferences.DefaultTextRelayTokens, []string{"existing-key"}) || !reflect.DeepEqual(preferences.DefaultImageRelayTokens, []string{"existing-key"}) || ssoCalls.Load() != 0 {
				t.Fatalf("password preferences=%#v error=%v sso_calls=%d", preferences, err, ssoCalls.Load())
			}
		})
	}
}

const testSSOSecret = "sso-session-test-shared-secret-123456"
const testSSOOrigin = "https://studio.example.test"

func newTestSSOIssuer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	upstream := httptest.NewTLSServer(handler)
	t.Cleanup(upstream.Close)
	previousTransport := http.DefaultTransport
	http.DefaultTransport = upstream.Client().Transport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	t.Setenv("CHATGPT2API_SSO_SECRET", testSSOSecret)
	t.Setenv("CHATGPT2API_SSO_ORIGIN", testSSOOrigin)
	t.Setenv("NEWAPI_SSO_ORIGINS", upstream.URL)
	return upstream.URL
}

func TestSSOStartValidatesExistingSession(t *testing.T) {
	for _, scenario := range []string{"same-user", "same-admin", "password-session", "different-issuer", "local-expired", "issuer-expired", "revoked", "wrong-user", "promoted", "demoted", "invalid-issuer"} {
		t.Run(scenario, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			var sessions, exchanges atomic.Int32
			issuer := newTestSSOIssuer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/sso/chatgpt2api/exchange" {
					exchanges.Add(1)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				sessions.Add(1)
				var payload map[string]string
				if r.Method != http.MethodPost || r.URL.Path != "/api/sso/chatgpt2api/session" || r.Header.Get("Authorization") != "Bearer "+testSSOSecret ||
					json.NewDecoder(r.Body).Decode(&payload) != nil || payload["reference"] != "existing-reference" || payload["issuer"] != "https://"+r.Host {
					t.Error("invalid session introspection request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if scenario == "revoked" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				user := ssoUser{ID: 1, Username: "alice", IsAdmin: scenario == "same-admin" || scenario == "promoted", ExpiresAt: time.Now().Add(time.Hour).Unix()}
				if scenario == "wrong-user" {
					user.ID = 2
				}
				if scenario == "issuer-expired" {
					user.ExpiresAt = time.Now().Add(-time.Minute).Unix()
				}
				json.NewEncoder(w).Encode(map[string]any{"success": true, "data": user})
			})
			user := service.NewAPIUser{ID: 1, Username: "alice", IsAdmin: scenario == "same-admin" || scenario == "demoted",
				SSOReference: "existing-reference", SSOIssuer: issuer, SSOExpiresAt: time.Now().Add(time.Hour).Unix()}
			if scenario == "password-session" {
				user.SSOReference, user.SSOIssuer = "", ""
			}
			if scenario == "local-expired" {
				user.SSOExpiresAt = time.Now().Add(-time.Minute).Unix()
			}
			_, token, err := app.auth.UpsertNewAPISession(user)
			if err != nil {
				t.Fatal(err)
			}
			requestedIssuer := issuer
			if scenario == "different-issuer" {
				requestedIssuer = "https://other.example.test"
				t.Setenv("NEWAPI_SSO_ORIGINS", issuer+","+requestedIssuer)
			}
			if scenario == "invalid-issuer" {
				requestedIssuer = "https://untrusted.example.test"
			}
			req := httptest.NewRequest(http.MethodGet, testSSOOrigin+"/auth/sso/start?issuer="+url.QueryEscape(requestedIssuer), nil)
			setRequestAuthCookie(req, token)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if exchanges.Load() != 0 || sessions.Load() != 0 {
				t.Fatal("SSO start must redirect to verify the current browser account instead of trusting a previous session reference")
			}
			if scenario == "invalid-issuer" {
				if res.Code != http.StatusBadRequest || sessions.Load() != 0 || res.Header().Get("Location") != "" {
					t.Fatalf("untrusted issuer status=%d sessions=%d location=%q", res.Code, sessions.Load(), res.Header().Get("Location"))
				}
				return
			}
			if res.Code != http.StatusSeeOther {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			cookie := findResponseCookieByDomain(res.Result(), ssoCookieName, "")
			location, err := url.Parse(res.Header().Get("Location"))
			if err != nil || location.Scheme+"://"+location.Host != requestedIssuer || location.Path != "/sso/chatgpt2api" || location.Query().Get("request") == "" || cookie == nil || cookie.Value == "" {
				t.Fatalf("expected reauthorization: location=%q transaction=%#v error=%v", res.Header().Get("Location"), cookie, err)
			}
			if scenario == "promoted" || scenario == "demoted" || scenario == "revoked" || scenario == "issuer-expired" || scenario == "local-expired" || scenario == "wrong-user" {
				for _, path := range []string{"/auth/session", "/api/settings"} {
					req := httptest.NewRequest(http.MethodGet, path, nil)
					setRequestAuthCookie(req, token)
					res := httptest.NewRecorder()
					app.Handler().ServeHTTP(res, req)
					if res.Code != http.StatusUnauthorized {
						t.Fatalf("stale role path=%s status=%d body=%s", path, res.Code, res.Body.String())
					}
				}
			}
		})
	}
}

func TestSSOCallbackRefreshesTrustedIdentityAndRole(t *testing.T) {
	for _, scenario := range []string{"first-admin", "password-user-promoted", "sso-user-promoted", "switch-password-user", "switch-sso-user", "sso-admin-demoted", "forged-admin-query", "same-user", "same-admin", "sso-new-reference", "sso-different-issuer"} {
		t.Run(scenario, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			isAdmin := scenario != "sso-admin-demoted" && scenario != "forged-admin-query" && scenario != "same-user"
			reuseSession := scenario == "same-user" || scenario == "same-admin"
			var exchanges atomic.Int32
			var transaction ssoTransaction
			issuer := newTestSSOIssuer(t, func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]string
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+testSSOSecret || json.NewDecoder(r.Body).Decode(&payload) != nil || payload["issuer"] != "https://"+r.Host {
					t.Error("invalid issuer request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				switch r.URL.Path {
				case "/api/sso/chatgpt2api/exchange":
					exchanges.Add(1)
					digest := sha256.Sum256([]byte(payload["verifier"]))
					if payload["code"] != "one-time-code" || base64.RawURLEncoding.EncodeToString(digest[:]) != transaction.Challenge {
						t.Error("authorization exchange did not preserve the code and PKCE binding")
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
				case "/api/sso/chatgpt2api/session":
					if payload["reference"] != "old-reference" && payload["reference"] != "new-reference" {
						t.Error("session introspection did not use the trusted reference")
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
				default:
					t.Errorf("unexpected issuer endpoint %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				user := ssoUser{ID: 1, Username: "alice", IsAdmin: isAdmin, Reference: "new-reference", ExpiresAt: time.Now().Add(time.Hour).Unix()}
				if scenario == "switch-sso-user" && r.URL.Path == "/api/sso/chatgpt2api/session" && payload["reference"] == "old-reference" {
					user.ID, user.Username, user.IsAdmin = 2, "bob", false
				}
				json.NewEncoder(w).Encode(map[string]any{"success": true, "data": user})
			})
			var oldToken string
			if scenario != "first-admin" && scenario != "forged-admin-query" {
				user := service.NewAPIUser{ID: 1, Username: "alice", IsAdmin: scenario == "sso-admin-demoted" || scenario == "same-admin" || scenario == "sso-new-reference" || scenario == "sso-different-issuer"}
				if scenario == "switch-password-user" || scenario == "switch-sso-user" {
					user.ID, user.Username = 2, "bob"
				}
				if strings.HasPrefix(scenario, "sso-") || scenario == "switch-sso-user" || reuseSession {
					user.SSOReference, user.SSOIssuer, user.SSOExpiresAt = "old-reference", issuer, time.Now().Add(time.Hour).Unix()
				}
				if reuseSession || scenario == "sso-different-issuer" {
					user.SSOReference = "new-reference"
				}
				if scenario == "sso-different-issuer" {
					user.SSOIssuer = "https://previous.example.test"
					t.Setenv("NEWAPI_SSO_ORIGINS", issuer+","+user.SSOIssuer)
				}
				var err error
				_, oldToken, err = app.auth.UpsertNewAPISession(user)
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "switch-sso-user" {
					req := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
					identity := app.authenticateSession(req, oldToken)
					if identity == nil || identity.OwnerID != "newapi:2" || identity.Role != service.AuthRoleUser {
						t.Fatalf("the previous platform account must still have a valid session: %#v", identity)
					}
				}
			}
			req := httptest.NewRequest(http.MethodGet, testSSOOrigin+"/auth/sso/start?issuer="+url.QueryEscape(issuer)+"&is_admin=true", nil)
			setRequestAuthCookie(req, oldToken)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			cookie := findResponseCookieByDomain(res.Result(), ssoCookieName, "")
			if res.Code != http.StatusSeeOther || cookie == nil || openSSO(cookie.Value, testSSOSecret, "browser", &transaction) != nil {
				t.Fatalf("start status=%d body=%s", res.Code, res.Body.String())
			}
			req = httptest.NewRequest(http.MethodGet, testSSOOrigin+"/auth/sso/callback?iss="+url.QueryEscape(issuer)+"&state="+url.QueryEscape(transaction.State)+"&code=one-time-code&is_admin=true&role=admin", nil)
			req.AddCookie(cookie)
			setRequestAuthCookie(req, oldToken)
			res = httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			authCookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
			if res.Code != http.StatusSeeOther || res.Header().Get("Location") != "/studio" || authCookie == nil || authCookie.Value == "" || exchanges.Load() != 1 {
				t.Fatalf("callback status=%d location=%q exchanges=%d body=%s", res.Code, res.Header().Get("Location"), exchanges.Load(), res.Body.String())
			}
			if (authCookie.Value == oldToken) != reuseSession {
				t.Fatalf("session reuse=%t want=%t", authCookie.Value == oldToken, reuseSession)
			}
			if !authCookie.HttpOnly || !authCookie.Secure || authCookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("session cookie must preserve secure browser attributes")
			}
			wantRole := service.AuthRoleUser
			if isAdmin {
				wantRole = service.AuthRoleAdmin
			}
			identity := app.auth.Authenticate(authCookie.Value)
			if identity == nil || identity.OwnerID != "newapi:1" || identity.Username != "alice" || identity.Role != wantRole || identity.SSOReference != "new-reference" || identity.SSOIssuer != issuer {
				t.Fatalf("callback identity=%#v want role=%s", identity, wantRole)
			}
			if oldToken != "" && scenario != "switch-password-user" && scenario != "switch-sso-user" && !reuseSession && app.auth.Authenticate(oldToken) != nil {
				t.Fatal("the same account's old session must be invalidated when its role is refreshed")
			}
			req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
			setRequestAuthCookie(req, authCookie.Value)
			res = httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			var payload struct {
				Role      string `json:"role"`
				SubjectID string `json:"subject_id"`
			}
			if res.Code != http.StatusOK || json.Unmarshal(res.Body.Bytes(), &payload) != nil || payload.Role != wantRole || payload.SubjectID != "newapi:1" {
				t.Fatalf("session API status=%d body=%s", res.Code, res.Body.String())
			}
		})
	}
}

func TestSSOCallbackRejectsInvalidTransactions(t *testing.T) {
	for _, scenario := range []string{"state-mismatch", "expired", "bad-signature", "untrusted-issuer", "exchange-rejected"} {
		t.Run(scenario, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			var exchanges atomic.Int32
			issuer := newTestSSOIssuer(t, func(w http.ResponseWriter, r *http.Request) {
				exchanges.Add(1)
				w.WriteHeader(http.StatusUnauthorized)
			})
			transaction := ssoTransaction{Issuer: issuer, Audience: testSSOOrigin, State: "expected-state", Verifier: "secret-verifier", ExpiresAt: time.Now().Add(time.Minute).Unix()}
			if scenario == "expired" {
				transaction.ExpiresAt = time.Now().Add(-time.Minute).Unix()
			}
			if scenario == "untrusted-issuer" {
				transaction.Issuer = "https://untrusted.example.test"
			}
			key := testSSOSecret
			if scenario == "bad-signature" {
				key = "different-key"
			}
			sealed, err := sealSSO(transaction, key, "browser")
			if err != nil {
				t.Fatal(err)
			}
			state := transaction.State
			if scenario == "state-mismatch" {
				state = "wrong-state"
			}
			req := httptest.NewRequest(http.MethodGet, testSSOOrigin+"/auth/sso/callback?iss="+url.QueryEscape(transaction.Issuer)+"&state="+state+"&code=code&is_admin=true", nil)
			req.AddCookie(&http.Cookie{Name: ssoCookieName, Value: sealed})
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			wantExchanges := int32(0)
			if scenario == "exchange-rejected" {
				wantExchanges = 1
			}
			cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
			if res.Code != http.StatusUnauthorized || exchanges.Load() != wantExchanges || cookie != nil && cookie.Value != "" {
				t.Fatalf("invalid callback status=%d exchanges=%d session=%#v", res.Code, exchanges.Load(), cookie)
			}
		})
	}
}

func TestSSOPreferencesInitializeRelayKeys(t *testing.T) {
	for _, scenario := range []string{"create", "reuse", "denied", "revoked", "expired", "mismatched-session", "not-visible", "cleared"} {
		t.Run(scenario, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			dbURL := newHTTPTestNewAPIDatabase(t)
			insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
			if scenario == "reuse" {
				insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, "shared", "existing-key", "private-key", -1, 0, true)
			}
			reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
			if err != nil {
				t.Fatal(err)
			}
			app.swapRelayTokenReader(reader)
			if _, err := app.config.Update(map[string]any{"relay_text_group": "shared", "relay_image_group": "shared", "relay_video_group": "", "relay_audio_group": ""}); err != nil {
				t.Fatal(err)
			}
			const secret = "sso-onboarding-test-shared-secret-123456"
			const reference = "sso-onboarding-reference"
			var sessions, creates atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+secret {
					t.Errorf("invalid SSO request method or authorization")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				var payload map[string]string
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["issuer"] != "https://"+r.Host || payload["reference"] != reference {
					t.Errorf("invalid SSO request identity payload")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/sso/chatgpt2api/session":
					sessions.Add(1)
					if scenario == "revoked" {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					userID := 1
					if scenario == "mismatched-session" {
						userID = 2
					}
					expiresAt := time.Now().Add(time.Hour).Unix()
					if scenario == "expired" {
						expiresAt = time.Now().Add(-time.Minute).Unix()
					}
					json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"user_id": userID, "username": "alice", "expires_at": expiresAt}})
				case "/api/sso/chatgpt2api/tokens":
					creates.Add(1)
					if payload["group"] != "shared" || payload["name"] != service.RelayCreationTokenName("shared") {
						t.Errorf("invalid SSO token group/name payload")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if scenario == "denied" {
						w.WriteHeader(http.StatusForbidden)
						w.Write([]byte(`{"success":false,"code":"token_group_forbidden"}`))
						return
					}
					if scenario != "not-visible" {
						insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, payload["group"], payload["name"], "private-created-key", -1, 0, true)
					}
					json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"user_id": 1, "id": 1, "name": payload["name"], "group": payload["group"], "created": true}})
				default:
					t.Errorf("unexpected SSO endpoint: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer upstream.Close()
			previousTransport := http.DefaultTransport
			http.DefaultTransport = upstream.Client().Transport
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			t.Setenv("CHATGPT2API_SSO_SECRET", secret)
			t.Setenv("CHATGPT2API_SSO_ORIGIN", "https://studio.example.test")
			t.Setenv("NEWAPI_SSO_ORIGINS", upstream.URL)
			_, token, err := app.auth.UpsertNewAPISession(service.NewAPIUser{
				ID: 1, Username: "alice", Email: "alice@example.test", Provider: service.AuthProviderNewAPI,
				SubjectPrefix: service.AuthProviderNewAPI, SSOReference: reference, SSOIssuer: upstream.URL,
				SSOExpiresAt: time.Now().Add(time.Hour).Unix(),
			})
			if err != nil {
				t.Fatal(err)
			}
			request := func(method, body string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(method, "/api/profile/image-generation-preferences", strings.NewReader(body))
				setRequestAuthCookie(req, token)
				res := httptest.NewRecorder()
				app.Handler().ServeHTTP(res, req)
				return res
			}
			if scenario == "cleared" {
				res := request(http.MethodPatch, `{"default_text_relay_token_names":[],"default_image_relay_token_names":[]}`)
				if res.Code != http.StatusOK {
					t.Fatalf("clear status=%d body=%s", res.Code, res.Body.String())
				}
			}
			res := request(http.MethodGet, "")
			if scenario == "revoked" || scenario == "expired" || scenario == "mismatched-session" {
				if res.Code != http.StatusUnauthorized || creates.Load() != 0 || sessions.Load() != 1 {
					t.Fatalf("invalid session status=%d sessions=%d creates=%d", res.Code, sessions.Load(), creates.Load())
				}
				return
			}
			if res.Code != http.StatusOK || sessions.Load() == 0 {
				t.Fatalf("status=%d body=%s sessions=%d", res.Code, res.Body.String(), sessions.Load())
			}
			var payload struct {
				Preferences service.ImageGenerationPreferences `json:"preferences"`
				Warnings    []string                           `json:"relay_onboarding_warnings"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			preferences, err := app.imagePreferences.Preferences("newapi:1")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(preferences.DefaultTextRelayTokens, preferences.DefaultImageRelayTokens) || !reflect.DeepEqual(preferences.DefaultTextRelayTokens, payload.Preferences.DefaultTextRelayTokens) {
				t.Fatalf("shared categories or persisted response mismatch: %#v", preferences)
			}
			switch scenario {
			case "create", "reuse":
				name, wantCreates := service.RelayCreationTokenName("shared"), int32(1)
				if scenario == "reuse" {
					name, wantCreates = "existing-key", 0
				}
				if creates.Load() != wantCreates || len(payload.Warnings) != 0 || !reflect.DeepEqual(preferences.DefaultTextRelayTokens, []string{name}) {
					t.Fatalf("creates=%d warnings=%v preferences=%#v", creates.Load(), payload.Warnings, preferences)
				}
				if repeated := request(http.MethodGet, ""); repeated.Code != http.StatusOK || creates.Load() != wantCreates {
					t.Fatalf("repeated access status=%d creates=%d", repeated.Code, creates.Load())
				}
			case "cleared":
				if creates.Load() != 0 || len(preferences.DefaultTextRelayTokens) != 0 || len(payload.Warnings) != 0 {
					t.Fatalf("cleared selections changed: creates=%d payload=%#v", creates.Load(), payload)
				}
			default:
				if creates.Load() != 1 || len(preferences.DefaultTextRelayTokens) != 0 || len(payload.Warnings) != 1 {
					t.Fatalf("creation failure creates=%d payload=%#v", creates.Load(), payload)
				}
			}
		})
	}
}

func TestSSORelayOnboardingRejectsUntrustedIssuer(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	app.swapRelayTokenReader(reader)
	if _, err := app.config.Update(map[string]any{"relay_text_group": "shared", "relay_image_group": "shared", "relay_video_group": "", "relay_audio_group": ""}); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	untrusted := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer untrusted.Close()
	previousTransport := http.DefaultTransport
	http.DefaultTransport = untrusted.Client().Transport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	t.Setenv("CHATGPT2API_SSO_SECRET", "sso-onboarding-test-shared-secret-123456")
	t.Setenv("CHATGPT2API_SSO_ORIGIN", "https://studio.example.test")
	t.Setenv("NEWAPI_SSO_ORIGINS", "https://trusted.example.test")
	identity := service.Identity{ID: "newapi:1", OwnerID: "newapi:1", Username: "alice", Provider: service.AuthProviderNewAPI, SSOReference: "reference", SSOIssuer: untrusted.URL}
	warnings := app.initializeRelayGroups(context.Background(), reader, identity, nil, "")
	if calls.Load() != 0 || len(warnings) != 1 {
		t.Fatalf("untrusted issuer calls=%d warnings=%v", calls.Load(), warnings)
	}
	preferences, err := app.imagePreferences.Preferences("newapi:1")
	if err != nil || len(preferences.DefaultTextRelayTokens) != 0 || len(preferences.DefaultImageRelayTokens) != 0 {
		t.Fatalf("untrusted issuer preferences=%#v error=%v", preferences, err)
	}
}
