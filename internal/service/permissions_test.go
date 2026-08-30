package service

import "testing"

func TestNormalizeAPIPermissionsRejectsRemovedCreationTaskPermissions(t *testing.T) {
	permissions := NormalizeAPIPermissions([]string{
		APIPermissionKey("GET", "/api/image-tasks"),
		"POST /api/image-tasks",
	})
	if len(permissions) != 0 {
		t.Fatalf("removed image task permissions should be ignored: %#v", permissions)
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

func TestRemovedPromptMarketAdultPermissionIsIgnored(t *testing.T) {
	permissions := NormalizeAPIPermissions([]string{
		APIPermissionKey("GET", "/api/prompt-market/adult-content"),
	})
	if len(permissions) != 0 {
		t.Fatalf("removed adult prompt market permission should be ignored: %#v", permissions)
	}
}

func TestDefaultUserPermissionsIncludeCanvas(t *testing.T) {
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	if !HasAPIPermission(permissions, "GET", "/api/canvas") || !HasAPIPermission(permissions, "POST", "/api/canvas") || !HasAPIPermission(permissions, "POST", "/api/canvas/images") || !HasAPIPermission(permissions, "PUT", "/api/canvas") || !HasAPIPermission(permissions, "DELETE", "/api/canvas") {
		t.Fatalf("default user permissions should include canvas access: %#v", permissions.APIPermissions)
	}
	menuPaths := sliceSet(permissions.MenuPaths)
	if _, ok := menuPaths["/canvas"]; !ok {
		t.Fatalf("default user menus should include canvas: %#v", permissions.MenuPaths)
	}
}

func TestCreativeLibrariesHaveIndependentMenus(t *testing.T) {
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	menuPaths := sliceSet(permissions.MenuPaths)
	for _, path := range []string{"/prompt-library", "/assets"} {
		if _, ok := menuPaths[path]; !ok {
			t.Fatalf("default user menus should include %s: %#v", path, permissions.MenuPaths)
		}
	}
	if normalized := NormalizeMenuPermissions([]string{"/unknown"}); len(normalized) != 0 {
		t.Fatalf("unknown menu path should be rejected: %#v", normalized)
	}
}

func TestLegacyImageMenuPermissionMigratesToStudio(t *testing.T) {
	permissions := NormalizeMenuPermissions([]string{"/image", "/studio"})
	if len(permissions) != 1 || permissions[0] != "/studio" {
		t.Fatalf("legacy image menu should migrate to studio: %#v", permissions)
	}
	menus := FilterMenuPermissions([]string{"/image"})
	if len(menus) != 1 || menus[0].Path != "/studio" || menus[0].Label != "创作台" {
		t.Fatalf("legacy image menu should still expose the studio: %#v", menus)
	}
}

func TestDefaultUserPermissionsIncludeCreatorFlows(t *testing.T) {
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	requests := []struct {
		method string
		path   string
	}{
		{"GET", "/api/creation-tasks"},
		{"GET", "/api/creation-tasks/audio-voices"},
		{"POST", "/api/creation-tasks/image-generations"},
		{"POST", "/api/creation-tasks/image-edits"},
		{"POST", "/api/creation-tasks/chat-completions"},
		{"POST", "/api/creation-tasks/video-generations"},
		{"POST", "/api/creation-tasks/audio-generations"},
		{"POST", "/api/creation-tasks/video-reference-uploads"},
		{"POST", "/api/creation-tasks/video-image-reference-uploads"},
		{"POST", "/api/creation-tasks/audio-reference-uploads"},
		{"POST", "/api/creation-tasks/task-1/cancel"},
		{"POST", "/api/profile/image-conversation-assets"},
		{"GET", "/api/proxy-image"},
		{"GET", "/api/canvas"},
		{"POST", "/api/canvas/images"},
		{"PUT", "/api/canvas"},
		{"DELETE", "/api/canvas"},
		{"GET", "/api/workflows"},
		{"POST", "/api/workflows/agent-draft"},
		{"PUT", "/api/workflows/workflow-1"},
		{"DELETE", "/api/workflows/workflow-1"},
		{"GET", "/api/images"},
		{"PATCH", "/api/images/visibility"},
		{"POST", "/api/files"},
		{"POST", "/api/files/direct"},
		{"DELETE", "/api/files/object-1"},
		{"DELETE", "/api/files/object-1/record"},
	}
	for _, request := range requests {
		if !HasAPIPermission(permissions, request.method, request.path) {
			t.Errorf("default user permissions missing %s %s: %#v", request.method, request.path, permissions.APIPermissions)
		}
	}
}
