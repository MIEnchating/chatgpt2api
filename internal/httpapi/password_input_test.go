package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPasswordInputsPreserveWhitespace(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token, err := app.auth.LoginPassword(testAdminUsername, testAdminPassword)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/admin/users", strings.NewReader(`{"username":"space_user","password":"  review password  ","role_id":"default-user"}`))
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", response.Code, response.Body.String())
	}
	for _, item := range []struct {
		password string
		status   int
	}{
		{"  review password  ", http.StatusOK},
		{"review password", http.StatusUnauthorized},
	} {
		request = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"space_user","password":"`+item.password+`"}`))
		response = httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != item.status {
			t.Fatalf("login status: %d, want %d", response.Code, item.status)
		}
	}
}
