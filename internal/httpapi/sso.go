package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const ssoCookieName = "__Host-chatgpt2api-sso"

var errSSO = errors.New("single sign-on failed")

type ssoConfig struct {
	secret, origin string
	issuers        []string
}

func loadSSOConfig() (ssoConfig, error) {
	cfg := ssoConfig{secret: os.Getenv("CHATGPT2API_SSO_SECRET"), origin: os.Getenv("CHATGPT2API_SSO_ORIGIN")}
	if len(cfg.secret) < 32 || !validSSOOrigin(cfg.origin) {
		return cfg, errSSO
	}
	for issuer := range strings.SplitSeq(os.Getenv("NEWAPI_SSO_ORIGINS"), ",") {
		issuer = strings.TrimSpace(issuer)
		if !validSSOOrigin(issuer) || issuer == cfg.origin {
			return cfg, errSSO
		}
		cfg.issuers = append(cfg.issuers, issuer)
	}
	if len(cfg.issuers) == 0 {
		return cfg, errSSO
	}
	return cfg, nil
}
func validSSOOrigin(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && u.String() == raw
}
func ssoConfigured() bool {
	return os.Getenv("CHATGPT2API_SSO_SECRET") != "" || os.Getenv("CHATGPT2API_SSO_ORIGIN") != "" || os.Getenv("NEWAPI_SSO_ORIGINS") != ""
}

type ssoTransaction struct {
	Issuer    string `json:"issuer"`
	Audience  string `json:"audience"`
	State     string `json:"state"`
	Challenge string `json:"challenge"`
	Verifier  string `json:"verifier,omitempty"`
	ExpiresAt int64  `json:"expires_at"`
}

func sealSSO(value any, key, purpose string) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("chatgpt2api-sso/v1/" + purpose + "/" + encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func openSSO(raw, key, purpose string, value any) error {
	if len(raw) > 8192 {
		return errSSO
	}
	payload, signature, ok := strings.Cut(raw, ".")
	if !ok {
		return errSSO
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return errSSO
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("chatgpt2api-sso/v1/" + purpose + "/" + payload))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return errSSO
	}
	data, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(data, value) != nil {
		return errSSO
	}
	return nil
}
func ssoHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
}
func ssoCookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: ssoCookieName, Value: value, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func (a *App) handleSSOStart(w http.ResponseWriter, r *http.Request) {
	ssoHeaders(w)
	cfg, err := loadSSOConfig()
	if err != nil || !isHTTPSRequest(r) || "https://"+r.Host != cfg.origin {
		util.WriteError(w, http.StatusServiceUnavailable, "单点登录未正确配置")
		return
	}
	issuer := r.URL.Query().Get("issuer")
	if issuer == "" {
		issuer = cfg.issuers[0]
	}
	if !slices.Contains(cfg.issuers, issuer) {
		util.WriteError(w, http.StatusBadRequest, "单点登录来源无效")
		return
	}
	transaction := ssoTransaction{Issuer: issuer, Audience: cfg.origin, ExpiresAt: time.Now().Add(10 * time.Minute).Unix()}
	for _, field := range []*string{&transaction.State, &transaction.Verifier} {
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			util.WriteError(w, http.StatusInternalServerError, "单点登录失败")
			return
		}
		*field = base64.RawURLEncoding.EncodeToString(random[:])
	}
	digest := sha256.Sum256([]byte(transaction.Verifier))
	transaction.Challenge = base64.RawURLEncoding.EncodeToString(digest[:])
	cookie, err := sealSSO(transaction, cfg.secret, "browser")
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "单点登录失败")
		return
	}
	transaction.Verifier = ""
	request, err := sealSSO(transaction, cfg.secret, "request")
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "单点登录失败")
		return
	}
	ssoCookie(w, cookie, 600)
	http.Redirect(w, r, issuer+"/sso/chatgpt2api?request="+url.QueryEscape(request), http.StatusSeeOther)
}

