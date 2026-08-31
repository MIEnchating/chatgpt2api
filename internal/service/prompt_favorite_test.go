package service

import (
	"path/filepath"
	"sync"
	"testing"

	"chatgpt2api/internal/storage"
)

type testDocumentSaveBarrier struct {
	mu        sync.Mutex
	remaining int
	release   chan struct{}
}

func newTestDocumentSaveBarrier(participants int) *testDocumentSaveBarrier {
	return &testDocumentSaveBarrier{remaining: participants, release: make(chan struct{})}
}

func (b *testDocumentSaveBarrier) wait() {
	b.mu.Lock()
	b.remaining--
	if b.remaining == 0 {
		close(b.release)
	}
	b.mu.Unlock()
	<-b.release
}

type firstSaveBarrierBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
	barrier   *testDocumentSaveBarrier
	once      sync.Once
}

func newFirstSaveBarrierBackend(t *testing.T, backend storage.Backend, barrier *testDocumentSaveBarrier) *firstSaveBarrierBackend {
	t.Helper()
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatal("test backend does not support JSON documents")
	}
	return &firstSaveBarrierBackend{Backend: backend, documents: documents, barrier: barrier}
}

func (b *firstSaveBarrierBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *firstSaveBarrierBackend) SaveJSONDocument(name string, value any) error {
	b.once.Do(b.barrier.wait)
	return b.documents.SaveJSONDocument(name, value)
}

