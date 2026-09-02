package service

import (
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

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
	documents       map[string]any
	documentLoadErr error
	failDocument    bool
	failAtomic      bool
}

type coordinatedBootstrapAuthBackend struct {
	*storage.DatabaseBackend
	saveReady      chan<- struct{}
	saveRelease    <-chan struct{}
	coordinateSave sync.Once
}

func (b *coordinatedBootstrapAuthBackend) SaveJSONDocument(name string, value any) error {
	if name == passwordAccountsDocumentName {
		b.coordinateSave.Do(func() {
			b.saveReady <- struct{}{}
			<-b.saveRelease
		})
	}
	return b.DatabaseBackend.SaveJSONDocument(name, value)
}

type alwaysConflictingBootstrapAuthStorage struct {
	failingAtomicAuthStorage
	saveCalls int
}

func (s *alwaysConflictingBootstrapAuthStorage) SaveJSONDocument(string, any) error {
	s.saveCalls++
	return storage.ErrConcurrentRowUpdate
}

type bootstrapAdminCallResult struct {
	result BootstrapAdminResult
	err    error
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

func TestAuthServiceNewAPISessionRoleIsStableAcrossRefresh(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		admin      bool
		wantRole   string
		wantRoleID string
	}{
		{name: "user", wantRole: AuthRoleUser, wantRoleID: DefaultManagedRoleID},
		{name: "admin", admin: true, wantRole: AuthRoleAdmin, wantRoleID: AuthRoleAdmin},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			auth := newTestAuthService(t, &failingAuthStorage{})
			user := NewAPIUser{ID: 42, Username: "alice", DisplayName: "Alice", IsAdmin: testCase.admin}
			first, _, err := auth.UpsertNewAPISession(user)
			if err != nil {
				t.Fatalf("first UpsertNewAPISession() error = %v", err)
			}
			refreshed, _, err := auth.UpsertNewAPISession(user)
			if err != nil {
				t.Fatalf("second UpsertNewAPISession() error = %v", err)
			}
			if first.Role != testCase.wantRole || first.RoleID != testCase.wantRoleID {
				t.Fatalf("first role = %q/%q, want %q/%q", first.Role, first.RoleID, testCase.wantRole, testCase.wantRoleID)
			}
			if refreshed.Role != first.Role || refreshed.RoleID != first.RoleID || refreshed.RoleName != first.RoleName {
				t.Fatalf("refreshed role = %q/%q/%q, first = %q/%q/%q", refreshed.Role, refreshed.RoleID, refreshed.RoleName, first.Role, first.RoleID, first.RoleName)
			}
			if !slices.Equal(refreshed.MenuPaths, first.MenuPaths) || !slices.Equal(refreshed.APIPermissions, first.APIPermissions) {
				t.Fatalf("refreshed permissions = %#v/%#v, first = %#v/%#v", refreshed.MenuPaths, refreshed.APIPermissions, first.MenuPaths, first.APIPermissions)
			}
		})
	}
}

func TestAuthServiceUpdateUserClearingDisplayNameSynchronizesActiveSession(t *testing.T) {
	backend := newTestStorageBackend(t)
	auth := newTestAuthService(t, backend)
	const username = "display_user"
	const password = "Password123!"

	created, err := auth.CreatePasswordUser(username, password, "Previous Name", DefaultManagedRoleID, true)
	if err != nil {
		t.Fatalf("CreatePasswordUser() error = %v", err)
	}
	userID := util.Clean(created["id"])
	identity, token, err := auth.LoginPassword(username, password)
	if err != nil || identity == nil || identity.Name != "Previous Name" || token == "" {
		t.Fatalf("LoginPassword() = (%#v, %q, %v)", identity, token, err)
	}

	updated, err := auth.UpdateUser(userID, map[string]any{"name": "  "})
	if err != nil {
		t.Fatalf("UpdateUser() error = %v", err)
	}
	if util.Clean(updated["name"]) != username || util.Clean(updated["owner_name"]) != username {
		t.Fatalf("UpdateUser() = %#v, want username fallback", updated)
	}
	current := auth.Authenticate(token)
	if current == nil || current.Name != username {
		t.Fatalf("Authenticate() after name clear = %#v, want name %q", current, username)
	}

	reloaded := newTestAuthService(t, backend)
	persisted := reloaded.Authenticate(token)
	if persisted == nil || persisted.Name != username {
		t.Fatalf("reloaded Authenticate() = %#v, want name %q", persisted, username)
	}
	account, ok := passwordAccountByIDLocked(reloaded.accounts, userID)
	if !ok || account.Name != username || account.DisplayName() != username {
		t.Fatalf("reloaded account = %#v, exists=%v", account, ok)
	}
}

