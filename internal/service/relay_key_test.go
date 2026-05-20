package service

import (
	"path/filepath"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestRelayAPIKeyServiceStoresPerOwnerKeys(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "test.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	keys := NewRelayAPIKeyService(backend)
	if status := keys.Status("alice"); status["has_key"] != false {
		t.Fatalf("initial status = %#v", status)
	}

	status, err := keys.Save("alice", "sk-alice-secret")
	if err != nil {
		t.Fatalf("Save(alice) error = %v", err)
	}
	if status["has_key"] != true || status["key_preview"] == "sk-alice-secret" || status["updated_at"] == "" {
		t.Fatalf("saved alice status = %#v", status)
	}
	if key, ok := keys.Get("alice"); !ok || key != "sk-alice-secret" {
		t.Fatalf("Get(alice) = %q %v", key, ok)
	}
	if key, ok := keys.Get("bob"); ok || key != "" {
		t.Fatalf("Get(bob) = %q %v", key, ok)
	}

	status, err = keys.Save("bob", "sk-bob-secret")
	if err != nil {
		t.Fatalf("Save(bob) error = %v", err)
	}
	if status["has_key"] != true {
		t.Fatalf("saved bob status = %#v", status)
	}
	if key, ok := keys.Get("alice"); !ok || key != "sk-alice-secret" {
		t.Fatalf("Get(alice) after bob save = %q %v", key, ok)
	}

	status, err = keys.Delete("alice")
	if err != nil {
		t.Fatalf("Delete(alice) error = %v", err)
	}
	if status["has_key"] != false {
		t.Fatalf("deleted alice status = %#v", status)
	}
	if key, ok := keys.Get("alice"); ok || key != "" {
		t.Fatalf("Get(alice) after delete = %q %v", key, ok)
	}
	if key, ok := keys.Get("bob"); !ok || key != "sk-bob-secret" {
		t.Fatalf("Get(bob) after alice delete = %q %v", key, ok)
	}
}
