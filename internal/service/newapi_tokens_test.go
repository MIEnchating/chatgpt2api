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

func TestNewAPITokenReaderReadsNewestMatchingGroupToken(t *testing.T) {
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
	if key != "sk-alice-newest" {
		t.Fatalf("KeyForIdentity() = %q, want normalized newest key", key)
	}

	status := reader.Status(context.Background(), Identity{Username: "alice"})
	if status["has_key"] != true || status["group"] != "draw" || status["key_preview"] == key {
		t.Fatalf("Status() = %#v", status)
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

func newTestNewAPIDatabase(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "newapi.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	schema := []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, email TEXT, display_name TEXT, password TEXT NOT NULL, status INTEGER NOT NULL, deleted_at TEXT)`,
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

func insertTestNewAPIToken(t *testing.T, dbURL string, id, userID int, group, key string, expiredTime int64, remainQuota int, unlimited bool) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("INSERT INTO tokens (id, user_id, `key`, status, name, expired_time, remain_quota, unlimited_quota, `group`, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)", id, userID, key, "token", expiredTime, remainQuota, unlimited, group); err != nil {
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
