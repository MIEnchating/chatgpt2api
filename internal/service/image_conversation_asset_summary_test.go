package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

func TestImageConversationAssetReferencesUseSummaryWithoutLeakingInternalFields(t *testing.T) {
	backend := newTestStorageBackend(t)
	counting := newImageConversationReferenceCountingBackend(t, backend)
	ownerID := "summary-reference-owner"
	history := NewImageConversationHistoryService(counting)
	item := imageConversationAssetSummaryTestItem(ownerID, "summary-reference", 1)
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item}, nil); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("seed merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	history.SetConversationAssetService(NewImageConversationAssetService(t.TempDir()))
	counting.loadCalls = 0

	references, err := history.ConversationAssetReferences(ownerID)
	if err != nil || len(references) != 1 {
		t.Fatalf("ConversationAssetReferences()=%#v error=%v", references, err)
	}
	if counting.loadCalls != 0 {
		t.Fatalf("complete summary triggered %d full row loads", counting.loadCalls)
	}

	page, err := history.ListPage(context.Background(), ownerID, "", 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListPage()=%#v error=%v", page, err)
	}
	if _, exists := page.Items[0][imageConversationAssetPathsSummaryKey]; exists {
		t.Fatalf("summary response leaked %q: %#v", imageConversationAssetPathsSummaryKey, page.Items[0])
	}
	if _, exists := page.Items[0][imageConversationAssetRefsCompleteKey]; exists {
		t.Fatalf("summary response leaked %q: %#v", imageConversationAssetRefsCompleteKey, page.Items[0])
	}
}

func TestImageConversationAssetReferencesLazilyBackfillLegacySummary(t *testing.T) {
	backend := newTestStorageBackend(t)
	counting := newImageConversationReferenceCountingBackend(t, backend)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "legacy-summary-reference-owner"
	history := NewImageConversationHistoryService(counting)
	item := imageConversationAssetSummaryTestItem(ownerID, "legacy-summary-reference", 1)
	_, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item}, nil)
	if err != nil {
		t.Fatalf("seed merge error=%v", err)
	}
	record, exists, err := rows.Load(context.Background(), ownerID, "legacy-summary-reference")
	if err != nil || !exists {
		t.Fatalf("Load(seed) record=%#v exists=%v error=%v", record, exists, err)
	}
	legacySummary := map[string]any{}
	if err := json.Unmarshal(record.Summary, &legacySummary); err != nil {
		t.Fatalf("decode seed summary: %v", err)
	}
	delete(legacySummary, imageConversationAssetPathsSummaryKey)
	delete(legacySummary, imageConversationAssetRefsCompleteKey)
	record.Summary, _ = json.Marshal(legacySummary)
	state, err := rows.LoadOwnerState(context.Background(), ownerID)
	if err != nil {
		t.Fatalf("LoadOwnerState() error=%v", err)
	}
	legacyRecord, err := rows.SaveCAS(context.Background(), ownerID, state.Generation, record.StorageVersion, record)
	if err != nil {
		t.Fatalf("SaveCAS(legacy summary) error=%v", err)
	}

	history.SetConversationAssetService(NewImageConversationAssetService(t.TempDir()))
	counting.loadCalls = 0
	references, err := history.ConversationAssetReferences(ownerID)
	if err != nil || len(references) != 1 {
		t.Fatalf("ConversationAssetReferences()=%#v error=%v", references, err)
	}
	if counting.loadCalls != 1 {
		t.Fatalf("legacy summary full row loads=%d, want 1", counting.loadCalls)
	}
	rewritten, exists, err := rows.Load(context.Background(), ownerID, "legacy-summary-reference")
	if err != nil || !exists || rewritten.StorageVersion != legacyRecord.StorageVersion+1 {
		t.Fatalf("lazy rewrite record=%#v exists=%v error=%v", rewritten, exists, err)
	}
	if indexed, complete := imageConversationAssetReferencesFromSummary(rewritten.Summary, ownerID); !complete || len(indexed) != 1 {
		t.Fatalf("lazy rewritten summary indexed=%#v complete=%v raw=%s", indexed, complete, rewritten.Summary)
	}
}

func TestImageConversationAssetReferencesFailClosedWhenSummaryExceedsLimit(t *testing.T) {
	backend := newTestStorageBackend(t)
	counting := newImageConversationReferenceCountingBackend(t, backend)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "oversized-summary-reference-owner"
	history := NewImageConversationHistoryService(counting)
	const referenceCount = 600
	item := imageConversationAssetSummaryTestItem(ownerID, "oversized-summary-reference", referenceCount)
	_, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item}, nil)
	if err != nil {
		t.Fatalf("seed merge error=%v", err)
	}
	before, exists, err := rows.Load(context.Background(), ownerID, "oversized-summary-reference")
	if err != nil || !exists {
		t.Fatalf("Load(seed) record=%#v exists=%v error=%v", before, exists, err)
	}
	if len(before.Summary) > storage.MaxImageConversationSummaryBytes {
		t.Fatalf("persisted summary bytes=%d, limit=%d", len(before.Summary), storage.MaxImageConversationSummaryBytes)
	}
	if _, complete := imageConversationAssetReferencesFromSummary(before.Summary, ownerID); complete {
		t.Fatalf("oversized summary incorrectly marked complete: %s", before.Summary)
	}

	history.SetConversationAssetService(NewImageConversationAssetService(t.TempDir()))
	counting.loadCalls = 0
	references, err := history.ConversationAssetReferences(ownerID)
	if err != nil || len(references) != referenceCount {
		t.Fatalf("ConversationAssetReferences() count=%d error=%v", len(references), err)
	}
	if counting.loadCalls != 1 {
		t.Fatalf("oversized summary full row loads=%d, want 1", counting.loadCalls)
	}
	after, exists, err := rows.Load(context.Background(), ownerID, "oversized-summary-reference")
	if err != nil || !exists || after.StorageVersion != before.StorageVersion {
		t.Fatalf("oversized summary should not be repeatedly rewritten: before=%#v after=%#v error=%v", before, after, err)
	}
}

