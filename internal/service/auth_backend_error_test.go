package service

import (
	"errors"
	"testing"
)

func TestAuthenticateWithErrorSeparatesUnknownCredentialFromUnreadableStorage(t *testing.T) {
	token := "sess-backend-error"
	backend := &failingAuthStorage{items: []map[string]any{
		newAuthItem(AuthRoleUser, "session", AuthOwner{ID: "newapi:backend", Provider: AuthProviderNewAPI}, token),
	}}
	auth := newTestAuthService(t, backend)

	identity, err := auth.AuthenticateWithError(token)
	if err != nil || identity == nil {
		t.Fatalf("healthy storage: identity=%v err=%v", identity, err)
	}

	identity, err = auth.AuthenticateWithError("sess-unknown")
	if err != nil || identity != nil {
		t.Fatalf("unknown credential must be unauthenticated without a backend error: identity=%v err=%v", identity, err)
	}

	backend.failLoad = true
	identity, err = auth.AuthenticateWithError(token)
	var persistenceErr AuthPersistenceError
	if identity != nil || !errors.As(err, &persistenceErr) {
		t.Fatalf("unreadable storage must return an AuthPersistenceError: identity=%v err=%v", identity, err)
	}
	if auth.Authenticate(token) != nil {
		t.Fatal("Authenticate must keep returning nil when storage is unreadable")
	}
}
