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

func TestDelegatedManagementCannotEscalatePermissions(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner, token := createPasswordUserSession(t, app, "delegated-manager", "Password123!", "Manager")
	role, err := app.auth.CreateRole(map[string]any{
		"name": "Manager role",
		"api_permissions": []string{
			service.APIPermissionKey(http.MethodPost, "/api/admin/roles"),
			service.APIPermissionKey(http.MethodPost, "/api/admin/users"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	roleID := util.Clean(role["id"])
	if _, err := app.auth.UpdateUser(owner.OwnerID, map[string]any{"role_id": roleID}); err != nil {
		t.Fatal(err)
	}
	privilegedRole, err := app.auth.CreateRole(map[string]any{"name": "Privileged", "api_permissions": []string{service.APIPermissionKey(http.MethodGet, "/api/settings")}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ path, body string }{
		{"/api/admin/roles", `{"name":"Escalation"}`},
		{"/api/admin/users/" + owner.OwnerID, `{"role_id":"` + util.Clean(privilegedRole["id"]) + `"}`},
		{"/api/admin/users", `{"username":"escalation","password":"Password123!"}`},
		{"/api/admin/roles/" + roleID, `{"api_permissions":["get/api/settings"]}`},
	} {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusForbidden {
			t.Errorf("%s: status %d, body %s", tc.path, res.Code, res.Body.String())
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/users/"+owner.OwnerID, strings.NewReader(`{"name":"Updated"}`))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("delegated user update: %d %s", res.Code, res.Body.String())
	}
}
