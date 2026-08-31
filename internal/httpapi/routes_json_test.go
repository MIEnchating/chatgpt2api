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

func TestAdminRoleAndUserMutationsRejectMalformedJSONWithoutStateChanges(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, app *App) (string, string, func() any)
	}{
		{
			name: "create role",
			setup: func(t *testing.T, app *App) (string, string, func() any) {
				return "/api/admin/roles", `{"name":"unexpected role"} {}`, func() any {
					return app.auth.ListRoles()
				}
			},
		},
		{
			name: "update role",
			setup: func(t *testing.T, app *App) (string, string, func() any) {
				role, err := app.auth.CreateRole(map[string]any{"name": "existing role"})
				if err != nil {
					t.Fatalf("CreateRole() error = %v", err)
				}
				roleID := util.Clean(role["id"])
				return "/api/admin/roles/" + roleID, `{"name":"unexpected name"} {}`, func() any {
					return app.auth.ListRoles()
				}
			},
		},
		{
			name: "update user",
			setup: func(t *testing.T, app *App) (string, string, func() any) {
				user, err := app.auth.CreatePasswordUser(
					"malformed_json_user",
					"Password123!",
					"Existing Name",
					service.DefaultManagedRoleID,
					true,
				)
				if err != nil {
					t.Fatalf("CreatePasswordUser() error = %v", err)
				}
				userID := util.Clean(user["id"])
				return "/api/admin/users/" + userID, `{"name":"Unexpected Name","enabled":false} {}`, func() any {
					return app.auth.ListUsers()
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()

			adminToken := adminSessionToken(t, app)
			path, body, snapshot := test.setup(t, app)
			before := snapshot()
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			setRequestAuthCookie(req, adminToken)
			res := httptest.NewRecorder()

			app.Handler().ServeHTTP(res, req)

			if res.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body = %s", res.Code, http.StatusBadRequest, res.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error response: %v", err)
			}
			if detail := util.StringMap(payload["detail"]); detail["error"] != "invalid json body" {
				t.Fatalf("error body = %#v", payload)
			}
			if after := snapshot(); !reflect.DeepEqual(after, before) {
				t.Fatalf("state changed after malformed request\nbefore: %#v\nafter:  %#v", before, after)
			}
		})
	}
}
