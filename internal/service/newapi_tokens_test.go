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

func TestNewAPITokenReaderSelectsFirstGroupAndAllowsSafeOverride(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "wrong-group", "wrong", now+3600, 10, false)
	insertTestNewAPIToken(t, dbURL, 2, 1, "draw", "expired", now-1, 10, false)
	insertTestNewAPIToken(t, dbURL, 3, 1, "draw", "empty-quota", now+3600, 0, false)
	insertTestNewAPIToken(t, dbURL, 4, 1, "draw", "alice-older", now+3600, 1, false)
	insertTestNewAPIToken(t, dbURL, 5, 1, "draw", "alice-newest", -1, 0, true)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	key, err := reader.KeyForIdentity(context.Background(), Identity{Username: "alice", Name: "Alice"})
	if err != nil {
		t.Fatalf("KeyForIdentity() error = %v", err)
	}
	if key != "sk-wrong" {
		t.Fatalf("KeyForIdentity() = %q, want first available key", key)
	}

	status := reader.StatusForGroupAndName(context.Background(), Identity{Username: "alice"}, "", "")
	if status["has_key"] != true || status["group"] != "wrong-group" {
		t.Fatalf("Status() = %#v", status)
	}
	groups, ok := status["groups"].([]string)
	if !ok || strings.Join(groups, ",") != "wrong-group,draw" {
		t.Fatalf("Status() groups = %#v, want wrong-group,draw", status["groups"])
	}
	overridden, err := reader.TokenForIdentityGroupAndName(context.Background(), Identity{Username: "alice"}, "wrong-group", "")
	if err != nil {
		t.Fatalf("TokenForIdentityGroup() error = %v", err)
	}
	if overridden.Group != "wrong-group" || overridden.Key != "sk-wrong" || strings.Join(overridden.Groups, ",") != "wrong-group,draw" {
		t.Fatalf("TokenForIdentityGroup() = %#v, want explicit wrong-group token", overridden)
	}

	missing, err := reader.TokenForIdentityGroupAndName(context.Background(), Identity{Username: "alice"}, "missing", "")
	if err == nil || !strings.Contains(err.Error(), "可用分组：wrong-group, draw") {
		t.Fatalf("TokenForIdentityGroup(missing) error = %v", err)
	}
	if missing.Group != "missing" || strings.Join(missing.Groups, ",") != "wrong-group,draw" {
		t.Fatalf("TokenForIdentityGroup(missing) = %#v", missing)
	}
}

func TestNewAPITokenReaderSelectsFirstSafeGroupWithoutConfiguredDefault(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "other", "other-key", time.Now().Unix()+3600, 10, false)
	insertTestNewAPIToken(t, dbURL, 2, 1, "draw", "draw-key", time.Now().Unix()+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	selection, err := reader.TokenForIdentity(context.Background(), Identity{Username: "alice"})
	if err != nil {
		t.Fatalf("TokenForIdentity() error = %v", err)
	}
	if selection.Group != "other" || selection.Key != "sk-other-key" || strings.Join(selection.Groups, ",") != "other,draw" {
		t.Fatalf("TokenForIdentity() = %#v, want first safe group", selection)
	}
	key, err := reader.KeyForIdentityGroupAndName(context.Background(), Identity{Username: "alice"}, "draw", "")
	if err != nil || key != "sk-draw-key" {
		t.Fatalf("KeyForIdentityGroup(draw) = %q, %v", key, err)
	}
}

func TestNewAPITokenReaderMatchesNewAPISingleGroupRouting(t *testing.T) {
	t.Run("empty token group falls back to user group", func(t *testing.T) {
		dbURL := newTestNewAPIDatabase(t)
		insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
		updateTestNewAPIUserBalance(t, dbURL, 1, 0, 0, 0, "draw")
		insertTestNewAPIToken(t, dbURL, 1, 1, "", "default-group-key", time.Now().Unix()+3600, 10, false)

		reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
		if err != nil {
			t.Fatalf("NewNewAPITokenReader() error = %v", err)
		}
		defer reader.Close()

		key, err := reader.KeyForIdentity(context.Background(), Identity{Username: "alice"})
		if err != nil || key != "sk-default-group-key" {
			t.Fatalf("KeyForIdentity() = %q, %v", key, err)
		}
	})

	t.Run("single enabled route is accepted", func(t *testing.T) {
		dbURL := newTestNewAPIDatabase(t)
		insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
		insertTestNewAPIToken(t, dbURL, 1, 1, "", "route-key", time.Now().Unix()+3600, 10, false)
		updateTestNewAPITokenRouteConfig(t, dbURL, 1, `[{"group":"draw","priority":1,"cooldown_seconds":60},{"group":"other","priority":0,"cooldown_seconds":60,"enabled":false}]`)

		reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
		if err != nil {
			t.Fatalf("NewNewAPITokenReader() error = %v", err)
		}
		defer reader.Close()

		key, err := reader.KeyForIdentity(context.Background(), Identity{Username: "alice"})
		if err != nil || key != "sk-route-key" {
			t.Fatalf("KeyForIdentity() = %q, %v", key, err)
		}
	})
}

