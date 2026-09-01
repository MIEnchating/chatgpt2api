package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

func newImageConversationTestBackend(t *testing.T) *DatabaseBackend {
	t.Helper()
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "history.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func imageConversationTestRecord(id string, updatedAt int64, active bool) ImageConversationRecord {
	return ImageConversationRecord{
		ID:              id,
		Revision:        1,
		CreatedAtMillis: updatedAt - 100,
		UpdatedAtMillis: updatedAt,
		Active:          active,
		Data:            json.RawMessage(fmt.Sprintf(`{"id":%q,"updatedAt":%d}`, id, updatedAt)),
	}
}

func saveOneImageConversationCASTest(
	ctx context.Context,
	backend *DatabaseBackend,
	ownerID string,
	expectedGeneration, expectedStorageVersion int64,
	record ImageConversationRecord,
) (ImageConversationRecord, error) {
	result, err := backend.BatchSaveCAS(ctx, ownerID, expectedGeneration, []ImageConversationCASRequest{{
		ExpectedStorageVersion: expectedStorageVersion,
		Record:                 record,
	}})
	if len(result.Items) != 1 {
		if err != nil {
			return ImageConversationRecord{}, err
		}
		return ImageConversationRecord{}, fmt.Errorf("BatchSaveCAS returned %d results for one request", len(result.Items))
	}
	if errors.Is(err, ErrImageConversationGenerationStale) {
		return ImageConversationRecord{}, err
	}
	return result.Items[0].Current, err
}

func TestDatabaseBackendImageConversationBatchSaveCASSingleRequest(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-cas")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	if state.Generation != 1 || state.CursorGeneration != 1 {
		t.Fatalf("initial state = %#v", state)
	}

	created, err := saveOneImageConversationCASTest(ctx, backend, "owner-cas", state.Generation, 0, imageConversationTestRecord("conversation", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(insert) error = %v", err)
	}
	if created.StorageVersion != 1 || created.AcceptedHash == "" {
		t.Fatalf("BatchSaveCAS(insert) = %#v", created)
	}

	current, err := saveOneImageConversationCASTest(ctx, backend, "owner-cas", state.Generation, 0, imageConversationTestRecord("conversation", 1001, true))
	if !errors.Is(err, ErrImageConversationCASConflict) || current.StorageVersion != 1 {
		t.Fatalf("BatchSaveCAS(conflicting insert) = (%#v, %v)", current, err)
	}

	updatedInput := imageConversationTestRecord("conversation", 2000, true)
	updatedInput.Revision = 2
	updated, err := saveOneImageConversationCASTest(ctx, backend, "owner-cas", state.Generation, created.StorageVersion, updatedInput)
	if err != nil {
		t.Fatalf("BatchSaveCAS(update) error = %v", err)
	}
	if updated.StorageVersion != 2 || !updated.Active || updated.Revision != 2 {
		t.Fatalf("BatchSaveCAS(update) = %#v", updated)
	}

	current, err = saveOneImageConversationCASTest(ctx, backend, "owner-cas", state.Generation, created.StorageVersion, updatedInput)
	if !errors.Is(err, ErrImageConversationCASConflict) || current.StorageVersion != 2 {
		t.Fatalf("BatchSaveCAS(stale update) = (%#v, %v)", current, err)
	}

	loaded, exists, err := backend.Load(ctx, "owner-cas", "conversation")
	if err != nil || !exists {
		t.Fatalf("Load() = (%#v, %v, %v)", loaded, exists, err)
	}
	if loaded.StorageVersion != 2 || string(loaded.Data) != string(updated.Data) {
		t.Fatalf("Load() = %#v", loaded)
	}
}

