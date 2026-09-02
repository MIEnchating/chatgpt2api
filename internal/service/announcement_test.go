package service

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"testing"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestAnnouncementServicePersistsAndFiltersAnnouncements(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "announcements.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	announcements := NewAnnouncementService(backend)
	created, itemsAfterCreate, err := announcements.CreateWithItems(map[string]any{
		"title":   "维护通知",
		"content": "今晚 23:00 进行维护。",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" || created.Title != "维护通知" || !created.Enabled {
		t.Fatalf("CreateWithItems() item = %#v", created)
	}
	if len(itemsAfterCreate) != 1 || itemsAfterCreate[0].ID != created.ID {
		t.Fatalf("CreateWithItems() items = %#v", itemsAfterCreate)
	}

	disabled, itemsAfterDisabled, err := announcements.CreateWithItems(map[string]any{
		"content": "内部草稿",
		"enabled": false,
	})
	if err != nil {
		t.Fatalf("Create(disabled) error = %v", err)
	}
	if disabled.Title != "系统公告" || disabled.Enabled {
		t.Fatalf("CreateWithItems(disabled) item = %#v", disabled)
	}
	if len(itemsAfterDisabled) != 2 || itemsAfterDisabled[0].ID != disabled.ID {
		t.Fatalf("CreateWithItems(disabled) items = %#v", itemsAfterDisabled)
	}

	visible, err := announcements.ListVisible()
	if err != nil {
		t.Fatalf("ListVisible() error = %v", err)
	}
	if len(visible) != 1 || visible[0].ID != created.ID {
		t.Fatalf("ListVisible() = %#v", visible)
	}

	updated, itemsAfterUpdate, err := announcements.UpdateWithItems(created.ID, map[string]any{"enabled": false, "content": "维护已延期。"})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated == nil || updated.Enabled || updated.Content != "维护已延期。" {
		t.Fatalf("UpdateWithItems() item = %#v", updated)
	}
	if len(itemsAfterUpdate) != 2 {
		t.Fatalf("UpdateWithItems() items = %#v", itemsAfterUpdate)
	}

	reloaded := NewAnnouncementService(backend)
	items, err := reloaded.ListAll()
	if err != nil {
		t.Fatalf("reloaded ListAll() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("reloaded ListAll() = %#v", items)
	}

	deleted, itemsAfterDelete, err := reloaded.DeleteWithItems(disabled.ID)
	if err != nil || !deleted {
		t.Fatalf("DeleteWithItems() deleted=%v error=%v", deleted, err)
	}
	if len(itemsAfterDelete) != 1 || itemsAfterDelete[0].ID != created.ID {
		t.Fatalf("DeleteWithItems() items = %#v", itemsAfterDelete)
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
	if _, _, err := announcements.CreateWithItems(map[string]any{"content": "  "}); err == nil {
		t.Fatal("CreateWithItems() error = nil, want content validation error")
	}
	if _, _, err := announcements.CreateWithItems(map[string]any{"content": string(make([]rune, maxAnnouncementBodyRunes+1))}); err == nil {
		t.Fatal("CreateWithItems() error = nil, want content length error")
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
	for _, date := range []string{"15-07-2026", "2026-02-29", "2026-13-01"} {
		if _, err := announcements.UpdatePreferences("user-a", "v1", "today", date); err == nil {
			t.Fatalf("today preference accepted invalid date %q", date)
		}
	}
	if _, err := announcements.UpdatePreferences("user-a", "v1", "unknown", ""); err == nil {
		t.Fatal("preference accepted invalid action")
	}
}

func TestAnnouncementPreferencesBoundSnoozedDatesWhenAdding501stVersion(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := backend.(storage.JSONDocumentBackend)
	const ownerID = "bounded-owner"
	seenVersions := make([]string, 0, maxAnnouncementPreferenceVersions)
	snoozedDates := make(map[string]string, maxAnnouncementPreferenceVersions)
	for index := 0; index < maxAnnouncementPreferenceVersions; index++ {
		version := testAnnouncementVersion(index)
		seenVersions = append(seenVersions, version)
		snoozedDates[version] = "2026-07-15"
	}
	if err := store.SaveJSONDocument(announcementPreferenceDocumentName(ownerID), AnnouncementPreferences{
		SeenVersions: seenVersions,
		SnoozedDates: snoozedDates,
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	newestVersion := testAnnouncementVersion(maxAnnouncementPreferenceVersions)
	preferences, err := NewAnnouncementService(backend).UpdatePreferences(ownerID, newestVersion, "today", "2026-07-16")
	if err != nil {
		t.Fatalf("UpdatePreferences() error = %v", err)
	}
	if len(preferences.SeenVersions) != maxAnnouncementPreferenceVersions || len(preferences.SnoozedDates) != maxAnnouncementPreferenceVersions {
		t.Fatalf("bounded preferences lengths = seen:%d snoozed:%d", len(preferences.SeenVersions), len(preferences.SnoozedDates))
	}
	if preferences.SeenVersions[0] != testAnnouncementVersion(1) || preferences.SeenVersions[len(preferences.SeenVersions)-1] != newestVersion {
		t.Fatalf("bounded seen versions = %#v", preferences.SeenVersions)
	}
	if _, exists := preferences.SnoozedDates[testAnnouncementVersion(0)]; exists {
		t.Fatalf("oldest snooze was not evicted: %#v", preferences.SnoozedDates)
	}
	if preferences.SnoozedDates[newestVersion] != "2026-07-16" {
		t.Fatalf("newest snooze = %q", preferences.SnoozedDates[newestVersion])
	}

	raw, err := store.LoadJSONDocument(announcementPreferenceDocumentName(ownerID))
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	persisted := util.StringMap(raw)
	if count := len(util.StringMap(persisted["snoozed_dates"])); count != maxAnnouncementPreferenceVersions {
		t.Fatalf("persisted snoozed_dates count = %d, want %d", count, maxAnnouncementPreferenceVersions)
	}
	reloaded, err := NewAnnouncementService(backend).Preferences(ownerID)
	if err != nil {
		t.Fatalf("reloaded Preferences() error = %v", err)
	}
	if !slices.Equal(reloaded.SeenVersions, preferences.SeenVersions) || !maps.Equal(reloaded.SnoozedDates, preferences.SnoozedDates) {
		t.Fatalf("reloaded preferences = %#v, want %#v", reloaded, preferences)
	}
}

func TestAnnouncementPreferencesNormalizeLegacySnoozeOverflowDeterministically(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := backend.(storage.JSONDocumentBackend)
	const ownerID = "legacy-overflow-owner"
	const overflow = 2
	seenVersions := make([]string, 0, maxAnnouncementPreferenceVersions+overflow)
	snoozedDates := make(map[string]string, maxAnnouncementPreferenceVersions+overflow)
	for index := 0; index < maxAnnouncementPreferenceVersions+overflow; index++ {
		version := testAnnouncementVersion(index)
		seenVersions = append(seenVersions, version)
		snoozedDates[version] = "2026-07-15"
	}
	if err := store.SaveJSONDocument(announcementPreferenceDocumentName(ownerID), AnnouncementPreferences{
		SeenVersions: seenVersions,
		SnoozedDates: snoozedDates,
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	first, err := NewAnnouncementService(backend).Preferences(ownerID)
	if err != nil {
		t.Fatalf("first Preferences() error = %v", err)
	}
	second, err := NewAnnouncementService(backend).Preferences(ownerID)
	if err != nil {
		t.Fatalf("second Preferences() error = %v", err)
	}
	if len(first.SnoozedDates) != maxAnnouncementPreferenceVersions || !maps.Equal(first.SnoozedDates, second.SnoozedDates) {
		t.Fatalf("legacy overflow normalization was unstable: first=%#v second=%#v", first.SnoozedDates, second.SnoozedDates)
	}
	for index := 0; index < overflow; index++ {
		if _, exists := first.SnoozedDates[testAnnouncementVersion(index)]; exists {
			t.Fatalf("stale snooze %q survived deterministic trimming", testAnnouncementVersion(index))
		}
	}
	for index := overflow; index < maxAnnouncementPreferenceVersions+overflow; index++ {
		if _, exists := first.SnoozedDates[testAnnouncementVersion(index)]; !exists {
			t.Fatalf("recent snooze %q was discarded", testAnnouncementVersion(index))
		}
	}
}

func testAnnouncementVersion(index int) string {
	return fmt.Sprintf("announcement-%03d:v1", index)
}

func TestAnnouncementServiceMergesConcurrentDatabaseCreates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-announcements.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewAnnouncementService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewAnnouncementService(newFirstSaveBarrierBackend(t, backendB, barrier))

	type createResult struct {
		content string
		item    Announcement
		items   []Announcement
		err     error
	}
	resultsCh := make(chan createResult, 2)
	go func() {
		item, items, saveErr := serviceA.CreateWithItems(map[string]any{"content": "公告 A"})
		resultsCh <- createResult{content: "公告 A", item: item, items: items, err: saveErr}
	}()
	go func() {
		item, items, saveErr := serviceB.CreateWithItems(map[string]any{"content": "公告 B"})
		resultsCh <- createResult{content: "公告 B", item: item, items: items, err: saveErr}
	}()
	maxReturnedItems := 0
	for range 2 {
		result := <-resultsCh
		if result.err != nil {
			t.Fatalf("concurrent CreateWithItems() error = %v", result.err)
		}
		if result.item.Content != result.content || !announcementSliceContainsID(result.items, result.item.ID) {
			t.Fatalf("CreateWithItems(%q) item=%#v items=%#v", result.content, result.item, result.items)
		}
		if len(result.items) > maxReturnedItems {
			maxReturnedItems = len(result.items)
		}
	}
	if maxReturnedItems != 2 {
		t.Fatalf("successful CAS results never included both announcements; max items = %d", maxReturnedItems)
	}
	items, err := serviceA.ListAll()
	if err != nil {
		t.Fatalf("ListAll() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("concurrent announcements lost an update: %#v", items)
	}
}

func announcementSliceContainsID(items []Announcement, id string) bool {
	for _, item := range items {
		if item.ID == id {
			return true
		}
	}
	return false
}

func TestAnnouncementServiceMergesConcurrentPreferenceUpdates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-announcement-preferences.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewAnnouncementService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewAnnouncementService(newFirstSaveBarrierBackend(t, backendB, barrier))

	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.UpdatePreferences("owner", "announcement-a:v1", "seen", "")
		errorsCh <- saveErr
	}()
	go func() {
		_, saveErr := serviceB.UpdatePreferences("owner", "announcement-b:v1", "forever", "")
		errorsCh <- saveErr
	}()
	for range 2 {
		if saveErr := <-errorsCh; saveErr != nil {
			t.Fatalf("concurrent UpdatePreferences() error = %v", saveErr)
		}
	}
	preferences, err := serviceA.Preferences("owner")
	if err != nil {
		t.Fatalf("Preferences() error = %v", err)
	}
	if len(preferences.SeenVersions) != 2 || len(preferences.PermanentVersions) != 1 {
		t.Fatalf("concurrent preferences lost an update: %#v", preferences)
	}
}
