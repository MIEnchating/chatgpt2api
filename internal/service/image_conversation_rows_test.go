package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

func TestImageConversationRowsMigratesLegacyDocumentAndTombstones(t *testing.T) {
	backend := newTestStorageBackend(t)
	documents := backend.(storage.JSONDocumentBackend)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "legacy-row-owner"
	deletedAt := "2026-07-19T10:00:00Z"
	live := imageConversationRowTestItem("legacy-live", 3, "2026-07-19T11:00:00Z", "success")
	if err := documents.SaveJSONDocument(imageConversationHistoryDocumentName(ownerID), map[string]any{
		"items":   []any{live},
		"deleted": map[string]any{"legacy-deleted": deletedAt},
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	history := NewImageConversationHistoryService(backend)
	page, err := history.ListPage(context.Background(), ownerID, "", 10)
	if err != nil || len(page.Items) != 1 || page.Items[0]["id"] != "legacy-live" {
		t.Fatalf("ListPage() page=%#v error=%v", page, err)
	}
	state, err := rows.LoadOwnerState(context.Background(), ownerID)
	if err != nil || !state.LegacyMigrated || state.CursorGeneration != page.Generation {
		t.Fatalf("LoadOwnerState() state=%#v error=%v", state, err)
	}
	legacy, err := documents.LoadJSONDocument(imageConversationHistoryDocumentName(ownerID))
	if err != nil || legacy == nil {
		t.Fatalf("legacy document was deleted: value=%#v error=%v", legacy, err)
	}

	delayed := imageConversationRowTestItem("legacy-deleted", 99, "2099-01-01T00:00:00Z", "success")
	acknowledgements, generation, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{delayed}, nil)
	if err != nil || generation != state.CursorGeneration || len(acknowledgements) != 1 || !acknowledgements[0].Gone || acknowledgements[0].Accepted {
		t.Fatalf("deleted legacy acknowledgement=%#v generation=%d error=%v", acknowledgements, generation, err)
	}
}

func TestImageConversationRowsMigrationFailureDoesNotMarkOwnerMigrated(t *testing.T) {
	backend := newTestStorageBackend(t)
	documents := backend.(storage.JSONDocumentBackend)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "legacy-migration-failure"
	if err := documents.SaveJSONDocument(imageConversationHistoryDocumentName(ownerID), map[string]any{
		"items": []any{imageConversationRowTestItem("legacy-item", 1, "2026-07-19T11:00:00Z", "success")},
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}
	failing := &failingImageConversationMigrationBackend{
		Backend:                  backend,
		JSONDocumentBackend:      documents,
		ImageConversationBackend: rows,
	}
	history := NewImageConversationHistoryService(failing)
	if _, err := history.List(ownerID); err == nil {
		t.Fatal("List() error = nil, want migration failure")
	}
	state, err := rows.LoadOwnerState(context.Background(), ownerID)
	if err != nil || state.LegacyMigrated {
		t.Fatalf("owner migration state=%#v error=%v", state, err)
	}
}

func TestImageConversationRowsPaginationActiveDetailAndClearInvalidation(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	ownerID := "row-pagination-owner"
	updatedAt := "2026-07-19T12:00:00Z"
	items := []map[string]any{
		imageConversationRowTestItem("conversation-a", 1, updatedAt, "success"),
		imageConversationRowTestItem("conversation-b", 1, updatedAt, "loading"),
		imageConversationRowTestItem("conversation-c", 1, updatedAt, "success"),
	}
	referencePayload := "summary-must-not-contain-" + strings.Repeat("x", 32*1024)
	activeReferencePayload := "active-must-remain-full-" + strings.Repeat("y", 1024)
	activeTurns := items[1]["turns"].([]any)
	activeTurns[0].(map[string]any)["referenceImages"] = []any{map[string]any{
		"name": "active.png", "type": "image/png", "dataUrl": activeReferencePayload,
	}}
	itemTurns := items[2]["turns"].([]any)
	itemTurns[0].(map[string]any)["referenceImages"] = []any{map[string]any{
		"name": "large.png", "type": "image/png", "dataUrl": referencePayload,
	}}
	acknowledgements, generation, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, items, nil)
	if err != nil || len(acknowledgements) != 3 {
		t.Fatalf("MergeWithAcknowledgementsMinimal() acknowledgements=%#v error=%v", acknowledgements, err)
	}
	for _, acknowledgement := range acknowledgements {
		if !acknowledgement.Accepted {
			t.Fatalf("initial acknowledgement=%#v", acknowledgement)
		}
	}

	first, err := history.ListPage(context.Background(), ownerID, "", 2)
	if err != nil || len(first.Items) != 2 || !first.HasMore || first.NextCursor == "" || first.Generation != generation {
		t.Fatalf("first ListPage() page=%#v error=%v", first, err)
	}
	second, err := history.ListPage(context.Background(), ownerID, first.NextCursor, 2)
	if err != nil || len(second.Items) != 1 || second.HasMore {
		t.Fatalf("second ListPage() page=%#v error=%v", second, err)
	}
	seen := map[string]bool{}
	pageItems := append(append([]map[string]any{}, first.Items...), second.Items...)
	for _, item := range pageItems {
		seen[item["id"].(string)] = true
		if _, exists := item["turns"]; exists || item["historySummaryOnly"] != true {
			t.Fatalf("ListPage() returned a full conversation: %#v", item)
		}
		summary := item["historySummary"].(map[string]any)
		if summary["turnCount"] != 1 {
			t.Fatalf("history summary=%#v", summary)
		}
		if item["id"] == "conversation-b" && (summary["queued"] != 1 || summary["running"] != 0) {
			t.Fatalf("active history summary=%#v", summary)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("paginated IDs=%#v", seen)
	}
	pageData, err := json.Marshal(pageItems)
	if err != nil || strings.Contains(string(pageData), referencePayload) || strings.Contains(string(pageData), activeReferencePayload) || strings.Contains(string(pageData), "dataUrl") {
		t.Fatalf("summary page leaked reference image data: bytes=%d error=%v", len(pageData), err)
	}

	active, activeGeneration, err := history.ListActive(context.Background(), ownerID, 10)
	if err != nil || activeGeneration != generation || len(active) != 1 || active[0]["id"] != "conversation-b" {
		t.Fatalf("ListActive() items=%#v generation=%d error=%v", active, activeGeneration, err)
	}
	activeData, err := json.Marshal(active)
	if err != nil || !strings.Contains(string(activeData), activeReferencePayload) || len(active[0]["turns"].([]any)) != 1 {
		t.Fatalf("ListActive() did not return the full conversation: bytes=%d error=%v", len(activeData), err)
	}
	detail, found, detailGeneration, err := history.GetItem(context.Background(), ownerID, "conversation-c")
	if err != nil || !found || detailGeneration != generation || detail["id"] != "conversation-c" {
		t.Fatalf("GetItem() item=%#v found=%v generation=%d error=%v", detail, found, detailGeneration, err)
	}
	detailData, err := json.Marshal(detail)
	if err != nil || !strings.Contains(string(detailData), referencePayload) || len(detail["turns"].([]any)) != 1 {
		t.Fatalf("GetItem() did not return the full conversation: bytes=%d error=%v", len(detailData), err)
	}

	clearedGeneration, err := history.ClearMinimal(context.Background(), ownerID)
	if err != nil || clearedGeneration <= generation {
		t.Fatalf("ClearMinimal() generation=%d error=%v", clearedGeneration, err)
	}
	_, err = history.ListPage(context.Background(), ownerID, first.NextCursor, 2)
	var invalidated ImageConversationHistoryCursorInvalidatedError
	if !errors.As(err, &invalidated) || invalidated.Generation != clearedGeneration {
		t.Fatalf("old cursor error=%v invalidated=%#v", err, invalidated)
	}
}

func TestImageConversationRowsSaveInvalidatesCursorBeforeReorderedItemCanBeSkipped(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	ownerID := "row-pagination-save-owner"
	items := []map[string]any{
		imageConversationRowTestItem("conversation-newest", 1, "2026-07-19T12:00:00Z", "success"),
		imageConversationRowTestItem("conversation-newer", 1, "2026-07-19T11:00:00Z", "success"),
		imageConversationRowTestItem("conversation-older", 1, "2026-07-19T10:00:00Z", "success"),
		imageConversationRowTestItem("conversation-oldest", 1, "2026-07-19T09:00:00Z", "success"),
	}
	_, initialGeneration, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, items, nil)
	if err != nil {
		t.Fatalf("seed merge error = %v", err)
	}
	first, err := history.ListPage(context.Background(), ownerID, "", 2)
	if err != nil || first.NextCursor == "" || first.Generation != initialGeneration {
		t.Fatalf("ListPage(first) = (%#v, %v)", first, err)
	}

	reordered := imageConversationRowTestItem("conversation-older", 2, "2026-07-19T13:00:00Z", "success")
	_, reorderedGeneration, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{reordered}, &initialGeneration)
	if err != nil || reorderedGeneration <= initialGeneration {
		t.Fatalf("reorder merge generation=%d initial=%d error=%v", reorderedGeneration, initialGeneration, err)
	}
	_, err = history.ListPage(context.Background(), ownerID, first.NextCursor, 2)
	var invalidated ImageConversationHistoryCursorInvalidatedError
	if !errors.As(err, &invalidated) || invalidated.Generation != reorderedGeneration {
		t.Fatalf("ListPage(old cursor) error=%v invalidated=%#v", err, invalidated)
	}
	refreshed, err := history.ListPage(context.Background(), ownerID, "", 2)
	if err != nil || len(refreshed.Items) == 0 || refreshed.Items[0]["id"] != "conversation-older" || refreshed.Generation != reorderedGeneration {
		t.Fatalf("ListPage(refreshed) = (%#v, %v)", refreshed, err)
	}
}

