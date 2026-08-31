package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	mysqlDriver "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	_ "modernc.org/sqlite"
)

type Backend interface {
	LoadAccounts() ([]map[string]any, error)
	SaveAccounts([]map[string]any) error
	LoadAuthKeys() ([]map[string]any, error)
	SaveAuthKeys([]map[string]any) error
	HealthCheck() map[string]any
	Info() map[string]any
}

type JSONDocumentBackend interface {
	LoadJSONDocument(name string) (any, error)
	SaveJSONDocument(name string, value any) error
	DeleteJSONDocument(name string) error
}

type AuthStateBackend interface {
	SaveAuthKeysAndJSONDocument(keys []map[string]any, name string, value any) error
}

type JSONDocumentPrefixBackend interface {
	ListJSONDocuments(prefix string) (map[string]any, error)
}

type LogBackend interface {
	AppendLog(item map[string]any) error
	QueryLogs(startDate, endDate string, limit int) ([]map[string]any, error)
}

type LogCursor struct {
	Day string
	ID  int64
}

type LogPage struct {
	Items      []map[string]any
	NextCursor *LogCursor
}

type LogPageBackend interface {
	QueryLogPage(startDate, endDate string, cursor *LogCursor, limit int) (LogPage, error)
}

type LogSummaryBackend interface {
	LogSummary() (total int, oldestTime, latestTime string, err error)
}

type LogMaintenanceBackend interface {
	DeleteLogsBefore(day string) (int, error)
}

func NewBackendFromEnv(dataDir string) (Backend, error) {
	backendType := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	if backendType == "" {
		backendType = "sqlite"
	}
	switch backendType {
	case "sqlite", "postgres", "postgresql", "mysql", "database":
		dsn := strings.TrimSpace(os.Getenv("STORAGE_DATABASE_URL"))
		if dsn == "" {
			if backendType != "sqlite" {
				return nil, fmt.Errorf("STORAGE_DATABASE_URL is required for %s storage", backendType)
			}
			dsn = "sqlite:///" + filepath.ToSlash(filepath.Join(dataDir, "chatgpt2api.db"))
		}
		return NewDatabaseBackend(dsn)
	default:
		return nil, fmt.Errorf("unknown storage backend: %s", backendType)
	}
}

type DatabaseBackend struct {
	databaseURL       string
	driver            string
	dsn               string
	db                *sql.DB
	stateMu           sync.Mutex
	rowSnapshots      map[string]map[string]string
	documentSnapshots map[string]jsonDocumentSnapshot
}

type jsonDocumentSnapshot struct {
	Data   string
	Exists bool
}

var ErrConcurrentRowUpdate = errors.New("storage row changed concurrently")

