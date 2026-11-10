package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
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

func TestRelayCreationGroupSettingsRequireAdmin(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_text_group": []string{"original"}}); err != nil {
		t.Fatal(err)
	}
	role, err := app.auth.CreateRole(map[string]any{
		"name": "Settings Operator", "menu_paths": []string{"/settings"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodGet, "/api/settings"), service.APIPermissionKey(http.MethodPost, "/api/settings")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.auth.CreatePasswordUser("group_operator", "Password123!", "Operator", util.Clean(role["id"]), true); err != nil {
		t.Fatal(err)
	}
	_, token, err := app.auth.LoginPassword("group_operator", "Password123!")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/settings", strings.NewReader(body))
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	read := request(http.MethodGet, "", token)
	if read.Code != http.StatusOK || strings.Contains(read.Body.String(), "relay_text_group") {
		t.Fatalf("operator read status=%d body=%s", read.Code, read.Body.String())
	}
	for _, key := range []string{"relay_text_group", "relay_image_group", "relay_video_group", "relay_audio_group"} {
		res := request(http.MethodPost, `{"`+key+`": ["changed"]}`, token)
		if res.Code != http.StatusForbidden {
			t.Fatalf("operator update %s status=%d body=%s", key, res.Code, res.Body.String())
		}
	}
	if res := request(http.MethodPost, `{}`, token); res.Code != http.StatusOK || strings.Contains(res.Body.String(), "relay_text_group") {
		t.Fatalf("operator ordinary update status=%d body=%s", res.Code, res.Body.String())
	}
	admin := adminSessionToken(t, app)
	if res := request(http.MethodGet, "", admin); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "original") {
		t.Fatalf("admin read status=%d body=%s", res.Code, res.Body.String())
	}
	if res := request(http.MethodPost, `{"relay_text_group":["changed"]}`, admin); res.Code != http.StatusOK {
		t.Fatalf("admin update status=%d body=%s", res.Code, res.Body.String())
	}
}
