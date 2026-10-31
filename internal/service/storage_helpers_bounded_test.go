package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

// hangingContextStore blocks every call until the caller's context is done.
type hangingContextStore struct {
	storage.JSONDocumentBackend
}

func (hangingContextStore) LoadJSONDocumentContext(ctx context.Context, _ string) (any, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (hangingContextStore) SaveJSONDocumentContext(ctx context.Context, _ string, _ any) error {
	<-ctx.Done()
	return ctx.Err()
}

// plainStore does not support contexts, so the helpers must fall back to the unbounded methods.
type plainStore struct {
	storage.JSONDocumentBackend
	loaded bool
	saved  bool
}

func (s *plainStore) LoadJSONDocument(string) (any, error) {
	s.loaded = true
	return "value", nil
}

func (s *plainStore) SaveJSONDocument(string, any) error {
	s.saved = true
	return nil
}

func shortenTaskStorageTimeout(t *testing.T) {
	t.Helper()
	original := taskStorageTimeout
	taskStorageTimeout = 50 * time.Millisecond
	t.Cleanup(func() { taskStorageTimeout = original })
}

func TestBoundedStorageHelpersReturnWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	store := hangingContextStore{}

	started := time.Now()
	if _, err := loadStoredJSONBounded(store, "tasks.json"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("load error = %v, want deadline exceeded", err)
	}
	if err := saveStoredJSONBounded(store, "tasks.json", map[string]any{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("save error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("bounded calls took %v, the timeout was not applied", elapsed)
	}
}

func TestBoundedStorageHelpersFallBackForBackendsWithoutContextSupport(t *testing.T) {
	store := &plainStore{}
	value, err := loadStoredJSONBounded(store, "tasks.json")
	if err != nil || value != "value" || !store.loaded {
		t.Fatalf("load = (%v, %v), loaded=%v", value, err, store.loaded)
	}
	if err := saveStoredJSONBounded(store, "tasks.json", map[string]any{}); err != nil || !store.saved {
		t.Fatalf("save error = %v, saved=%v", err, store.saved)
	}
}

func TestBoundedStorageHelpersHandleNilStore(t *testing.T) {
	if value, err := loadStoredJSONBounded(nil, "tasks.json"); value != nil || err != nil {
		t.Fatalf("nil store load = (%v, %v)", value, err)
	}
	if err := saveStoredJSONBounded(nil, "tasks.json", nil); err == nil {
		t.Fatal("nil store save should fail")
	}
}