func TestAuthServicePrunesLastUsedFlushesAcrossSessionLifecycle(t *testing.T) {
	t.Run("external rotation revoke and delete", func(t *testing.T) {
		auth := newTestAuthService(t, &failingAuthStorage{})
		user := NewAPIUser{ID: 42, Username: "alice", DisplayName: "Alice"}

		_, firstToken, err := auth.UpsertNewAPISession(user)
		if err != nil {
			t.Fatalf("first UpsertNewAPISession() error = %v", err)
		}
		firstIdentity := auth.Authenticate(firstToken)
		if firstIdentity == nil || len(auth.lastUsedFlushAt) != 1 {
			t.Fatalf("first Authenticate() identity=%#v flushes=%#v", firstIdentity, auth.lastUsedFlushAt)
		}
		firstCredentialID := firstIdentity.CredentialID

		secondIdentity, secondToken, err := auth.UpsertNewAPISession(user)
		if err != nil {
			t.Fatalf("second UpsertNewAPISession() error = %v", err)
		}
		if secondIdentity.CredentialID == firstCredentialID {
			t.Fatalf("session credential was not rotated: %#v", secondIdentity)
		}
		if _, exists := auth.lastUsedFlushAt[firstCredentialID]; exists || len(auth.lastUsedFlushAt) != 0 {
			t.Fatalf("rotated session retained stale flush timestamp: %#v", auth.lastUsedFlushAt)
		}

		secondIdentity = auth.Authenticate(secondToken)
		if secondIdentity == nil || len(auth.lastUsedFlushAt) != 1 {
			t.Fatalf("second Authenticate() identity=%#v flushes=%#v", secondIdentity, auth.lastUsedFlushAt)
		}
		if removed, revokeErr := auth.RevokeSessions(secondToken); revokeErr != nil || removed != 1 {
			t.Fatalf("RevokeSessions() = (%d, %v)", removed, revokeErr)
		}
		if len(auth.lastUsedFlushAt) != 0 {
			t.Fatalf("revoked session retained flush timestamp: %#v", auth.lastUsedFlushAt)
		}

		_, thirdToken, err := auth.UpsertNewAPISession(user)
		if err != nil {
			t.Fatalf("third UpsertNewAPISession() error = %v", err)
		}
		thirdIdentity := auth.Authenticate(thirdToken)
		if thirdIdentity == nil || len(auth.lastUsedFlushAt) != 1 {
			t.Fatalf("third Authenticate() identity=%#v flushes=%#v", thirdIdentity, auth.lastUsedFlushAt)
		}
		if deleted, deleteErr := auth.DeleteUser(firstIdentity.ID); deleteErr != nil || !deleted {
			t.Fatalf("DeleteUser() = (%v, %v)", deleted, deleteErr)
		}
		if len(auth.lastUsedFlushAt) != 0 {
			t.Fatalf("deleted user retained flush timestamp: %#v", auth.lastUsedFlushAt)
		}
	})

	t.Run("password session rotation", func(t *testing.T) {
		auth := newTestAuthService(t, newTestStorageBackend(t))
		if _, err := auth.CreatePasswordUser("local_user", "Password123!", "Local User", DefaultManagedRoleID, true); err != nil {
			t.Fatalf("CreatePasswordUser() error = %v", err)
		}
		_, firstToken, err := auth.LoginPassword("local_user", "Password123!")
		if err != nil {
			t.Fatalf("first LoginPassword() error = %v", err)
		}
		firstIdentity := auth.Authenticate(firstToken)
		if firstIdentity == nil || len(auth.lastUsedFlushAt) != 1 {
			t.Fatalf("first Authenticate() identity=%#v flushes=%#v", firstIdentity, auth.lastUsedFlushAt)
		}
		if _, _, err := auth.LoginPassword("local_user", "Password123!"); err != nil {
			t.Fatalf("second LoginPassword() error = %v", err)
		}
		if _, exists := auth.lastUsedFlushAt[firstIdentity.CredentialID]; exists || len(auth.lastUsedFlushAt) != 0 {
			t.Fatalf("rotated password session retained stale flush timestamp: %#v", auth.lastUsedFlushAt)
		}
	})

	t.Run("conflict reload", func(t *testing.T) {
		backend := &failingAuthStorage{}
		auth := newTestAuthService(t, backend)
		_, token, err := auth.UpsertNewAPISession(NewAPIUser{ID: 7, Username: "reload-user"})
		if err != nil {
			t.Fatalf("UpsertNewAPISession() error = %v", err)
		}
		identity := auth.Authenticate(token)
		if identity == nil {
			t.Fatal("Authenticate() identity = nil")
		}
		auth.lastUsedFlushAt["stale-session"] = time.Now().UTC()
		auth.reloadAuthItemsAfterConflictLocked(AuthPersistenceError{Err: storage.ErrConcurrentRowUpdate})
		if _, exists := auth.lastUsedFlushAt["stale-session"]; exists {
			t.Fatalf("reload retained stale flush timestamp: %#v", auth.lastUsedFlushAt)
		}
		if _, exists := auth.lastUsedFlushAt[identity.CredentialID]; !exists {
			t.Fatalf("reload removed active session flush timestamp: %#v", auth.lastUsedFlushAt)
		}
	})
}

