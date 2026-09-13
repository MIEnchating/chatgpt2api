package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"chatgpt2api/internal/service"
)

func TestRelayCreationGroupsRequireAdminAndUseDatabase(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	databaseURL := newHTTPTestNewAPIDatabase(t)
	db := openHTTPTestNewAPIDatabase(t, databaseURL)
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE options (`key` TEXT PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO options (`key`, value) VALUES (?, ?)", "GroupRatio", `{"shared":1,"draw":2}`); err != nil {
		t.Fatal(err)
	}
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	app.swapRelayTokenReader(reader)
	_, userToken := createPasswordUserSession(t, app, "groups-user", "Password123!", "User")
	for _, tc := range []struct {
		name, token string
		status      int
	}{
		{"anonymous", "", http.StatusUnauthorized},
		{"user", userToken, http.StatusForbidden},
		{"admin", adminSessionToken(t, app), http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/settings/relay-groups", nil)
			if tc.token != "" {
				setRequestAuthCookie(req, tc.token)
			}
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != tc.status {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			if tc.status == http.StatusOK {
				var payload struct {
					Groups []string `json:"groups"`
				}
				if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(payload.Groups, []string{"draw", "shared"}) {
					t.Fatalf("groups=%v", payload.Groups)
				}
			}
		})
	}
	if _, err := db.Exec("DROP TABLE options"); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/settings/relay-groups", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed database query status=%d", res.Code)
	}
}
