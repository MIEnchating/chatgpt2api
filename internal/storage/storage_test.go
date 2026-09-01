package storage

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type logDeleteResult struct {
	affected int64
	err      error
}

func (r logDeleteResult) LastInsertId() (int64, error) { return 0, nil }
func (r logDeleteResult) RowsAffected() (int64, error) { return r.affected, r.err }

var _ driver.Result = logDeleteResult{}

func openSQLiteStorageTestBackend(t *testing.T, path string) *DatabaseBackend {
	t.Helper()
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func TestDatabaseBackendStoresDocumentsAndLogs(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "chatgpt2api.db")
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.db.Close()

	if err := backend.SaveAccounts([]map[string]any{{"access_token": "token-1", "type": "Plus"}}); err != nil {
		t.Fatalf("SaveAccounts() error = %v", err)
	}
	if err := backend.SaveAuthKeys([]map[string]any{{"id": "key-1", "key": "sk-test"}}); err != nil {
		t.Fatalf("SaveAuthKeys() error = %v", err)
	}
	if err := backend.SaveJSONDocument("announcements.json", []map[string]any{{"id": "a1", "content": "hello"}}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}
	if err := backend.AppendLog(map[string]any{
		"time":    "2026-04-30 10:00:00",
		"type":    "event",
		"summary": "ok",
		"detail":  map[string]any{"status": "success"},
	}); err != nil {
		t.Fatalf("AppendLog() error = %v", err)
	}
	if err := backend.AppendLog(map[string]any{
		"time":    "2026-04-29 10:00:00",
		"type":    "event",
		"summary": "skip",
	}); err != nil {
		t.Fatalf("AppendLog() error = %v", err)
	}

	accounts, err := backend.LoadAccounts()
	if err != nil {
		t.Fatalf("LoadAccounts() error = %v", err)
	}
	if len(accounts) != 1 || accounts[0]["access_token"] != "token-1" {
		t.Fatalf("LoadAccounts() = %#v", accounts)
	}

	doc, err := backend.LoadJSONDocument("announcements.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	items, ok := doc.([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("LoadJSONDocument() = %#v", doc)
	}

	logs, err := backend.QueryLogs("2026-04-30", "2026-04-30", 10)
	if err != nil {
		t.Fatalf("QueryLogs() error = %v", err)
	}
	if len(logs) != 1 || logs[0]["summary"] != "ok" {
		t.Fatalf("QueryLogs() = %#v", logs)
	}

	health := backend.HealthCheck()
	if health["document_count"] != 1 || health["log_count"] != 2 {
		t.Fatalf("HealthCheck() = %#v", health)
	}
}

func TestDeleteLogsResultPropagatesRowsAffectedError(t *testing.T) {
	wantErr := errors.New("rows affected unavailable")
	deleted, err := deletedLogRows(logDeleteResult{err: wantErr})
	if deleted != 0 || !errors.Is(err, wantErr) {
		t.Fatalf("deletedLogRows() = (%d, %v), want (0, %v)", deleted, err, wantErr)
	}
}

func TestAppendLogDoesNotMutateCallerData(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "append-log.db"))
	item := map[string]any{"time": "2026-04-30 10:00:00", "type": "caller-value", "summary": "immutable"}
	if err := backend.AppendLog(item); err != nil {
		t.Fatalf("AppendLog() error = %v", err)
	}
	if item["type"] != "caller-value" {
		t.Fatalf("AppendLog() mutated caller item: %#v", item)
	}
	logs, err := backend.QueryLogs("", "", 1)
	if err != nil || len(logs) != 1 || logs[0]["type"] != "event" {
		t.Fatalf("QueryLogs() = (%#v, %v), want normalized event", logs, err)
	}
}

func TestDatabaseBackendHealthCheckReportsCountFailure(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "health.db"))
	if _, err := backend.db.Exec(`DROP TABLE logs`); err != nil {
		t.Fatalf("drop logs table: %v", err)
	}

	health := backend.HealthCheck()
	if health["status"] != "unhealthy" || !strings.Contains(fmt.Sprint(health["error"]), "count logs rows") {
		t.Fatalf("HealthCheck() = %#v, want count failure", health)
	}
}

