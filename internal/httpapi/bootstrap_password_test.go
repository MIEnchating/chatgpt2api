package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBootstrapAdminPreservesConfiguredPasswordWhitespace(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	t.Setenv("ADMIN_USERNAME", testAdminUsername)
	t.Setenv("ADMIN_PASSWORD", "  bootstrap password  ")
	t.Setenv("STORAGE_BACKEND", "sqlite")
	t.Setenv("STORAGE_DATABASE_URL", "")
	unsetTestEnv(t, "OBJECT_STORAGE_SETTINGS")
	app, err := NewApp()
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	for _, test := range []struct {
		name     string
		password string
		status   int
	}{
		{"original", "  bootstrap password  ", http.StatusOK},
		{"trimmed", "bootstrap password", http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+test.password+`"}`))
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("login status = %d, want %d", response.Code, test.status)
			}
		})
	}
}
