package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

const (
	postgresIntegrationDatabaseURLEnv = "CHATGPT2API_TEST_POSTGRES_DATABASE_URL"
	mysqlIntegrationDatabaseURLEnv    = "CHATGPT2API_TEST_MYSQL_DATABASE_URL"
	integrationFailureConversationID  = "integration-failure"
)

// TestDatabaseBackendIntegration is intentionally destructive. It only runs
// when an explicit test database URL is provided and CI supplies disposable
// PostgreSQL and MySQL databases for it.
func TestDatabaseBackendIntegration(t *testing.T) {
	testCases := []struct {
		name        string
		backendType string
		driver      string
		envName     string
	}{
		{name: "postgresql", backendType: "postgresql", driver: "postgres", envName: postgresIntegrationDatabaseURLEnv},
		{name: "mysql", backendType: "mysql", driver: "mysql", envName: mysqlIntegrationDatabaseURLEnv},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			databaseURL := strings.TrimSpace(os.Getenv(testCase.envName))
			if databaseURL == "" {
				t.Skipf("%s is not set; skipping destructive database integration test", testCase.envName)
			}
			t.Setenv("STORAGE_BACKEND", testCase.backendType)
			t.Setenv("DATABASE_URL", databaseURL)
			runDatabaseBackendIntegration(t, databaseURL, testCase.driver)
		})
	}
}

func runDatabaseBackendIntegration(t *testing.T, databaseURL, wantDriver string) {
	t.Helper()
	ctx := context.Background()

	initial := openIntegrationBackend(t, wantDriver)
	resetIntegrationDatabase(t, initial)
	t.Cleanup(func() {
		cleanup, err := NewDatabaseBackend(databaseURL)
		if err != nil {
			t.Errorf("open integration database for cleanup: %v", err)
			return
		}
		defer cleanup.Close()
		resetIntegrationDatabase(t, cleanup)
	})
	prepareIntegrationLegacyImageConversationSchema(t, initial, wantDriver)
	if err := initial.Close(); err != nil {
		t.Fatalf("Close(legacy schema backend) error = %v", err)
	}

	initial = openIntegrationBackend(t, wantDriver)
	verifyIntegrationLegacyImageConversationUpgrade(t, initial, wantDriver)
	resetIntegrationDatabase(t, initial)

	writeIntegrationCoreData(t, initial, wantDriver)
	if err := initial.Close(); err != nil {
		t.Fatalf("Close(initial backend) error = %v", err)
	}

	// Opening the same database again exercises idempotent schema setup,
	// including the MySQL indexes that do not support IF NOT EXISTS.
	reopened := openIntegrationBackend(t, wantDriver)
	defer reopened.Close()
	verifyIntegrationCoreData(t, reopened, wantDriver)
	exerciseImageConversationIntegration(t, ctx, reopened, wantDriver)

	if err := reopened.Close(); err != nil {
		t.Fatalf("Close(reopened backend) error = %v", err)
	}

	finalBackend := openIntegrationBackend(t, wantDriver)
	defer finalBackend.Close()
	state, err := finalBackend.LoadOwnerState(ctx, integrationOwnerID(wantDriver))
	if err != nil {
		t.Fatalf("LoadOwnerState(after final reopen) error = %v", err)
	}
	if state.Generation != 3 || !state.LegacyMigrated {
		t.Fatalf("owner state after final reopen = %#v, want generation 3 and migrated", state)
	}
	page, err := finalBackend.List(ctx, integrationOwnerID(wantDriver), state.Generation, nil, 10)
	if err != nil {
		t.Fatalf("List(after final reopen) error = %v", err)
	}
	if len(page.Records) != 0 {
		t.Fatalf("List(after persisted clear) = %#v, want no records", page.Records)
	}
}