func TestDatabaseBackendRowCASConflictRequiresReloadBeforeRetry(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "cas-retry.db")
	first := openSQLiteStorageTestBackend(t, databasePath)
	second := openSQLiteStorageTestBackend(t, databasePath)
	seed := []map[string]any{{"access_token": "token", "type": "seed"}}
	if err := first.SaveAccounts(seed); err != nil {
		t.Fatalf("seed SaveAccounts() error = %v", err)
	}
	if _, err := first.LoadAccounts(); err != nil {
		t.Fatalf("first LoadAccounts() error = %v", err)
	}
	if _, err := second.LoadAccounts(); err != nil {
		t.Fatalf("second LoadAccounts() error = %v", err)
	}
	if err := first.SaveAccounts([]map[string]any{{"access_token": "token", "type": "first"}}); err != nil {
		t.Fatalf("first SaveAccounts() error = %v", err)
	}
	secondValue := []map[string]any{{"access_token": "token", "type": "second"}}
	if err := second.SaveAccounts(secondValue); !errors.Is(err, ErrConcurrentRowUpdate) {
		t.Fatalf("stale SaveAccounts() error = %v, want ErrConcurrentRowUpdate", err)
	}
	if err := second.SaveAccounts(secondValue); !errors.Is(err, ErrConcurrentRowUpdate) {
		t.Fatalf("second stale SaveAccounts() error = %v, want ErrConcurrentRowUpdate", err)
	}
	reloaded, err := second.LoadAccounts()
	if err != nil {
		t.Fatalf("reload accounts error = %v", err)
	}
	reloaded[0]["type"] = "second"
	if err := second.SaveAccounts(reloaded); err != nil {
		t.Fatalf("rebased SaveAccounts() error = %v", err)
	}
	items, err := first.LoadAccounts()
	if err != nil {
		t.Fatalf("final LoadAccounts() error = %v", err)
	}
	if len(items) != 1 || items[0]["type"] != "second" {
		t.Fatalf("final accounts = %#v", items)
	}
}

func TestEncodeRowsRejectsMissingAndDuplicateKeys(t *testing.T) {
	if _, err := encodeRows("accounts", []map[string]any{{"type": "Plus"}}); err == nil {
		t.Fatal("encodeRows() missing key error = nil")
	}
	if _, err := encodeRows("auth_keys", []map[string]any{{"id": "same"}, {"id": "same"}}); err == nil {
		t.Fatal("encodeRows() duplicate key error = nil")
	}
}

func TestDatabaseBackendMySQLRowCASUsesExactPredicates(t *testing.T) {
	backend := &DatabaseBackend{driver: "mysql"}
	if got := backend.rowKeyPredicate("accounts", "access_token", 0); got != "access_token_hash = SHA2(?, 256)" {
		t.Fatalf("accounts key predicate = %q", got)
	}
	if got := backend.rowKeyPredicate("auth_keys", "key_id", 0); got != "key_id = ?" {
		t.Fatalf("auth key predicate = %q", got)
	}
	if got := backend.rowDataPredicate(0); got != "BINARY data = BINARY ?" {
		t.Fatalf("data predicate = %q", got)
	}
}

func TestDatabaseBackendPostgresRowPredicatesUseNumberedArguments(t *testing.T) {
	backend := &DatabaseBackend{driver: "postgres"}
	if got := backend.rowKeyPredicate("accounts", "access_token", 1); got != "access_token = $2" {
		t.Fatalf("key predicate = %q", got)
	}
	if got := backend.rowDataPredicate(2); got != "data = $3" {
		t.Fatalf("data predicate = %q", got)
	}
}

