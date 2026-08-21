package service

import (
	"errors"
	"testing"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func newTestAuthService(t *testing.T, backend storage.Backend) *AuthService {
	t.Helper()
	auth, err := NewAuthService(backend)
	if err != nil {
		t.Fatalf("NewAuthService() error = %v", err)
	}
	return auth
}

type failingAuthStorage struct {
	items    []map[string]any
	failLoad bool
	failSave bool
	saveErr  error
}

type failingAtomicAuthStorage struct {
	failingAuthStorage
	documents    map[string]any
	failDocument bool
	failAtomic   bool
}

func (s *failingAuthStorage) LoadAccounts() ([]map[string]any, error) { return nil, nil }
func (s *failingAuthStorage) SaveAccounts([]map[string]any) error     { return nil }
func (s *failingAuthStorage) LoadAuthKeys() ([]map[string]any, error) {
	if s.failLoad {
		return nil, errors.New("auth storage unavailable")
	}
	return cloneAuthItems(s.items), nil
}
func (s *failingAuthStorage) SaveAuthKeys(items []map[string]any) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	if s.failSave {
		return errors.New("auth storage unavailable")
	}
	s.items = make([]map[string]any, len(items))
	for index, item := range items {
		s.items[index] = util.CopyMap(item)
	}
	return nil
}

