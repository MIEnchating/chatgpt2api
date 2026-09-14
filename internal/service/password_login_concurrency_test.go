package service

import (
	"errors"
	"testing"

	"chatgpt2api/internal/storage"
)

type passwordSnapshotMutationBackend struct {
	*storage.DatabaseBackend
	afterPasswordRead func()
}

func (b *passwordSnapshotMutationBackend) LoadJSONDocument(name string) (any, error) {
	value, err := b.DatabaseBackend.LoadJSONDocument(name)
	if name == passwordAccountsDocumentName && err == nil && b.afterPasswordRead != nil {
		hook := b.afterPasswordRead
		b.afterPasswordRead = nil
		hook()
	}
	return value, err
}

func TestPasswordLoginRechecksAccountAfterPasswordSnapshot(t *testing.T) {
	for _, change := range []string{"disable", "delete", "password", "replace"} {
		t.Run(change, func(t *testing.T) {
			backend := &passwordSnapshotMutationBackend{DatabaseBackend: newRoleConcurrencyBackend(t, "sqlite:///"+t.TempDir()+"/auth.db")}
			auth := newTestAuthService(t, backend)
			if _, err := auth.CreatePasswordUser("alice", "review-password", "Alice", DefaultManagedRoleID, true); err != nil {
				t.Fatal(err)
			}
			accounts := append([]PasswordAccount(nil), auth.accounts...)
			backend.afterPasswordRead = func() {
				switch change {
				case "disable":
					accounts[0].Enabled = false
				case "delete":
					accounts = nil
				case "password":
					accounts[0].PasswordHash = "changed-hash"
				case "replace":
					accounts[0].ID = "replacement-user"
				}
				if err := backend.SaveJSONDocument(passwordAccountsDocumentName, storedAuthDocument(accounts, storedPasswordAccount)); err != nil {
					t.Fatal(err)
				}
			}
			identity, token, err := auth.LoginPassword("alice", "review-password")
			wantErr := ErrInvalidPasswordCredentials
			if change == "disable" {
				wantErr = ErrAuthUserDisabled
			}
			if !errors.Is(err, wantErr) || identity != nil || token != "" {
				t.Fatalf("LoginPassword after %s = (%#v, %q, %v), want %v and no session", change, identity, token, err, wantErr)
			}
			items, err := backend.LoadAuthKeys()
			if err != nil || len(items) != 0 {
				t.Fatalf("persisted sessions = %#v, %v, want none", items, err)
			}
		})
	}
}
