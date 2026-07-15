package service

import (
	"path/filepath"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestAnnouncementServicePersistsAndFiltersAnnouncements(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "announcements.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	announcements := NewAnnouncementService(backend)
	created, err := announcements.Create(map[string]any{
		"title":   "维护通知",
		"content": "今晚 23:00 进行维护。",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" || created.Title != "维护通知" || !created.Enabled {
		t.Fatalf("Create() = %#v", created)
	}

	disabled, err := announcements.Create(map[string]any{
		"content": "内部草稿",
		"enabled": false,
	})
	if err != nil {
		t.Fatalf("Create(disabled) error = %v", err)
	}
	if disabled.Title != "系统公告" || disabled.Enabled {
		t.Fatalf("Create(disabled) = %#v", disabled)
	}

	visible, err := announcements.ListVisible()
	if err != nil {
		t.Fatalf("ListVisible() error = %v", err)
	}
	if len(visible) != 1 || visible[0].ID != created.ID {
		t.Fatalf("ListVisible() = %#v", visible)
	}

	updated, err := announcements.Update(created.ID, map[string]any{"enabled": false, "content": "维护已延期。"})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated == nil || updated.Enabled || updated.Content != "维护已延期。" {
		t.Fatalf("Update() = %#v", updated)
	}

	reloaded := NewAnnouncementService(backend)
	items, err := reloaded.ListAll()
	if err != nil {
		t.Fatalf("reloaded ListAll() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("reloaded ListAll() = %#v", items)
	}

	deleted, err := reloaded.Delete(disabled.ID)
	if err != nil || !deleted {
		t.Fatalf("Delete() deleted=%v error=%v", deleted, err)
	}
	items, err = announcements.ListAll()
	if err != nil || len(items) != 1 || items[0].ID != created.ID {
		t.Fatalf("ListAll() after delete = %#v, error=%v", items, err)
	}
}

func TestAnnouncementServiceValidatesContent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "announcements.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	announcements := NewAnnouncementService(backend)
	if _, err := announcements.Create(map[string]any{"content": "  "}); err == nil {
		t.Fatal("Create() error = nil, want content validation error")
	}
	if _, err := announcements.Create(map[string]any{"content": string(make([]rune, maxAnnouncementBodyRunes+1))}); err == nil {
		t.Fatal("Create() error = nil, want content length error")
	}
}

func TestAnnouncementPreferencesPersistPerOwner(t *testing.T) {
	backend := newTestStorageBackend(t)
	announcements := NewAnnouncementService(backend)

	preferences, err := announcements.UpdatePreferences("user-a", "announcement-1:v1", "seen", "")
	if err != nil {
		t.Fatalf("seen preference error = %v", err)
	}
	if len(preferences.SeenVersions) != 1 || len(preferences.PermanentVersions) != 0 {
		t.Fatalf("seen preferences = %#v", preferences)
	}

	preferences, err = announcements.UpdatePreferences("user-a", "announcement-1:v1", "today", "2026-07-15")
	if err != nil {
		t.Fatalf("today preference error = %v", err)
	}
	if preferences.SnoozedDates["announcement-1:v1"] != "2026-07-15" {
		t.Fatalf("today preferences = %#v", preferences)
	}

	preferences, err = announcements.UpdatePreferences("user-a", "announcement-1:v1", "forever", "")
	if err != nil {
		t.Fatalf("forever preference error = %v", err)
	}
	if len(preferences.PermanentVersions) != 1 || preferences.SnoozedDates["announcement-1:v1"] != "" {
		t.Fatalf("forever preferences = %#v", preferences)
	}

	other, err := announcements.Preferences("user-b")
	if err != nil {
		t.Fatalf("other preferences error = %v", err)
	}
	if len(other.SeenVersions) != 0 || len(other.PermanentVersions) != 0 || len(other.SnoozedDates) != 0 {
		t.Fatalf("other owner saw preferences = %#v", other)
	}

	reloaded, err := NewAnnouncementService(backend).Preferences("user-a")
	if err != nil || len(reloaded.PermanentVersions) != 1 {
		t.Fatalf("reloaded preferences=%#v error=%v", reloaded, err)
	}
}

func TestAnnouncementPreferencesValidateActions(t *testing.T) {
	announcements := NewAnnouncementService(newTestStorageBackend(t))
	if _, err := announcements.UpdatePreferences("user-a", "v1", "today", "15-07-2026"); err == nil {
		t.Fatal("today preference accepted invalid date")
	}
	if _, err := announcements.UpdatePreferences("user-a", "v1", "unknown", ""); err == nil {
		t.Fatal("preference accepted invalid action")
	}
}