func TestStoredAuthDocumentUsesCanonicalEnvelope(t *testing.T) {
	account := PasswordAccount{
		ID: "user-1", Username: "alice", Name: "Alice", PasswordHash: "hash", Role: AuthRoleUser,
		RoleID: DefaultManagedRoleID, Enabled: true, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
	}
	accountItems, ok := storedAuthDocument([]PasswordAccount{account}, storedPasswordAccount)["items"].([]map[string]any)
	if !ok || len(accountItems) != 1 || !reflect.DeepEqual(accountItems[0], storedPasswordAccount(account)) {
		t.Fatalf("stored account document items = %#v", accountItems)
	}

	role := ManagedRole{ID: "reviewer", Name: "Reviewer", MenuPaths: []string{"/studio"}, APIPermissions: []string{"GET /api/models"}}
	roleItems, ok := storedAuthDocument([]ManagedRole{role}, storedManagedRole)["items"].([]map[string]any)
	if !ok || len(roleItems) != 1 || !reflect.DeepEqual(roleItems[0], storedManagedRole(role)) {
		t.Fatalf("stored role document items = %#v", roleItems)
	}

	emptyItems, ok := storedAuthDocument([]PasswordAccount(nil), storedPasswordAccount)["items"].([]map[string]any)
	if !ok || emptyItems == nil || len(emptyItems) != 0 {
		t.Fatalf("empty stored document items = %#v", emptyItems)
	}
}

func TestAuthServiceReloadsRelatedStateAfterConcurrentPersistenceConflict(t *testing.T) {
	t.Run("password accounts", func(t *testing.T) {
		backend := &failingAtomicAuthStorage{}
		auth := newTestAuthService(t, backend)
		authoritative := PasswordAccount{
			ID: "user-current", Username: "alice", Name: "Alice", PasswordHash: "hash", Role: AuthRoleUser,
			RoleID: DefaultManagedRoleID, Enabled: true, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
		}
		backend.documents = map[string]any{
			passwordAccountsDocumentName: storedAuthDocument([]PasswordAccount{authoritative}, storedPasswordAccount),
		}
		backend.items = []map[string]any{newAuthItem(AuthRoleUser, passwordSessionName, AuthOwner{
			ID: authoritative.ID, Name: "stale", Provider: AuthProviderLocal,
		}, "session-token")}

		auth.restoreAuthAccountsAfterSaveFailureLocked(
			[]PasswordAccount{{ID: "user-previous", Username: "previous", PasswordHash: "hash", Role: AuthRoleUser, Enabled: true}},
			nil,
			AuthPersistenceError{Err: storage.ErrConcurrentRowUpdate},
		)
		if len(auth.accounts) != 1 || auth.accounts[0].ID != authoritative.ID {
			t.Fatalf("reloaded accounts = %#v", auth.accounts)
		}
		if len(auth.items) != 1 || util.Clean(auth.items[0]["username"]) != authoritative.Username || util.Clean(auth.items[0]["owner_name"]) != authoritative.Name {
			t.Fatalf("reloaded auth items = %#v", auth.items)
		}
	})

	t.Run("roles", func(t *testing.T) {
		backend := &failingAtomicAuthStorage{}
		auth := newTestAuthService(t, backend)
		permissions := DefaultPermissionSetForRole(AuthRoleUser)
		authoritative := ManagedRole{
			ID: "reviewer", Name: "Reviewer", MenuPaths: permissions.MenuPaths, APIPermissions: permissions.APIPermissions,
		}
		backend.documents = map[string]any{
			rbacRolesDocumentName: storedAuthDocument([]ManagedRole{authoritative}, storedManagedRole),
		}
		item := newAuthItem(AuthRoleUser, "remote session", AuthOwner{ID: "newapi:42", Name: "Alice", Provider: AuthProviderNewAPI}, "session-token")
		item["role_id"] = authoritative.ID
		backend.items = []map[string]any{item}

		auth.restoreAuthRolesAfterSaveFailureLocked([]ManagedRole{defaultManagedRole()}, nil, AuthPersistenceError{Err: storage.ErrConcurrentRowUpdate})
		if _, ok := managedRoleByIDLocked(auth.roles, authoritative.ID); !ok {
			t.Fatalf("reloaded roles = %#v", auth.roles)
		}
		if len(auth.items) != 1 || util.Clean(auth.items[0]["role_id"]) != authoritative.ID || util.Clean(auth.items[0]["role_name"]) != authoritative.Name {
			t.Fatalf("reloaded auth items = %#v", auth.items)
		}
	})
}