func openIntegrationBackend(t *testing.T, wantDriver string) *DatabaseBackend {
	t.Helper()
	backend, err := NewBackendFromEnv(t.TempDir())
	if err != nil {
		t.Fatalf("NewBackendFromEnv() error = %v", err)
	}
	database, ok := backend.(*DatabaseBackend)
	if !ok {
		t.Fatalf("NewBackendFromEnv() returned %T, want *DatabaseBackend", backend)
	}
	if database.driver != wantDriver {
		_ = database.Close()
		t.Fatalf("database driver = %q, want %q", database.driver, wantDriver)
	}
	return database
}

func resetIntegrationDatabase(t *testing.T, backend *DatabaseBackend) {
	t.Helper()
	dropIntegrationFailureConstraint(t, backend)
	for _, table := range []string{
		"image_conversations",
		"image_conversation_owners",
		"accounts",
		"auth_keys",
		"json_documents",
		"logs",
	} {
		if _, err := backend.db.Exec("DELETE FROM " + table); err != nil {
			t.Fatalf("clear integration table %s: %v", table, err)
		}
	}
}

func prepareIntegrationLegacyImageConversationSchema(t *testing.T, backend *DatabaseBackend, driver string) {
	t.Helper()
	dropIntegrationFailureConstraint(t, backend)
	for _, statement := range []string{
		"DROP TABLE image_conversations",
		"DROP TABLE image_conversation_owners",
	} {
		if _, err := backend.db.Exec(statement); err != nil {
			t.Fatalf("drop current %s schema: %v", driver, err)
		}
	}

	var schema []string
	switch driver {
	case "postgres":
		schema = []string{
			`CREATE TABLE image_conversation_owners (
				owner_key TEXT PRIMARY KEY,
				cleared_at TEXT NOT NULL DEFAULT '',
				cleared_at_ms BIGINT NOT NULL DEFAULT 0,
				generation BIGINT NOT NULL DEFAULT 1,
				legacy_migrated SMALLINT NOT NULL DEFAULT 0
			)`,
			`CREATE TABLE image_conversations (
				owner_key TEXT NOT NULL,
				conversation_key TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				revision BIGINT NOT NULL DEFAULT 0,
				storage_version BIGINT NOT NULL DEFAULT 1,
				accepted_hash TEXT NOT NULL,
				created_at_ms BIGINT NOT NULL DEFAULT 0,
				updated_at_ms BIGINT NOT NULL DEFAULT 0,
				active SMALLINT NOT NULL DEFAULT 0,
				deleted_at_ms BIGINT NOT NULL DEFAULT 0,
				data TEXT,
				PRIMARY KEY (owner_key, conversation_key)
			)`,
		}
	case "mysql":
		schema = []string{
			`CREATE TABLE image_conversation_owners (
				owner_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
				cleared_at TEXT NOT NULL,
				cleared_at_ms BIGINT NOT NULL DEFAULT 0,
				generation BIGINT NOT NULL DEFAULT 1,
				legacy_migrated TINYINT(1) NOT NULL DEFAULT 0
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			`CREATE TABLE image_conversations (
				owner_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				conversation_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				conversation_id TEXT NOT NULL,
				revision BIGINT NOT NULL DEFAULT 0,
				storage_version BIGINT NOT NULL DEFAULT 1,
				accepted_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				created_at_ms BIGINT NOT NULL DEFAULT 0,
				updated_at_ms BIGINT NOT NULL DEFAULT 0,
				active TINYINT(1) NOT NULL DEFAULT 0,
				deleted_at_ms BIGINT NOT NULL DEFAULT 0,
				data LONGTEXT,
				PRIMARY KEY (owner_key, conversation_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
		}
	default:
		t.Fatalf("unsupported integration legacy schema driver %q", driver)
	}
	for _, statement := range schema {
		if _, err := backend.db.Exec(statement); err != nil {
			t.Fatalf("create legacy %s schema: %v", driver, err)
		}
	}

	ownerID := "integration-upgrade-owner-" + driver
	conversationID := "integration-upgrade-conversation-" + driver
	ownerKey, _ := imageConversationStorageKey(ownerID)
	conversationKey, _ := imageConversationStorageKey(conversationID)
	data, _ := json.Marshal(map[string]any{
		"id":        conversationID,
		"revision":  1,
		"title":     "Legacy integration conversation",
		"createdAt": "2098-01-01T00:00:00Z",
		"updatedAt": "2098-01-02T00:00:00Z",
		"turns":     []any{},
	})
	ownerInsert := `INSERT INTO image_conversation_owners
		(owner_key, cleared_at, cleared_at_ms, generation, legacy_migrated) VALUES (` + backend.imageConversationPlaceholders(5) + `)`
	if _, err := backend.db.Exec(ownerInsert, ownerKey, "", 0, 4, 1); err != nil {
		t.Fatalf("insert legacy %s owner: %v", driver, err)
	}
	conversationInsert := `INSERT INTO image_conversations (
		owner_key, conversation_key, conversation_id, revision, storage_version,
		accepted_hash, created_at_ms, updated_at_ms, active, deleted_at_ms, data
	) VALUES (` + backend.imageConversationPlaceholders(11) + `)`
	if _, err := backend.db.Exec(
		conversationInsert,
		ownerKey,
		conversationKey,
		conversationID,
		1,
		1,
		imageConversationDataHash(data),
		1_000,
		2_000,
		0,
		0,
		string(data),
	); err != nil {
		t.Fatalf("insert legacy %s conversation: %v", driver, err)
	}
}

func verifyIntegrationLegacyImageConversationUpgrade(t *testing.T, backend *DatabaseBackend, driver string) {
	t.Helper()
	ownerID := "integration-upgrade-owner-" + driver
	conversationID := "integration-upgrade-conversation-" + driver
	record, exists, err := backend.Load(context.Background(), ownerID, conversationID)
	if err != nil || !exists || len(record.Data) == 0 || !strings.Contains(string(record.Summary), "Legacy integration conversation") {
		t.Fatalf("Load(upgraded %s conversation) = (%#v, %v, %v)", driver, record, exists, err)
	}
	state, err := backend.LoadOwnerState(context.Background(), ownerID)
	if err != nil || state.Generation != 4 || state.CursorGeneration != state.Generation {
		t.Fatalf("LoadOwnerState(upgraded %s) = (%#v, %v)", driver, state, err)
	}

	var summaryColumns int
	var cursorGenerationColumns int
	var indexCount func(string) int
	switch driver {
	case "postgres":
		if err := backend.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'image_conversations' AND column_name = 'summary'`).Scan(&summaryColumns); err != nil {
			t.Fatalf("inspect upgraded postgres summary column: %v", err)
		}
		if err := backend.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'image_conversation_owners' AND column_name = 'cursor_generation'`).Scan(&cursorGenerationColumns); err != nil {
			t.Fatalf("inspect upgraded postgres cursor generation column: %v", err)
		}
		indexCount = func(name string) int {
			var count int
			if err := backend.db.QueryRow(`SELECT COUNT(*) FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = 'image_conversations' AND indexname = $1`, name).Scan(&count); err != nil {
				t.Fatalf("inspect upgraded postgres index %s: %v", name, err)
			}
			return count
		}
	case "mysql":
		if err := backend.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = DATABASE() AND table_name = 'image_conversations' AND column_name = 'summary'`).Scan(&summaryColumns); err != nil {
			t.Fatalf("inspect upgraded mysql summary column: %v", err)
		}
		if err := backend.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = DATABASE() AND table_name = 'image_conversation_owners' AND column_name = 'cursor_generation'`).Scan(&cursorGenerationColumns); err != nil {
			t.Fatalf("inspect upgraded mysql cursor generation column: %v", err)
		}
		indexCount = func(name string) int {
			var count int
			if err := backend.db.QueryRow(`SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
				WHERE table_schema = DATABASE() AND table_name = 'image_conversations' AND index_name = ?`, name).Scan(&count); err != nil {
				t.Fatalf("inspect upgraded mysql index %s: %v", name, err)
			}
			return count
		}
	default:
		t.Fatalf("unsupported integration upgrade driver %q", driver)
	}
	if summaryColumns != 1 {
		t.Fatalf("upgraded %s summary column count = %d, want 1", driver, summaryColumns)
	}
	if cursorGenerationColumns != 1 {
		t.Fatalf("upgraded %s cursor generation column count = %d, want 1", driver, cursorGenerationColumns)
	}
	for _, name := range []string{"idx_image_conversations_owner_list", "idx_image_conversations_owner_active"} {
		if count := indexCount(name); count != 1 {
			t.Fatalf("upgraded %s index %s count = %d, want 1", driver, name, count)
		}
	}
}

