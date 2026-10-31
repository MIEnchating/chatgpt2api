package storage

import (
	"context"
	"fmt"
	"time"
)

// BoundedDocumentTimeout bounds one JSON document read or write so a slow database cannot hold callers' locks indefinitely.
var BoundedDocumentTimeout = 10 * time.Second

// LoadJSONDocumentBounded reads a document with BoundedDocumentTimeout when the backend supports cancellation.
func LoadJSONDocumentBounded(store JSONDocumentBackend, name string) (any, error) {
	if store == nil {
		return nil, nil
	}
	contextStore, ok := store.(ContextJSONDocumentBackend)
	if !ok {
		return store.LoadJSONDocument(name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), BoundedDocumentTimeout)
	defer cancel()
	return contextStore.LoadJSONDocumentContext(ctx, name)
}

// SaveJSONDocumentBounded writes a document with BoundedDocumentTimeout when the backend supports cancellation.
func SaveJSONDocumentBounded(store JSONDocumentBackend, name string, value any) error {
	if store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	contextStore, ok := store.(ContextJSONDocumentBackend)
	if !ok {
		return store.SaveJSONDocument(name, value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), BoundedDocumentTimeout)
	defer cancel()
	return contextStore.SaveJSONDocumentContext(ctx, name, value)
}