func TestDatabaseBackendImageConversationCursorPaginationUsesHashTieBreaker(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-page")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	input := []ImageConversationRecord{
		imageConversationTestRecord("same-time-a", 2000, false),
		imageConversationTestRecord("same-time-b", 2000, false),
		imageConversationTestRecord("older-a", 1000, false),
		imageConversationTestRecord("older-b", 1000, false),
	}
	for _, record := range input {
		if _, err := saveOneImageConversationCASTest(ctx, backend, "owner-page", state.Generation, 0, record); err != nil {
			t.Fatalf("BatchSaveCAS(%q) error = %v", record.ID, err)
		}
	}
	sort.Slice(input, func(i, j int) bool {
		if input[i].UpdatedAtMillis != input[j].UpdatedAtMillis {
			return input[i].UpdatedAtMillis > input[j].UpdatedAtMillis
		}
		left, _ := imageConversationStorageKey(input[i].ID)
		right, _ := imageConversationStorageKey(input[j].ID)
		return left > right
	})

	first, err := backend.List(ctx, "owner-page", state.Generation, nil, 2)
	if err != nil {
		t.Fatalf("List(first) error = %v", err)
	}
	if len(first.Records) != 2 || first.NextCursor == nil {
		t.Fatalf("List(first) = %#v", first)
	}
	for _, record := range first.Records {
		if len(record.Data) != 0 || len(record.Summary) == 0 || strings.Contains(string(record.Summary), `"turns"`) {
			t.Fatalf("List(first) loaded non-summary payload = %#v", record)
		}
	}
	second, err := backend.List(ctx, "owner-page", state.Generation, first.NextCursor, 2)
	if err != nil {
		t.Fatalf("List(second) error = %v", err)
	}
	if len(second.Records) != 2 || second.NextCursor != nil {
		t.Fatalf("List(second) = %#v", second)
	}
	got := []string{first.Records[0].ID, first.Records[1].ID, second.Records[0].ID, second.Records[1].ID}
	want := []string{input[0].ID, input[1].ID, input[2].ID, input[3].ID}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("pagination order = %#v, want %#v", got, want)
		}
	}
}

func TestDatabaseBackendImageConversationCursorInvalidatedWhenSaveReordersRows(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	ownerID := "owner-page-reorder"
	state, err := backend.LoadOwnerState(ctx, ownerID)
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	for index, id := range []string{"newest", "newer", "older", "oldest"} {
		updatedAt := int64(4000 - index*1000)
		if _, err := saveOneImageConversationCASTest(ctx, backend, ownerID, state.Generation, 0, imageConversationTestRecord(id, updatedAt, false)); err != nil {
			t.Fatalf("BatchSaveCAS(%q) error = %v", id, err)
		}
	}
	stableState, err := backend.LoadOwnerState(ctx, ownerID)
	if err != nil || stableState.CursorGeneration <= state.CursorGeneration {
		t.Fatalf("LoadOwnerState(after seed) = (%#v, %v)", stableState, err)
	}
	first, err := backend.List(ctx, ownerID, state.Generation, nil, 2)
	if err != nil || len(first.Records) != 2 || first.NextCursor == nil || first.NextCursor.Generation != stableState.CursorGeneration {
		t.Fatalf("List(first) = (%#v, %v)", first, err)
	}

	older, exists, err := backend.Load(ctx, ownerID, "older")
	if err != nil || !exists {
		t.Fatalf("Load(older) = (%#v, %v, %v)", older, exists, err)
	}
	reordered := imageConversationTestRecord("older", 5000, false)
	reordered.Revision = older.Revision + 1
	if _, err := saveOneImageConversationCASTest(ctx, backend, ownerID, state.Generation, older.StorageVersion, reordered); err != nil {
		t.Fatalf("BatchSaveCAS(reorder) error = %v", err)
	}
	latestState, err := backend.LoadOwnerState(ctx, ownerID)
	if err != nil || latestState.CursorGeneration <= stableState.CursorGeneration {
		t.Fatalf("LoadOwnerState(after reorder) = (%#v, %v)", latestState, err)
	}
	if _, err := backend.List(ctx, ownerID, state.Generation, first.NextCursor, 2); !errors.Is(err, ErrImageConversationCursorStale) {
		t.Fatalf("List(old cursor) error = %v, want %v", err, ErrImageConversationCursorStale)
	}
	refreshed, err := backend.List(ctx, ownerID, state.Generation, nil, 2)
	if err != nil || len(refreshed.Records) == 0 || refreshed.Records[0].ID != "older" || refreshed.NextCursor.Generation != latestState.CursorGeneration {
		t.Fatalf("List(refreshed) = (%#v, %v)", refreshed, err)
	}
}