func TestAuthServiceReloadsAfterConcurrentCredentialConflict(t *testing.T) {
	backend := &failingAuthStorage{}
	auth := newTestAuthService(t, backend)
	public, raw, err := auth.CreateAPIKey(AuthRoleUser, "original", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	external := cloneAuthItems(backend.items)
	external[0]["name"] = "external"
	external[0]["enabled"] = false
	backend.items = external
	backend.saveErr = storage.ErrConcurrentRowUpdate
	if _, err := auth.UpdateKey(util.Clean(public["id"]), map[string]any{"name": "local"}, AuthKeyFilter{}); !errors.Is(err, storage.ErrConcurrentRowUpdate) {
		t.Fatalf("UpdateKey() error = %v, want ErrConcurrentRowUpdate", err)
	}

	items := auth.ListKeys(AuthKeyFilter{})
	if len(items) != 1 || items[0]["name"] != "external" || items[0]["enabled"] != false {
		t.Fatalf("credentials after conflict reload = %#v", items)
	}
	if identity := auth.Authenticate(raw); identity != nil {
		t.Fatalf("Authenticate() accepted externally disabled credential: %#v", identity)
	}
}

func TestAuthServiceCreatesSub2APISessionIdentity(t *testing.T) {
	auth := newTestAuthService(t, &failingAuthStorage{})
	identity, raw, err := auth.UpsertNewAPISession(NewAPIUser{
		ID:            42,
		Username:      "alice",
		Email:         "alice@example.test",
		DisplayName:   "Alice",
		Provider:      AuthProviderSub2API,
		SubjectPrefix: AuthProviderSub2API,
	})
	if err != nil {
		t.Fatalf("UpsertNewAPISession() error = %v", err)
	}
	if raw == "" || identity == nil {
		t.Fatalf("UpsertNewAPISession() identity=%#v raw=%q", identity, raw)
	}
	if identity.ID != "sub2api:42" || identity.OwnerID != "sub2api:42" || identity.Provider != AuthProviderSub2API || identity.Username != "alice" {
		t.Fatalf("UpsertNewAPISession() identity = %#v", identity)
	}
	if authenticated := auth.Authenticate(raw); authenticated == nil || authenticated.ID != "sub2api:42" || authenticated.Provider != AuthProviderSub2API {
		t.Fatalf("Authenticate() identity = %#v", authenticated)
	}
}

func TestAuthServiceDoesNotPersistRawSessionToken(t *testing.T) {
	backend := &failingAuthStorage{}
	auth := newTestAuthService(t, backend)
	_, raw, err := auth.UpsertLinuxDoSession(AuthOwner{ID: "linuxdo:1", Name: "user"})
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	if len(backend.items) != 1 {
		t.Fatalf("stored sessions = %#v", backend.items)
	}
	if value := util.Clean(backend.items[0]["key"]); value != "" {
		t.Fatalf("stored session leaked raw key %q", value)
	}
	if value := util.Clean(backend.items[0]["key_hash"]); value == "" {
		t.Fatal("stored session key_hash is empty")
	}
	if identity := auth.Authenticate(raw); identity == nil {
		t.Fatal("Authenticate() rejected hash-only session")
	}

	legacyRaw := "sess-legacy"
	legacy := newAuthItem(AuthRoleUser, AuthKindSession, "legacy", AuthOwner{ID: "linuxdo:2", Provider: AuthProviderLinuxDo}, legacyRaw)
	legacy["key"] = legacyRaw
	legacyBackend := &failingAuthStorage{items: []map[string]any{legacy}}
	legacyAuth := newTestAuthService(t, legacyBackend)
	if value := util.Clean(legacyBackend.items[0]["key"]); value != "" {
		t.Fatalf("legacy session migration retained raw key %q", value)
	}
	if identity := legacyAuth.Authenticate(legacyRaw); identity == nil {
		t.Fatal("Authenticate() rejected migrated legacy session")
	}
}
func (s *failingAuthStorage) HealthCheck() map[string]any { return map[string]any{} }
func (s *failingAuthStorage) Info() map[string]any        { return map[string]any{} }

func (s *failingAtomicAuthStorage) LoadJSONDocument(name string) (any, error) {
	return s.documents[name], nil
}

func (s *failingAtomicAuthStorage) SaveJSONDocument(name string, value any) error {
	if s.failDocument {
		return errors.New("auth document storage unavailable")
	}
	if s.documents == nil {
		s.documents = map[string]any{}
	}
	s.documents[name] = value
	return nil
}

func TestNewAuthServiceReturnsCredentialLoadError(t *testing.T) {
	backend := &failingAuthStorage{failLoad: true}
	if _, err := NewAuthService(backend); err == nil {
		t.Fatal("NewAuthService() error = nil, want credential load failure")
	}
}

func TestAuthServiceRollsBackRoleCreateAndDeleteWhenPersistenceFails(t *testing.T) {
	backend := &failingAtomicAuthStorage{}
	auth := newTestAuthService(t, backend)
	beforeCreate := auth.ListRoles()

	backend.failDocument = true
	if _, err := auth.CreateRole(map[string]any{"name": "failed role"}); err == nil {
		t.Fatal("CreateRole() error = nil, want persistence failure")
	}
	if roles := auth.ListRoles(); len(roles) != len(beforeCreate) {
		t.Fatalf("failed role create changed in-memory roles: %#v", roles)
	}

	backend.failDocument = false
	role, err := auth.CreateRole(map[string]any{"name": "saved role"})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	roleID := util.Clean(role["id"])
	backend.failDocument = true
	if deleted, err := auth.DeleteRole(roleID); err == nil || deleted {
		t.Fatalf("DeleteRole() = %v, %v; want persistence failure", deleted, err)
	}
	if _, ok := managedRoleByIDLocked(auth.roles, roleID); !ok {
		t.Fatalf("failed role delete removed role %q from memory", roleID)
	}
}

func (s *failingAtomicAuthStorage) DeleteJSONDocument(name string) error {
	delete(s.documents, name)
	return nil
}

func (s *failingAtomicAuthStorage) SaveAuthKeysAndJSONDocument(items []map[string]any, name string, value any) error {
	if s.failAtomic {
		return errors.New("atomic auth storage unavailable")
	}
	if err := s.SaveAuthKeys(items); err != nil {
		return err
	}
	return s.SaveJSONDocument(name, value)
}

func TestAuthServiceRollsBackCredentialMemoryWhenPersistenceFails(t *testing.T) {
	backend := &failingAuthStorage{failSave: true}
	auth := newTestAuthService(t, backend)
	if _, _, err := auth.CreateAPIKey(AuthRoleUser, "failed", AuthOwner{}); err == nil {
		t.Fatal("CreateAPIKey() error = nil, want persistence failure")
	}
	if items := auth.ListKeys(AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey}); len(items) != 0 {
		t.Fatalf("failed credential remained in memory: %#v", items)
	}

	backend.failSave = false
	if _, _, err := auth.CreateAPIKey(AuthRoleUser, "saved", AuthOwner{}); err != nil {
		t.Fatalf("CreateAPIKey() after recovery error = %v", err)
	}
}