func TestNewAPITokenReaderUsesSafeGroupsForDefaultButAllowsNamedRoutedTokens(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "draw", "multi-route", "unsafe-route-key", time.Now().Unix()+3600, 10, false)
	updateTestNewAPITokenRouteConfig(t, dbURL, 1, `[{"group":"draw","priority":2,"cooldown_seconds":60},{"group":"other","priority":1,"cooldown_seconds":60}]`)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "auto", "automatic", "auto-key", time.Now().Unix()+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 3, 1, "other", "invalid-route", "invalid-route-key", time.Now().Unix()+3600, 10, false)
	updateTestNewAPITokenRouteConfig(t, dbURL, 3, `[{"group":"other","priority":0,"cooldown_seconds":0}]`)
	insertTestNewAPITokenNamed(t, dbURL, 4, 1, "draw", "direct", "safe-key", time.Now().Unix()+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	selection, err := reader.TokenForIdentity(context.Background(), Identity{Username: "alice"})
	if err != nil || selection.Key != "sk-safe-key" {
		t.Fatalf("TokenForIdentity() = %#v, %v, want safe direct token", selection, err)
	}
	if strings.Join(selection.Groups, ",") != "draw" {
		t.Fatalf("TokenForIdentity() groups = %#v, want only safe draw group", selection.Groups)
	}
	if strings.Join(selection.Names, ",") != "multi-route,automatic,invalid-route,direct" {
		t.Fatalf("TokenForIdentity() names = %#v, want every valid named token", selection.Names)
	}

	for _, test := range []struct {
		name  string
		group string
		key   string
	}{
		{name: "multi-route", group: "draw", key: "sk-unsafe-route-key"},
		{name: "automatic", group: "auto", key: "sk-auto-key"},
		{name: "invalid-route", group: "other", key: "sk-invalid-route-key"},
	} {
		selected, err := reader.TokenForIdentityGroupAndName(context.Background(), Identity{Username: "alice"}, "missing-group", test.name)
		if err != nil || selected.Key != test.key || selected.Name != test.name || selected.Group != test.group {
			t.Fatalf("TokenForIdentityGroupAndName(%q) = %#v, %v", test.name, selected, err)
		}
	}
}

func TestNewAPITokenReaderUsesStableNewAPIUserID(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "draw", "draw-key", time.Now().Unix()+3600, 10, false)
	db := openTestNewAPIDatabase(t, dbURL)
	if _, err := db.Exec("UPDATE users SET username = ? WHERE id = ?", "alice-renamed", 1); err != nil {
		db.Close()
		t.Fatalf("rename user: %v", err)
	}
	db.Close()

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	identity := Identity{ID: "newapi:1", OwnerID: "newapi:1", Username: "alice"}
	key, err := reader.KeyForIdentity(context.Background(), identity)
	if err != nil || key != "sk-draw-key" {
		t.Fatalf("KeyForIdentity() = %q, %v", key, err)
	}
	balance := reader.BalanceStatus(context.Background(), identity)
	if balance["has_balance"] != true || balance["username"] != "alice-renamed" {
		t.Fatalf("BalanceStatus() = %#v", balance)
	}
}

func TestNewAPITokenReaderUsesAvailableGroup(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "other", "other-key", time.Now().Unix()+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	selection, err := reader.TokenForIdentity(context.Background(), Identity{Username: "alice"})
	if err != nil {
		t.Fatalf("TokenForIdentity() error = %v", err)
	}
	if selection.Group != "other" || selection.Key != "sk-other-key" || strings.Join(selection.Groups, ",") != "other" {
		t.Fatalf("TokenForIdentity() = %#v, want fallback other token", selection)
	}
	status := reader.StatusForGroupAndName(context.Background(), Identity{Username: "alice"}, "", "")
	if status["has_key"] != true || status["group"] != "other" {
		t.Fatalf("Status() = %#v", status)
	}
}