func TestImageConversationRowsLostAcknowledgementIsIdempotentAndStaleIsReadOnly(t *testing.T) {
	backend := newTestStorageBackend(t)
	rows := backend.(storage.ImageConversationBackend)
	history := NewImageConversationHistoryService(backend)
	ownerID := "row-idempotence-owner"
	base := imageConversationRowTestItem("conversation-idempotent", 1, "2026-07-19T10:00:00Z", "success")
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{base}, nil); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("initial merge acknowledgements=%#v error=%v", acknowledgements, err)
	}

	next := imageConversationRowTestItem("conversation-idempotent", 2, "2026-07-19T11:00:00Z", "success")
	next["turns"] = []any{map[string]any{"id": "turn-new", "status": "success", "images": []any{}}}
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{next}, nil); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("new revision acknowledgements=%#v error=%v", acknowledgements, err)
	}
	before, ok, err := rows.Load(context.Background(), ownerID, "conversation-idempotent")
	if err != nil || !ok {
		t.Fatalf("Load(before replay) record=%#v ok=%v error=%v", before, ok, err)
	}
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{next}, nil); err != nil || !acknowledgements[0].Accepted || acknowledgements[0].ActualRevision != 2 {
		t.Fatalf("replay acknowledgements=%#v error=%v", acknowledgements, err)
	}
	afterReplay, _, err := rows.Load(context.Background(), ownerID, "conversation-idempotent")
	if err != nil || afterReplay.StorageVersion != before.StorageVersion || !reflect.DeepEqual(afterReplay.Data, before.Data) {
		t.Fatalf("idempotent replay mutated row: before=%#v after=%#v error=%v", before, afterReplay, err)
	}

	stale := imageConversationRowTestItem("conversation-idempotent", 1, "2099-01-01T00:00:00Z", "success")
	stale["title"] = "stale conflict"
	acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{stale}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 2 {
		t.Fatalf("stale acknowledgements=%#v error=%v", acknowledgements, err)
	}
	afterStale, _, err := rows.Load(context.Background(), ownerID, "conversation-idempotent")
	if err != nil || afterStale.StorageVersion != before.StorageVersion || !reflect.DeepEqual(afterStale.Data, before.Data) {
		t.Fatalf("stale write mutated row: before=%#v after=%#v error=%v", before, afterStale, err)
	}
}