func TestAuthServiceConcurrentRestoreDoesNotPartiallyApplyFailedLoads(t *testing.T) {
	conflictErr := AuthPersistenceError{Err: storage.ErrConcurrentRowUpdate}

	for _, failure := range []struct {
		name            string
		documentLoadErr error
		failAuthLoad    bool
	}{
		{name: "related document load", documentLoadErr: errors.New("auth document storage unavailable")},
		{name: "auth items load", failAuthLoad: true},
	} {
		t.Run("password accounts/"+failure.name, func(t *testing.T) {
			backend := &failingAtomicAuthStorage{}
			auth := newTestAuthService(t, backend)
			authoritative := PasswordAccount{
				ID: "user-current", Username: "alice", Name: "Alice", PasswordHash: "hash", Role: AuthRoleUser,
				RoleID: DefaultManagedRoleID, Enabled: true, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
			}
			backend.documents = map[string]any{
				passwordAccountsDocumentName: storedAuthDocument([]PasswordAccount{authoritative}, storedPasswordAccount),
			}
			backend.items = []map[string]any{newAuthItem(AuthRoleUser, passwordSessionName, AuthOwner{
				ID: authoritative.ID, Name: authoritative.Name, Provider: AuthProviderLocal,
			}, "session-token")}
			backend.documentLoadErr = failure.documentLoadErr
			backend.failLoad = failure.failAuthLoad

			previousAccounts := []PasswordAccount{{
				ID: "user-previous", Username: "previous", Name: "Previous", PasswordHash: "previous-hash", Role: AuthRoleUser, Enabled: true,
			}}
			previousItems := []map[string]any{{"id": "session-previous", "owner_id": "user-previous", "username": "previous"}}
			wantAccounts := append([]PasswordAccount(nil), previousAccounts...)
			wantItems := cloneAuthItems(previousItems)

			auth.restoreAuthAccountsAfterSaveFailureLocked(previousAccounts, previousItems, conflictErr)
			if !reflect.DeepEqual(auth.accounts, wantAccounts) {
				t.Fatalf("accounts after failed reload = %#v, want previous %#v", auth.accounts, wantAccounts)
			}
			if !reflect.DeepEqual(auth.items, wantItems) {
				t.Fatalf("auth items after failed reload = %#v, want previous %#v", auth.items, wantItems)
			}
		})

		t.Run("roles/"+failure.name, func(t *testing.T) {
			backend := &failingAtomicAuthStorage{}
			auth := newTestAuthService(t, backend)
			authoritative := ManagedRole{ID: "reviewer", Name: "Reviewer"}
			backend.documents = map[string]any{
				rbacRolesDocumentName: storedAuthDocument([]ManagedRole{authoritative}, storedManagedRole),
			}
			item := newAuthItem(AuthRoleUser, "remote session", AuthOwner{ID: "newapi:42", Name: "Alice", Provider: AuthProviderNewAPI}, "session-token")
			item["role_id"] = authoritative.ID
			backend.items = []map[string]any{item}
			backend.documentLoadErr = failure.documentLoadErr
			backend.failLoad = failure.failAuthLoad

			previousRoles := []ManagedRole{{ID: "previous-role", Name: "Previous role"}}
			previousItems := []map[string]any{{"id": "session-previous", "owner_id": "newapi:previous", "role_id": "previous-role"}}
			wantRoles := append([]ManagedRole(nil), previousRoles...)
			wantItems := cloneAuthItems(previousItems)

			auth.restoreAuthRolesAfterSaveFailureLocked(previousRoles, previousItems, conflictErr)
			if !reflect.DeepEqual(auth.roles, wantRoles) {
				t.Fatalf("roles after failed reload = %#v, want previous %#v", auth.roles, wantRoles)
			}
			if !reflect.DeepEqual(auth.items, wantItems) {
				t.Fatalf("auth items after failed reload = %#v, want previous %#v", auth.items, wantItems)
			}
		})
	}
}