func TestNewAPITokenReaderSelectsCurrentUsersKeyByExactTokenName(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIUser(t, dbURL, 2, "bob", "bob@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "codex", "image", "image-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "codex", "codex", "codex-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 3, 2, "other", "codex", "bob-key", now+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	identity := Identity{ID: "newapi:1", OwnerID: "newapi:1", Username: "renamed-locally"}
	key, err := reader.KeyForIdentityGroupAndName(context.Background(), identity, "missing-group", "codex")
	if err != nil {
		t.Fatalf("KeyForIdentityGroupAndName() error = %v", err)
	}
	if key != "sk-codex-key" {
		t.Fatalf("KeyForIdentityGroupAndName() = %q, want exact current-user token", key)
	}
	status := reader.StatusForGroupAndName(context.Background(), identity, "missing-group", "image")
	if status["has_key"] != true || status["group"] != "codex" || status["token_name"] != "image" {
		t.Fatalf("StatusForGroupAndName() = %#v", status)
	}
	names, ok := status["token_names"].([]string)
	if !ok || strings.Join(names, ",") != "image,codex" {
		t.Fatalf("StatusForGroupAndName() token_names = %#v, want image,codex", status["token_names"])
	}

	missing, err := reader.TokenForIdentityGroupAndName(context.Background(), identity, "", "Image")
	if err == nil || !strings.Contains(err.Error(), "没有名为“Image”") || strings.Join(missing.Names, ",") != "image,codex" {
		t.Fatalf("TokenForIdentityGroupAndName(Image) = %#v, %v, want exact case-sensitive miss", missing, err)
	}
}

func TestNewAPITokenReaderFiltersTokenNamesByOwnerAndAvailability(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIUser(t, dbURL, 2, "bob", "bob@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "draw", "available", "available-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "draw", "expired", "expired-key", now-1, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 3, 1, "draw", "no-quota", "no-quota-key", now+3600, 0, false)
	insertTestNewAPITokenNamed(t, dbURL, 4, 1, "draw", "", "blank-name-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 5, 1, "draw", "blank-key", " ", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 6, 2, "draw", "other-user", "other-user-key", now+3600, 10, false)
	db := openTestNewAPIDatabase(t, dbURL)
	if _, err := db.Exec("UPDATE tokens SET status = 0 WHERE id = ?", 5); err != nil {
		db.Close()
		t.Fatalf("disable token: %v", err)
	}
	db.Close()

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	identity := Identity{ID: "newapi:1", OwnerID: "newapi:1", Username: "alice"}
	selection, err := reader.TokenForIdentity(context.Background(), identity)
	if err != nil || selection.Key != "sk-available-key" || strings.Join(selection.Names, ",") != "available" {
		t.Fatalf("TokenForIdentity() = %#v, %v", selection, err)
	}
	for _, unavailableName := range []string{"expired", "no-quota", "other-user", "blank-key"} {
		_, err := reader.TokenForIdentityGroupAndName(context.Background(), identity, "", unavailableName)
		if err == nil || !strings.Contains(err.Error(), "没有名为") {
			t.Fatalf("TokenForIdentityGroupAndName(%q) error = %v", unavailableName, err)
		}
	}
}

func TestNewAPITokenReaderRejectsAmbiguousDuplicateTokenNames(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	now := time.Now().Unix()
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "draw", "duplicate", "first-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "other", "duplicate", "second-key", now+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	selection, err := reader.TokenForIdentityGroupAndName(context.Background(), Identity{ID: "newapi:1"}, "draw", "duplicate")
	if err == nil || !strings.Contains(err.Error(), "存在 2 个名为“duplicate”") || !strings.Contains(err.Error(), "重命名") {
		t.Fatalf("TokenForIdentityGroupAndName(duplicate) = %#v, %v", selection, err)
	}
	if selection.Key != "" || strings.Join(selection.Names, ",") != "duplicate" {
		t.Fatalf("ambiguous selection = %#v, want no silently selected key", selection)
	}
}

func TestNewAPITokenReaderAuthenticatesNewAPIUserPassword(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 7, "alice", "alice@example.test")

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
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

func TestNewAPITokenReaderAuthenticatesNumericNewAPIAdminRole(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	addTestNewAPIUserRole(t, dbURL)
	insertTestNewAPIUser(t, dbURL, 8, "root", "root@example.test")
	updateTestNewAPIUserRole(t, dbURL, 8, 10)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	user, err := reader.AuthenticatePassword(context.Background(), "root@example.test", "Password123")
	if err != nil {
		t.Fatalf("AuthenticatePassword() error = %v", err)
	}
	if !user.IsAdmin {
		t.Fatalf("AuthenticatePassword() IsAdmin = false, want true")
	}
}

func TestNewAPITokenReaderReadsUserBalance(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 9, "alice", "alice@example.test")
	updateTestNewAPIUserBalance(t, dbURL, 9, 123456, 789, 42, "codex")

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	status := reader.BalanceStatus(context.Background(), Identity{Username: "alice"})
	if status["has_balance"] != true || status["user_id"] != int64(9) || status["quota"] != float64(123456) || status["used_quota"] != float64(789) || status["request_count"] != int64(42) || status["user_group"] != "codex" {
		t.Fatalf("BalanceStatus() = %#v", status)
	}
}

func TestNewAPITokenReaderSupportsSub2API(t *testing.T) {
	dbURL := newTestSub2APIDatabase(t)
	insertTestSub2APIUser(t, dbURL, 1, "alice", "alice@example.test", "admin", 12.5)
	insertTestSub2APIGroup(t, dbURL, 1, "image", "active", false)
	insertTestSub2APIGroup(t, dbURL, 2, "disabled", "disabled", false)
	insertTestSub2APIGroup(t, dbURL, 3, "deleted", "active", true)
	now := time.Now()
	insertTestSub2APIKey(t, dbURL, 1, 1, "sub-valid", "main", 1, "active", 10, 1, now.Add(time.Hour), false)
	insertTestSub2APIKey(t, dbURL, 2, 1, "sk-disabled", "disabled-key", 1, "disabled", 0, 0, time.Time{}, false)
	insertTestSub2APIKey(t, dbURL, 3, 1, "sk-expired", "expired", 1, "active", 0, 0, now.Add(-time.Hour), false)
	insertTestSub2APIKey(t, dbURL, 4, 1, "sk-exhausted", "exhausted", 1, "active", 10, 10, time.Time{}, false)
	insertTestSub2APIKey(t, dbURL, 5, 1, "sk-no-group", "no-group", 0, "active", 0, 0, time.Time{}, false)
	insertTestSub2APIKey(t, dbURL, 6, 1, "sk-disabled-group", "disabled-group", 2, "active", 0, 0, time.Time{}, false)
	insertTestSub2APIKey(t, dbURL, 7, 1, "sk-deleted-group", "deleted-group", 3, "active", 0, 0, time.Time{}, false)
	insertTestSub2APIUsage(t, dbURL, 1, 2.25)
	insertTestSub2APIUsage(t, dbURL, 1, 0.75)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, DatabaseType: "sub2api"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()
	if !reader.IsSub2API() || reader.Source() != "sub2api" {
		t.Fatalf("database kind = %q, want sub2api", reader.Source())
	}

	user, err := reader.AuthenticatePassword(context.Background(), "alice@example.test", "Password123")
	if err != nil {
		t.Fatalf("AuthenticatePassword() error = %v", err)
	}
	if user.ID != 1 || user.Username != "alice" || user.DisplayName != "alice" || !user.IsAdmin || user.Provider != "sub2api" || user.SubjectPrefix != "sub2api" {
		t.Fatalf("AuthenticatePassword() user = %#v", user)
	}

	identity := Identity{ID: "sub2api:1", OwnerID: "sub2api:1", Username: "old-name"}
	selection, err := reader.TokenForIdentity(context.Background(), identity)
	if err != nil {
		t.Fatalf("TokenForIdentity() error = %v", err)
	}
	if selection.Key != "sub-valid" || selection.Name != "main" || selection.Group != "image" || strings.Join(selection.Names, ",") != "main" {
		t.Fatalf("TokenForIdentity() = %#v", selection)
	}

	db := openTestNewAPIDatabase(t, dbURL)
	if _, err := db.Exec("UPDATE users SET username = ? WHERE id = ?", "alice-renamed", 1); err != nil {
		db.Close()
		t.Fatalf("rename Sub2API user: %v", err)
	}
	db.Close()
	status := reader.BalanceStatus(context.Background(), identity)
	if status["source"] != "sub2api" || status["has_balance"] != true || status["username"] != "alice-renamed" || status["quota"] != float64(6_250_000) || status["used_quota"] != float64(1_500_000) || status["request_count"] != int64(2) {
		t.Fatalf("BalanceStatus() = %#v", status)
	}
}

func TestNewAPITokenReaderSub2APIFallsBackToEmailUsername(t *testing.T) {
	dbURL := newTestSub2APIDatabase(t)
	insertTestSub2APIUser(t, dbURL, 2, "", "email-only@example.test", "user", 0)
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, DatabaseType: "sub2api"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()
	user, err := reader.AuthenticatePassword(context.Background(), "email-only@example.test", "Password123")
	if err != nil {
		t.Fatalf("AuthenticatePassword() error = %v", err)
	}
	if user.Username != "email-only@example.test" || user.DisplayName != "email-only@example.test" || user.IsAdmin {
		t.Fatalf("AuthenticatePassword() user = %#v", user)
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
		"CREATE TABLE tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, `key` TEXT NOT NULL, status INTEGER NOT NULL, name TEXT, expired_time INTEGER NOT NULL, remain_quota INTEGER NOT NULL, unlimited_quota BOOLEAN NOT NULL, `group` TEXT NOT NULL, group_route_config TEXT NOT NULL DEFAULT '', deleted_at TEXT)",
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("create newapi schema: %v", err)
		}
	}
	return "sqlite:///" + filepath.ToSlash(dbPath)
}

