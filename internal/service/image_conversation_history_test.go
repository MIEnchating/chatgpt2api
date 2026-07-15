package service

import "testing"

func TestImageConversationHistoryServicePersistsAndIsolatesOwners(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)

	items, err := history.Merge("user-a", []map[string]any{
		{
			"id":        "conversation-1",
			"title":     "first",
			"updatedAt": "2026-07-15T10:00:00Z",
			"turns":     []any{map[string]any{"id": "turn-1"}},
		},
	})
	if err != nil {
		t.Fatalf("Merge() error = %v", err)
	}
	if len(items) != 1 || items[0]["title"] != "first" {
		t.Fatalf("Merge() items = %#v", items)
	}

	items, err = history.Merge("user-a", []map[string]any{
		{
			"id":        "conversation-1",
			"title":     "older",
			"updatedAt": "2026-07-15T09:00:00Z",
			"turns":     []any{},
		},
		{
			"id":        "conversation-2",
			"title":     "second",
			"updatedAt": "2026-07-15T11:00:00Z",
			"turns":     []any{},
		},
	})
	if err != nil {
		t.Fatalf("second Merge() error = %v", err)
	}
	if len(items) != 2 || items[0]["id"] != "conversation-2" || items[1]["title"] != "first" {
		t.Fatalf("second Merge() items = %#v", items)
	}

	other, err := history.List("user-b")
	if err != nil {
		t.Fatalf("List(other) error = %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("other owner saw conversations: %#v", other)
	}

	reloaded := NewImageConversationHistoryService(backend)
	items, err = reloaded.List("user-a")
	if err != nil || len(items) != 2 {
		t.Fatalf("reloaded List() items=%#v error=%v", items, err)
	}

	items, removed, err := reloaded.Delete("user-a", "conversation-1")
	if err != nil || !removed || len(items) != 1 {
		t.Fatalf("Delete() items=%#v removed=%v error=%v", items, removed, err)
	}
	if err := reloaded.Clear("user-a"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	items, err = reloaded.List("user-a")
	if err != nil || len(items) != 0 {
		t.Fatalf("List() after Clear items=%#v error=%v", items, err)
	}
}

func TestImageConversationHistoryServiceRejectsInvalidItems(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	for index, item := range []map[string]any{
		{"updatedAt": "2026-07-15T10:00:00Z", "turns": []any{}},
		{"id": "conversation-1", "turns": []any{}},
		{"id": "conversation-1", "updatedAt": "2026-07-15T10:00:00Z"},
	} {
		if _, err := history.Merge("user-a", []map[string]any{item}); err == nil {
			t.Fatalf("case %d Merge() error = nil", index)
		}
	}
}