func writeIntegrationCoreData(t *testing.T, backend *DatabaseBackend, driver string) {
	t.Helper()
	longToken := integrationLongToken(driver)
	if err := backend.SaveAccounts([]map[string]any{
		{"access_token": "token-" + driver, "type": "Plus", "profile": map[string]any{"region": "test"}},
		{"access_token": longToken, "type": "Free"},
	}); err != nil {
		t.Fatalf("SaveAccounts() error = %v", err)
	}
	if err := backend.SaveAuthKeys([]map[string]any{
		{"id": "key-" + driver, "key": "sk-integration", "enabled": true},
		{"id": integrationLongAuthKeyID(driver), "key": "sk-long"},
	}); err != nil {
		t.Fatalf("SaveAuthKeys() error = %v", err)
	}

	documentName := integrationDocumentName(driver)
	if err := backend.SaveJSONDocument(documentName, map[string]any{"version": 1, "name": "before-upsert"}); err != nil {
		t.Fatalf("SaveJSONDocument(first) error = %v", err)
	}
	if err := backend.SaveJSONDocument(documentName, map[string]any{
		"version": 2,
		"name":    "after-upsert",
		"nested":  map[string]any{"enabled": true},
	}); err != nil {
		t.Fatalf("SaveJSONDocument(upsert) error = %v", err)
	}

	for _, item := range []map[string]any{
		{"time": "2098-01-01 10:00:00", "summary": "old-" + driver},
		{"time": "2098-01-02 10:00:00", "summary": "new-" + driver},
	} {
		if err := backend.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}
	deleted, err := backend.DeleteLogsBefore("2098-01-02")
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteLogsBefore() = (%d, %v), want (1, nil)", deleted, err)
	}
}