func TestDatabaseBackendRowCASPreservesUnrelatedConcurrentUpdates(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "cas-independent.db")
	first := openSQLiteStorageTestBackend(t, databasePath)
	second := openSQLiteStorageTestBackend(t, databasePath)
	seed := []map[string]any{
		{"access_token": "token-a", "type": "seed"},
		{"access_token": "token-b", "type": "seed"},
	}
	if err := first.SaveAccounts(seed); err != nil {
		t.Fatalf("seed SaveAccounts() error = %v", err)
	}
	firstItems, err := first.LoadAccounts()
	if err != nil {
		t.Fatalf("first LoadAccounts() error = %v", err)
	}
	secondItems, err := second.LoadAccounts()
	if err != nil {
		t.Fatalf("second LoadAccounts() error = %v", err)
	}
	for _, item := range firstItems {
		if item["access_token"] == "token-a" {
			item["type"] = "first"
		}
	}
	for _, item := range secondItems {
		if item["access_token"] == "token-b" {
			item["type"] = "second"
		}
	}
	if err := first.SaveAccounts(firstItems); err != nil {
		t.Fatalf("first SaveAccounts() error = %v", err)
	}
	if err := second.SaveAccounts(secondItems); err != nil {
		t.Fatalf("second SaveAccounts() error = %v", err)
	}
	items, err := openSQLiteStorageTestBackend(t, databasePath).LoadAccounts()
	if err != nil {
		t.Fatalf("final LoadAccounts() error = %v", err)
	}
	values := map[string]any{}
	for _, item := range items {
		values[item["access_token"].(string)] = item["type"]
	}
	if values["token-a"] != "first" || values["token-b"] != "second" {
		t.Fatalf("final account values = %#v", values)
	}
}

func TestDatabaseBackendJSONDocumentCASConflictRequiresReload(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "document-cas.db")
	first := openSQLiteStorageTestBackend(t, databasePath)
	second := openSQLiteStorageTestBackend(t, databasePath)
	if err := first.SaveJSONDocument("auth_users.json", map[string]any{"version": 1}); err != nil {
		t.Fatalf("seed SaveJSONDocument() error = %v", err)
	}
	if _, err := first.LoadJSONDocument("auth_users.json"); err != nil {
		t.Fatalf("first LoadJSONDocument() error = %v", err)
	}
	if _, err := second.LoadJSONDocument("auth_users.json"); err != nil {
		t.Fatalf("second LoadJSONDocument() error = %v", err)
	}
	if err := first.SaveJSONDocument("auth_users.json", map[string]any{"version": 2}); err != nil {
		t.Fatalf("first SaveJSONDocument() error = %v", err)
	}
	if err := second.SaveJSONDocument("auth_users.json", map[string]any{"version": 3}); !errors.Is(err, ErrConcurrentRowUpdate) {
		t.Fatalf("stale SaveJSONDocument() error = %v, want ErrConcurrentRowUpdate", err)
	}
	if _, err := second.LoadJSONDocument("auth_users.json"); err != nil {
		t.Fatalf("reload LoadJSONDocument() error = %v", err)
	}
	if err := second.SaveJSONDocument("auth_users.json", map[string]any{"version": 3}); err != nil {
		t.Fatalf("rebased SaveJSONDocument() error = %v", err)
	}
	value, err := first.LoadJSONDocument("auth_users.json")
	if err != nil {
		t.Fatalf("final LoadJSONDocument() error = %v", err)
	}
	if version := value.(map[string]any)["version"]; version != json.Number("3") {
		t.Fatalf("final document version = %#v, want 3", version)
	}
}