func TestImageConversationRowsDeleteMissingAdvancesGeneration(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	ownerID := "row-delete-missing-owner"
	page, err := history.ListPage(context.Background(), ownerID, "", 10)
	if err != nil {
		t.Fatalf("ListPage() error = %v", err)
	}
	removed, generation, err := history.DeleteMinimal(context.Background(), ownerID, "missing-conversation")
	if err != nil || removed || generation <= page.Generation {
		t.Fatalf("DeleteMinimal() removed=%v generation=%d initial=%d error=%v", removed, generation, page.Generation, err)
	}
}

func TestImageConversationRowsStaleGenerationReevaluatesEachConversation(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	ownerID := "row-generation-reevaluation-owner"
	deletedItem := imageConversationRowTestItem("conversation-x", 1, "2026-07-19T10:00:00Z", "success")
	acknowledgements, originalGeneration, err := history.MergeWithAcknowledgementsMinimal(
		context.Background(),
		ownerID,
		[]map[string]any{deletedItem},
		nil,
	)
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted {
		t.Fatalf("initial merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	removed, deleteGeneration, err := history.DeleteMinimal(context.Background(), ownerID, "conversation-x")
	if err != nil || !removed || deleteGeneration <= originalGeneration {
		t.Fatalf("DeleteMinimal() removed=%v generation=%d original=%d error=%v", removed, deleteGeneration, originalGeneration, err)
	}

	deletedRetry := imageConversationRowTestItem("conversation-x", 2, "2026-07-19T11:00:00Z", "success")
	unrelated := imageConversationRowTestItem("conversation-y", 1, "2026-07-19T11:00:00Z", "success")
	acknowledgements, generation, err := history.MergeWithAcknowledgementsMinimal(
		context.Background(),
		ownerID,
		[]map[string]any{deletedRetry, unrelated},
		&originalGeneration,
	)
	if err != nil || generation <= deleteGeneration || len(acknowledgements) != 2 {
		t.Fatalf("stale-generation batch acknowledgements=%#v generation=%d error=%v", acknowledgements, generation, err)
	}
	if !acknowledgements[0].Gone || acknowledgements[0].Accepted {
		t.Fatalf("deleted X acknowledgement=%#v", acknowledgements[0])
	}
	if acknowledgements[1].Gone || !acknowledgements[1].Accepted {
		t.Fatalf("unrelated Y acknowledgement=%#v", acknowledgements[1])
	}

	clearGeneration, err := history.ClearMinimal(context.Background(), ownerID)
	if err != nil || clearGeneration <= deleteGeneration {
		t.Fatalf("ClearMinimal() generation=%d deleteGeneration=%d error=%v", clearGeneration, deleteGeneration, err)
	}
	preClearUnknown := imageConversationRowTestItem("conversation-before-clear", 1, "2026-07-19T09:00:00Z", "success")
	acknowledgements, generation, err = history.MergeWithAcknowledgementsMinimal(
		context.Background(),
		ownerID,
		[]map[string]any{preClearUnknown},
		&deleteGeneration,
	)
	if err != nil || generation != clearGeneration || len(acknowledgements) != 1 || !acknowledgements[0].Gone || acknowledgements[0].Accepted {
		t.Fatalf("pre-clear acknowledgement=%#v generation=%d error=%v", acknowledgements, generation, err)
	}
}

func TestImageConversationRowsGetRechecksGenerationAfterRecordRead(t *testing.T) {
	backend := newTestStorageBackend(t)
	rows := backend.(storage.ImageConversationBackend)
	documents := backend.(storage.JSONDocumentBackend)
	ownerID := "row-detail-generation-owner"
	conversationID := "conversation-detail-race"
	history := NewImageConversationHistoryService(backend)
	item := imageConversationRowTestItem(conversationID, 1, "2026-07-19T10:00:00Z", "success")
	_, initialGeneration, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item}, nil)
	if err != nil {
		t.Fatalf("initial merge error = %v", err)
	}
	tracing := &deleteImageConversationAfterLoadBackend{
		Backend:                  backend,
		JSONDocumentBackend:      documents,
		ImageConversationBackend: rows,
		ownerID:                  ownerID,
		conversationID:           conversationID,
	}
	history = NewImageConversationHistoryService(tracing)
	detail, found, generation, err := history.GetItem(context.Background(), ownerID, conversationID)
	if err != nil || found || detail != nil || generation <= initialGeneration {
		t.Fatalf("GetItem() detail=%#v found=%v generation=%d initial=%d error=%v", detail, found, generation, initialGeneration, err)
	}
}

