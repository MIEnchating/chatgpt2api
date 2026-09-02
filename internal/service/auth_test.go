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
		b.waitForSaveRelease()
	}
	return b.DatabaseBackend.SaveJSONDocument(name, value)
}

func (b *coordinatedBootstrapAuthBackend) SaveAuthState(items []map[string]any, documents map[string]any) error {
	b.waitForSaveRelease()
	return b.DatabaseBackend.SaveAuthState(items, documents)
}

func (b *coordinatedBootstrapAuthBackend) SaveAuthKeys(items []map[string]any) error {
	b.waitForSaveRelease()
	return b.DatabaseBackend.SaveAuthKeys(items)
}

func (b *coordinatedBootstrapAuthBackend) waitForSaveRelease() {
	b.coordinateSave.Do(func() {
		b.saveReady <- struct{}{}
		<-b.saveRelease
	})
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

type newAPISessionCallResult struct {
	identity *Identity
	token    string
	err      error
}

type updateUserCallResult struct {
	user map[string]any
	err  error
}

type deleteRoleCallResult struct {
	deleted bool
	err     error
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
	auth := newTestAuthService(t, &failingAtomicAuthStorage{})
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

func TestAuthServiceConcurrentNewAPISessionPersistsOneToken(t *testing.T) {
	first, second, saveReady, releaseFirst, releaseSecond := newCoordinatedBootstrapAuthServices(t)
	user := NewAPIUser{ID: 42, Username: "alice", DisplayName: "Alice"}
	firstResult := make(chan newAPISessionCallResult, 1)
	secondResult := make(chan newAPISessionCallResult, 1)

	go func() {
		identity, token, err := first.UpsertNewAPISession(user)
		firstResult <- newAPISessionCallResult{identity: identity, token: token, err: err}
	}()
	go func() {
		identity, token, err := second.UpsertNewAPISession(user)
		secondResult <- newAPISessionCallResult{identity: identity, token: token, err: err}
	}()

	waitForAuthTestValue(t, saveReady)
	waitForAuthTestValue(t, saveReady)
	releaseFirst <- struct{}{}
	committed := waitForAuthTestValue(t, firstResult)
	if committed.err != nil || committed.identity == nil || committed.token == "" {
		t.Fatalf("first UpsertNewAPISession() = (%#v, %q, %v), want committed session", committed.identity, committed.token, committed.err)
	}

	releaseSecond <- struct{}{}
	conflicted := waitForAuthTestValue(t, secondResult)
	if !errors.Is(conflicted.err, storage.ErrConcurrentRowUpdate) || conflicted.identity != nil || conflicted.token != "" {
		t.Fatalf("second UpsertNewAPISession() = (%#v, %q, %v), want persistence conflict", conflicted.identity, conflicted.token, conflicted.err)
	}
	if identity := second.Authenticate(committed.token); identity == nil || identity.ID != committed.identity.ID {
		t.Fatalf("Authenticate(committed token) = %#v", identity)
	}
	ownerSessions := 0
	for _, item := range second.items {
		if util.Clean(item["provider"]) == AuthProviderNewAPI && util.Clean(item["owner_id"]) == committed.identity.ID {
			ownerSessions++
			if hash := util.Clean(item["key_hash"]); hash != util.SHA256Hex(committed.token) {
				t.Fatalf("persisted session hash = %q, want committed token hash", hash)
			}
		}
	}
	if ownerSessions != 1 {
		t.Fatalf("persisted owner sessions = %d, items = %#v", ownerSessions, second.items)
	}
}

func TestAuthServiceConcurrentNewAPISessionsForDifferentOwnersDoNotConflict(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "different-owners.db"))
	first, second, saveReady, releaseFirst, releaseSecond := newCoordinatedAuthServices(t, databaseURL)
	firstResult := make(chan newAPISessionCallResult, 1)
	secondResult := make(chan newAPISessionCallResult, 1)
	go func() {
		identity, token, err := first.UpsertNewAPISession(NewAPIUser{ID: 1, Username: "alice"})
		firstResult <- newAPISessionCallResult{identity: identity, token: token, err: err}
	}()
	go func() {
		identity, token, err := second.UpsertNewAPISession(NewAPIUser{ID: 2, Username: "bob"})
		secondResult <- newAPISessionCallResult{identity: identity, token: token, err: err}
	}()
	waitForAuthTestValue(t, saveReady)
	waitForAuthTestValue(t, saveReady)
	releaseFirst <- struct{}{}
	releaseSecond <- struct{}{}
	for index, result := range []newAPISessionCallResult{
		waitForAuthTestValue(t, firstResult),
		waitForAuthTestValue(t, secondResult),
	} {
		if result.err != nil || result.identity == nil || result.token == "" {
			t.Fatalf("UpsertNewAPISession(result %d) = (%#v, %q, %v)", index, result.identity, result.token, result.err)
		}
	}

	verifierBackend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(verifier) error = %v", err)
	}
	t.Cleanup(func() { _ = verifierBackend.Close() })
	verifier := newTestAuthService(t, verifierBackend)
	if users := verifier.ListUsers(); len(users) != 2 {
		t.Fatalf("persisted users = %#v, want two external owners", users)
	}
}