func TestDatabaseBackendImageConversationActiveDeleteAndGeneration(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-delete")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	active, err := saveOneImageConversationCASTest(ctx, backend, "owner-delete", state.Generation, 0, imageConversationTestRecord("active", 2000, true))
	if err != nil {
		t.Fatalf("BatchSaveCAS(active) error = %v", err)
	}
	if _, err := saveOneImageConversationCASTest(ctx, backend, "owner-delete", state.Generation, 0, imageConversationTestRecord("inactive", 1000, false)); err != nil {
		t.Fatalf("BatchSaveCAS(inactive) error = %v", err)
	}
	activeRecords, err := backend.ListActive(ctx, "owner-delete", state.Generation, 10)
	if err != nil || len(activeRecords) != 1 || activeRecords[0].ID != "active" {
		t.Fatalf("ListActive() = (%#v, %v)", activeRecords, err)
	}
	if len(activeRecords[0].Data) == 0 || len(activeRecords[0].Summary) == 0 {
		t.Fatalf("ListActive() did not return full record = %#v", activeRecords[0])
	}

	removed, err := backend.Delete(ctx, "owner-delete", "active", 3000)
	if err != nil || !removed {
		t.Fatalf("Delete(active) = (%v, %v)", removed, err)
	}
	if _, err := backend.ListActive(ctx, "owner-delete", state.Generation, 10); !errors.Is(err, ErrImageConversationGenerationStale) {
		t.Fatalf("ListActive(stale generation) error = %v", err)
	}
	nextState, err := backend.LoadOwnerState(ctx, "owner-delete")
	if err != nil || nextState.Generation != state.Generation+1 {
		t.Fatalf("LoadOwnerState(after delete) = (%#v, %v)", nextState, err)
	}
	activeRecords, err = backend.ListActive(ctx, "owner-delete", nextState.Generation, 10)
	if err != nil || len(activeRecords) != 0 {
		t.Fatalf("ListActive(after delete) = (%#v, %v)", activeRecords, err)
	}
	tombstone, exists, err := backend.Load(ctx, "owner-delete", "active")
	if err != nil || !exists || tombstone.DeletedAtMillis != 3000 || len(tombstone.Data) != 0 || tombstone.Active {
		t.Fatalf("Load(tombstone) = (%#v, %v, %v)", tombstone, exists, err)
	}
	if tombstone.StorageVersion != active.StorageVersion+1 {
		t.Fatalf("tombstone storage version = %d, want %d", tombstone.StorageVersion, active.StorageVersion+1)
	}
	if _, err := saveOneImageConversationCASTest(ctx, backend, "owner-delete", nextState.Generation, tombstone.StorageVersion, imageConversationTestRecord("active", 4000, false)); !errors.Is(err, ErrImageConversationGone) {
		t.Fatalf("BatchSaveCAS(deleted) error = %v", err)
	}

	removed, err = backend.Delete(ctx, "owner-delete", "missing", 4000)
	if err != nil || removed {
		t.Fatalf("Delete(missing) = (%v, %v)", removed, err)
	}
	finalState, err := backend.LoadOwnerState(ctx, "owner-delete")
	if err != nil || finalState.Generation != nextState.Generation+1 {
		t.Fatalf("LoadOwnerState(after missing delete) = (%#v, %v)", finalState, err)
	}
	missing, exists, err := backend.Load(ctx, "owner-delete", "missing")
	if err != nil || !exists || missing.DeletedAtMillis != 4000 {
		t.Fatalf("Load(missing tombstone) = (%#v, %v, %v)", missing, exists, err)
	}
}