func TestImageConversationRowsListActiveDefaultDoesNotTruncateAtOneHundred(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	ownerID := "row-active-default-owner"
	items := make([]map[string]any, 0, 101)
	for index := 0; index < 101; index++ {
		items = append(items, imageConversationRowTestItem(
			fmt.Sprintf("active-%03d", index),
			1,
			"2026-07-19T10:00:00Z",
			"loading",
		))
	}
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, items, nil); err != nil || len(acknowledgements) != len(items) {
		t.Fatalf("active merge acknowledgements=%d error=%v", len(acknowledgements), err)
	}
	active, _, err := history.ListActive(context.Background(), ownerID, 0)
	if err != nil || len(active) != 101 {
		t.Fatalf("default ListActive() count=%d error=%v", len(active), err)
	}
	active, _, err = history.ListActive(context.Background(), ownerID, 100)
	if err != nil || len(active) != 100 {
		t.Fatalf("explicit ListActive(100) count=%d error=%v", len(active), err)
	}
}

func TestImageConversationRowsMergeUsesOneBatchCAS(t *testing.T) {
	backend := newTestStorageBackend(t)
	tracing := &tracingImageConversationBatchBackend{
		Backend:                  backend,
		JSONDocumentBackend:      backend.(storage.JSONDocumentBackend),
		ImageConversationBackend: backend.(storage.ImageConversationBackend),
	}
	history := NewImageConversationHistoryService(tracing)
	items := []map[string]any{
		imageConversationRowTestItem("batch-a", 1, "2026-07-20T10:00:00Z", "success"),
		imageConversationRowTestItem("batch-b", 1, "2026-07-20T10:01:00Z", "success"),
		imageConversationRowTestItem("batch-c", 1, "2026-07-20T10:02:00Z", "success"),
	}
	acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), "batch-owner", items, nil)
	if err != nil || len(acknowledgements) != len(items) {
		t.Fatalf("MergeWithAcknowledgementsMinimal() acknowledgements=%#v error=%v", acknowledgements, err)
	}
	if tracing.batchCalls != 1 || tracing.batchSizes[0] != len(items) || tracing.singleSaveCalls != 0 {
		t.Fatalf("CAS calls: batches=%d sizes=%#v singles=%d", tracing.batchCalls, tracing.batchSizes, tracing.singleSaveCalls)
	}
}

