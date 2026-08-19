package service

import (
	"fmt"

	"chatgpt2api/internal/storage"
)

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
