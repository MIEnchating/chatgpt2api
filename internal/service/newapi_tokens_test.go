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

func TestNewAPITokenReaderPrefersConfiguredGroupAndAllowsSafeOverride(t *testing.T) {
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
	if groups := reader.ConfiguredTokenGroups(context.Background()); strings.Join(groups, ",") != "draw" {
		t.Fatalf("ConfiguredTokenGroups() = %#v, want draw", groups)
	}
	overridden, err := reader.TokenForIdentityGroup(context.Background(), Identity{Username: "alice"}, "wrong-group")
	if err != nil {
		t.Fatalf("TokenForIdentityGroup() error = %v", err)
	}
	if overridden.Group != "wrong-group" || overridden.Key != "sk-wrong" || strings.Join(overridden.Groups, ",") != "wrong-group,draw" {
		t.Fatalf("TokenForIdentityGroup() = %#v, want explicit wrong-group token", overridden)
	}

	missing, err := reader.TokenForIdentityGroup(context.Background(), Identity{Username: "alice"}, "missing")
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
	key, err := reader.KeyForIdentityGroup(context.Background(), Identity{Username: "alice"}, "draw")
	if err != nil || key != "sk-draw-key" {
		t.Fatalf("KeyForIdentityGroup(draw) = %q, %v", key, err)
	}
	if groups := reader.ConfiguredTokenGroups(context.Background()); len(groups) != 0 {
		t.Fatalf("ConfiguredTokenGroups() = %#v, want empty", groups)
	}
}

func TestNewAPITokenReaderMatchesNewAPISingleGroupRouting(t *testing.T) {
	t.Run("empty token group falls back to user group", func(t *testing.T) {
		dbURL := newTestNewAPIDatabase(t)
		insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
		updateTestNewAPIUserBalance(t, dbURL, 1, 0, 0, 0, "draw")
		insertTestNewAPIToken(t, dbURL, 1, 1, "", "default-group-key", time.Now().Unix()+3600, 10, false)

		reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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

		reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	defer reader.Close()

	identity := Identity{ID: "newapi:1", OwnerID: "newapi:1", Username: "alice"}
	key, err := reader.KeyForIdentity(context.Background(), identity)
	if err != nil || key != "sk-draw-key" {
		t.Fatalf("KeyForIdentity() = %q, %v", key, err)
	}
	balance, err := reader.BalanceForIdentity(context.Background(), identity)
	if err != nil || balance.Username != "alice-renamed" {
		t.Fatalf("BalanceForIdentity() = %#v, %v", balance, err)
	}
}

func TestNewAPITokenReaderFallsBackWhenConfiguredGroupIsUnavailable(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIToken(t, dbURL, 1, 1, "other", "other-key", time.Now().Unix()+3600, 10, false)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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
	status := reader.Status(context.Background(), Identity{Username: "alice"})
	if status["has_key"] != true || status["group"] != "other" || status["configured_group"] != "draw" {
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

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "codex"})
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

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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

func TestNewAPITokenReaderAuthenticatesNumericNewAPIAdminRole(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	addTestNewAPIUserRole(t, dbURL)
	insertTestNewAPIUser(t, dbURL, 8, "root", "root@example.test")
	updateTestNewAPIUserRole(t, dbURL, 8, 10)

	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
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
		"CREATE TABLE tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, `key` TEXT NOT NULL, status INTEGER NOT NULL, name TEXT, expired_time INTEGER NOT NULL, remain_quota INTEGER NOT NULL, unlimited_quota BOOLEAN NOT NULL, `group` TEXT NOT NULL, group_route_config TEXT NOT NULL DEFAULT '', deleted_at TEXT)",
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("create newapi schema: %v", err)
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