func TestAuthServiceRemovesNonSessionCredentialsOnLoad(t *testing.T) {
	apiKey := "sk-api-key"
	sessionToken := "sess-current"
	backend := &failingAuthStorage{items: []map[string]any{
		{
			"id":         "api-key",
			"name":       "API key",
			"role":       AuthRoleUser,
			"kind":       "api_key",
			"key":        apiKey,
			"key_hash":   util.SHA256Hex(apiKey),
			"enabled":    true,
			"created_at": util.NowISO(),
		},
		newAuthItem(AuthRoleUser, "current session", AuthOwner{ID: "newapi:current", Provider: AuthProviderNewAPI}, sessionToken),
	}}
	auth := newTestAuthService(t, backend)
	if len(backend.items) != 1 || backend.items[0]["kind"] != AuthKindSession {
		t.Fatalf("sanitized stored credentials = %#v", backend.items)
	}
	if identity := auth.Authenticate(apiKey); identity != nil {
		t.Fatalf("non-session credential still authenticates: %#v", identity)
	}
	if identity := auth.Authenticate(sessionToken); identity == nil {
		t.Fatal("valid session was removed with non-session credentials")
	}
}

func (s *failingAuthStorage) HealthCheck() map[string]any { return map[string]any{} }
func (s *failingAuthStorage) Info() map[string]any        { return map[string]any{} }

func (s *failingAtomicAuthStorage) LoadJSONDocument(name string) (any, error) {
	if s.documentLoadErr != nil {
		return nil, s.documentLoadErr
	}
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

func TestAuthServiceEnsureBootstrapAdminHandlesConcurrentFirstStartup(t *testing.T) {
	t.Run("peer creates admin", func(t *testing.T) {
		first, second, saveReady, releaseFirst, releaseSecond := newCoordinatedBootstrapAuthServices(t)
		firstResult := make(chan bootstrapAdminCallResult, 1)
		secondResult := make(chan bootstrapAdminCallResult, 1)

		go func() {
			result, err := first.EnsureBootstrapAdmin("admin", "FirstAdminPassword123")
			firstResult <- bootstrapAdminCallResult{result: result, err: err}
		}()
		go func() {
			result, err := second.EnsureBootstrapAdmin("admin", "SecondAdminPassword123")
			secondResult <- bootstrapAdminCallResult{result: result, err: err}
		}()

		waitForAuthTestValue(t, saveReady)
		waitForAuthTestValue(t, saveReady)
		releaseFirst <- struct{}{}
		created := waitForAuthTestValue(t, firstResult)
		if created.err != nil || !created.result.Created || created.result.Username != "admin" {
			t.Fatalf("first EnsureBootstrapAdmin() = (%#v, %v), want created admin", created.result, created.err)
		}

		releaseSecond <- struct{}{}
		reloaded := waitForAuthTestValue(t, secondResult)
		if reloaded.err != nil || reloaded.result.Created || reloaded.result.Username != "admin" {
			t.Fatalf("second EnsureBootstrapAdmin() = (%#v, %v), want existing admin", reloaded.result, reloaded.err)
		}
		if len(second.accounts) != 1 || second.accounts[0].Role != AuthRoleAdmin || !verifyAccountPassword("FirstAdminPassword123", second.accounts[0].PasswordHash) {
			t.Fatalf("second service accounts after conflict reload = %#v", second.accounts)
		}
	})

	t.Run("peer creates non-admin account", func(t *testing.T) {
		first, second, saveReady, releaseFirst, releaseSecond := newCoordinatedBootstrapAuthServices(t)
		userResult := make(chan error, 1)
		bootstrapResult := make(chan bootstrapAdminCallResult, 1)

		go func() {
			_, err := first.CreatePasswordUser("alice", "AlicePassword123", "Alice", DefaultManagedRoleID, true)
			userResult <- err
		}()
		go func() {
			result, err := second.EnsureBootstrapAdmin("admin", "AdminPassword123")
			bootstrapResult <- bootstrapAdminCallResult{result: result, err: err}
		}()

		waitForAuthTestValue(t, saveReady)
		waitForAuthTestValue(t, saveReady)
		releaseFirst <- struct{}{}
		if err := waitForAuthTestValue(t, userResult); err != nil {
			t.Fatalf("concurrent CreatePasswordUser() error = %v", err)
		}

		releaseSecond <- struct{}{}
		created := waitForAuthTestValue(t, bootstrapResult)
		if created.err != nil || !created.result.Created || created.result.Username != "admin" {
			t.Fatalf("EnsureBootstrapAdmin() after unrelated conflict = (%#v, %v), want created admin", created.result, created.err)
		}
		if len(second.accounts) != 2 {
			t.Fatalf("second service accounts after retry = %#v, want user and admin", second.accounts)
		}
		if _, ok := passwordAccountByUsernameLocked(second.accounts, "alice"); !ok {
			t.Fatalf("concurrent user was lost after bootstrap retry: %#v", second.accounts)
		}
		if admin, ok := bootstrapAdminAccountLocked(second.accounts); !ok || !verifyAccountPassword("AdminPassword123", admin.PasswordHash) {
			t.Fatalf("retried bootstrap admin = %#v, exists=%v", admin, ok)
		}
	})
}

func TestAuthServiceEnsureBootstrapAdminBoundsConflictRetries(t *testing.T) {
	backend := &alwaysConflictingBootstrapAuthStorage{}
	auth := newTestAuthService(t, backend)

	result, err := auth.EnsureBootstrapAdmin("admin", "AdminPassword123")
	if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
		t.Fatalf("EnsureBootstrapAdmin() = (%#v, %v), want concurrent update", result, err)
	}
	if backend.saveCalls != bootstrapAdminSaveAttempts {
		t.Fatalf("bootstrap save calls = %d, want %d", backend.saveCalls, bootstrapAdminSaveAttempts)
	}
	if len(auth.accounts) != 0 {
		t.Fatalf("failed bootstrap left in-memory account: %#v", auth.accounts)
	}
}