func verifyIntegrationCoreData(t *testing.T, backend *DatabaseBackend, driver string) {
	t.Helper()
	accounts, err := backend.LoadAccounts()
	if err != nil {
		t.Fatalf("LoadAccounts() error = %v", err)
	}
	if len(accounts) != 2 || !integrationRowsContain(accounts, "access_token", "token-"+driver) ||
		!integrationRowsContain(accounts, "access_token", integrationLongToken(driver)) {
		t.Fatalf("LoadAccounts() = %#v", accounts)
	}
	authKeys, err := backend.LoadAuthKeys()
	if err != nil {
		t.Fatalf("LoadAuthKeys() error = %v", err)
	}
	if len(authKeys) != 2 || !integrationRowsContain(authKeys, "id", "key-"+driver) ||
		!integrationRowsContain(authKeys, "id", integrationLongAuthKeyID(driver)) {
		t.Fatalf("LoadAuthKeys() = %#v", authKeys)
	}

	document, err := backend.LoadJSONDocument(integrationDocumentName(driver))
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	documentMap, ok := document.(map[string]any)
	if !ok || fmt.Sprint(documentMap["version"]) != "2" || documentMap["name"] != "after-upsert" {
		t.Fatalf("LoadJSONDocument() = %#v", document)
	}
	logs, err := backend.QueryLogs("2098-01-02", "2098-01-02", 10)
	if err != nil {
		t.Fatalf("QueryLogs() error = %v", err)
	}
	if len(logs) != 1 || logs[0]["summary"] != "new-"+driver {
		t.Fatalf("QueryLogs() = %#v", logs)
	}

	health := backend.HealthCheck()
	if health["status"] != "healthy" || health["account_count"] != 2 || health["auth_key_count"] != 2 ||
		health["document_count"] != 1 || health["log_count"] != 1 {
		t.Fatalf("HealthCheck() = %#v", health)
	}
	info := backend.Info()
	wantDatabaseType := driver
	if driver == "postgres" {
		wantDatabaseType = "postgresql"
	}
	if info["db_type"] != wantDatabaseType || strings.Contains(fmt.Sprint(info["database_url"]), "chatgpt2api:chatgpt2api@") {
		t.Fatalf("Info() = %#v", info)
	}
}

