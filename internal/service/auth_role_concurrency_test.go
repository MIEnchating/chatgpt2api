package service

import (
	"errors"
	"path/filepath"
	"testing"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type authKeysReadHookBackend struct {
	*storage.DatabaseBackend
	beforeRead func()
}

func (b *authKeysReadHookBackend) LoadAuthKeys() ([]map[string]any, error) {
	if hook := b.beforeRead; hook != nil {
		b.beforeRead = nil
		hook()
	}
	return b.DatabaseBackend.LoadAuthKeys()
}

func newRoleConcurrencyBackend(t *testing.T, databaseURL string) *storage.DatabaseBackend {
	t.Helper()
	backend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func revokeDefaultRolePermissions(t *testing.T, auth *AuthService) {
	t.Helper()
	if _, err := auth.UpdateRole(DefaultManagedRoleID, map[string]any{"api_permissions": []string{}}); err != nil {
		t.Fatal(err)
	}
}

func TestAuthServiceRejectsConcurrentDefaultRoleRevocationDuringLogin(t *testing.T) {
	for _, kind := range []string{"password", "external"} {
		for _, existing := range []bool{false, true} {
			name := kind + "/new"
			if existing {
				name = kind + "/rotation"
			}
			t.Run(name, func(t *testing.T) {
				databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "auth.db"))
				writer := newTestAuthService(t, newRoleConcurrencyBackend(t, databaseURL))
				user := NewAPIUser{ID: 77, Username: "alice"}
				if kind == "password" {
					if _, err := writer.CreatePasswordUser("alice", "review-password", "Alice", DefaultManagedRoleID, true); err != nil {
						t.Fatal(err)
					}
				}
				login := func(auth *AuthService) (*Identity, string, error) {
					if kind == "password" {
						return auth.LoginPassword("alice", "review-password")
					}
					return auth.UpsertNewAPISession(user)
				}
				if existing {
					if _, _, err := login(writer); err != nil {
						t.Fatal(err)
					}
				}
				backend := &authKeysReadHookBackend{DatabaseBackend: newRoleConcurrencyBackend(t, databaseURL)}
				reader := newTestAuthService(t, backend)
				// Revoke after reading roles but before reading sessions.
				backend.beforeRead = func() { revokeDefaultRolePermissions(t, writer) }
				identity, token, err := login(reader)
				if !errors.Is(err, storage.ErrConcurrentRowUpdate) || identity != nil || token != "" {
					t.Fatalf("concurrent login = (%#v, %q, %v), want no session and a persistence conflict", identity, token, err)
				}
				identity, token, err = login(reader)
				if err != nil || identity == nil || len(identity.APIPermissions) != 0 {
					t.Fatalf("subsequent login restored revoked permissions: identity=%#v, err=%v", identity, err)
				}
				if authenticated := reader.Authenticate(token); authenticated == nil || len(authenticated.APIPermissions) != 0 {
					t.Fatalf("persisted session restored revoked permissions: %#v", authenticated)
				}
			})
		}
	}
}

func TestAuthServiceRejectsConcurrentDefaultRoleRevocationDuringAssignment(t *testing.T) {
	for _, kind := range []string{"password", "external"} {
		t.Run(kind, func(t *testing.T) {
			databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "auth.db"))
			writer := newTestAuthService(t, newRoleConcurrencyBackend(t, databaseURL))
			var userID string
			if kind == "password" {
				user, err := writer.CreatePasswordUser("alice", "review-password", "Alice", DefaultManagedRoleID, true)
				if err != nil {
					t.Fatal(err)
				}
				userID = util.Clean(user["id"])
			} else {
				user, _, err := writer.UpsertNewAPISession(NewAPIUser{ID: 77, Username: "alice"})
				if err != nil {
					t.Fatal(err)
				}
				userID = user.ID
			}
			if _, err := writer.EnsureBootstrapAdmin("admin", "review-password"); err != nil {
				t.Fatal(err)
			}
			_, adminToken, err := writer.LoginPassword("admin", "review-password")
			if err != nil {
				t.Fatal(err)
			}
			backend := &authKeysReadHookBackend{DatabaseBackend: newRoleConcurrencyBackend(t, databaseURL)}
			reader := newTestAuthService(t, backend)
			backend.beforeRead = func() { revokeDefaultRolePermissions(t, writer) }
			if reader.Authenticate(adminToken) == nil {
				t.Fatal("administrator authentication failed")
			}
			user, err := reader.UpdateUser(userID, map[string]any{"role_id": DefaultManagedRoleID})
			if !errors.Is(err, storage.ErrConcurrentRowUpdate) || user != nil {
				t.Fatalf("concurrent role assignment = (%#v, %v), want persistence conflict", user, err)
			}
		})
	}
}

func TestAuthServiceRejectsDefaultRoleUserCreationFromStaleRoles(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "auth.db"))
	writer := newTestAuthService(t, newRoleConcurrencyBackend(t, databaseURL))
	reader := newTestAuthService(t, newRoleConcurrencyBackend(t, databaseURL))
	revokeDefaultRolePermissions(t, writer)
	user, err := reader.CreatePasswordUser("alice", "review-password", "Alice", DefaultManagedRoleID, true)
	if !errors.Is(err, storage.ErrConcurrentRowUpdate) || user != nil {
		t.Fatalf("creation from stale roles = (%#v, %v), want persistence conflict", user, err)
	}
	verifier := newTestAuthService(t, newRoleConcurrencyBackend(t, databaseURL))
	if users := verifier.ListUsers(); len(users) != 0 {
		t.Fatalf("rejected creation persisted an account: %#v", users)
	}
}
