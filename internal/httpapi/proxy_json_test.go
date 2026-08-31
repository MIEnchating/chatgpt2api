package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProxyTestRejectsMalformedJSONWithoutNetworkRequest(t *testing.T) {
	t.Setenv("PROXY", "")

	var requests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	defer proxy.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"proxy": proxy.URL}); err != nil {
		t.Fatalf("configure proxy: %v", err)
	}
	token := adminSessionToken(t, app)
	req := httptest.NewRequest(http.MethodPost, "/api/proxy/test", strings.NewReader(`{"url":""} {}`))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()

	app.Handler().ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", res.Code, http.StatusBadRequest, res.Body.String())
	}
	if requests.Load() != 0 {
		t.Fatalf("malformed request triggered %d proxy calls", requests.Load())
	}
}