func exerciseImageConversationIntegration(t *testing.T, ctx context.Context, backend *DatabaseBackend, driver string) {
	t.Helper()
	ownerID := integrationOwnerID(driver)
	state, err := backend.LoadOwnerState(ctx, ownerID)
	if err != nil {
		t.Fatalf("LoadOwnerState() error = %v", err)
	}
	if state.Generation != 1 {
		t.Fatalf("initial owner state = %#v", state)
	}

	first := integrationConversationRecord("first", 1_000, true, "First summary")
	first, err = backend.SaveCAS(ctx, ownerID, state.Generation, 0, first)
	if err != nil || first.StorageVersion != 1 {
		t.Fatalf("SaveCAS(first) = (%#v, %v)", first, err)
	}
	second := integrationConversationRecord("second", 2_000, false, "Second summary")
	second, err = backend.SaveCAS(ctx, ownerID, state.Generation, 0, second)
	if err != nil || second.StorageVersion != 1 {
		t.Fatalf("SaveCAS(second) = (%#v, %v)", second, err)
	}

	loaded, exists, err := backend.Load(ctx, ownerID, first.ID)
	if err != nil || !exists || len(loaded.Data) == 0 || !strings.Contains(string(loaded.Summary), "First summary") {
		t.Fatalf("Load(first) = (%#v, %v, %v)", loaded, exists, err)
	}
	page, err := backend.List(ctx, ownerID, state.Generation, nil, 10)
	if err != nil || len(page.Records) != 2 {
		t.Fatalf("List() = (%#v, %v)", page, err)
	}
	for _, record := range page.Records {
		if len(record.Data) != 0 || len(record.Summary) == 0 {
			t.Fatalf("List() returned non-summary row %#v", record)
		}
	}
	active, err := backend.ListActive(ctx, ownerID, state.Generation, 10)
	if err != nil || len(active) != 1 || active[0].ID != first.ID || len(active[0].Data) == 0 {
		t.Fatalf("ListActive() = (%#v, %v)", active, err)
	}

	firstUpdate := integrationConversationRecord(first.ID, 3_000, false, "First updated")
	firstUpdate.Revision = 2
	first, err = backend.SaveCAS(ctx, ownerID, state.Generation, first.StorageVersion, firstUpdate)
	if err != nil || first.StorageVersion != 2 || first.Revision != 2 {
		t.Fatalf("SaveCAS(update first) = (%#v, %v)", first, err)
	}
	batchFirstUpdate := integrationConversationRecord(first.ID, 3_200, true, "First batch update")
	batchFirstUpdate.Revision = 3
	batchCreated := integrationConversationRecord("batch-created", 3_300, false, "Batch created")
	batchResult, batchErr := backend.BatchSaveCAS(ctx, ownerID, state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: batchFirstUpdate},
		{ExpectedStorageVersion: 0, Record: batchCreated},
	})
	if batchErr != nil || len(batchResult.Items) != 2 ||
		batchResult.Items[0].Status != ImageConversationCASSaved || batchResult.Items[0].Current.StorageVersion != 3 ||
		batchResult.Items[1].Status != ImageConversationCASSaved || batchResult.Items[1].Current.StorageVersion != 1 {
		t.Fatalf("BatchSaveCAS(success) = (%#v, %v)", batchResult, batchErr)
	}
	first = batchResult.Items[0].Current

	failure := integrationConversationRecord(integrationFailureConversationID, 3_500, false, "Failure row")
	failure, err = backend.SaveCAS(ctx, ownerID, state.Generation, 0, failure)
	if err != nil {
		t.Fatalf("SaveCAS(failure row) error = %v", err)
	}
	firstAttempt := integrationConversationRecord(first.ID, 4_000, true, "Must roll back")
	firstAttempt.Revision = 3
	failureAttempt := integrationConversationRecord(failure.ID, 4_100, true, "Force failure")
	failureAttempt.Revision = 2
	removeFailureConstraint := installIntegrationFailureConstraint(t, backend)
	batchResult, batchErr = backend.BatchSaveCAS(ctx, ownerID, state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: firstAttempt},
		{ExpectedStorageVersion: failure.StorageVersion, Record: failureAttempt},
	})
	removeFailureConstraint()
	if batchErr == nil {
		t.Fatalf("BatchSaveCAS(forced database error) = %#v, want error", batchResult)
	}
	rolledBack, exists, err := backend.Load(ctx, ownerID, first.ID)
	if err != nil || !exists || rolledBack.StorageVersion != first.StorageVersion || rolledBack.UpdatedAtMillis != first.UpdatedAtMillis {
		t.Fatalf("Load(first after batch rollback) = (%#v, %v, %v)", rolledBack, exists, err)
	}

	conflictAttempt := integrationConversationRecord(first.ID, 4_500, true, "Conflict rollback")
	conflictAttempt.Revision = 3
	secondAttempt := integrationConversationRecord(second.ID, 4_600, true, "Stale second")
	secondAttempt.Revision = 2
	batchResult, batchErr = backend.BatchSaveCAS(ctx, ownerID, state.Generation, []ImageConversationCASRequest{
		{ExpectedStorageVersion: first.StorageVersion, Record: conflictAttempt},
		{ExpectedStorageVersion: second.StorageVersion + 10, Record: secondAttempt},
	})
	if !errors.Is(batchErr, ErrImageConversationCASConflict) || len(batchResult.Items) != 2 ||
		batchResult.Items[0].Status != ImageConversationCASReady || batchResult.Items[1].Status != ImageConversationCASConflict {
		t.Fatalf("BatchSaveCAS(conflict) = (%#v, %v)", batchResult, batchErr)
	}
	rolledBack, _, err = backend.Load(ctx, ownerID, first.ID)
	if err != nil || rolledBack.StorageVersion != first.StorageVersion || rolledBack.UpdatedAtMillis != first.UpdatedAtMillis {
		t.Fatalf("Load(first after conflict rollback) = (%#v, %v)", rolledBack, err)
	}

	removed, err := backend.Delete(ctx, ownerID, second.ID, 5_000)
	if err != nil || !removed {
		t.Fatalf("Delete(second) = (%v, %v)", removed, err)
	}
	stateAfterDelete, err := backend.LoadOwnerState(ctx, ownerID)
	if err != nil || stateAfterDelete.Generation != 2 {
		t.Fatalf("LoadOwnerState(after delete) = (%#v, %v)", stateAfterDelete, err)
	}
	if _, err := backend.List(ctx, ownerID, state.Generation, nil, 10); !errors.Is(err, ErrImageConversationGenerationStale) {
		t.Fatalf("List(stale generation) error = %v", err)
	}
	tombstone, exists, err := backend.Load(ctx, ownerID, second.ID)
	if err != nil || !exists || tombstone.DeletedAtMillis != 5_000 || len(tombstone.Data) != 0 {
		t.Fatalf("Load(second tombstone) = (%#v, %v, %v)", tombstone, exists, err)
	}

	cleared, err := backend.Clear(ctx, ownerID, "2098-01-03T00:00:00Z", 6_000)
	if err != nil || cleared.Generation != 3 || !cleared.LegacyMigrated {
		t.Fatalf("Clear() = (%#v, %v)", cleared, err)
	}
	page, err = backend.List(ctx, ownerID, cleared.Generation, nil, 10)
	if err != nil || len(page.Records) != 0 {
		t.Fatalf("List(after clear) = (%#v, %v)", page, err)
	}
}

