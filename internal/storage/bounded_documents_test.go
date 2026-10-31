package storage

import (
	"context"
	"errors"
	"testing"
	"time"
)

// hangingDocumentStore blocks every context-aware call until its context is done.
type hangingDocumentStore struct {
	JSONDocumentBackend
}

func (hangingDocumentStore) LoadJSONDocumentContext(ctx context.Context, _ string) (any, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (hangingDocumentStore) SaveJSONDocumentContext(ctx context.Context, _ string, _ any) error {
	<-ctx.Done()
	return ctx.Err()
}

// plainDocumentStore has no context support, so the bounded helpers must use the plain methods.
type plainDocumentStore struct {
	JSONDocumentBackend
	loaded bool
	saved  bool
}

func (s *plainDocumentStore) LoadJSONDocument(string) (any, error) {
	s.loaded = true
	return "value", nil
}

func (s *plainDocumentStore) SaveJSONDocument(string, any) error {
	s.saved = true
	return nil
}

func TestBoundedDocumentHelpersReturnWhenTheDatabaseHangs(t *testing.T) {
	original := BoundedDocumentTimeout
	BoundedDocumentTimeout = 50 * time.Millisecond
	t.Cleanup(func() { BoundedDocumentTimeout = original })

	started := time.Now()
	if _, err := LoadJSONDocumentBounded(hangingDocumentStore{}, "doc.json"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("load error = %v, want deadline exceeded", err)
	}
	if err := SaveJSONDocumentBounded(hangingDocumentStore{}, "doc.json", map[string]any{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("save error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("bounded calls took %v, the timeout was not applied", elapsed)
	}
}

func TestBoundedDocumentHelpersFallBackWithoutContextSupport(t *testing.T) {
	store := &plainDocumentStore{}
	value, err := LoadJSONDocumentBounded(store, "doc.json")
	if err != nil || value != "value" || !store.loaded {
		t.Fatalf("load = (%v, %v), loaded=%v", value, err, store.loaded)
	}
	if err := SaveJSONDocumentBounded(store, "doc.json", map[string]any{}); err != nil || !store.saved {
		t.Fatalf("save error = %v, saved=%v", err, store.saved)
	}
}

func TestBoundedDocumentHelpersHandleNilStore(t *testing.T) {
	if value, err := LoadJSONDocumentBounded(nil, "doc.json"); value != nil || err != nil {
		t.Fatalf("nil store load = (%v, %v)", value, err)
	}
	if err := SaveJSONDocumentBounded(nil, "doc.json", nil); err == nil {
		t.Fatal("nil store save should fail")
	}
}