func TestAuthServiceRollsBackResetAPIKeyWhenPersistenceFails(t *testing.T) {
	backend := &failingAuthStorage{}
	auth := newTestAuthService(t, backend)
	public, raw, err := auth.CreateAPIKey(AuthRoleUser, "original", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	backend.failSave = true
	if _, _, _, found, err := auth.ResetUserAPIKey(public["id"].(string), "replacement"); err == nil || !found {
		t.Fatalf("ResetUserAPIKey() = found %v, error %v; want persistence failure", found, err)
	}
	if identity := auth.Authenticate(raw); identity == nil {
		t.Fatal("failed API key reset invalidated the persisted key in memory")
	}
}

func TestAuthServiceAuthenticateRollsBackLastUsedWhenPersistenceFails(t *testing.T) {
	backend := &failingAuthStorage{}
	auth := newTestAuthService(t, backend)
	public, raw, err := auth.CreateAPIKey(AuthRoleUser, "audit", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	backend.failSave = true
	if identity := auth.Authenticate(raw); identity == nil {
		t.Fatal("Authenticate() rejected a valid key when audit persistence failed")
	}
	items := auth.ListKeys(AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey})
	if len(items) != 1 || items[0]["id"] != public["id"] || items[0]["last_used_at"] != nil {
		t.Fatalf("failed audit persistence changed in-memory key: %#v", items)
	}
	backend.failSave = false
	if identity := auth.Authenticate(raw); identity == nil {
		t.Fatal("Authenticate() after storage recovery returned nil")
	}
	items = auth.ListKeys(AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey})
	if len(items) != 1 || items[0]["last_used_at"] == nil {
		t.Fatalf("successful audit persistence did not update key: %#v", items)
	}
}