func integrationConversationRecord(id string, updatedAt int64, active bool, title string) ImageConversationRecord {
	data, _ := json.Marshal(map[string]any{
		"id":        id,
		"revision":  1,
		"title":     title,
		"createdAt": "2098-01-01T00:00:00Z",
		"updatedAt": "2098-01-02T00:00:00Z",
		"turns": []any{
			map[string]any{"id": "turn-1", "prompt": "integration detail", "status": "success"},
		},
	})
	summary, _ := json.Marshal(map[string]any{
		"id":                 id,
		"title":              title,
		"historySummaryOnly": true,
	})
	return ImageConversationRecord{
		ID:              id,
		Revision:        1,
		CreatedAtMillis: 500,
		UpdatedAtMillis: updatedAt,
		Active:          active,
		Summary:         summary,
		Data:            data,
	}
}

func installIntegrationFailureConstraint(t *testing.T, backend *DatabaseBackend) func() {
	t.Helper()
	dropIntegrationFailureConstraint(t, backend)
	statement := `ALTER TABLE image_conversations
		ADD CONSTRAINT chatgpt2api_test_fail_conversation_update
		CHECK (conversation_id <> 'integration-failure' OR revision <= 1)`
	if _, err := backend.db.Exec(statement); err != nil {
		t.Fatalf("install %s integration failure constraint: %v", backend.driver, err)
	}
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() { dropIntegrationFailureConstraint(t, backend) })
	}
	t.Cleanup(cleanup)
	return cleanup
}