func TestDatabaseBackendSaveAuthStateRollsBackBothWrites(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "auth-state.db")
	backend := openSQLiteStorageTestBackend(t, databasePath)
	seedKeys := []map[string]any{{"id": "session-1", "name": "before"}}
	seedDocument := map[string]any{"items": []map[string]any{{"id": "user-1", "name": "before"}}}
	if err := backend.SaveAuthKeysAndJSONDocument(seedKeys, "auth_users.json", seedDocument); err != nil {
		t.Fatalf("seed SaveAuthKeysAndJSONDocument() error = %v", err)
	}
	if _, err := backend.db.Exec(`CREATE TRIGGER fail_auth_users_update
		BEFORE UPDATE ON json_documents
		WHEN NEW.name = 'auth_users.json'
		BEGIN
			SELECT RAISE(ABORT, 'forced auth document failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	nextKeys := []map[string]any{{"id": "session-1", "name": "after"}}
	nextDocument := map[string]any{"items": []map[string]any{{"id": "user-1", "name": "after"}}}
	if err := backend.SaveAuthKeysAndJSONDocument(nextKeys, "auth_users.json", nextDocument); err == nil {
		t.Fatal("SaveAuthKeysAndJSONDocument() error = nil, want document failure")
	}
	var storedKey string
	if err := backend.db.QueryRow(`SELECT data FROM auth_keys WHERE key_id = ?`, "session-1").Scan(&storedKey); err != nil {
		t.Fatalf("read auth key after rollback: %v", err)
	}
	if !strings.Contains(storedKey, `"name":"before"`) {
		t.Fatalf("auth key was not rolled back: %s", storedKey)
	}
	storedDocument, err := backend.LoadJSONDocument("auth_users.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() after rollback error = %v", err)
	}
	encodedDocument, err := json.Marshal(storedDocument)
	if err != nil {
		t.Fatalf("marshal stored document: %v", err)
	}
	if !strings.Contains(string(encodedDocument), `"name":"before"`) {
		t.Fatalf("auth document was not rolled back: %s", encodedDocument)
	}

	if _, err := backend.db.Exec(`DROP TRIGGER fail_auth_users_update`); err != nil {
		t.Fatalf("drop failure trigger: %v", err)
	}
	if err := backend.SaveAuthKeysAndJSONDocument(nextKeys, "auth_users.json", nextDocument); err != nil {
		t.Fatalf("retry SaveAuthKeysAndJSONDocument() error = %v", err)
	}
	storedKeys, err := backend.LoadAuthKeys()
	if err != nil {
		t.Fatalf("LoadAuthKeys() after retry error = %v", err)
	}
	if len(storedKeys) != 1 || storedKeys[0]["name"] != "after" {
		t.Fatalf("stored auth keys after retry = %#v", storedKeys)
	}
}

func TestDatabaseBackendQueryLogsEmptyReturnsJSONArray(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "chatgpt2api.db")
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.db.Close()

	logs, err := backend.QueryLogs("2026-04-30", "2026-04-30", 10)
	if err != nil {
		t.Fatalf("QueryLogs() error = %v", err)
	}
	if logs == nil {
		t.Fatal("QueryLogs() returned nil slice, want empty slice")
	}
	data, err := json.Marshal(map[string]any{"items": logs})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if string(data) != `{"items":[]}` {
		t.Fatalf("marshaled logs = %s, want {\"items\":[]}", data)
	}
}

func TestDatabaseBackendPaginatesLogsAndAggregatesSummary(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "chatgpt2api.db"))
	for _, item := range []map[string]any{
		{"time": "2026-04-29 23:59:00", "summary": "old"},
		{"time": "2026-04-30 09:00:00", "summary": "middle"},
		{"time": "2026-04-30 10:00:00", "summary": "new"},
	} {
		if err := backend.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	first, err := backend.QueryLogPage("", "", nil, 2)
	if err != nil {
		t.Fatalf("QueryLogPage(first) error = %v", err)
	}
	if got := []any{first.Records[0].Item["summary"], first.Records[1].Item["summary"]}; !reflect.DeepEqual(got, []any{"new", "middle"}) || first.NextCursor == nil {
		t.Fatalf("QueryLogPage(first) = %#v", first)
	}
	if first.NextCursor.SnapshotID != 3 || first.Records[0].Cursor.SnapshotID != 3 || first.Records[1].Cursor != *first.NextCursor {
		t.Fatalf("QueryLogPage(first) cursors = %#v", first)
	}
	second, err := backend.QueryLogPage("", "", first.NextCursor, 2)
	if err != nil {
		t.Fatalf("QueryLogPage(second) error = %v", err)
	}
	if len(second.Records) != 1 || second.Records[0].Item["summary"] != "old" || second.NextCursor != nil {
		t.Fatalf("QueryLogPage(second) = %#v", second)
	}
	total, oldest, latest, err := backend.LogSummary()
	if err != nil || total != 3 || oldest != "2026-04-29 23:59:00" || latest != "2026-04-30 10:00:00" {
		t.Fatalf("LogSummary() = (%d, %q, %q, %v)", total, oldest, latest, err)
	}
	var plan string
	if err := backend.db.QueryRow(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM logs`).Scan(new(int), new(int), new(int), &plan); err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	if !strings.Contains(plan, "COVERING INDEX idx_logs_created_at") {
		t.Fatalf("log summary query plan = %q", plan)
	}
}

