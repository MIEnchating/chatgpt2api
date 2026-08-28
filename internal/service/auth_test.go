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