func TestAuthServiceDeleteRoleAndAssignRoleAreSerializedAcrossInstances(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		localUser   bool
		deleteFirst bool
	}{
		{name: "external user delete commits first", deleteFirst: true},
		{name: "external user assignment commits first", deleteFirst: false},
		{name: "local user delete commits first", localUser: true, deleteFirst: true},
		{name: "local user assignment commits first", localUser: true, deleteFirst: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "role-race.db"))
			seedBackend, err := storage.NewDatabaseBackend(databaseURL)
			if err != nil {
				t.Fatalf("NewDatabaseBackend(seed) error = %v", err)
			}
			t.Cleanup(func() { _ = seedBackend.Close() })
			seed := newTestAuthService(t, seedBackend)
			role, err := seed.CreateRole(map[string]any{"name": "Reviewer"})
			if err != nil {
				t.Fatalf("CreateRole() error = %v", err)
			}
			roleID := util.Clean(role["id"])
			userID := ""
			if testCase.localUser {
				user, createErr := seed.CreatePasswordUser("reviewer", "Password123!", "Reviewer", DefaultManagedRoleID, true)
				if createErr != nil {
					t.Fatalf("CreatePasswordUser() error = %v", createErr)
				}
				userID = util.Clean(user["id"])
			} else {
				identity, _, sessionErr := seed.UpsertNewAPISession(NewAPIUser{ID: 7, Username: "reviewer"})
				if sessionErr != nil {
					t.Fatalf("UpsertNewAPISession() error = %v", sessionErr)
				}
				userID = identity.ID
			}

			deleter, updater, saveReady, releaseDelete, releaseUpdate := newCoordinatedAuthServices(t, databaseURL)
			deleteResult := make(chan deleteRoleCallResult, 1)
			updateResult := make(chan updateUserCallResult, 1)
			go func() {
				deleted, err := deleter.DeleteRole(roleID)
				deleteResult <- deleteRoleCallResult{deleted: deleted, err: err}
			}()
			go func() {
				user, err := updater.UpdateUser(userID, map[string]any{"role_id": roleID})
				updateResult <- updateUserCallResult{user: user, err: err}
			}()

			waitForAuthTestValue(t, saveReady)
			waitForAuthTestValue(t, saveReady)
			if testCase.deleteFirst {
				releaseDelete <- struct{}{}
				deleted := waitForAuthTestValue(t, deleteResult)
				if deleted.err != nil || !deleted.deleted {
					t.Fatalf("DeleteRole() = (%v, %v), want success", deleted.deleted, deleted.err)
				}
				releaseUpdate <- struct{}{}
				updated := waitForAuthTestValue(t, updateResult)
				if !errors.Is(updated.err, storage.ErrConcurrentRowUpdate) || updated.user != nil {
					t.Fatalf("UpdateUser() = (%#v, %v), want persistence conflict", updated.user, updated.err)
				}
				assertManagedUserRoleReference(t, updater, userID, DefaultManagedRoleID, false, roleID)
				return
			}

			releaseUpdate <- struct{}{}
			updated := waitForAuthTestValue(t, updateResult)
			if updated.err != nil || util.Clean(updated.user["role_id"]) != roleID {
				t.Fatalf("UpdateUser() = (%#v, %v), want assigned role %q", updated.user, updated.err, roleID)
			}
			releaseDelete <- struct{}{}
			deleted := waitForAuthTestValue(t, deleteResult)
			if !errors.Is(deleted.err, storage.ErrConcurrentRowUpdate) || deleted.deleted {
				t.Fatalf("DeleteRole() = (%v, %v), want persistence conflict", deleted.deleted, deleted.err)
			}
			assertManagedUserRoleReference(t, deleter, userID, roleID, true, roleID)
		})
	}
}

