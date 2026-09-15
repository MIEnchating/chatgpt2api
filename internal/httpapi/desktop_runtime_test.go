package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestDesktopHealthIdentifiesOnlyTheOwnedProcess(t *testing.T) {
	t.Setenv("DESKTOP_INSTANCE_TOKEN", "instance-test-nonce")
	for _, mode := range []string{"", "1"} {
		t.Setenv("DESKTOP_RUNTIME", mode)
		response := httptest.NewRecorder()
		(&App{}).handleHealth(response, httptest.NewRequest("GET", "/health", nil))
		want := ""
		if mode == "1" {
			want = "instance-test-nonce"
		}
		if got := response.Header().Get("X-Desktop-Instance"); got != want {
			t.Fatalf("mode %q header = %q", mode, got)
		}
	}
}