func newCoordinatedBootstrapAuthServices(t *testing.T) (*AuthService, *AuthService, <-chan struct{}, chan<- struct{}, chan<- struct{}) {
	t.Helper()
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "bootstrap.db"))
	firstDatabase, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(first) error = %v", err)
	}
	t.Cleanup(func() { _ = firstDatabase.Close() })
	secondDatabase, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(second) error = %v", err)
	}
	t.Cleanup(func() { _ = secondDatabase.Close() })

	saveReady := make(chan struct{}, 2)
	releaseFirst := make(chan struct{}, 1)
	releaseSecond := make(chan struct{}, 1)
	firstBackend := &coordinatedBootstrapAuthBackend{
		DatabaseBackend: firstDatabase,
		saveReady:       saveReady,
		saveRelease:     releaseFirst,
	}
	secondBackend := &coordinatedBootstrapAuthBackend{
		DatabaseBackend: secondDatabase,
		saveReady:       saveReady,
		saveRelease:     releaseSecond,
	}
	return newTestAuthService(t, firstBackend), newTestAuthService(t, secondBackend), saveReady, releaseFirst, releaseSecond
}

func waitForAuthTestValue[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for coordinated auth operation")
		var zero T
		return zero
	}
}

func TestAuthServiceDeleteUserDoesNotDeleteBootstrapAdmin(t *testing.T) {
	backend := &failingAtomicAuthStorage{}
	auth := newTestAuthService(t, backend)
	const password = "AdminPassword123"
	result, err := auth.EnsureBootstrapAdmin("admin", password)
	if err != nil || !result.Created {
		t.Fatalf("EnsureBootstrapAdmin() = (%#v, %v), want created admin", result, err)
	}

	deleted, err := auth.DeleteUser(AuthRoleAdmin)
	if err != nil || deleted {
		t.Fatalf("DeleteUser(admin) = (%v, %v), want protected account", deleted, err)
	}
	identity, token, err := auth.LoginPassword("admin", password)
	if err != nil || identity == nil || identity.Role != AuthRoleAdmin || token == "" {
		t.Fatalf("LoginPassword(admin) = (%#v, %q, %v), want working admin login", identity, token, err)
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
