package service

import (
	"testing"

	"chatgpt2api/internal/storage"
)

func TestWorkflowLoadIsolatesInvalidStoredItem(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := backend.(storage.JSONDocumentBackend)
	document := map[string]any{"items": []any{
		map[string]any{"id": "bad", "owner_id": "alice", "name": ""},
		map[string]any{"id": "good", "owner_id": "alice", "name": "ok", "revision": 1},
	}}
	if err := store.SaveJSONDocument(workflowDocumentName, document); err != nil {
		t.Fatal(err)
	}
	items, err := NewWorkflowService(backend).List("alice")
	if err != nil || len(items) != 1 || items[0].ID != "good" {
		t.Fatalf("List() = (%#v, %v), want only the valid workflow", items, err)
	}
}