type ssoUser struct {
	ID          int64  `json:"user_id"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Reference   string `json:"reference"`
	ExpiresAt   int64  `json:"expires_at"`
}

// The issuer is an explicit allowlist entry, never a URL supplied by an
// unverified callback. Redirects are rejected before sending client credentials.
func (cfg ssoConfig) request(r *http.Request, issuer, endpoint string, payload any) (*ssoUser, error) {
	if !slices.Contains(cfg.issuers, issuer) {
		return nil, errSSO
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, errSSO
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, issuer+"/api/sso/chatgpt2api/"+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errSSO
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+cfg.secret)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errSSO
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errSSO
	}
	var result struct {
		Success bool    `json:"success"`
		Data    ssoUser `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 16384)).Decode(&result) != nil || !result.Success || result.Data.ID <= 0 || result.Data.Username == "" || result.Data.ExpiresAt <= time.Now().Unix() {
		return nil, errSSO
	}
	return &result.Data, nil
}

func (a *App) handleSSOCallback(w http.ResponseWriter, r *http.Request) {
	ssoHeaders(w)
	cfg, err := loadSSOConfig()
	if err != nil || !isHTTPSRequest(r) || "https://"+r.Host != cfg.origin {
		util.WriteError(w, http.StatusUnauthorized, "单点登录失败，请从平台重新进入")
		return
	}
	cookie, err := r.Cookie(ssoCookieName)
	var transaction ssoTransaction
	if err != nil || openSSO(cookie.Value, cfg.secret, "browser", &transaction) != nil || transaction.Audience != cfg.origin ||
		transaction.ExpiresAt <= time.Now().Unix() || transaction.ExpiresAt > time.Now().Add(10*time.Minute).Unix() || transaction.Verifier == "" ||
		!hmac.Equal([]byte(transaction.State), []byte(r.URL.Query().Get("state"))) || transaction.Issuer != r.URL.Query().Get("iss") {
		util.WriteError(w, http.StatusUnauthorized, "单点登录已失效，请从平台重新进入")
		return
	}
	ssoCookie(w, "", -1)
	user, err := cfg.request(r, transaction.Issuer, "exchange", map[string]string{"code": r.URL.Query().Get("code"), "verifier": transaction.Verifier, "issuer": transaction.Issuer})
	if err != nil || user.Reference == "" {
		util.WriteError(w, http.StatusUnauthorized, "单点登录已失效，请从平台重新进入")
		return
	}
	identity, token, err := a.auth.UpsertNewAPISession(service.NewAPIUser{
		ID: user.ID, Username: user.Username, Email: user.Email, DisplayName: user.DisplayName,
		Provider: service.AuthProviderNewAPI, SubjectPrefix: service.AuthProviderNewAPI,
		SSOReference: user.Reference, SSOIssuer: transaction.Issuer, SSOExpiresAt: user.ExpiresAt,
	})
	if err != nil {
		util.WriteError(w, http.StatusForbidden, "无法建立登录会话，请联系管理员")
		return
	}
	*r = *r.WithContext(withRequestIdentity(r.Context(), *identity))
	setAuthSessionCookie(w, r, token)
	http.Redirect(w, r, "/studio", http.StatusSeeOther)
}

func (a *App) authenticateSession(r *http.Request, token string) *service.Identity {
	identity := a.auth.Authenticate(token)
	if identity == nil {
		return nil
	}
	if identity.SSOReference == "" {
		// Enabling SSO invalidates legacy New API password sessions as well.
		if ssoConfigured() && identity.Provider == service.AuthProviderNewAPI {
			return nil
		}
		return identity
	}
	cfg, err := loadSSOConfig()
	if err != nil {
		return nil
	}
	user, err := cfg.request(r, identity.SSOIssuer, "session", map[string]string{"issuer": identity.SSOIssuer, "reference": identity.SSOReference})
	if err != nil || identity.OwnerID != "newapi:"+util.Clean(user.ID) {
		return nil
	}
	return identity
}