func TestImageConversationRowsBatchConflictRetriesFromReturnedCurrent(t *testing.T) {
	backend := newTestStorageBackend(t)
	ownerID := "batch-conflict-owner"
	base := imageConversationRowTestItem("batch-conflict", 1, "2026-07-20T10:00:00Z", "success")
	baseHistory := NewImageConversationHistoryService(backend)
	if acknowledgements, _, err := baseHistory.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{base}, nil); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("initial merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	competitor := imageConversationRowTestItem("batch-conflict", 2, "2026-07-20T10:01:00Z", "success")
	competitorRecord, err := imageConversationRecordFromItem(competitor, "")
	if err != nil {
		t.Fatalf("imageConversationRecordFromItem() error = %v", err)
	}
	tracing := &conflictOnceImageConversationBatchBackend{
		Backend:                  backend,
		JSONDocumentBackend:      backend.(storage.JSONDocumentBackend),
		ImageConversationBackend: backend.(storage.ImageConversationBackend),
		competitor:               competitorRecord,
	}
	history := NewImageConversationHistoryService(tracing)
	incoming := imageConversationRowTestItem("batch-conflict", 3, "2026-07-20T10:02:00Z", "success")
	acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{incoming}, nil)
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted || acknowledgements[0].ActualRevision != 3 {
		t.Fatalf("conflict retry acknowledgements=%#v error=%v", acknowledgements, err)
	}
	if tracing.batchCalls != 2 || tracing.loadCalls != 1 {
		t.Fatalf("conflict retry calls: batches=%d loads=%d", tracing.batchCalls, tracing.loadCalls)
	}
}

