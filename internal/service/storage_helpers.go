package service

import (
	"context"
	"fmt"
	"time"

	"chatgpt2api/internal/storage"
)

// taskStorageTimeout bounds one task-document read or write so a slow database cannot hold the task lock indefinitely.
var taskStorageTimeout = 10 * time.Second

func jsonDocumentStoreFromBackend(backend storage.Backend) storage.JSONDocumentBackend {
	if store, ok := backend.(storage.JSONDocumentBackend); ok {
		return store
	}
	return nil
}

func firstJSONDocumentStore(backends []storage.Backend) storage.JSONDocumentBackend {
	if len(backends) == 0 {
		return nil
	}
	return jsonDocumentStoreFromBackend(backends[0])
}

func loadStoredJSON(store storage.JSONDocumentBackend, name string) (any, error) {
	if store == nil {
		return nil, nil
	}
	return store.LoadJSONDocument(name)
}

func saveStoredJSON(store storage.JSONDocumentBackend, name string, value any) error {
	if store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return store.SaveJSONDocument(name, value)
}

// loadStoredJSONBounded reads a document with taskStorageTimeout when the backend supports cancellation.
func loadStoredJSONBounded(store storage.JSONDocumentBackend, name string) (any, error) {
	if store == nil {
		return nil, nil
	}
	contextStore, ok := store.(storage.ContextJSONDocumentBackend)
	if !ok {
		return store.LoadJSONDocument(name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), taskStorageTimeout)
	defer cancel()
	return contextStore.LoadJSONDocumentContext(ctx, name)
}

// saveStoredJSONBounded writes a document with taskStorageTimeout when the backend supports cancellation.
func saveStoredJSONBounded(store storage.JSONDocumentBackend, name string, value any) error {
	if store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	contextStore, ok := store.(storage.ContextJSONDocumentBackend)
	if !ok {
		return store.SaveJSONDocument(name, value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), taskStorageTimeout)
	defer cancel()
	return contextStore.SaveJSONDocumentContext(ctx, name, value)
}