func TestAuthServiceUpdateRoleRollsBackBothStatesWhenAtomicPersistenceFails(t *testing.T) {
	backend := &failingAtomicAuthStorage{}
	auth := newTestAuthService(t, backend)
	user, raw, err := auth.CreateAPIKey(AuthRoleUser, "operator", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	role, err := auth.CreateRole(map[string]any{
		"name":            "image viewer",
		"api_permissions": []string{APIPermissionKey("GET", "/api/images")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	roleID := role["id"].(string)
	if _, err := auth.UpdateUser(user["id"].(string), map[string]any{"role_id": roleID}); err != nil {
		t.Fatalf("UpdateUser() error = %v", err)
	}

	backend.failAtomic = true
	if _, err := auth.UpdateRole(roleID, map[string]any{
		"api_permissions": []string{APIPermissionKey("GET", "/api/logs")},
	}); err == nil {
		t.Fatal("UpdateRole() error = nil, want atomic persistence failure")
	}
	identity := auth.Authenticate(raw)
	if identity == nil {
		t.Fatal("Authenticate() returned nil after failed role update")
	}
	permissions := PermissionSet{APIPermissions: identity.APIPermissions}
	if !HasAPIPermission(permissions, "GET", "/api/images") || HasAPIPermission(permissions, "GET", "/api/logs") {
		t.Fatalf("failed role update changed in-memory permissions: %#v", identity.APIPermissions)
	}

	backend.failAtomic = false
	updated, err := auth.UpdateRole(roleID, map[string]any{
		"api_permissions": []string{APIPermissionKey("GET", "/api/logs")},
	})
	if err != nil || updated == nil {
		t.Fatalf("UpdateRole() after recovery = %#v, %v", updated, err)
	}
}

func TestAuthServiceCreateAuthenticateDisableAndDelete(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	filter := AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey}
	public, raw, err := auth.CreateAPIKey(AuthRoleUser, "绘图用户", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	if raw == "" {
		t.Fatal("CreateAPIKey() returned empty raw key")
	}
	if _, ok := public["key_hash"]; ok {
		t.Fatalf("public key item leaked key_hash: %#v", public)
	}
	if _, ok := public["key"]; ok {
		t.Fatalf("public key item leaked raw key: %#v", public)
	}

	identity := auth.Authenticate(raw)
	if identity == nil {
		t.Fatal("Authenticate(raw) returned nil")
	}
	if identity.Role != "user" || identity.Name != "绘图用户" {
		t.Fatalf("identity = %#v", identity)
	}
	if !HasAPIPermission(PermissionSet{APIPermissions: identity.APIPermissions}, "POST", "/v1/images/generations") {
		t.Fatalf("default user permissions missing image generation: %#v", identity.APIPermissions)
	}

	keyID, _ := public["id"].(string)
	revealed, found := auth.RevealKey(keyID, filter)
	if !found || revealed != raw {
		t.Fatalf("RevealKey() = %q, %v; want raw, true", revealed, found)
	}

	updated, err := auth.UpdateKey(keyID, map[string]any{"enabled": false}, filter)
	if err != nil || updated == nil {
		t.Fatalf("UpdateKey() = %#v, %v", updated, err)
	}
	if auth.Authenticate(raw) != nil {
		t.Fatal("disabled key still authenticated")
	}

	if deleted, err := auth.DeleteKey(keyID, filter); err != nil || !deleted {
		t.Fatalf("DeleteKey() = %v, %v", deleted, err)
	}
	if len(auth.ListKeys(filter)) != 0 {
		t.Fatalf("ListKeys(user) after delete = %#v", auth.ListKeys(filter))
	}
}

func TestAuthServiceAssignsManagedRolesToUsers(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	user, raw, err := auth.CreateAPIKey(AuthRoleUser, "operator", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	role, err := auth.CreateRole(map[string]any{
		"name":            "image manager",
		"menu_paths":      []string{"/image-manager", "/missing"},
		"api_permissions": []string{APIPermissionKey("GET", "/api/images"), "get/missing"},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if _, err := auth.CreateRole(map[string]any{"name": "image manager"}); err == nil {
		t.Fatal("duplicate role name creation succeeded")
	}
	roleID := role["id"].(string)
	userID := user["id"].(string)
	updated, err := auth.UpdateUser(userID, map[string]any{"role_id": roleID})
	if err != nil || updated == nil {
		t.Fatalf("UpdateUser() = %#v, %v", updated, err)
	}
	if updated["role_id"] != roleID || updated["role_name"] != "image manager" {
		t.Fatalf("updated role fields = %#v", updated)
	}
	identity := auth.Authenticate(raw)
	if identity == nil {
		t.Fatal("Authenticate(raw) returned nil")
	}
	if identity.RoleID != roleID || identity.RoleName != "image manager" {
		t.Fatalf("identity role fields = %#v", identity)
	}
	if !HasAPIPermission(PermissionSet{APIPermissions: identity.APIPermissions}, "GET", "/api/images") {
		t.Fatalf("updated API permissions missing images read: %#v", identity.APIPermissions)
	}
	if HasAPIPermission(PermissionSet{APIPermissions: identity.APIPermissions}, "DELETE", "/api/images") {
		t.Fatalf("unexpected images delete permission: %#v", identity.APIPermissions)
	}

	if _, err := auth.UpdateRole(roleID, map[string]any{
		"api_permissions": []string{APIPermissionKey("DELETE", "/api/images")},
	}); err != nil {
		t.Fatalf("UpdateRole() error = %v", err)
	}
	identity = auth.Authenticate(raw)
	if identity == nil || !HasAPIPermission(PermissionSet{APIPermissions: identity.APIPermissions}, "DELETE", "/api/images") {
		t.Fatalf("role update did not affect user identity: %#v", identity)
	}

	if deleted, err := auth.DeleteRole(roleID); err == nil || deleted {
		t.Fatalf("DeleteRole(in use) = %v, %v; want false and error", deleted, err)
	}
}

func TestAuthServicePasswordAccountLoginAndRoleUpdates(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	bootstrap, err := auth.EnsureBootstrapAdmin("admin", "AdminPass123!")
	if err != nil {
		t.Fatalf("EnsureBootstrapAdmin() error = %v", err)
	}
	if !bootstrap.Created || bootstrap.Generated {
		t.Fatalf("bootstrap result = %#v", bootstrap)
	}
	admin, adminRaw, err := auth.LoginPassword("admin", "AdminPass123!")
	if err != nil {
		t.Fatalf("LoginPassword(admin) error = %v", err)
	}
	if admin == nil || admin.Role != AuthRoleAdmin || adminRaw == "" {
		t.Fatalf("admin identity=%#v raw=%q", admin, adminRaw)
	}

	createdUser, err := auth.CreatePasswordUser("alice", "Password123", "Alice", DefaultManagedRoleID, true)
	if err != nil {
		t.Fatalf("CreatePasswordUser(alice) error = %v", err)
	}
	user, raw, err := auth.LoginPassword("alice", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(alice) error = %v", err)
	}
	if user == nil || user.Role != AuthRoleUser || user.RoleID != DefaultManagedRoleID || raw == "" {
		t.Fatalf("created user identity=%#v raw=%q", user, raw)
	}
	if createdUser["id"] != user.ID {
		t.Fatalf("created user id = %#v, login identity id = %q", createdUser["id"], user.ID)
	}
	if authenticated := auth.Authenticate(raw); authenticated == nil || authenticated.ID != user.ID || authenticated.Name != "Alice" {
		t.Fatalf("Authenticate(password user) = %#v", authenticated)
	}
	if _, err := auth.CreatePasswordUser("alice", "Password123", "Alice again", DefaultManagedRoleID, true); err == nil {
		t.Fatal("duplicate username creation succeeded")
	}

	created, err := auth.CreatePasswordUser("bob", "Password123", "Bob", DefaultManagedRoleID, false)
	if err != nil {
		t.Fatalf("CreatePasswordUser() error = %v", err)
	}
	if created == nil || created["username"] != "bob" || created["enabled"] != false || created["has_session"] != false {
		t.Fatalf("created password user = %#v", created)
	}
	if _, _, err := auth.LoginPassword("bob", "Password123"); err == nil {
		t.Fatal("disabled admin-created password account logged in")
	}
	if _, err := auth.CreatePasswordUser("bob", "Password123", "Bob", DefaultManagedRoleID, true); err == nil {
		t.Fatal("duplicate admin-created username succeeded")
	}

	role, err := auth.CreateRole(map[string]any{
		"name":            "logs viewer",
		"menu_paths":      []string{"/logs"},
		"api_permissions": []string{APIPermissionKey("GET", "/api/logs")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	updated, err := auth.UpdateUser(user.ID, map[string]any{"role_id": role["id"]})
	if err != nil || updated == nil || updated["role_id"] != role["id"] {
		t.Fatalf("UpdateUser(role) = %#v, %v", updated, err)
	}
	assignedRole := findManagedRole(auth.ListRoles(), role["id"].(string))
	if assignedRole == nil || assignedRole["user_count"] != 1 {
		t.Fatalf("assigned role count = %#v", assignedRole)
	}
	if deleted, err := auth.DeleteRole(role["id"].(string)); err == nil || deleted {
		t.Fatalf("DeleteRole(password account in use) = %v, %v; want false and error", deleted, err)
	}
	identity := auth.Authenticate(raw)
	if identity == nil || identity.RoleID != role["id"] || !HasAPIPermission(PermissionSet{APIPermissions: identity.APIPermissions}, "GET", "/api/logs") {
		t.Fatalf("role-updated identity = %#v", identity)
	}

	disabled, err := auth.UpdateUser(user.ID, map[string]any{"enabled": false})
	if err != nil || disabled == nil || disabled["enabled"] != false {
		t.Fatalf("UpdateUser(disable) = %#v, %v", disabled, err)
	}
	if auth.Authenticate(raw) != nil {
		t.Fatal("disabled password account session still authenticated")
	}
	if _, _, err := auth.LoginPassword("alice", "Password123"); err == nil {
		t.Fatal("disabled password account logged in")
	}
}

func TestAuthServiceLinuxDoSessionOwnsAPIKeys(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	owner := AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: AuthProviderLinuxDo, LinuxDoLevel: "3"}
	_, rawSession, err := auth.UpsertLinuxDoSession(owner)
	if err != nil || rawSession == "" {
		t.Fatalf("UpsertLinuxDoSession() raw=%q err=%v", rawSession, err)
	}
	sessionIdentity := auth.Authenticate(rawSession)
	if sessionIdentity == nil {
		t.Fatal("Authenticate(session) returned nil")
	}
	if sessionIdentity.ID != owner.ID || sessionIdentity.OwnerID != owner.ID || sessionIdentity.Provider != AuthProviderLinuxDo || sessionIdentity.Kind != AuthKindSession {
		t.Fatalf("session identity = %#v", sessionIdentity)
	}

	item, rawAPIKey, err := auth.CreateAPIKey(AuthRoleUser, "绘图 API", owner)
	if err != nil {
		t.Fatalf("CreateAPIKey(owner) error = %v", err)
	}
	if rawAPIKey == "" {
		t.Fatal("CreateAPIKey(owner) returned empty key")
	}
	apiIdentity := auth.Authenticate(rawAPIKey)
	if apiIdentity == nil {
		t.Fatal("Authenticate(api key) returned nil")
	}
	if apiIdentity.ID != owner.ID || apiIdentity.CredentialID != item["id"] || apiIdentity.CredentialName != "绘图 API" {
		t.Fatalf("api identity = %#v", apiIdentity)
	}

	ownerFilter := AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey, OwnerID: owner.ID}
	keys := auth.ListKeys(ownerFilter)
	if len(keys) != 1 || keys[0]["owner_id"] != owner.ID {
		t.Fatalf("owner scoped keys = %#v", keys)
	}
	allAPIKeys := auth.ListKeys(AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey})
	if len(allAPIKeys) != 1 {
		t.Fatalf("all API keys should exclude sessions: %#v", allAPIKeys)
	}
}

func TestAuthServiceRevokeSessionsRemovesAllRequestedSessionsOnly(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	_, first, err := auth.UpsertLinuxDoSession(AuthOwner{ID: "linuxdo:revoke-first", Name: "first"})
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(first) error = %v", err)
	}
	_, second, err := auth.UpsertLinuxDoSession(AuthOwner{ID: "linuxdo:revoke-second", Name: "second"})
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(second) error = %v", err)
	}
	_, untouched, err := auth.UpsertLinuxDoSession(AuthOwner{ID: "linuxdo:revoke-untouched", Name: "untouched"})
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(untouched) error = %v", err)
	}

	removed, err := auth.RevokeSessions(first, second, first, "")
	if err != nil || removed != 2 {
		t.Fatalf("RevokeSessions() = (%d, %v), want (2, nil)", removed, err)
	}
	if auth.Authenticate(first) != nil || auth.Authenticate(second) != nil {
		t.Fatal("requested sessions remain valid")
	}
	if auth.Authenticate(untouched) == nil {
		t.Fatal("unrequested session was revoked")
	}
}

func TestAuthServiceUpsertLinuxDoSessionHonorsCreateGate(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	owner := AuthOwner{ID: "linuxdo:blocked", Name: "blocked_user", Provider: AuthProviderLinuxDo, LinuxDoLevel: "1"}
	if _, _, err := auth.UpsertLinuxDoSessionIfAllowed(owner, false); err != ErrAuthUserCreationDisabled {
		t.Fatalf("UpsertLinuxDoSessionIfAllowed(disallow new) error = %v, want %v", err, ErrAuthUserCreationDisabled)
	}
	if user := findAuthUser(auth.ListUsers(), owner.ID); user != nil {
		t.Fatalf("disallowed linuxdo session created user: %#v", user)
	}

	created, createdRaw, err := auth.UpsertLinuxDoSessionIfAllowed(owner, true)
	if err != nil || createdRaw == "" {
		t.Fatalf("UpsertLinuxDoSessionIfAllowed(allow new) raw=%q err=%v", createdRaw, err)
	}
	if created["owner_id"] != owner.ID {
		t.Fatalf("created linuxdo session = %#v", created)
	}

	next, nextRaw, err := auth.UpsertLinuxDoSessionIfAllowed(owner, false)
	if err != nil || nextRaw == "" {
		t.Fatalf("UpsertLinuxDoSessionIfAllowed(existing, disallow new) raw=%q err=%v", nextRaw, err)
	}
	if next["id"] == created["id"] {
		t.Fatalf("new login should rotate the non-secret credential id, created=%#v next=%#v", created, next)
	}
	if auth.Authenticate(createdRaw) != nil {
		t.Fatal("new login left the previous LinuxDo session active")
	}
}

func TestAuthServiceUpsertAPIKeyForOwnerKeepsOneToken(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	owner := AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: AuthProviderLinuxDo, LinuxDoLevel: "3"}
	if items := auth.ListSingleAPIKeyForOwner(owner.ID); len(items) != 0 {
		t.Fatalf("new owner should start with no token, got %#v", items)
	}

	first, firstRaw, err := auth.UpsertAPIKeyForOwner("", owner)
	if err != nil {
		t.Fatalf("first UpsertAPIKeyForOwner() error = %v", err)
	}
	second, secondRaw, err := auth.UpsertAPIKeyForOwner("", owner)
	if err != nil {
		t.Fatalf("second UpsertAPIKeyForOwner() error = %v", err)
	}
	if first["id"] != second["id"] {
		t.Fatalf("upsert should keep the same item id, first=%#v second=%#v", first, second)
	}
	if firstRaw == secondRaw {
		t.Fatal("upsert should rotate the raw token")
	}
	if auth.Authenticate(firstRaw) != nil {
		t.Fatal("old owner token still authenticated after reset")
	}
	if identity := auth.Authenticate(secondRaw); identity == nil || identity.ID != owner.ID {
		t.Fatalf("new owner token identity = %#v", identity)
	}
	keys := auth.ListKeys(AuthKeyFilter{Role: AuthRoleUser, Kind: AuthKindAPIKey, OwnerID: owner.ID})
	if len(keys) != 1 {
		t.Fatalf("owner should have exactly one token, got %#v", keys)
	}
}

func TestAuthServiceListSingleAPIKeyForOwnerDoesNotMutateDuplicates(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	owner := AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: AuthProviderLinuxDo, LinuxDoLevel: "3"}
	first, firstRaw, err := auth.CreateAPIKey(AuthRoleUser, "first", owner)
	if err != nil {
		t.Fatalf("CreateAPIKey(first) error = %v", err)
	}
	_, secondRaw, err := auth.CreateAPIKey(AuthRoleUser, "second", owner)
	if err != nil {
		t.Fatalf("CreateAPIKey(second) error = %v", err)
	}
	items := auth.ListSingleAPIKeyForOwner(owner.ID)
	if len(items) != 1 || items[0]["id"] != first["id"] {
		t.Fatalf("ListSingleAPIKeyForOwner() = %#v, want first token only", items)
	}
	if auth.Authenticate(firstRaw) == nil {
		t.Fatal("kept token should still authenticate")
	}
	if auth.Authenticate(secondRaw) == nil {
		t.Fatal("listing one token must not silently revoke a duplicate token")
	}
}

func TestAuthServiceManagedUsersGroupAndControlCredentials(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)

	owner := AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: AuthProviderLinuxDo, LinuxDoLevel: "3"}
	_, sessionRaw, err := auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	_, ownerRaw, err := auth.UpsertAPIKeyForOwner("", owner)
	if err != nil {
		t.Fatalf("UpsertAPIKeyForOwner() error = %v", err)
	}
	local, localRaw, err := auth.CreateAPIKey(AuthRoleUser, "local user", AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey(local) error = %v", err)
	}

	users := auth.ListUsers()
	if len(users) != 2 {
		t.Fatalf("ListUsers() length = %d users = %#v", len(users), users)
	}
	linuxdoUser := findAuthUser(users, owner.ID)
	if linuxdoUser == nil {
		t.Fatalf("missing linuxdo user in %#v", users)
	}
	if linuxdoUser["name"] != owner.Name || linuxdoUser["provider"] != AuthProviderLinuxDo || linuxdoUser["has_session"] != true || linuxdoUser["has_api_key"] != true {
		t.Fatalf("linuxdo user = %#v", linuxdoUser)
	}
	if linuxdoUser["linuxdo_level"] != "3" {
		t.Fatalf("linuxdo level = %#v", linuxdoUser)
	}
	if _, ok := linuxdoUser["key"]; ok {
		t.Fatalf("managed user leaked key: %#v", linuxdoUser)
	}
	localID, _ := local["id"].(string)
	localUser := findAuthUser(users, localID)
	if localUser == nil || localUser["provider"] != AuthProviderLocal || localUser["has_api_key"] != true {
		t.Fatalf("local user = %#v in %#v", localUser, users)
	}

	disabled, err := auth.UpdateUser(owner.ID, map[string]any{"enabled": false})
	if err != nil || disabled == nil || disabled["enabled"] != false {
		t.Fatalf("disabled managed user = %#v, %v", disabled, err)
	}
	if auth.Authenticate(sessionRaw) != nil {
		t.Fatal("disabled linuxdo session still authenticated")
	}
	if auth.Authenticate(ownerRaw) != nil {
		t.Fatal("disabled linuxdo API key still authenticated")
	}
	if auth.Authenticate(localRaw) == nil {
		t.Fatal("disabling linuxdo user should not affect local user")
	}
	disabledSession, disabledSessionRaw, err := auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(disabled) error = %v", err)
	}
	if disabledSession["enabled"] != false {
		t.Fatalf("disabled linuxdo login session should stay disabled: %#v", disabledSession)
	}
	if auth.Authenticate(disabledSessionRaw) != nil {
		t.Fatal("disabled linuxdo user authenticated after a new login session was issued")
	}
	sessionRaw = disabledSessionRaw

	managedUser, apiKey, rotatedRaw, found, err := auth.ResetUserAPIKey(owner.ID, "rotated")
	if err != nil || !found {
		t.Fatalf("ResetUserAPIKey(owner) found=%v err=%v", found, err)
	}
	if managedUser["id"] != owner.ID || apiKey["owner_id"] != owner.ID || rotatedRaw == "" || rotatedRaw == ownerRaw {
		t.Fatalf("ResetUserAPIKey(owner) user=%#v apiKey=%#v raw=%q old=%q", managedUser, apiKey, rotatedRaw, ownerRaw)
	}
	if auth.Authenticate(ownerRaw) != nil {
		t.Fatal("old owner API key still authenticated after managed reset")
	}
	if auth.Authenticate(rotatedRaw) != nil {
		t.Fatal("rotated owner API key should keep the disabled user state")
	}
	if auth.Authenticate(sessionRaw) != nil {
		t.Fatal("resetting API key should not re-enable disabled linuxdo session")
	}

	enabled, err := auth.UpdateUser(owner.ID, map[string]any{"enabled": true})
	if err != nil || enabled == nil || enabled["enabled"] != true {
		t.Fatalf("enabled managed user = %#v, %v", enabled, err)
	}
	if auth.Authenticate(sessionRaw) == nil {
		t.Fatal("enabled linuxdo session should authenticate")
	}
	if identity := auth.Authenticate(rotatedRaw); identity == nil || identity.ID != owner.ID {
		t.Fatalf("enabled rotated owner API identity = %#v", identity)
	}
	if auth.Authenticate(sessionRaw) == nil || auth.Authenticate(rotatedRaw) == nil {
		t.Fatal("enabled linuxdo user should authenticate with session and API key")
	}

	_, _, localRotatedRaw, found, err := auth.ResetUserAPIKey(localID, "")
	if err != nil || !found {
		t.Fatalf("ResetUserAPIKey(local) found=%v err=%v", found, err)
	}
	if localRotatedRaw == "" || localRotatedRaw == localRaw {
		t.Fatalf("local reset raw = %q old = %q", localRotatedRaw, localRaw)
	}
	if auth.Authenticate(localRaw) != nil {
		t.Fatal("old local key still authenticated after managed reset")
	}
	if identity := auth.Authenticate(localRotatedRaw); identity == nil || identity.ID != localID {
		t.Fatalf("local rotated identity = %#v", identity)
	}

	if deleted, err := auth.DeleteUser(owner.ID); err != nil || !deleted {
		t.Fatalf("DeleteUser(owner) = %v, %v", deleted, err)
	}
	if auth.Authenticate(sessionRaw) != nil || auth.Authenticate(rotatedRaw) != nil {
		t.Fatal("deleted linuxdo user still authenticated")
	}
	if findAuthUser(auth.ListUsers(), owner.ID) != nil {
		t.Fatalf("deleted linuxdo user still listed: %#v", auth.ListUsers())
	}
}

func findAuthUser(users []map[string]any, id string) map[string]any {
	for _, user := range users {
		if user["id"] == id {
			return user
		}
	}
	return nil
}

func findManagedRole(roles []map[string]any, id string) map[string]any {
	for _, role := range roles {
		if role["id"] == id {
			return role
		}
	}
	return nil
}