func assertManagedUserRoleReference(t *testing.T, auth *AuthService, userID, wantRoleID string, wantRoleExists bool, racedRoleID string) {
	t.Helper()
	if got := auth.RoleExists(racedRoleID); got != wantRoleExists {
		t.Fatalf("RoleExists(%q) = %v, want %v", racedRoleID, got, wantRoleExists)
	}
	for _, user := range auth.ListUsers() {
		if util.Clean(user["id"]) != userID {
			continue
		}
		if roleID := util.Clean(user["role_id"]); roleID != wantRoleID {
			t.Fatalf("user role_id = %q, want %q; user = %#v", roleID, wantRoleID, user)
		}
		return
	}
	t.Fatalf("managed user %q not found", userID)
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
			auth := newTestAuthService(t, &failingAtomicAuthStorage{})
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
		auth := newTestAuthService(t, &failingAtomicAuthStorage{})
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
		backend := &failingAtomicAuthStorage{}
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

func TestAuthServiceDeduplicatesStoredSessionsByOwnerOnLoad(t *testing.T) {
	owner := AuthOwner{ID: "newapi:42", Name: "Alice", Provider: AuthProviderNewAPI}
	olderToken := "sess-older"
	newerToken := "sess-newer"
	older := newAuthItem(AuthRoleUser, "older", owner, olderToken)
	older["id"] = "credential-older"
	older["updated_at"] = "2026-08-01T00:00:00Z"
	newer := newAuthItem(AuthRoleUser, "newer", owner, newerToken)
	newer["id"] = "credential-newer"
	newer["updated_at"] = "2026-08-02T00:00:00Z"
	invalid := util.CopyMap(newer)
	invalid["id"] = "credential-invalid"
	invalid["updated_at"] = "2026-08-03T00:00:00Z"
	invalid["key_hash"] = ""
	backend := &failingAtomicAuthStorage{failingAuthStorage: failingAuthStorage{
		items: []map[string]any{older, invalid, newer},
	}}

	auth := newTestAuthService(t, backend)
	if len(backend.items) != 1 || util.Clean(backend.items[0]["id"]) != "credential-newer" {
		t.Fatalf("sanitized stored sessions = %#v, want latest valid session", backend.items)
	}
	if identity := auth.Authenticate(olderToken); identity != nil {
		t.Fatalf("older duplicate session still authenticates: %#v", identity)
	}
	if identity := auth.Authenticate(newerToken); identity == nil || identity.CredentialID != "credential-newer" {
		t.Fatalf("Authenticate(newer token) = %#v", identity)
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
	return newCoordinatedAuthServices(t, databaseURL)
}

func newCoordinatedAuthServices(t *testing.T, databaseURL string) (*AuthService, *AuthService, <-chan struct{}, chan<- struct{}, chan<- struct{}) {
	t.Helper()
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

func (s *failingAtomicAuthStorage) SaveAuthState(items []map[string]any, documents map[string]any) error {
	if s.failAtomic {
		return errors.New("atomic auth storage unavailable")
	}
	previousItems := cloneAuthItems(s.items)
	previousDocuments := make(map[string]any, len(s.documents))
	for name, value := range s.documents {
		previousDocuments[name] = value
	}
	if err := s.SaveAuthKeys(items); err != nil {
		return err
	}
	for name, value := range documents {
		if err := s.SaveJSONDocument(name, value); err != nil {
			s.items = previousItems
			s.documents = previousDocuments
			return err
		}
	}
	return nil
}
