package storage

import (
	"context"
	"database/sql"
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

func TestDatabaseBackendImageConversationSaveCAS(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-cas")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	if state.Generation != 1 || state.LegacyMigrated {
		t.Fatalf("initial state = %#v", state)
	}

	created, err := backend.SaveCAS(ctx, "owner-cas", state.Generation, 0, imageConversationTestRecord("conversation", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(insert) error = %v", err)
	}
	if created.StorageVersion != 1 || created.AcceptedHash == "" {
		t.Fatalf("SaveCAS(insert) = %#v", created)
	}

	current, err := backend.SaveCAS(ctx, "owner-cas", state.Generation, 0, imageConversationTestRecord("conversation", 1001, true))
	if !errors.Is(err, ErrImageConversationCASConflict) || current.StorageVersion != 1 {
		t.Fatalf("SaveCAS(conflicting insert) = (%#v, %v)", current, err)
	}

	updatedInput := imageConversationTestRecord("conversation", 2000, true)
	updatedInput.Revision = 2
	updated, err := backend.SaveCAS(ctx, "owner-cas", state.Generation, created.StorageVersion, updatedInput)
	if err != nil {
		t.Fatalf("SaveCAS(update) error = %v", err)
	}
	if updated.StorageVersion != 2 || !updated.Active || updated.Revision != 2 {
		t.Fatalf("SaveCAS(update) = %#v", updated)
	}

	current, err = backend.SaveCAS(ctx, "owner-cas", state.Generation, created.StorageVersion, updatedInput)
	if !errors.Is(err, ErrImageConversationCASConflict) || current.StorageVersion != 2 {
		t.Fatalf("SaveCAS(stale update) = (%#v, %v)", current, err)
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
		if _, err := backend.SaveCAS(ctx, "owner-page", state.Generation, 0, record); err != nil {
			t.Fatalf("SaveCAS(%q) error = %v", record.ID, err)
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
		if _, err := backend.SaveCAS(ctx, ownerID, state.Generation, 0, imageConversationTestRecord(id, updatedAt, false)); err != nil {
			t.Fatalf("SaveCAS(%q) error = %v", id, err)
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
	if _, err := backend.SaveCAS(ctx, ownerID, state.Generation, older.StorageVersion, reordered); err != nil {
		t.Fatalf("SaveCAS(reorder) error = %v", err)
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
	active, err := backend.SaveCAS(ctx, "owner-delete", state.Generation, 0, imageConversationTestRecord("active", 2000, true))
	if err != nil {
		t.Fatalf("SaveCAS(active) error = %v", err)
	}
	if _, err := backend.SaveCAS(ctx, "owner-delete", state.Generation, 0, imageConversationTestRecord("inactive", 1000, false)); err != nil {
		t.Fatalf("SaveCAS(inactive) error = %v", err)
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
	if _, err := backend.SaveCAS(ctx, "owner-delete", nextState.Generation, tombstone.StorageVersion, imageConversationTestRecord("active", 4000, false)); !errors.Is(err, ErrImageConversationGone) {
		t.Fatalf("SaveCAS(deleted) error = %v", err)
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
		if _, err := backend.SaveCAS(ctx, "owner-clear", state.Generation, 0, imageConversationTestRecord(id, 1000, id == "one")); err != nil {
			t.Fatalf("SaveCAS(%q) error = %v", id, err)
		}
	}
	cleared, err := backend.Clear(ctx, "owner-clear", "2026-07-20T10:00:00Z", 5000)
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Generation != state.Generation+1 || !cleared.LegacyMigrated || cleared.ClearedAtMillis != 5000 {
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
	if _, err := backend.SaveCAS(ctx, "owner-clear", cleared.Generation, 0, imageConversationTestRecord("new", 6000, false)); err != nil {
		t.Fatalf("SaveCAS(new after clear) error = %v", err)
	}
}

func TestDatabaseBackendImageConversationLegacyMigrationIsIdempotent(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	legacy := []ImageConversationRecord{
		imageConversationTestRecord("live", 2000, true),
		{ID: "deleted", DeletedAtMillis: 1500},
		imageConversationTestRecord("duplicate", 1000, false),
		{ID: "duplicate", DeletedAtMillis: 1600},
	}
	state, err := backend.MigrateLegacy(ctx, "owner-migrate", legacy, ImageConversationOwnerState{
		ClearedAt:       "2026-07-20T09:00:00Z",
		ClearedAtMillis: 900,
	})
	if err != nil {
		t.Fatalf("MigrateLegacy() error = %v", err)
	}
	if !state.LegacyMigrated || state.Generation != 1 || state.ClearedAtMillis != 900 {
		t.Fatalf("MigrateLegacy() state = %#v", state)
	}
	page, err := backend.List(ctx, "owner-migrate", state.Generation, nil, 10)
	if err != nil || len(page.Records) != 1 || page.Records[0].ID != "live" {
		t.Fatalf("List(after migration) = (%#v, %v)", page, err)
	}
	for _, id := range []string{"deleted", "duplicate"} {
		record, exists, err := backend.Load(ctx, "owner-migrate", id)
		if err != nil || !exists || record.DeletedAtMillis == 0 || len(record.Data) != 0 {
			t.Fatalf("Load(%q tombstone) = (%#v, %v, %v)", id, record, exists, err)
		}
	}

	second, err := backend.MigrateLegacy(ctx, "owner-migrate", []ImageConversationRecord{
		imageConversationTestRecord("must-not-import", 3000, false),
	}, ImageConversationOwnerState{})
	if err != nil || !second.LegacyMigrated || second.Generation != state.Generation {
		t.Fatalf("MigrateLegacy(second) = (%#v, %v)", second, err)
	}
	if record, exists, err := backend.Load(ctx, "owner-migrate", "must-not-import"); err != nil || exists {
		t.Fatalf("Load(must-not-import) = (%#v, %v, %v)", record, exists, err)
	}
}

func TestDatabaseBackendImageConversationSummarySchemaUpgradeAndBackfill(t *testing.T) {
	databasePath := filepath.ToSlash(filepath.Join(t.TempDir(), "summary-upgrade.db"))
	rawDatabase, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	ownerKey, _ := imageConversationStorageKey("owner-upgrade")
	conversationKey, _ := imageConversationStorageKey("legacy-row")
	legacyData := `{"id":"legacy-row","title":"Legacy title","createdAt":"2026-07-20T00:00:00Z","updatedAt":"2026-07-20T00:00:01Z","turns":[{"id":"turn","prompt":"large detail"}]}`
	for _, statement := range []string{
		`CREATE TABLE image_conversation_owners (
			owner_key TEXT PRIMARY KEY, cleared_at TEXT NOT NULL DEFAULT '', cleared_at_ms INTEGER NOT NULL DEFAULT 0,
			generation INTEGER NOT NULL DEFAULT 1, legacy_migrated INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE image_conversations (
			owner_key TEXT NOT NULL, conversation_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 0, storage_version INTEGER NOT NULL DEFAULT 1,
			accepted_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 0, deleted_at_ms INTEGER NOT NULL DEFAULT 0, data TEXT,
			PRIMARY KEY (owner_key, conversation_key)
		)`,
	} {
		if _, err := rawDatabase.Exec(statement); err != nil {
			_ = rawDatabase.Close()
			t.Fatalf("create legacy schema error = %v", err)
		}
	}
	if _, err := rawDatabase.Exec(
		`INSERT INTO image_conversation_owners (owner_key, generation, legacy_migrated) VALUES (?, 7, 1)`,
		ownerKey,
	); err != nil {
		_ = rawDatabase.Close()
		t.Fatalf("insert legacy owner error = %v", err)
	}
	if _, err := rawDatabase.Exec(
		`INSERT INTO image_conversations (
			owner_key, conversation_key, conversation_id, revision, storage_version, accepted_hash,
			created_at_ms, updated_at_ms, active, deleted_at_ms, data
		) VALUES (?, ?, ?, 1, 1, ?, 1000, 2000, 0, 0, ?)`,
		ownerKey,
		conversationKey,
		"legacy-row",
		imageConversationDataHash([]byte(legacyData)),
		legacyData,
	); err != nil {
		_ = rawDatabase.Close()
		t.Fatalf("insert legacy conversation error = %v", err)
	}
	for index := 1; index < 105; index++ {
		id := fmt.Sprintf("legacy-row-%03d", index)
		key, _ := imageConversationStorageKey(id)
		data := fmt.Sprintf(`{"id":%q,"title":%q,"createdAt":"2026-07-20T00:00:00Z","updatedAt":"2026-07-20T00:00:01Z","turns":[]}`, id, id)
		if _, err := rawDatabase.Exec(
			`INSERT INTO image_conversations (
				owner_key, conversation_key, conversation_id, revision, storage_version, accepted_hash,
				created_at_ms, updated_at_ms, active, deleted_at_ms, data
			) VALUES (?, ?, ?, 1, 1, ?, 1000, 2000, 0, 0, ?)`,
			ownerKey,
			key,
			id,
			imageConversationDataHash([]byte(data)),
			data,
		); err != nil {
			_ = rawDatabase.Close()
			t.Fatalf("insert legacy conversation %q error = %v", id, err)
		}
	}
	if err := rawDatabase.Close(); err != nil {
		t.Fatalf("close legacy database error = %v", err)
	}

	backend, err := NewDatabaseBackend("sqlite:///" + databasePath)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(upgrade) error = %v", err)
	}
	upgradedState, err := backend.LoadOwnerState(context.Background(), "owner-upgrade")
	if err != nil || upgradedState.Generation != 7 || upgradedState.CursorGeneration != upgradedState.Generation {
		_ = backend.Close()
		t.Fatalf("LoadOwnerState(upgraded) = (%#v, %v)", upgradedState, err)
	}
	var missingBeforeList int
	if err := backend.db.QueryRow(`SELECT COUNT(*) FROM image_conversations WHERE summary IS NULL`).Scan(&missingBeforeList); err != nil {
		_ = backend.Close()
		t.Fatalf("count summaries before list error = %v", err)
	}
	if missingBeforeList < 5 {
		_ = backend.Close()
		t.Fatalf("startup backfill was not bounded: missing summaries = %d", missingBeforeList)
	}
	page, err := backend.List(context.Background(), "owner-upgrade", upgradedState.Generation, nil, 200)
	if err != nil || len(page.Records) != 105 {
		_ = backend.Close()
		t.Fatalf("List(upgraded) = (%#v, %v)", page, err)
	}
	var row ImageConversationRecord
	for _, candidate := range page.Records {
		if candidate.ID == "legacy-row" {
			row = candidate
			break
		}
	}
	if len(row.Data) != 0 || !strings.Contains(string(row.Summary), `"Legacy title"`) || strings.Contains(string(row.Summary), `"turns"`) {
		_ = backend.Close()
		t.Fatalf("upgraded summary = %#v", row)
	}
	loaded, exists, err := backend.Load(context.Background(), "owner-upgrade", "legacy-row")
	if err != nil || !exists || !strings.Contains(string(loaded.Data), `"turns"`) {
		_ = backend.Close()
		t.Fatalf("Load(upgraded full row) = (%#v, %v, %v)", loaded, exists, err)
	}
	var missingAfterList int
	if err := backend.db.QueryRow(`SELECT COUNT(*) FROM image_conversations WHERE summary IS NULL`).Scan(&missingAfterList); err != nil || missingAfterList != 0 {
		_ = backend.Close()
		t.Fatalf("summaries after lazy list backfill = %d, error = %v", missingAfterList, err)
	}
	if err := backend.Close(); err != nil {
		t.Fatalf("Close(upgraded backend) error = %v", err)
	}

	reopened, err := NewDatabaseBackend("sqlite:///" + databasePath)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(reopen upgraded schema) error = %v", err)
	}
	defer reopened.Close()
	var summaryColumnCount int
	if err := reopened.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('image_conversations') WHERE name = 'summary'`).Scan(&summaryColumnCount); err != nil {
		t.Fatalf("inspect upgraded summary column error = %v", err)
	}
	if summaryColumnCount != 1 {
		t.Fatalf("summary column count = %d, want 1", summaryColumnCount)
	}
	var cursorGenerationColumnCount int
	if err := reopened.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('image_conversation_owners') WHERE name = 'cursor_generation'`).Scan(&cursorGenerationColumnCount); err != nil {
		t.Fatalf("inspect upgraded cursor generation column error = %v", err)
	}
	if cursorGenerationColumnCount != 1 {
		t.Fatalf("cursor generation column count = %d, want 1", cursorGenerationColumnCount)
	}
}

func TestDatabaseBackendImageConversationBatchSaveCASCommitsAtomically(t *testing.T) {
	backend := newImageConversationTestBackend(t)
	ctx := context.Background()
	state, err := backend.LoadOwnerState(ctx, "owner-batch")
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	first, err := backend.SaveCAS(ctx, "owner-batch", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(first) error = %v", err)
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
	first, err := backend.SaveCAS(ctx, "owner-batch-conflict", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(first) error = %v", err)
	}
	second, err := backend.SaveCAS(ctx, "owner-batch-conflict", state.Generation, 0, imageConversationTestRecord("second", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(second) error = %v", err)
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
	first, err := backend.SaveCAS(ctx, "owner-batch-infrastructure", state.Generation, 0, imageConversationTestRecord("first", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(first) error = %v", err)
	}
	second, err := backend.SaveCAS(ctx, "owner-batch-infrastructure", state.Generation, 0, imageConversationTestRecord("failure", 1000, false))
	if err != nil {
		t.Fatalf("SaveCAS(failure) error = %v", err)
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
			_, err := backend.SaveCAS(
				ctx,
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
			t.Fatalf("concurrent SaveCAS() error = %v", err)
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
			_, err := backend.SaveCAS(
				ctx,
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
			t.Fatalf("same-row concurrent SaveCAS() error = %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("same-row concurrent SaveCAS() succeeded=%d conflicted=%d", succeeded, conflicted)
	}
}