func TestImageConversationAssetReferencesDoNotTriggerLegacyMigration(t *testing.T) {
	backend := newTestStorageBackend(t)
	counting := newImageConversationReferenceCountingBackend(t, backend)
	documents := backend.(storage.JSONDocumentBackend)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "unmigrated-summary-reference-owner"
	if err := documents.SaveJSONDocument(imageConversationHistoryDocumentName(ownerID), map[string]any{
		"items": []any{imageConversationAssetSummaryTestItem(ownerID, "legacy-not-migrated", 1)},
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error=%v", err)
	}
	history := NewImageConversationHistoryService(counting)
	history.SetConversationAssetService(NewImageConversationAssetService(filepath.Join(t.TempDir(), "assets")))

	references, err := history.ConversationAssetReferences(ownerID)
	if !errors.Is(err, ErrImageConversationAssetReferencesUnavailable) || references != nil {
		t.Fatalf("ConversationAssetReferences()=%#v error=%v", references, err)
	}
	if counting.documentLoadCalls != 0 {
		t.Fatalf("asset GC loaded legacy document %d times", counting.documentLoadCalls)
	}
	state, err := rows.LoadOwnerState(context.Background(), ownerID)
	if err != nil || state.LegacyMigrated {
		t.Fatalf("asset GC changed legacy migration state=%#v error=%v", state, err)
	}
}

func TestImageConversationAssetReferencesContextCancelsBlockedDatabaseScan(t *testing.T) {
	backend := newTestStorageBackend(t)
	blocking := &blockingImageConversationReferenceBackend{
		Backend:                  backend,
		ImageConversationBackend: backend.(storage.ImageConversationBackend),
		started:                  make(chan struct{}),
	}
	history := NewImageConversationHistoryService(blocking)
	history.SetConversationAssetService(NewImageConversationAssetService(t.TempDir()))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	references, err := history.ConversationAssetReferencesContext(ctx, "blocked-owner")
	if !errors.Is(err, context.DeadlineExceeded) || references != nil {
		t.Fatalf("ConversationAssetReferencesContext()=%#v error=%v, want context deadline", references, err)
	}
	select {
	case <-blocking.started:
	default:
		t.Fatal("ConversationAssetReferencesContext() did not reach the database scan")
	}
	if blocking.listCalls != 0 {
		t.Fatalf("database scan continued with a canceled context: list calls = %d", blocking.listCalls)
	}
}

func imageConversationAssetSummaryTestItem(ownerID, id string, referenceCount int) map[string]any {
	ownerHash := imageConversationAssetHash([]byte(ownerID))
	references := make([]any, referenceCount)
	for index := range references {
		references[index] = map[string]any{
			"assetPath": fmt.Sprintf("%s/%064x.png", ownerHash, index+1),
		}
	}
	return map[string]any{
		"id":        id,
		"revision":  1,
		"title":     id,
		"createdAt": "2026-07-20T00:00:00Z",
		"updatedAt": "2026-07-20T00:00:01Z",
		"turns": []any{map[string]any{
			"id":              "turn-1",
			"status":          "success",
			"referenceImages": references,
			"images":          []any{},
		}},
	}
}

type imageConversationReferenceCountingBackend struct {
	storage.Backend
	storage.ImageConversationBackend
	documents         storage.JSONDocumentBackend
	loadCalls         int
	documentLoadCalls int
}

type blockingImageConversationReferenceBackend struct {
	storage.Backend
	storage.ImageConversationBackend
	once      sync.Once
	started   chan struct{}
	listCalls int
}

func (b *blockingImageConversationReferenceBackend) LoadOwnerState(ctx context.Context, _ string) (storage.ImageConversationOwnerState, error) {
	b.once.Do(func() { close(b.started) })
	<-ctx.Done()
	return storage.ImageConversationOwnerState{Generation: 1, LegacyMigrated: true}, nil
}

func (b *blockingImageConversationReferenceBackend) List(ctx context.Context, ownerID string, generation int64, cursor *storage.ImageConversationCursor, limit int) (storage.ImageConversationPage, error) {
	b.listCalls++
	return b.ImageConversationBackend.List(ctx, ownerID, generation, cursor, limit)
}

func newImageConversationReferenceCountingBackend(t *testing.T, backend storage.Backend) *imageConversationReferenceCountingBackend {
	t.Helper()
	rows, ok := backend.(storage.ImageConversationBackend)
	if !ok {
		t.Fatalf("backend %T does not implement ImageConversationBackend", backend)
	}
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("backend %T does not implement JSONDocumentBackend", backend)
	}
	return &imageConversationReferenceCountingBackend{
		Backend:                  backend,
		ImageConversationBackend: rows,
		documents:                documents,
	}
}

func (b *imageConversationReferenceCountingBackend) Load(ctx context.Context, ownerID, conversationID string) (storage.ImageConversationRecord, bool, error) {
	b.loadCalls++
	return b.ImageConversationBackend.Load(ctx, ownerID, conversationID)
}

func (b *imageConversationReferenceCountingBackend) LoadJSONDocument(name string) (any, error) {
	b.documentLoadCalls++
	return b.documents.LoadJSONDocument(name)
}

func (b *imageConversationReferenceCountingBackend) SaveJSONDocument(name string, value any) error {
	return b.documents.SaveJSONDocument(name, value)
}

func (b *imageConversationReferenceCountingBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}