func TestDatabaseBackendImageConversationClearInvalidatesGenerationAndData(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-clear")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	for _, id := range []string{"one", "two"} {
		if _, err := saveOneImageConversationCASTest(ctx, backend, "owner-clear", state.Generation, 0, imageConversationTestRecord(id, 1000, id == "one")); err != nil {
			t.Fatalf("BatchSaveCAS(%q) error = %v", id, err)
		}
	}
	cleared, err := backend.Clear(ctx, "owner-clear", "2026-07-20T10:00:00Z", 5000)
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Generation != state.Generation+1 || cleared.ClearedAtMillis != 5000 {
		t.Fatalf("Clear() = %#v", cleared)
	}
	if _, err := backend.List(ctx, "owner-clear", state.Generation, nil, 10); !errors.Is(err, ErrImageConversationGenerationStale) {
		t.Fatalf("List(stale generation) error = %v", err)
	}
	page, err := backend.List(ctx, "owner-clear", cleared.Generation, nil, 10)
	if err != nil || len(page.Records) != 0 {
		t.Fatalf("List(after clear) = (%#v, %v)", page, err)
	}
	for _, id := range []string{"one", "two"} {
		record, exists, err := backend.Load(ctx, "owner-clear", id)
		if err != nil || !exists || record.DeletedAtMillis != 5000 || len(record.Data) != 0 || record.Active {
			t.Fatalf("Load(%q after clear) = (%#v, %v, %v)", id, record, exists, err)
		}
	}
	if _, err := saveOneImageConversationCASTest(ctx, backend, "owner-clear", cleared.Generation, 0, imageConversationTestRecord("new", 6000, false)); err != nil {
		t.Fatalf("BatchSaveCAS(new after clear) error = %v", err)
	}
}

func TestDatabaseBackendImageConversationBatchSaveCASCommitsAtomically(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-batch")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	first, err := saveOneImageConversationCASTest(ctx, backend, "owner-batch", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(first) error = %v", err)
	}
	beforeBatch, err := backend.LoadOwnerState(ctx, "owner-batch")
	if err != nil {
		t.Fatalf("LoadOwnerState(before batch) error = %v", err)
	}
	updatedFirst := imageConversationTestRecord("first", 3000, true)
	updatedFirst.Revision = 2
	result, err := backend.BatchSaveCAS(ctx, "owner-batch", state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: updatedFirst},
		{ExpectedStorageVersion: 0, Record: imageConversationTestRecord("second", 2000, false)},
	})
	if err != nil {
		t.Fatalf("BatchSaveCAS() error = %v", err)
	}
	if result.Generation != state.Generation || result.CursorGeneration != beforeBatch.CursorGeneration+1 || len(result.Items) != 2 {
		t.Fatalf("BatchSaveCAS() = %#v", result)
	}
	if result.Items[0].Status != ImageConversationCASSaved || result.Items[0].Current.StorageVersion != 2 {
		t.Fatalf("BatchSaveCAS(first result) = %#v", result.Items[0])
	}
	if result.Items[1].Status != ImageConversationCASSaved || result.Items[1].Current.StorageVersion != 1 {
		t.Fatalf("BatchSaveCAS(second result) = %#v", result.Items[1])
	}
}