func (b *firstSaveBarrierBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func TestPromptFavoriteServiceUpsertListAndDelete(t *testing.T) {
	backend := newTestStorageBackend(t)
	service := NewPromptFavoriteService(backend)

	item, err := service.Upsert("user_1", map[string]any{
		"prompt_id":            "prompt-a",
		"source":               "banana-prompt-quicker",
		"title":                "Prompt A",
		"preview":              "https://example.test/a.png",
		"reference_image_urls": []any{"https://example.test/ref.png", "https://example.test/ref.png"},
		"prompt":               "draw a cat",
		"author":               "Alice",
		"mode":                 "edit",
		"category":             "Animals",
		"tags":                 []any{"cat", "poster", "cat"},
		"source_label":         "banana-prompt-quicker",
		"is_nsfw":              false,
		"localizations": map[string]any{
			"zh-CN": map[string]any{
				"title":        "提示词 A",
				"prompt":       "画一只猫",
				"category":     "动物",
				"sub_category": "猫",
			},
			"fr": map[string]any{
				"title":    "ignored",
				"prompt":   "ignored",
				"category": "ignored",
			},
		},
	})
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if item["id"] == "" || item["mode"] != "edit" || item["favorited_at"] == "" {
		t.Fatalf("created favorite = %#v", item)
	}
	if refs := item["reference_image_urls"].([]string); len(refs) != 1 {
		t.Fatalf("reference urls were not normalized: %#v", item["reference_image_urls"])
	}
	if tags := item["tags"].([]string); len(tags) != 2 || tags[0] != "cat" || tags[1] != "poster" {
		t.Fatalf("tags were not normalized: %#v", item["tags"])
	}
	if localizations := item["localizations"].(map[string]any); len(localizations) != 1 {
		t.Fatalf("localizations were not normalized: %#v", item["localizations"])
	}

	items, err := service.ListWithError("user_1")
	if err != nil {
		t.Fatalf("ListWithError() error = %v", err)
	}
	if len(items) != 1 || items[0]["title"] != "Prompt A" {
		t.Fatalf("ListWithError() = %#v", items)
	}
	otherItems, err := service.ListWithError("user_2")
	if err != nil {
		t.Fatalf("ListWithError(other owner) error = %v", err)
	}
	if len(otherItems) != 0 {
		t.Fatalf("other owner saw favorites: %#v", otherItems)
	}

	updated, err := service.Upsert("user_1", map[string]any{
		"prompt_id":    "prompt-a",
		"source":       "banana-prompt-quicker",
		"title":        "Prompt A Updated",
		"preview":      "https://example.test/a2.png",
		"prompt":       "draw a dog",
		"author":       "Alice",
		"mode":         "generate",
		"category":     "Animals",
		"source_label": "banana-prompt-quicker",
	})
	if err != nil {
		t.Fatalf("second Upsert() error = %v", err)
	}
	if updated["id"] != item["id"] || updated["favorited_at"] != item["favorited_at"] {
		t.Fatalf("duplicate upsert changed identity fields: first=%#v second=%#v", item, updated)
	}
	items, err = service.ListWithError("user_1")
	if err != nil {
		t.Fatalf("ListWithError(after update) error = %v", err)
	}
	if len(items) != 1 || items[0]["title"] != "Prompt A Updated" {
		t.Fatalf("duplicate upsert did not update in place: %#v", items)
	}

	if deleted, err := service.Delete("user_1", item["id"].(string)); err != nil || !deleted {
		t.Fatalf("Delete() = %v, %v", deleted, err)
	}
	items, err = service.ListWithError("user_1")
	if err != nil {
		t.Fatalf("ListWithError(after delete) error = %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("favorite remained after delete: %#v", items)
	}
	if deleted, err := service.Delete("user_1", item["id"].(string)); err != nil || deleted {
		t.Fatalf("Delete() missing favorite = %v, %v", deleted, err)
	}
}

func TestPromptFavoriteServiceRejectsInvalidInput(t *testing.T) {
	service := NewPromptFavoriteService(newTestStorageBackend(t))

	cases := []map[string]any{
		{"source": "banana-prompt-quicker", "title": "Title", "preview": "https://example.test/a.png", "prompt": "draw", "author": "Alice"},
		{"prompt_id": "p1", "source": "unknown", "title": "Title", "preview": "https://example.test/a.png", "prompt": "draw", "author": "Alice"},
		{"prompt_id": "p1", "source": "banana-prompt-quicker", "preview": "https://example.test/a.png", "prompt": "draw", "author": "Alice"},
		{"prompt_id": "p1", "source": "banana-prompt-quicker", "title": "Title", "prompt": "draw", "author": "Alice"},
		{"prompt_id": "p1", "source": "banana-prompt-quicker", "title": "Title", "preview": "https://example.test/a.png", "author": "Alice"},
	}
	for index, body := range cases {
		if _, err := service.Upsert("user_1", body); err == nil {
			t.Fatalf("case %d Upsert() error = nil", index)
		}
	}
}

func TestPromptFavoriteServiceDoesNotInventReferenceProjectModeOrReferences(t *testing.T) {
	service := NewPromptFavoriteService(newTestStorageBackend(t))
	item, err := service.Upsert("user_1", map[string]any{
		"prompt_id":            "gpt-image-2-prompts:0001",
		"source":               "gpt-image-2-prompts",
		"title":                "Prompt",
		"preview":              "https://example.test/cover.png",
		"reference_image_urls": []any{"https://example.test/cover.png"},
		"prompt":               "draw",
		"author":               "Source",
		"mode":                 "generate",
		"category":             "Portrait",
	})
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if _, ok := item["mode"]; ok {
		t.Fatalf("reference project favorite mode = %#v, want absent", item["mode"])
	}
	if refs := item["reference_image_urls"].([]string); len(refs) != 0 {
		t.Fatalf("reference project favorite references = %#v, want empty", refs)
	}
}

func TestPromptFavoriteServiceMergesConcurrentDatabaseUpdates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-favorites.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewPromptFavoriteService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewPromptFavoriteService(newFirstSaveBarrierBackend(t, backendB, barrier))

	body := func(id string) map[string]any {
		return map[string]any{
			"prompt_id": id, "source": "banana-prompt-quicker", "title": id,
			"preview": "https://example.test/preview.png", "prompt": "draw", "author": "Alice",
		}
	}
	type upsertResult struct {
		items []map[string]any
		err   error
	}
	resultsCh := make(chan upsertResult, 2)
	go func() {
		_, items, saveErr := serviceA.UpsertWithItems("owner", body("prompt-a"))
		resultsCh <- upsertResult{items: items, err: saveErr}
	}()
	go func() {
		_, items, saveErr := serviceB.UpsertWithItems("owner", body("prompt-b"))
		resultsCh <- upsertResult{items: items, err: saveErr}
	}()
	maxResponseItems := 0
	for range 2 {
		result := <-resultsCh
		if result.err != nil {
			t.Fatalf("concurrent UpsertWithItems() error = %v", result.err)
		}
		if len(result.items) > maxResponseItems {
			maxResponseItems = len(result.items)
		}
	}
	if maxResponseItems != 2 {
		t.Fatalf("successful CAS response omitted a previously committed favorite: max items = %d", maxResponseItems)
	}
	items, err := serviceA.ListWithError("owner")
	if err != nil {
		t.Fatalf("ListWithError() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("concurrent favorites lost an update: %#v", items)
	}
}