func NewDatabaseBackend(databaseURL string) (*DatabaseBackend, error) {
	driver, dsn, err := ParseDatabaseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	backend := &DatabaseBackend{
		databaseURL:       databaseURL,
		driver:            driver,
		dsn:               dsn,
		db:                db,
		rowSnapshots:      make(map[string]map[string]string),
		documentSnapshots: make(map[string]jsonDocumentSnapshot),
	}
	backend.configurePool()
	if err := backend.configureSQLite(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := backend.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return backend, nil
}

func (b *DatabaseBackend) configurePool() {
	b.db.SetConnMaxLifetime(time.Hour)
	if b.driver == "sqlite" {
		b.db.SetMaxOpenConns(1)
		b.db.SetMaxIdleConns(1)
		return
	}
	b.db.SetMaxOpenConns(10)
	b.db.SetMaxIdleConns(5)
}

func (b *DatabaseBackend) Close() error {
	if b == nil || b.db == nil {
		return nil
	}
	return b.db.Close()
}

func (b *DatabaseBackend) configureSQLite() error {
	if b.driver != "sqlite" {
		return nil
	}
	for _, stmt := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=NORMAL`,
		`PRAGMA busy_timeout=5000`,
		`PRAGMA temp_store=MEMORY`,
		`PRAGMA foreign_keys=ON`,
	} {
		if _, err := b.db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

func (b *DatabaseBackend) init() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, access_token TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS auth_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS json_documents (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, type TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_logs_day_id ON logs (day, id)`,
		`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at)`,
		`CREATE TABLE IF NOT EXISTS storage_objects (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, bucket TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, direct BOOLEAN NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_objects_created_by ON storage_objects (created_by)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_objects_provider_mime ON storage_objects (provider_id, mime_type)`,
	}
	if b.driver == "postgres" {
		schema = []string{
			`CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, access_token TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS auth_keys (id SERIAL PRIMARY KEY, key_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS json_documents (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS logs (id SERIAL PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL)`,
			`CREATE INDEX IF NOT EXISTS idx_logs_day_id ON logs (day, id)`,
			`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at)`,
			`CREATE TABLE IF NOT EXISTS storage_objects (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, bucket TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL, mime_type TEXT NOT NULL, bytes BIGINT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, direct BOOLEAN NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT NOT NULL)`,
			`CREATE INDEX IF NOT EXISTS idx_storage_objects_created_by ON storage_objects (created_by)`,
			`CREATE INDEX IF NOT EXISTS idx_storage_objects_provider_mime ON storage_objects (provider_id, mime_type)`,
		}
	}
	if b.driver == "mysql" {
		schema = []string{
			`CREATE TABLE IF NOT EXISTS accounts (
				id INTEGER PRIMARY KEY AUTO_INCREMENT,
				access_token LONGTEXT NOT NULL,
				access_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (SHA2(access_token, 256)) STORED,
				data LONGTEXT NOT NULL,
				UNIQUE KEY uq_accounts_access_token_hash (access_token_hash)
			)`,
			`CREATE TABLE IF NOT EXISTS auth_keys (id INTEGER PRIMARY KEY AUTO_INCREMENT, key_id VARCHAR(768) CHARACTER SET ascii COLLATE ascii_bin UNIQUE NOT NULL, data LONGTEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS json_documents (name VARCHAR(512) PRIMARY KEY, data LONGTEXT NOT NULL, updated_at TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTO_INCREMENT, created_at TEXT NOT NULL, type VARCHAR(64) NOT NULL, day VARCHAR(10) NOT NULL, data LONGTEXT NOT NULL)`,
			`CREATE INDEX idx_logs_day_id ON logs (day, id)`,
			`CREATE INDEX idx_logs_created_at ON logs (created_at(64))`,
			`CREATE TABLE IF NOT EXISTS storage_objects (
				id VARCHAR(64) PRIMARY KEY,
				provider_id VARCHAR(128) NOT NULL,
				bucket VARCHAR(512) NOT NULL,
				object_key VARCHAR(1024) NOT NULL,
				object_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (SHA2(object_key, 256)) STORED,
				public_url LONGTEXT NOT NULL,
				mime_type VARCHAR(255) NOT NULL,
				bytes BIGINT NOT NULL,
				width INTEGER NOT NULL,
				height INTEGER NOT NULL,
				sha256 VARCHAR(64) NOT NULL,
				direct BOOLEAN NOT NULL,
				created_by VARCHAR(255) NOT NULL,
				created_at TEXT NOT NULL,
				deleted_at TEXT NOT NULL,
				UNIQUE KEY uq_storage_objects_object_key_hash (object_key_hash)
			)`,
			`CREATE INDEX idx_storage_objects_created_by ON storage_objects (created_by)`,
			`CREATE INDEX idx_storage_objects_provider_mime ON storage_objects (provider_id, mime_type)`,
		}
	}
	for _, stmt := range schema {
		if _, err := b.db.Exec(stmt); err != nil {
			var mysqlError *mysqlDriver.MySQLError
			if b.driver == "mysql" && errors.As(err, &mysqlError) && mysqlError.Number == 1061 {
				continue
			}
			return err
		}
	}
	if err := b.ensureMySQLAccountAccessTokenHash(); err != nil {
		return err
	}
	return b.initImageConversationSchema()
}