func imageConversationRowTestItem(id string, revision int64, updatedAt, status string) map[string]any {
	imageStatus := status
	taskStatus := status
	if status == "loading" {
		taskStatus = "queued"
	}
	return map[string]any{
		"id":        id,
		"revision":  revision,
		"title":     id,
		"createdAt": updatedAt,
		"updatedAt": updatedAt,
		"turns": []any{map[string]any{
			"id":     "turn-" + id,
			"status": status,
			"images": []any{map[string]any{
				"id":         "image-" + id,
				"taskId":     "task-" + id,
				"taskStatus": taskStatus,
				"status":     imageStatus,
			}},
		}},
	}
}

type failingImageConversationMigrationBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.ImageConversationBackend
}

type deleteImageConversationAfterLoadBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.ImageConversationBackend
	once           sync.Once
	ownerID        string
	conversationID string
}

type tracingImageConversationBatchBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.ImageConversationBackend
	batchCalls      int
	batchSizes      []int
	singleSaveCalls int
}

func (b *tracingImageConversationBatchBackend) BatchSaveCAS(ctx context.Context, ownerID string, generation int64, requests []storage.ImageConversationCASRequest) (storage.ImageConversationBatchCASResult, error) {
	b.batchCalls++
	b.batchSizes = append(b.batchSizes, len(requests))
	return b.ImageConversationBackend.BatchSaveCAS(ctx, ownerID, generation, requests)
}

func (b *tracingImageConversationBatchBackend) SaveCAS(ctx context.Context, ownerID string, generation, storageVersion int64, record storage.ImageConversationRecord) (storage.ImageConversationRecord, error) {
	b.singleSaveCalls++
	return b.ImageConversationBackend.SaveCAS(ctx, ownerID, generation, storageVersion, record)
}

type conflictOnceImageConversationBatchBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.ImageConversationBackend
	competitor storage.ImageConversationRecord
	batchCalls int
	loadCalls  int
}

func (b *conflictOnceImageConversationBatchBackend) Load(ctx context.Context, ownerID, conversationID string) (storage.ImageConversationRecord, bool, error) {
	b.loadCalls++
	return b.ImageConversationBackend.Load(ctx, ownerID, conversationID)
}

func (b *conflictOnceImageConversationBatchBackend) BatchSaveCAS(ctx context.Context, ownerID string, generation int64, requests []storage.ImageConversationCASRequest) (storage.ImageConversationBatchCASResult, error) {
	b.batchCalls++
	if b.batchCalls == 1 {
		if len(requests) != 1 {
			return storage.ImageConversationBatchCASResult{}, fmt.Errorf("unexpected request count: %d", len(requests))
		}
		if _, err := b.ImageConversationBackend.SaveCAS(ctx, ownerID, generation, requests[0].ExpectedStorageVersion, b.competitor); err != nil {
			return storage.ImageConversationBatchCASResult{}, err
		}
	}
	return b.ImageConversationBackend.BatchSaveCAS(ctx, ownerID, generation, requests)
}

func (b *deleteImageConversationAfterLoadBackend) Load(ctx context.Context, ownerID, conversationID string) (storage.ImageConversationRecord, bool, error) {
	record, ok, err := b.ImageConversationBackend.Load(ctx, ownerID, conversationID)
	if err != nil || !ok || ownerID != b.ownerID || conversationID != b.conversationID {
		return record, ok, err
	}
	var deleteErr error
	b.once.Do(func() {
		_, deleteErr = b.ImageConversationBackend.Delete(ctx, ownerID, conversationID, time.Now().UTC().UnixMilli())
	})
	return record, ok, deleteErr
}

func (b *failingImageConversationMigrationBackend) MigrateLegacy(context.Context, string, []storage.ImageConversationRecord, storage.ImageConversationOwnerState) (storage.ImageConversationOwnerState, error) {
	return storage.ImageConversationOwnerState{}, errors.New("migration unavailable")
}

var _ storage.Backend = (*failingImageConversationMigrationBackend)(nil)
var _ storage.ImageConversationBackend = (*failingImageConversationMigrationBackend)(nil)
var _ storage.Backend = (*deleteImageConversationAfterLoadBackend)(nil)
var _ storage.ImageConversationBackend = (*deleteImageConversationAfterLoadBackend)(nil)
var _ storage.ImageConversationBackend = (*tracingImageConversationBatchBackend)(nil)
var _ storage.ImageConversationBackend = (*conflictOnceImageConversationBatchBackend)(nil)
