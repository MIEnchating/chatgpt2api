package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

func postProxyTest(app *App, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/proxy/test", strings.NewReader(body))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	return res
}

func TestProxyTestRequiresAdmin(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.auth.CreatePasswordUser("proxy_user", "Password123", "Proxy User", service.DefaultManagedRoleID, true); err != nil {
		t.Fatalf("CreatePasswordUser() error = %v", err)
	}
	_, token, err := app.auth.LoginPassword("proxy_user", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword() error = %v", err)
	}
	res := postProxyTest(app, token, `{"url":"http://203.0.113.10:8080"}`)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", res.Code, res.Body.String())
	}
}

func TestProxyTestRejectsLoopbackAndPrivateTargets(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, target := range []string{
		"http://127.0.0.1:8080",
		"http://localhost:8080",
		"socks5://10.0.0.5:1080",
		"http://192.168.1.1:3128",
		"http://[::1]:8080",
		"http://198.18.0.1:8080",
	} {
		res := postProxyTest(app, token, `{"url":"`+target+`"}`)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400; body = %s", target, res.Code, res.Body.String())
		}
	}
}

func TestProxyTestResultDoesNotExposeConnectionDetails(t *testing.T) {
	proxy := service.NewProxyService(nil)
	defer proxy.Close()
	result := proxy.Test("http://203.0.113.10:1", 1)
	if got, _ := result["error"].(string); got != "proxy connection failed" {
		t.Fatalf("error = %q, want generic message", got)
	}
}