func TestDatabaseBackendImageConversationBatchSaveCASConflictRollsBackAll(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-batch-conflict")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	first, err := saveOneImageConversationCASTest(ctx, backend, "owner-batch-conflict", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(first) error = %v", err)
	}
	second, err := saveOneImageConversationCASTest(ctx, backend, "owner-batch-conflict", state.Generation, 0, imageConversationTestRecord("second", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(second) error = %v", err)
	}
	firstUpdate := imageConversationTestRecord("first", 3000, true)
	firstUpdate.Revision = 2
	secondUpdate := imageConversationTestRecord("second", 3000, true)
	secondUpdate.Revision = 2
	result, err := backend.BatchSaveCAS(ctx, "owner-batch-conflict", state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: firstUpdate},
		{ExpectedStorageVersion: second.StorageVersion + 10, Record: secondUpdate},
	})
	if !errors.Is(err, ErrImageConversationCASConflict) {
		t.Fatalf("BatchSaveCAS(conflict) error = %v", err)
	}
	if len(result.Items) != 2 || result.Items[0].Status != ImageConversationCASReady || result.Items[1].Status != ImageConversationCASConflict {
		t.Fatalf("BatchSaveCAS(conflict) = %#v", result)
	}
	if result.Items[1].Current.StorageVersion != second.StorageVersion {
		t.Fatalf("BatchSaveCAS(conflict current) = %#v", result.Items[1])
	}
	loadedFirst, exists, err := backend.Load(ctx, "owner-batch-conflict", "first")
	if err != nil || !exists || loadedFirst.StorageVersion != first.StorageVersion || loadedFirst.UpdatedAtMillis != first.UpdatedAtMillis {
		t.Fatalf("Load(first after rollback) = (%#v, %v, %v)", loadedFirst, exists, err)
	}

	removed, err := backend.Delete(ctx, "owner-batch-conflict", "second", 4000)
	if err != nil || !removed {
		t.Fatalf("Delete(second) = (%v, %v)", removed, err)
	}
	currentState, err := backend.LoadOwnerState(ctx, "owner-batch-conflict")
	if err != nil {
		t.Fatalf("LoadOwnerState(after delete) error = %v", err)
	}
	result, err = backend.BatchSaveCAS(ctx, "owner-batch-conflict", state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: firstUpdate},
	})
	if !errors.Is(err, ErrImageConversationGenerationStale) || result.Generation != currentState.Generation || result.Items[0].Status != ImageConversationCASGenerationStale {
		t.Fatalf("BatchSaveCAS(stale generation) = (%#v, %v)", result, err)
	}
	tombstone, exists, err := backend.Load(ctx, "owner-batch-conflict", "second")
	if err != nil || !exists {
		t.Fatalf("Load(second tombstone) = (%#v, %v, %v)", tombstone, exists, err)
	}
	result, err = backend.BatchSaveCAS(ctx, "owner-batch-conflict", currentState.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: firstUpdate},
		{ExpectedStorageVersion: tombstone.StorageVersion, Record: secondUpdate},
	})
	if !errors.Is(err, ErrImageConversationGone) || result.Items[0].Status != ImageConversationCASReady || result.Items[1].Status != ImageConversationCASGone {
		t.Fatalf("BatchSaveCAS(gone) = (%#v, %v)", result, err)
	}
	loadedFirst, _, err = backend.Load(ctx, "owner-batch-conflict", "first")
	if err != nil || loadedFirst.StorageVersion != first.StorageVersion {
		t.Fatalf("Load(first after gone rollback) = (%#v, %v)", loadedFirst, err)
	}
}

