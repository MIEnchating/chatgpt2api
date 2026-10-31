package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSPAResponsesCarryFrameAndContentSecurityHeaders(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, path := range []string{"/", "/studio"} {
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if res.Code != http.StatusOK {
			t.Fatalf("%s status = %d", path, res.Code)
		}
		policy := res.Header().Get("Content-Security-Policy")
		for _, want := range []string{"frame-ancestors 'none'", "object-src 'none'", "script-src 'self'"} {
			if !strings.Contains(policy, want) {
				t.Fatalf("%s CSP = %q, missing %q", path, policy, want)
			}
		}
		if got := res.Header().Get("X-Frame-Options"); got != "DENY" {
			t.Fatalf("%s X-Frame-Options = %q", path, got)
		}
	}
}