func dropIntegrationFailureConstraint(t *testing.T, backend *DatabaseBackend) {
	t.Helper()
	statement := `ALTER TABLE image_conversations DROP CONSTRAINT IF EXISTS chatgpt2api_test_fail_conversation_update`
	if backend.driver == "mysql" {
		var count int
		if err := backend.db.QueryRow(`SELECT COUNT(*) FROM information_schema.table_constraints
			WHERE table_schema = DATABASE() AND table_name = 'image_conversations'
				AND constraint_name = 'chatgpt2api_test_fail_conversation_update' AND constraint_type = 'CHECK'`).Scan(&count); err != nil {
			t.Fatalf("inspect mysql integration failure constraint: %v", err)
		}
		if count == 0 {
			return
		}
		statement = `ALTER TABLE image_conversations DROP CHECK chatgpt2api_test_fail_conversation_update`
	}
	if _, err := backend.db.Exec(statement); err != nil {
		t.Fatalf("remove %s integration failure constraint: %v", backend.driver, err)
	}
}

func integrationRowsContain(rows []map[string]any, key, value string) bool {
	for _, row := range rows {
		if fmt.Sprint(row[key]) == value {
			return true
		}
	}
	return false
}

func integrationLongToken(driver string) string {
	return "token-" + strings.Repeat("x", 4_096) + "-" + driver
}

func integrationLongAuthKeyID(driver string) string {
	return "key-" + strings.Repeat("x", 680) + "-" + driver
}

func integrationDocumentName(driver string) string {
	return "integration/" + driver + "/settings.json"
}

func integrationOwnerID(driver string) string {
	return "integration-owner-" + driver
}