func TestDatabaseBackendLogCursorExcludesLaterBackfilledRows(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "chatgpt2api.db"))
	for _, item := range []map[string]any{
		{"time": "2026-04-30 10:00:00", "summary": "first"},
		{"time": "2026-04-29 10:00:00", "summary": "second"},
	} {
		if err := backend.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	first, err := backend.QueryLogPage("", "", nil, 1)
	if err != nil || len(first.Records) != 1 || first.NextCursor == nil {
		t.Fatalf("QueryLogPage(first) = (%#v, %v)", first, err)
	}
	if err := backend.AppendLog(map[string]any{"time": "2020-01-01 00:00:00", "summary": "backfilled later"}); err != nil {
		t.Fatalf("AppendLog(backfill) error = %v", err)
	}
	replayed, err := backend.QueryLogPage("", "", &LogCursor{SnapshotID: first.SnapshotID}, 1)
	if err != nil || len(replayed.Records) != 1 || replayed.Records[0].Item["summary"] != "first" {
		t.Fatalf("QueryLogPage(snapshot start) = (%#v, %v)", replayed, err)
	}

	second, err := backend.QueryLogPage("", "", first.NextCursor, 10)
	if err != nil {
		t.Fatalf("QueryLogPage(second) error = %v", err)
	}
	if len(second.Records) != 1 || second.Records[0].Item["summary"] != "second" || second.NextCursor != nil {
		t.Fatalf("QueryLogPage(second) = %#v, want only snapshot row", second)
	}
}

func TestDatabaseBackendListsDocumentPrefixWithIndexRange(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "chatgpt2api.db"))
	for name, value := range map[string]any{
		"my_assets/a.json":        map[string]any{"id": "a"},
		"my_assets/b.json":        map[string]any{"id": "b"},
		"myXassets/wildcard.json": map[string]any{"id": "wrong"},
	} {
		if err := backend.SaveJSONDocument(name, value); err != nil {
			t.Fatalf("SaveJSONDocument(%q) error = %v", name, err)
		}
	}
	documents, err := backend.ListJSONDocuments("my_assets/")
	if err != nil || len(documents) != 2 || documents["my_assets/a.json"] == nil || documents["my_assets/b.json"] == nil {
		t.Fatalf("ListJSONDocuments() = %#v, error = %v", documents, err)
	}
	var plan string
	if err := backend.db.QueryRow(`EXPLAIN QUERY PLAN SELECT name, data FROM json_documents
		WHERE name >= ? AND name < ? ORDER BY name`, "my_assets/", documentPrefixUpperBound("my_assets/")).Scan(new(int), new(int), new(int), &plan); err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	if !strings.Contains(plan, "name>? AND name<?") {
		t.Fatalf("document prefix query plan = %q", plan)
	}
}

func TestDatabaseBackendListJSONDocumentsRejectsCorruptDocument(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "chatgpt2api.db"))
	name := "my_assets/corrupt.json"
	if _, err := backend.db.Exec(`INSERT INTO json_documents (name, data, updated_at) VALUES (?, ?, ?)`, name, "{invalid", "2026-04-30T10:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.ListJSONDocuments("my_assets/"); err == nil || !strings.Contains(err.Error(), name) {
		t.Fatalf("ListJSONDocuments() error = %v, want document name context", err)
	}
}

