package service

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestNewAPITokenReaderReadsFirstMatchingGroupTokenAndListsGroups(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "wrong-group", "wrong", now+3600, 10, false)
	insertTestNewAPIToken(t, dbURL, 2, 1, "draw", "expired", now-1, 10, false)
	insertTestNewAPIToken(t, dbURL, 3, 1, "draw", "empty-quota", now+3600, 0, false)
	insertTestNewAPIToken(t, dbURL, 4, 1, "draw", "alice-older", now+3600, 1, false)
	insertTestNewAPIToken(t, dbURL, 5, 1, "draw", "alice-newest", -1, 0, true)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	key, err := reader.KeyForIdentity(context.Background(), Identity{Username: "alice", Name: "Alice"})
	if err != nil {
		t.Fatalf("KeyForIdentity() error = %v", err)
	}
	if key != "sk-alice-older" {
		t.Fatalf("KeyForIdentity() = %q, want normalized first key", key)
	}

	status := reader.Status(context.Background(), Identity{Username: "alice"})
	if status["has_key"] != true || status["group"] != "draw" || status["key_preview"] == key {
		t.Fatalf("Status() = %#v", status)
	}
	groups, ok := status["groups"].([]string)
	if !ok || strings.Join(groups, ",") != "wrong-group,draw" {
		t.Fatalf("Status() groups = %#v, want wrong-group,draw", status["groups"])
	}
	if groups := reader.ConfiguredTokenGroups(context.Background()); strings.Join(groups, ",") != "wrong-group,draw" {
		t.Fatalf("ConfiguredTokenGroups() = %#v, want wrong-group,draw", groups)
	}
}

func TestNewAPITokenReaderReportsMissingConfiguredGroupToken(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "other", "other-key", time.Now().Unix()+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	_, err = reader.KeyForIdentity(context.Background(), Identity{Username: "alice"})
	if err == nil || !strings.Contains(err.Error(), "draw") {
		t.Fatalf("KeyForIdentity() error = %v, want group prompt", err)
	}
	status := reader.Status(context.Background(), Identity{Username: "alice"})
	if status["has_key"] != false || !strings.Contains(status["message"].(string), "draw") {
		t.Fatalf("Status() = %#v", status)
	}
}

func TestNewAPITokenReaderSelectsTokenByNameInConfiguredGroup(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "codex", "image", "image-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "codex", "codex", "codex-key", now+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "codex"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	key, err := reader.KeyForIdentityGroupAndName(context.Background(), Identity{Username: "alice"}, "", "codex")
	if err != nil {
		t.Fatalf("KeyForIdentityGroupAndName() error = %v", err)
	}
	if key != "sk-codex-key" {
		t.Fatalf("KeyForIdentityGroupAndName() = %q, want selected token name key", key)
	}
	status := reader.StatusForGroupAndName(context.Background(), Identity{Username: "alice"}, "", "image")
	if status["has_key"] != true || status["group"] != "codex" || status["token_name"] != "image" {
		t.Fatalf("StatusForGroupAndName() = %#v", status)
	}
	names, ok := status["token_names"].([]string)
	if !ok || strings.Join(names, ",") != "image,codex" {
		t.Fatalf("StatusForGroupAndName() token_names = %#v, want image,codex", status["token_names"])
	}
}

func TestNewAPITokenReaderAuthenticatesNewAPIUserPassword(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 7, "alice", "alice@example.test")

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	user, err := reader.AuthenticatePassword(context.Background(), "alice@example.test", "Password123")
	if err != nil {
		t.Fatalf("AuthenticatePassword() error = %v", err)
	}
	if user.ID != 7 || user.Username != "alice" || user.DisplayName != "Alice" {
		t.Fatalf("AuthenticatePassword() user = %#v", user)
	}
	if _, err := reader.AuthenticatePassword(context.Background(), "alice", "wrong-password"); err == nil {
		t.Fatal("AuthenticatePassword() accepted wrong password")
	}
}

func TestNewAPITokenReaderReadsUserBalance(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 9, "alice", "alice@example.test")
	updateTestNewAPIUserBalance(t, dbURL, 9, 123456, 789, 42, "codex")

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	balance, err := reader.BalanceForIdentity(context.Background(), Identity{Username: "alice"})
	if err != nil {
		t.Fatalf("BalanceForIdentity() error = %v", err)
	}
	if balance.ID != 9 || balance.Quota != 123456 || balance.UsedQuota != 789 || balance.RequestCount != 42 || balance.Group != "codex" {
		t.Fatalf("BalanceForIdentity() = %#v", balance)
	}
	status := reader.BalanceStatus(context.Background(), Identity{Username: "alice"})
	if status["has_balance"] != true || status["quota"] != int64(123456) || status["user_group"] != "codex" {
		t.Fatalf("BalanceStatus() = %#v", status)
	}
}

func newTestNewAPIDatabase(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "newapi.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	schema := []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, email TEXT, display_name TEXT, password TEXT NOT NULL, quota INTEGER NOT NULL DEFAULT 0, used_quota INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, ` + "`group`" + ` TEXT NOT NULL DEFAULT 'default', status INTEGER NOT NULL, deleted_at TEXT)`,
		"CREATE TABLE tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, `key` TEXT NOT NULL, status INTEGER NOT NULL, name TEXT, expired_time INTEGER NOT NULL, remain_quota INTEGER NOT NULL, unlimited_quota BOOLEAN NOT NULL, `group` TEXT NOT NULL, deleted_at TEXT)",
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("create newapi schema: %v", err)
		}
	}
	return "sqlite:///" + filepath.ToSlash(dbPath)
}

func insertTestNewAPIUser(t *testing.T, dbURL string, id int, username, email string) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	hash, err := bcrypt.GenerateFromPassword([]byte("Password123"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if _, err := db.Exec("INSERT INTO users (id, username, email, display_name, password, status, deleted_at) VALUES (?, ?, ?, ?, ?, 1, NULL)", id, username, email, "Alice", string(hash)); err != nil {
		t.Fatalf("insert user: %v", err)
	}
}

func updateTestNewAPIUserBalance(t *testing.T, dbURL string, id int, quota, usedQuota, requestCount int, group string) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("UPDATE users SET quota = ?, used_quota = ?, request_count = ?, `group` = ? WHERE id = ?", quota, usedQuota, requestCount, group, id); err != nil {
		t.Fatalf("update user balance: %v", err)
	}
}

func insertTestNewAPIToken(t *testing.T, dbURL string, id, userID int, group, key string, expiredTime int64, remainQuota int, unlimited bool) {
	insertTestNewAPITokenNamed(t, dbURL, id, userID, group, "token", key, expiredTime, remainQuota, unlimited)
}

func insertTestNewAPITokenNamed(t *testing.T, dbURL string, id, userID int, group, name, key string, expiredTime int64, remainQuota int, unlimited bool) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("INSERT INTO tokens (id, user_id, `key`, status, name, expired_time, remain_quota, unlimited_quota, `group`, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)", id, userID, key, name, expiredTime, remainQuota, unlimited, group); err != nil {
		t.Fatalf("insert token: %v", err)
	}
}

func openTestNewAPIDatabase(t *testing.T, dbURL string) *sql.DB {
	t.Helper()
	path := strings.TrimPrefix(dbURL, "sqlite:///")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open sqlite fixture: %v", err)
	}
	return db
}