func (b *DatabaseBackend) ensureMySQLAccountAccessTokenHash() error {
	if b.driver != "mysql" {
		return nil
	}
	var columnCount int
	if err := b.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'accounts' AND column_name = 'access_token_hash'`).Scan(&columnCount); err != nil {
		return fmt.Errorf("inspect MySQL account token hash column: %w", err)
	}
	if columnCount == 0 {
		if _, err := b.db.Exec(`ALTER TABLE accounts ADD COLUMN access_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (SHA2(access_token, 256)) STORED`); err != nil {
			return fmt.Errorf("add MySQL account token hash column: %w", err)
		}
	}
	var indexCount int
	if err := b.db.QueryRow(`SELECT COUNT(*) FROM information_schema.statistics
		WHERE table_schema = DATABASE() AND table_name = 'accounts' AND index_name = 'uq_accounts_access_token_hash'`).Scan(&indexCount); err != nil {
		return fmt.Errorf("inspect MySQL account token hash index: %w", err)
	}
	if indexCount == 0 {
		if _, err := b.db.Exec(`CREATE UNIQUE INDEX uq_accounts_access_token_hash ON accounts (access_token_hash)`); err != nil {
			return fmt.Errorf("create MySQL account token hash index: %w", err)
		}
	}
	return nil
}

func (b *DatabaseBackend) LoadAccounts() ([]map[string]any, error) {
	return b.loadRows("accounts", "access_token")
}

func (b *DatabaseBackend) SaveAccounts(accounts []map[string]any) error {
	return b.saveRows("accounts", "access_token", accounts)
}

func (b *DatabaseBackend) LoadAuthKeys() ([]map[string]any, error) {
	return b.loadRows("auth_keys", "key_id")
}

func (b *DatabaseBackend) SaveAuthKeys(keys []map[string]any) error {
	return b.saveRows("auth_keys", "key_id", keys)
}

func (b *DatabaseBackend) HealthCheck() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.db.PingContext(ctx); err != nil {
		return map[string]any{"status": "unhealthy", "backend": "database", "error": err.Error()}
	}
	counts := make(map[string]int, 4)
	for _, item := range []struct {
		outputField string
		table       string
	}{
		{outputField: "account_count", table: "accounts"},
		{outputField: "auth_key_count", table: "auth_keys"},
		{outputField: "document_count", table: "json_documents"},
		{outputField: "log_count", table: "logs"},
	} {
		count, err := b.count(ctx, item.table)
		if err != nil {
			return map[string]any{"status": "unhealthy", "backend": "database", "error": err.Error()}
		}
		counts[item.outputField] = count
	}
	return map[string]any{
		"status":         "healthy",
		"backend":        "database",
		"database_url":   maskPassword(b.databaseURL),
		"account_count":  counts["account_count"],
		"auth_key_count": counts["auth_key_count"],
		"document_count": counts["document_count"],
		"log_count":      counts["log_count"],
	}
}

func (b *DatabaseBackend) Info() map[string]any {
	dbType := "unknown"
	switch b.driver {
	case "sqlite":
		dbType = "sqlite"
	case "postgres":
		dbType = "postgresql"
	case "mysql":
		dbType = "mysql"
	}
	return map[string]any{"type": "database", "db_type": dbType, "description": "数据库存储 (" + dbType + ")", "database_url": maskPassword(b.databaseURL)}
}

func (b *DatabaseBackend) loadRows(table, keyColumn string) ([]map[string]any, error) {
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	rows, err := b.db.Query("SELECT " + keyColumn + ", data FROM " + table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	snapshot := make(map[string]string)
	for rows.Next() {
		var key string
		var text string
		if err := rows.Scan(&key, &text); err != nil {
			return nil, err
		}
		var item map[string]any
		if err := json.Unmarshal([]byte(text), &item); err != nil {
			return nil, fmt.Errorf("decode %s row %q: %w", table, key, err)
		}
		if item == nil {
			return nil, fmt.Errorf("decode %s row %q: expected JSON object", table, key)
		}
		out = append(out, item)
		snapshot[key] = text
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	b.rowSnapshots[table] = snapshot
	return out, nil
}

func (b *DatabaseBackend) saveRows(table, keyColumn string, items []map[string]any) error {
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	current, err := encodeRows(table, items)
	if err != nil {
		return err
	}
	known := b.rowSnapshots[table]
	if known == nil {
		known = map[string]string{}
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if err := b.applyRows(tx, table, keyColumn, known, current); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	b.rowSnapshots[table] = current
	return nil
}

func encodeRows(table string, items []map[string]any) (map[string]string, error) {
	sourceKey := "access_token"
	if table == "auth_keys" {
		sourceKey = "id"
	}
	current := make(map[string]string, len(items))
	for _, item := range items {
		rawKey, ok := item[sourceKey]
		if !ok || rawKey == nil {
			return nil, fmt.Errorf("encode %s row: %s is required", table, sourceKey)
		}
		key := strings.TrimSpace(fmt.Sprint(rawKey))
		if key == "" {
			return nil, fmt.Errorf("encode %s row: %s is required", table, sourceKey)
		}
		if _, exists := current[key]; exists {
			return nil, fmt.Errorf("encode %s row %q: duplicate key", table, key)
		}
		data, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		current[key] = string(data)
	}
	return current, nil
}

func (b *DatabaseBackend) applyRows(tx *sql.Tx, table, keyColumn string, known, current map[string]string) error {
	for key, data := range current {
		previous, existed := known[key]
		if existed && previous == data {
			continue
		}
		if !existed {
			query := "INSERT INTO " + table + " (" + keyColumn + ", data) VALUES (?, ?)"
			if b.driver == "postgres" {
				query = "INSERT INTO " + table + " (" + keyColumn + ", data) VALUES ($1, $2)"
			}
			if _, err := tx.Exec(query, key, data); err != nil {
				return b.classifyRowInsertError(tx, table, keyColumn, key, err)
			}
			continue
		}
		query := "UPDATE " + table + " SET data = ? WHERE " + b.rowKeyPredicate(table, keyColumn, 1) + " AND " + b.rowDataPredicate(2)
		args := []any{data, key, previous}
		if b.driver == "postgres" {
			query = "UPDATE " + table + " SET data = $1 WHERE " + keyColumn + " = $2 AND data = $3"
		}
		result, err := tx.Exec(query, args...)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return b.concurrentRowUpdateError(tx, table, keyColumn, "update", key)
		}
	}
	for key, previous := range known {
		if _, exists := current[key]; exists {
			continue
		}
		query := "DELETE FROM " + table + " WHERE " + b.rowKeyPredicate(table, keyColumn, 0) + " AND " + b.rowDataPredicate(1)
		if b.driver == "postgres" {
			query = "DELETE FROM " + table + " WHERE " + keyColumn + " = $1 AND data = $2"
		}
		result, err := tx.Exec(query, key, previous)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return b.concurrentRowUpdateError(tx, table, keyColumn, "delete", key)
		}
	}
	return nil
}

func (b *DatabaseBackend) SaveAuthKeysAndJSONDocument(keys []map[string]any, name string, value any) error {
	rel, err := cleanDocumentName(name)
	if err != nil {
		return err
	}
	documentData, err := json.Marshal(value)
	if err != nil {
		return err
	}
	current, err := encodeRows("auth_keys", keys)
	if err != nil {
		return err
	}

	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	known := b.rowSnapshots["auth_keys"]
	if known == nil {
		known = map[string]string{}
	}
	knownDocument, err := b.jsonDocumentSnapshotLocked(rel)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if err := b.applyRows(tx, "auth_keys", "key_id", known, current); err != nil {
		return err
	}
	documentText := string(documentData)
	if err := b.applyJSONDocument(tx, rel, knownDocument, documentText, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	b.rowSnapshots["auth_keys"] = current
	b.documentSnapshots[rel] = jsonDocumentSnapshot{Data: documentText, Exists: true}
	return nil
}

func (b *DatabaseBackend) classifyRowInsertError(tx *sql.Tx, table, keyColumn, key string, insertErr error) error {
	_ = tx.Rollback()
	exists, inspectErr := b.rowExists(table, keyColumn, key)
	if inspectErr != nil {
		return fmt.Errorf("insert %s row %q: %w (inspect row: %v)", table, key, insertErr, inspectErr)
	}
	if !exists {
		return insertErr
	}
	return fmt.Errorf("%w: insert %s row %q", ErrConcurrentRowUpdate, table, key)
}

func (b *DatabaseBackend) concurrentRowUpdateError(tx *sql.Tx, table, keyColumn, operation, key string) error {
	_ = tx.Rollback()
	return fmt.Errorf("%w: %s %s row %q", ErrConcurrentRowUpdate, operation, table, key)
}

func (b *DatabaseBackend) rowExists(table, keyColumn, key string) (bool, error) {
	query := "SELECT 1 FROM " + table + " WHERE " + b.rowKeyPredicate(table, keyColumn, 0)
	if b.driver == "postgres" {
		query = "SELECT 1 FROM " + table + " WHERE " + keyColumn + " = $1"
	}
	var marker int
	err := b.db.QueryRow(query, key).Scan(&marker)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (b *DatabaseBackend) rowKeyPredicate(table, keyColumn string, argumentIndex int) string {
	placeholder := "?"
	if b.driver == "postgres" {
		placeholder = fmt.Sprintf("$%d", argumentIndex+1)
	}
	if b.driver == "mysql" && table == "accounts" && keyColumn == "access_token" {
		return "access_token_hash = SHA2(" + placeholder + ", 256)"
	}
	return keyColumn + " = " + placeholder
}

func (b *DatabaseBackend) rowDataPredicate(argumentIndex int) string {
	placeholder := "?"
	if b.driver == "postgres" {
		placeholder = fmt.Sprintf("$%d", argumentIndex+1)
	}
	if b.driver == "mysql" {
		return "BINARY data = BINARY " + placeholder
	}
	return "data = " + placeholder
}

func (b *DatabaseBackend) count(ctx context.Context, table string) (int, error) {
	var count int
	if err := b.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		return 0, fmt.Errorf("count %s rows: %w", table, err)
	}
	return count, nil
}

func (b *DatabaseBackend) LoadJSONDocument(name string) (any, error) {
	rel, err := cleanDocumentName(name)
	if err != nil {
		return nil, err
	}
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	snapshot, err := b.readJSONDocumentSnapshot(rel)
	if err != nil {
		return nil, err
	}
	if !snapshot.Exists {
		b.documentSnapshots[rel] = snapshot
		return nil, nil
	}
	value, err := decodeJSONString(snapshot.Data)
	if err != nil {
		return nil, err
	}
	b.documentSnapshots[rel] = snapshot
	return value, nil
}

func (b *DatabaseBackend) SaveJSONDocument(name string, value any) error {
	rel, err := cleanDocumentName(name)
	if err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	known, err := b.jsonDocumentSnapshotLocked(rel)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	text := string(data)
	if err := b.applyJSONDocument(tx, rel, known, text, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	b.documentSnapshots[rel] = jsonDocumentSnapshot{Data: text, Exists: true}
	return nil
}

func (b *DatabaseBackend) DeleteJSONDocument(name string) error {
	rel, err := cleanDocumentName(name)
	if err != nil {
		return err
	}
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	known, err := b.jsonDocumentSnapshotLocked(rel)
	if err != nil {
		return err
	}
	if !known.Exists {
		return nil
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	query := "DELETE FROM json_documents WHERE name = ? AND data = ?"
	args := []any{rel, known.Data}
	if b.driver == "postgres" {
		query = "DELETE FROM json_documents WHERE name = $1 AND data = $2"
	} else if b.driver == "mysql" {
		query = "DELETE FROM json_documents WHERE name = ? AND BINARY data = BINARY ?"
	}
	result, err := tx.Exec(query, args...)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return b.concurrentRowUpdateError(tx, "json_documents", "name", "delete", rel)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	b.documentSnapshots[rel] = jsonDocumentSnapshot{}
	return nil
}

func (b *DatabaseBackend) jsonDocumentSnapshotLocked(name string) (jsonDocumentSnapshot, error) {
	if snapshot, ok := b.documentSnapshots[name]; ok {
		return snapshot, nil
	}
	snapshot, err := b.readJSONDocumentSnapshot(name)
	if err != nil {
		return jsonDocumentSnapshot{}, err
	}
	b.documentSnapshots[name] = snapshot
	return snapshot, nil
}

func (b *DatabaseBackend) readJSONDocumentSnapshot(name string) (jsonDocumentSnapshot, error) {
	var text string
	err := b.db.QueryRow("SELECT data FROM json_documents WHERE name = "+b.placeholder(1), name).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return jsonDocumentSnapshot{}, nil
	}
	if err != nil {
		return jsonDocumentSnapshot{}, err
	}
	return jsonDocumentSnapshot{Data: text, Exists: true}, nil
}

func (b *DatabaseBackend) applyJSONDocument(tx *sql.Tx, name string, known jsonDocumentSnapshot, data, updatedAt string) error {
	if !known.Exists {
		query := "INSERT INTO json_documents (name, data, updated_at) VALUES (?, ?, ?)"
		if b.driver == "postgres" {
			query = "INSERT INTO json_documents (name, data, updated_at) VALUES ($1, $2, $3)"
		}
		if _, err := tx.Exec(query, name, data, updatedAt); err != nil {
			return b.classifyRowInsertError(tx, "json_documents", "name", name, err)
		}
		return nil
	}
	query := "UPDATE json_documents SET data = ?, updated_at = ? WHERE name = ? AND data = ?"
	args := []any{data, updatedAt, name, known.Data}
	if b.driver == "postgres" {
		query = "UPDATE json_documents SET data = $1, updated_at = $2 WHERE name = $3 AND data = $4"
	} else if b.driver == "mysql" {
		query = "UPDATE json_documents SET data = ?, updated_at = ? WHERE name = ? AND BINARY data = BINARY ?"
	}
	result, err := tx.Exec(query, args...)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return b.concurrentRowUpdateError(tx, "json_documents", "name", "update", name)
	}
	return nil
}

func (b *DatabaseBackend) ListJSONDocuments(prefix string) (map[string]any, error) {
	prefix = filepath.ToSlash(strings.TrimSpace(prefix))
	if prefix == "" || strings.HasPrefix(prefix, "/") || strings.Contains(prefix, "..") {
		return nil, errors.New("invalid document prefix")
	}
	upper := documentPrefixUpperBound(prefix)
	rows, err := b.db.Query("SELECT name, data FROM json_documents WHERE name >= "+b.placeholder(1)+" AND name < "+b.placeholder(2)+" ORDER BY name", prefix, upper)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]any)
	for rows.Next() {
		var name, text string
		if err := rows.Scan(&name, &text); err != nil {
			return nil, err
		}
		value, err := decodeJSONString(text)
		if err != nil {
			return nil, fmt.Errorf("decode JSON document %q: %w", name, err)
		}
		out[name] = value
	}
	return out, rows.Err()
}

func documentPrefixUpperBound(prefix string) string {
	runes := []rune(prefix)
	for index := len(runes) - 1; index >= 0; index-- {
		if runes[index] < utf8.MaxRune {
			runes[index]++
			return string(runes[:index+1])
		}
	}
	return prefix + string(utf8.MaxRune)
}

func (b *DatabaseBackend) AppendLog(item map[string]any) error {
	if item == nil {
		item = map[string]any{}
	}
	item["type"] = "event"
	data, err := json.Marshal(item)
	if err != nil {
		return err
	}
	createdAt := strings.TrimSpace(fmt.Sprint(item["time"]))
	if createdAt == "" {
		createdAt = time.Now().Format("2006-01-02 15:04:05")
	}
	logType := "event"
	day := logDay(createdAt)
	if day == "" {
		day = time.Now().Format("2006-01-02")
	}
	_, err = b.db.Exec(
		"INSERT INTO logs (created_at, type, day, data) VALUES ("+b.placeholder(1)+", "+b.placeholder(2)+", "+b.placeholder(3)+", "+b.placeholder(4)+")",
		createdAt,
		logType,
		day,
		string(data),
	)
	return err
}

func (b *DatabaseBackend) QueryLogs(startDate, endDate string, limit int) ([]map[string]any, error) {
	query := "SELECT id, data FROM logs"
	var filters []string
	var args []any
	if strings.TrimSpace(startDate) != "" {
		args = append(args, strings.TrimSpace(startDate))
		filters = append(filters, "day >= "+b.placeholder(len(args)))
	}
	if strings.TrimSpace(endDate) != "" {
		args = append(args, strings.TrimSpace(endDate))
		filters = append(filters, "day <= "+b.placeholder(len(args)))
	}
	if len(filters) > 0 {
		query += " WHERE " + strings.Join(filters, " AND ")
	}
	query += " ORDER BY day DESC, id DESC"
	if limit > 0 {
		args = append(args, limit)
		query += " LIMIT " + b.placeholder(len(args))
	}
	rows, err := b.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	rowNumber := 0
	for rows.Next() {
		rowNumber++
		var id int64
		var text string
		if err := rows.Scan(&id, &text); err != nil {
			return nil, fmt.Errorf("scan log result row %d: %w", rowNumber, err)
		}
		item, err := decodeJSONString(text)
		if err != nil {
			return nil, fmt.Errorf("decode log row %d: %w", id, err)
		}
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("decode log row %d: expected JSON object", id)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (b *DatabaseBackend) QueryLogPage(startDate, endDate string, cursor *LogCursor, limit int) (LogPage, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	query := "SELECT id, day, data FROM logs"
	filters := make([]string, 0, 3)
	args := make([]any, 0, 5)
	if startDate = strings.TrimSpace(startDate); startDate != "" {
		args = append(args, startDate)
		filters = append(filters, "day >= "+b.placeholder(len(args)))
	}
	if endDate = strings.TrimSpace(endDate); endDate != "" {
		args = append(args, endDate)
		filters = append(filters, "day <= "+b.placeholder(len(args)))
	}
	if cursor != nil && strings.TrimSpace(cursor.Day) != "" && cursor.ID > 0 {
		args = append(args, strings.TrimSpace(cursor.Day), strings.TrimSpace(cursor.Day), cursor.ID)
		last := len(args)
		filters = append(filters, "(day < "+b.placeholder(last-2)+" OR (day = "+b.placeholder(last-1)+" AND id < "+b.placeholder(last)+"))")
	}
	if len(filters) > 0 {
		query += " WHERE " + strings.Join(filters, " AND ")
	}
	args = append(args, limit+1)
	query += " ORDER BY day DESC, id DESC LIMIT " + b.placeholder(len(args))
	rows, err := b.db.Query(query, args...)
	if err != nil {
		return LogPage{}, err
	}
	defer rows.Close()
	page := LogPage{Items: make([]map[string]any, 0, limit)}
	var pageCursor *LogCursor
	rowNumber := 0
	for rows.Next() {
		rowNumber++
		var id int64
		var day, text string
		if err := rows.Scan(&id, &day, &text); err != nil {
			return LogPage{}, fmt.Errorf("scan log result row %d: %w", rowNumber, err)
		}
		decoded, err := decodeJSONString(text)
		if err != nil {
			return LogPage{}, fmt.Errorf("decode log row %d: %w", id, err)
		}
		item, ok := decoded.(map[string]any)
		if !ok {
			return LogPage{}, fmt.Errorf("decode log row %d: expected JSON object", id)
		}
		if rowNumber > limit {
			page.NextCursor = pageCursor
			continue
		}
		pageCursor = &LogCursor{Day: day, ID: id}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return LogPage{}, err
	}
	return page, nil
}

func (b *DatabaseBackend) LogSummary() (int, string, string, error) {
	var total int
	var oldest, latest sql.NullString
	query := `SELECT COUNT(*),
		(SELECT created_at FROM logs ORDER BY created_at ASC LIMIT 1),
		(SELECT created_at FROM logs ORDER BY created_at DESC LIMIT 1)
		FROM logs`
	if err := b.db.QueryRow(query).Scan(&total, &oldest, &latest); err != nil {
		return 0, "", "", err
	}
	return total, oldest.String, latest.String, nil
}

func (b *DatabaseBackend) DeleteLogsBefore(day string) (int, error) {
	day = strings.TrimSpace(day)
	if day == "" {
		return 0, nil
	}
	result, err := b.db.Exec("DELETE FROM logs WHERE day < "+b.placeholder(1), day)
	if err != nil {
		return 0, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return int(rows), nil
}

func (b *DatabaseBackend) placeholder(index int) string {
	if b.driver == "postgres" {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}

func cleanDocumentName(name string) (string, error) {
	raw := strings.TrimSpace(filepath.ToSlash(name))
	rel := path.Clean(raw)
	if raw != rel || rel == "." || rel == "" || strings.HasPrefix(rel, "../") || strings.HasPrefix(rel, "/") || strings.ContainsRune(rel, 0) || filepath.IsAbs(filepath.FromSlash(rel)) {
		return "", fmt.Errorf("invalid document name: %s", name)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, ":") {
			return "", fmt.Errorf("invalid document name: %s", name)
		}
	}
	return rel, nil
}

func decodeJSONString(text string) (any, error) {
	return decodeJSONBytes([]byte(text))
}

func decodeJSONBytes(data []byte) (any, error) {
	var out any
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return nil, fmt.Errorf("invalid trailing JSON data")
	}
	return out, nil
}

func logDay(value string) string {
	if len(value) < 10 {
		return ""
	}
	return value[:10]
}

func ParseDatabaseURL(databaseURL string) (driver, dsn string, err error) {
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		return "", "", fmt.Errorf("database URL is required")
	}
	lower := strings.ToLower(databaseURL)
	switch {
	case strings.HasPrefix(lower, "sqlite:///"):
		return "sqlite", databaseURL[len("sqlite:///"):], nil
	case strings.HasPrefix(lower, "sqlite://"):
		return "sqlite", databaseURL[len("sqlite://"):], nil
	case strings.HasPrefix(lower, "postgresql://"), strings.HasPrefix(lower, "postgres://"):
		u, parseErr := url.Parse(databaseURL)
		if parseErr != nil {
			return "", "", parseErr
		}
		u.Scheme = strings.ToLower(u.Scheme)
		return "postgres", u.String(), nil
	case strings.HasPrefix(lower, "mysql://"):
		u, parseErr := url.Parse(databaseURL)
		if parseErr != nil {
			return "", "", parseErr
		}
		if u.User == nil {
			return "", "", fmt.Errorf("mysql database URL requires user, host, and database name")
		}
		pass, _ := u.User.Password()
		user := u.User.Username()
		db := strings.TrimPrefix(u.Path, "/")
		if user == "" || u.Host == "" || db == "" {
			return "", "", fmt.Errorf("mysql database URL requires user, host, and database name")
		}
		params := u.Query()
		params.Set("parseTime", "true")
		return "mysql", fmt.Sprintf(
			"%s:%s@tcp(%s)/%s?%s",
			user,
			pass,
			u.Host,
			url.PathEscape(db),
			params.Encode(),
		), nil
	default:
		if strings.Contains(databaseURL, "://") {
			return "", "", fmt.Errorf("unsupported database URL scheme")
		}
		if strings.Contains(lower, "postgres") {
			return "postgres", databaseURL, nil
		}
		return "sqlite", databaseURL, nil
	}
}

func maskPassword(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	username := u.User.Username()
	if _, ok := u.User.Password(); ok {
		u.User = url.UserPassword(username, "****")
	}
	return u.String()
}