func TestDatabaseBackendLogQueriesRejectCorruptRows(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "chatgpt2api.db"))
	result, err := backend.db.Exec(`INSERT INTO logs (created_at, type, day, data) VALUES (?, ?, ?, ?)`, "2026-04-30 10:00:00", "event", "2026-04-30", "{invalid")
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func() error{
		"QueryLogs": func() error {
			_, err := backend.QueryLogs("", "", 10)
			return err
		},
		"QueryLogPage": func() error {
			_, err := backend.QueryLogPage("", "", nil, 10)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := run()
			if err == nil || !strings.Contains(err.Error(), fmt.Sprint(id)) {
				t.Fatalf("error = %v, want log row ID %d", err, id)
			}
		})
	}
}

func TestDatabaseBackendDeletesLogsBeforeDay(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "chatgpt2api.db")
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.db.Close()

	for _, item := range []map[string]any{
		{"time": "2026-04-28 10:00:00", "type": "event", "summary": "old"},
		{"time": "2026-04-29 10:00:00", "type": "event", "summary": "cutoff"},
		{"time": "2026-04-30 10:00:00", "type": "event", "summary": "new"},
	} {
		if err := backend.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	deleted, err := backend.DeleteLogsBefore("2026-04-29")
	if err != nil {
		t.Fatalf("DeleteLogsBefore() error = %v", err)
	}
	if deleted != 1 {
		t.Fatalf("DeleteLogsBefore() deleted = %d, want 1", deleted)
	}
	logs, err := backend.QueryLogs("", "", 0)
	if err != nil {
		t.Fatalf("QueryLogs() error = %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("remaining logs = %#v, want 2", logs)
	}
}

func TestNewBackendFromEnvDefaultsToSQLiteProjectDatabase(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("STORAGE_BACKEND", "")
	t.Setenv("STORAGE_DATABASE_URL", "")

	backend, err := NewBackendFromEnv(dir)
	if err != nil {
		t.Fatalf("NewBackendFromEnv() error = %v", err)
	}
	database, ok := backend.(*DatabaseBackend)
	if !ok {
		t.Fatalf("NewBackendFromEnv() returned %T, want *DatabaseBackend", backend)
	}
	defer database.db.Close()
	if database.driver != "sqlite" {
		t.Fatalf("driver = %q, want sqlite", database.driver)
	}
	want := filepath.ToSlash(filepath.Join(dir, "chatgpt2api.db"))
	if database.dsn != want {
		t.Fatalf("dsn = %q, want %q", database.dsn, want)
	}
}

func TestNewBackendFromEnvIgnoresRemovedStorageNamesAndUpstreamURL(t *testing.T) {
	dir := t.TempDir()
	unsetStorageEnv(t, "STORAGE_BACKEND")
	unsetStorageEnv(t, "STORAGE_DATABASE_URL")
	t.Setenv("CHATGPT2API_STORAGE_BACKEND", "sqlite")
	removedDatabasePath := filepath.Join(dir, "removed.db")
	t.Setenv("CHATGPT2API_STORAGE_DATABASE_URL", "sqlite:///"+filepath.ToSlash(removedDatabasePath))
	t.Setenv("DATABASE_URL", "sqlite:///"+filepath.ToSlash(filepath.Join(dir, "upstream.db")))

	backend, err := NewBackendFromEnv(dir)
	if err != nil {
		t.Fatalf("NewBackendFromEnv() error = %v", err)
	}
	database, ok := backend.(*DatabaseBackend)
	if !ok {
		t.Fatalf("NewBackendFromEnv() returned %T, want *DatabaseBackend", backend)
	}
	defer database.db.Close()
	want := filepath.ToSlash(filepath.Join(dir, "chatgpt2api.db"))
	if database.driver != "sqlite" || database.dsn != want {
		t.Fatalf("database = (%q, %q), want current default SQLite path %q", database.driver, database.dsn, want)
	}
}

func TestNewBackendFromEnvRejectsJSONBackend(t *testing.T) {
	t.Setenv("STORAGE_BACKEND", "json")
	t.Setenv("STORAGE_DATABASE_URL", "")

	_, err := NewBackendFromEnv(t.TempDir())
	if err == nil {
		t.Fatal("NewBackendFromEnv() succeeded, want error")
	}
	if !strings.Contains(err.Error(), "unknown storage backend: json") {
		t.Fatalf("NewBackendFromEnv() error = %v", err)
	}
}

func TestNewBackendFromEnvRequiresDatabaseURLForRemoteBackend(t *testing.T) {
	for _, backendType := range []string{"postgres", "postgresql", "mysql", "database"} {
		t.Run(backendType, func(t *testing.T) {
			t.Setenv("STORAGE_BACKEND", backendType)
			t.Setenv("STORAGE_DATABASE_URL", "")

			_, err := NewBackendFromEnv(t.TempDir())
			if err == nil || !strings.Contains(err.Error(), "STORAGE_DATABASE_URL is required") {
				t.Fatalf("NewBackendFromEnv() error = %v, want missing STORAGE_DATABASE_URL error", err)
			}
		})
	}
}

func TestParseDatabaseURLRejectsEmptyAndUnsupportedURL(t *testing.T) {
	for _, databaseURL := range []string{"", "   ", "mongodb://db.internal/chatgpt2api", "https://db.internal/chatgpt2api"} {
		if _, _, err := ParseDatabaseURL(databaseURL); err == nil {
			t.Fatalf("ParseDatabaseURL(%q) succeeded, want error", databaseURL)
		}
	}
}

func TestParseDatabaseURLAcceptsCaseInsensitiveSQLiteScheme(t *testing.T) {
	driver, dsn, err := ParseDatabaseURL("  SQLite:////app/data/chatgpt2api.db  ")
	if err != nil {
		t.Fatalf("ParseDatabaseURL() error = %v", err)
	}
	if driver != "sqlite" || dsn != "/app/data/chatgpt2api.db" {
		t.Fatalf("ParseDatabaseURL() = (%q, %q), want sqlite absolute path", driver, dsn)
	}
}

func unsetStorageEnv(t *testing.T, key string) {
	t.Helper()
	original, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("Unsetenv(%s): %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, original)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func TestParseDatabaseURLNormalizesPostgreSQLScheme(t *testing.T) {
	driver, dsn, err := ParseDatabaseURL("  PostgreSQL://app:p%40ss@db.internal:5432/chatgpt2api?sslmode=disable  ")
	if err != nil {
		t.Fatalf("ParseDatabaseURL() error = %v", err)
	}
	if driver != "postgres" || dsn != "postgresql://app:p%40ss@db.internal:5432/chatgpt2api?sslmode=disable" {
		t.Fatalf("ParseDatabaseURL() = (%q, %q), want normalized PostgreSQL URL", driver, dsn)
	}
}

func TestParseMySQLDatabaseURLPreservesConnectionOptions(t *testing.T) {
	driver, dsn, err := ParseDatabaseURL("mysql://app:p%40ss@db.internal:3307/chatgpt2api?tls=true&timeout=5s&parseTime=false")
	if err != nil {
		t.Fatalf("ParseDatabaseURL() error = %v", err)
	}
	if driver != "mysql" {
		t.Fatalf("driver = %q, want mysql", driver)
	}
	want := "app:p@ss@tcp(db.internal:3307)/chatgpt2api?parseTime=true&timeout=5s&tls=true"
	if dsn != want {
		t.Fatalf("dsn = %q, want %q", dsn, want)
	}
}

func TestParseMySQLDatabaseURLRequiresCompleteAddress(t *testing.T) {
	for _, databaseURL := range []string{
		"mysql://db.internal/chatgpt2api",
		"mysql://app@/chatgpt2api",
		"mysql://app@db.internal/",
	} {
		if _, _, err := ParseDatabaseURL(databaseURL); err == nil {
			t.Fatalf("ParseDatabaseURL(%q) succeeded, want error", databaseURL)
		}
	}
}

func TestDocumentNameValidation(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "chatgpt2api.db")
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.db.Close()

	for _, name := range []string{"../x.json", "/x.json", "a/../x.json", "C:/x.json"} {
		t.Run(name, func(t *testing.T) {
			if err := backend.SaveJSONDocument(name, map[string]any{}); err == nil {
				t.Fatalf("SaveJSONDocument(%q) succeeded, want error", name)
			}
		})
	}
}
