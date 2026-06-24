package service

import "testing"

func TestNormalizeAPIPermissionsMigratesCreationTaskPermissions(t *testing.T) {
	permissions := NormalizeAPIPermissions([]string{
		APIPermissionKey("GET", "/api/image-tasks"),
		"POST /api/image-tasks",
	})

	if !HasAPIPermission(PermissionSet{APIPermissions: permissions}, "GET", "/api/creation-tasks") {
		t.Fatalf("migrated permissions missing creation task read: %#v", permissions)
	}
	if !HasAPIPermission(PermissionSet{APIPermissions: permissions}, "POST", "/api/creation-tasks/image-generations") {
		t.Fatalf("migrated permissions missing image creation task submit subtree: %#v", permissions)
	}
	if HasAPIPermission(PermissionSet{APIPermissions: permissions}, "GET", "/api/image-tasks") {
		t.Fatalf("old image task route should not be authorized: %#v", permissions)
	}
}

func TestRemovedAccountPoolPermissionsAreIgnored(t *testing.T) {
	permissions := NormalizeAPIPermissions([]string{
		APIPermissionKey("GET", "/api/accounts"),
		APIPermissionKey("POST", "/api/accounts/refresh"),
	})
	if len(permissions) != 0 {
		t.Fatalf("removed account pool permissions should be ignored: %#v", permissions)
	}
	if HasAPIPermission(PermissionSet{APIPermissions: permissions}, "GET", "/api/accounts") {
		t.Fatalf("removed account route should not be authorized: %#v", permissions)
	}
}

func TestPromptMarketAdultPermissionIsExplicit(t *testing.T) {
	userPermissions := DefaultPermissionSetForRole(AuthRoleUser)
	if HasAPIPermission(userPermissions, "GET", PromptMarketAdultPermissionPath) {
		t.Fatalf("default user permissions should not include adult prompt market access: %#v", userPermissions.APIPermissions)
	}

	adminPermissions := DefaultPermissionSetForRole(AuthRoleAdmin)
	if !HasAPIPermission(adminPermissions, "GET", PromptMarketAdultPermissionPath) {
		t.Fatalf("admin permissions should include adult prompt market access: %#v", adminPermissions.APIPermissions)
	}

	explicit := NormalizeAPIPermissions([]string{APIPermissionKey("GET", PromptMarketAdultPermissionPath)})
	if !HasAPIPermission(PermissionSet{APIPermissions: explicit}, "GET", PromptMarketAdultPermissionPath) {
		t.Fatalf("explicit adult prompt market permission was not accepted: %#v", explicit)
	}
}
