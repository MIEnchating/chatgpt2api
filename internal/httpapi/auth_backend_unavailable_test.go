package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequireIdentityAnswers503WhenAuthStorageIsUnreadable(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	login := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, login)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("login cookie = %#v", cookie)
	}

	const endpoint = "/api/profile/announcement-preferences"
	req := httptest.NewRequest(http.MethodGet, endpoint, nil)
	req.AddCookie(cookie)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code == http.StatusUnauthorized || res.Code == http.StatusServiceUnavailable {
		t.Fatalf("healthy storage status = %d body = %s", res.Code, res.Body.String())
	}

	// Closing the database makes the next auth refresh fail, which must not be reported as an invalid session.
	app.closeStorageBackend()

	req = httptest.NewRequest(http.MethodGet, endpoint, nil)
	req.AddCookie(cookie)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("unreadable auth storage status = %d, want 503; body = %s", res.Code, res.Body.String())
	}
}