func newTestSub2APIDatabase(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "sub2api.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	schema := []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', deleted_at DATETIME)`,
		`CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, deleted_at DATETIME)`,
		`CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, group_id INTEGER, status TEXT NOT NULL, quota REAL NOT NULL DEFAULT 0, quota_used REAL NOT NULL DEFAULT 0, expires_at DATETIME, deleted_at DATETIME)`,
		`CREATE TABLE usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, actual_cost REAL NOT NULL DEFAULT 0)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("create Sub2API schema: %v", err)
		}
	}
	return "sqlite:///" + filepath.ToSlash(dbPath)
}

func addTestNewAPIUserRole(t *testing.T, dbURL string) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("ALTER TABLE users ADD COLUMN role INTEGER NOT NULL DEFAULT 1"); err != nil {
		t.Fatalf("add user role: %v", err)
	}
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

func insertTestSub2APIUser(t *testing.T, dbURL string, id int, username, email, role string, balance float64) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	hash, err := bcrypt.GenerateFromPassword([]byte("Password123"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if _, err := db.Exec("INSERT INTO users (id, username, email, password_hash, role, balance, status, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL)", id, username, email, string(hash), role, balance); err != nil {
		t.Fatalf("insert Sub2API user: %v", err)
	}
}

func insertTestSub2APIGroup(t *testing.T, dbURL string, id int, name, status string, deleted bool) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	var deletedAt any
	if deleted {
		deletedAt = time.Now()
	}
	if _, err := db.Exec("INSERT INTO groups (id, name, status, deleted_at) VALUES (?, ?, ?, ?)", id, name, status, deletedAt); err != nil {
		t.Fatalf("insert Sub2API group: %v", err)
	}
}

func insertTestSub2APIKey(t *testing.T, dbURL string, id, userID int, key, name string, groupID int, status string, quota, quotaUsed float64, expiresAt time.Time, deleted bool) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	var groupValue any
	if groupID > 0 {
		groupValue = groupID
	}
	var expiresValue any
	if !expiresAt.IsZero() {
		expiresValue = expiresAt
	}
	var deletedAt any
	if deleted {
		deletedAt = time.Now()
	}
	if _, err := db.Exec("INSERT INTO api_keys (id, user_id, key, name, group_id, status, quota, quota_used, expires_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, userID, key, name, groupValue, status, quota, quotaUsed, expiresValue, deletedAt); err != nil {
		t.Fatalf("insert Sub2API key: %v", err)
	}
}

func insertTestSub2APIUsage(t *testing.T, dbURL string, userID int, actualCost float64) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("INSERT INTO usage_logs (user_id, actual_cost) VALUES (?, ?)", userID, actualCost); err != nil {
		t.Fatalf("insert Sub2API usage: %v", err)
	}
}

func updateTestNewAPIUserRole(t *testing.T, dbURL string, id, role int) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("UPDATE users SET role = ? WHERE id = ?", role, id); err != nil {
		t.Fatalf("update user role: %v", err)
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

func updateTestNewAPITokenRouteConfig(t *testing.T, dbURL string, id int, routeConfig string) {
	t.Helper()
	db := openTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("UPDATE tokens SET group_route_config = ? WHERE id = ?", routeConfig, id); err != nil {
		t.Fatalf("update token route config: %v", err)
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