func TestDatabaseBackendImageConversationBatchSaveCASInfrastructureFailureRollsBackAll(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-batch-infrastructure")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	first, err := saveOneImageConversationCASTest(ctx, backend, "owner-batch-infrastructure", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(first) error = %v", err)
	}
	second, err := saveOneImageConversationCASTest(ctx, backend, "owner-batch-infrastructure", state.Generation, 0, imageConversationTestRecord("failure", 1000, false))
	if err != nil {
		t.Fatalf("BatchSaveCAS(failure) error = %v", err)
	}
	if _, err := backend.db.Exec(`CREATE TRIGGER fail_image_conversation_batch
		BEFORE UPDATE ON image_conversations
		WHEN NEW.conversation_id = 'failure'
		BEGIN SELECT RAISE(ABORT, 'forced image conversation batch failure'); END`); err != nil {
		t.Fatalf("create failure trigger error = %v", err)
	}
	firstUpdate := imageConversationTestRecord("first", 3000, true)
	firstUpdate.Revision = 2
	failureUpdate := imageConversationTestRecord("failure", 3000, true)
	failureUpdate.Revision = 2
	result, err := backend.BatchSaveCAS(ctx, "owner-batch-infrastructure", state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: firstUpdate},
		{ExpectedStorageVersion: second.StorageVersion, Record: failureUpdate},
	})
	if err == nil || !strings.Contains(err.Error(), "forced image conversation batch failure") {
		t.Fatalf("BatchSaveCAS(infrastructure failure) = (%#v, %v)", result, err)
	}
	if result.Items[0].Status != ImageConversationCASReady || result.Items[0].Current.StorageVersion != first.StorageVersion {
		t.Fatalf("BatchSaveCAS(infrastructure current) = %#v", result.Items[0])
	}
	loadedFirst, exists, err := backend.Load(ctx, "owner-batch-infrastructure", "first")
	if err != nil || !exists || loadedFirst.StorageVersion != first.StorageVersion || loadedFirst.UpdatedAtMillis != first.UpdatedAtMillis {
		t.Fatalf("Load(first after infrastructure rollback) = (%#v, %v, %v)", loadedFirst, exists, err)
	}
}

func TestDatabaseBackendImageConversationConcurrentSQLiteCAS(t *testing.T) {
	databasePath := filepath.ToSlash(filepath.Join(t.TempDir(), "concurrent.db"))
	first, err := NewDatabaseBackend("sqlite:///" + databasePath)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(first) error = %v", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := NewDatabaseBackend("sqlite:///" + databasePath)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(second) error = %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	ctx := context.Background()
	state, err := first.LoadOwnerState(ctx, "owner-concurrent")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	const count = 24
	start := make(chan struct{})
	errorsByWrite := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			backend := first
			if index%2 != 0 {
				backend = second
			}
			_, err := saveOneImageConversationCASTest(
				ctx,
				backend,
				"owner-concurrent",
				state.Generation,
				0,
				imageConversationTestRecord(fmt.Sprintf("conversation-%02d", index), int64(1000+index), index%3 == 0),
			)
			errorsByWrite <- err
		}(index)
	}
	close(start)
	wait.Wait()
	close(errorsByWrite)
	for err := range errorsByWrite {
		if err != nil {
			t.Fatalf("concurrent BatchSaveCAS() error = %v", err)
		}
	}
	page, err := first.List(ctx, "owner-concurrent", state.Generation, nil, count)
	if err != nil || len(page.Records) != count {
		t.Fatalf("List(after concurrent writes) = (%d records, %v)", len(page.Records), err)
	}

	start = make(chan struct{})
	conflicts := make(chan error, 2)
	for _, backend := range []*DatabaseBackend{first, second} {
		wait.Add(1)
		go func(backend *DatabaseBackend) {
			defer wait.Done()
			<-start
			_, err := saveOneImageConversationCASTest(
				ctx,
				backend,
				"owner-concurrent",
				state.Generation,
				0,
				imageConversationTestRecord("same-conversation", 5000, false),
			)
			conflicts <- err
		}(backend)
	}
	close(start)
	wait.Wait()
	close(conflicts)
	succeeded := 0
	conflicted := 0
	for err := range conflicts {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrImageConversationCASConflict):
			conflicted++
		default:
			t.Fatalf("same-row concurrent BatchSaveCAS() error = %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("same-row concurrent BatchSaveCAS() succeeded=%d conflicted=%d", succeeded, conflicted)
	}
}
