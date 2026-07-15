package service

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	announcementDocumentName          = "announcements.json"
	announcementPreferenceDocumentDir = "announcement_preferences"
	maxAnnouncementTitleRunes         = 80
	maxAnnouncementBodyRunes          = 2000
	maxAnnouncementPreferenceVersions = 500
)

type Announcement struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type AnnouncementService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

type AnnouncementPreferences struct {
	SeenVersions      []string          `json:"seen_versions"`
	PermanentVersions []string          `json:"permanent_versions"`
	SnoozedDates      map[string]string `json:"snoozed_dates"`
}

func NewAnnouncementService(backend storage.Backend) *AnnouncementService {
	return &AnnouncementService{store: jsonDocumentStoreFromBackend(backend)}
}

func (s *AnnouncementService) ListAll() ([]Announcement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *AnnouncementService) ListVisible() ([]Announcement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	visible := make([]Announcement, 0, len(items))
	for _, item := range items {
		if item.Enabled {
			visible = append(visible, item)
		}
	}
	return visible, nil
}

func (s *AnnouncementService) Create(body map[string]any) (Announcement, error) {
	title, err := normalizeAnnouncementTitle(body["title"])
	if err != nil {
		return Announcement{}, err
	}
	content, err := normalizeAnnouncementContent(body["content"])
	if err != nil {
		return Announcement{}, err
	}
	enabled := true
	if value, exists := body["enabled"]; exists {
		enabled = util.ToBool(value)
	}
	now := util.NowISO()
	item := Announcement{
		ID:        "announcement_" + util.NewHex(16),
		Title:     title,
		Content:   content,
		Enabled:   enabled,
		CreatedAt: now,
		UpdatedAt: now,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return Announcement{}, err
	}
	items = append([]Announcement{item}, items...)
	if err := s.saveLocked(items); err != nil {
		return Announcement{}, err
	}
	return item, nil
}

func (s *AnnouncementService) Update(id string, body map[string]any) (*Announcement, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("announcement id is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	for index := range items {
		if items[index].ID != id {
			continue
		}
		changed := false
		if value, exists := body["title"]; exists {
			title, normalizeErr := normalizeAnnouncementTitle(value)
			if normalizeErr != nil {
				return nil, normalizeErr
			}
			items[index].Title = title
			changed = true
		}
		if value, exists := body["content"]; exists {
			content, normalizeErr := normalizeAnnouncementContent(value)
			if normalizeErr != nil {
				return nil, normalizeErr
			}
			items[index].Content = content
			changed = true
		}
		if value, exists := body["enabled"]; exists {
			items[index].Enabled = util.ToBool(value)
			changed = true
		}
		if !changed {
			return nil, fmt.Errorf("no updates provided")
		}
		items[index].UpdatedAt = util.NowISO()
		updated := items[index]
		sortAnnouncements(items)
		if err := s.saveLocked(items); err != nil {
			return nil, err
		}
		return &updated, nil
	}
	return nil, nil
}

func (s *AnnouncementService) Delete(id string) (bool, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return false, err
	}
	next := make([]Announcement, 0, len(items))
	removed := false
	for _, item := range items {
		if item.ID == id {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return false, nil
	}
	if err := s.saveLocked(next); err != nil {
		return false, err
	}
	return true, nil
}

func (s *AnnouncementService) Preferences(ownerID string) (AnnouncementPreferences, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return AnnouncementPreferences{}, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadPreferencesLocked(ownerID)
}

func (s *AnnouncementService) UpdatePreferences(ownerID, version, action, localDate string) (AnnouncementPreferences, error) {
	ownerID = util.Clean(ownerID)
	version = strings.TrimSpace(version)
	action = strings.TrimSpace(action)
	localDate = strings.TrimSpace(localDate)
	if ownerID == "" || version == "" || len(version) > 300 {
		return AnnouncementPreferences{}, fmt.Errorf("owner_id and announcement version are required")
	}
	if action != "seen" && action != "today" && action != "forever" {
		return AnnouncementPreferences{}, fmt.Errorf("invalid announcement preference action")
	}
	if action == "today" && !validAnnouncementLocalDate(localDate) {
		return AnnouncementPreferences{}, fmt.Errorf("local_date must use YYYY-MM-DD")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	preferences, err := s.loadPreferencesLocked(ownerID)
	if err != nil {
		return AnnouncementPreferences{}, err
	}
	preferences.SeenVersions = appendUniqueAnnouncementVersion(preferences.SeenVersions, version)
	switch action {
	case "today":
		preferences.SnoozedDates[version] = localDate
	case "forever":
		preferences.PermanentVersions = appendUniqueAnnouncementVersion(preferences.PermanentVersions, version)
		delete(preferences.SnoozedDates, version)
	}
	if err := s.savePreferencesLocked(ownerID, preferences); err != nil {
		return AnnouncementPreferences{}, err
	}
	return preferences, nil
}

func (s *AnnouncementService) loadPreferencesLocked(ownerID string) (AnnouncementPreferences, error) {
	if s.store == nil {
		return AnnouncementPreferences{}, fmt.Errorf("storage document backend is required")
	}
	raw, err := s.store.LoadJSONDocument(announcementPreferenceDocumentName(ownerID))
	if err != nil {
		return AnnouncementPreferences{}, err
	}
	value := util.StringMap(raw)
	return AnnouncementPreferences{
		SeenVersions:      normalizeAnnouncementVersions(value["seen_versions"]),
		PermanentVersions: normalizeAnnouncementVersions(value["permanent_versions"]),
		SnoozedDates:      normalizeAnnouncementSnoozedDates(value["snoozed_dates"]),
	}, nil
}

func (s *AnnouncementService) savePreferencesLocked(ownerID string, preferences AnnouncementPreferences) error {
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return s.store.SaveJSONDocument(announcementPreferenceDocumentName(ownerID), preferences)
}

func announcementPreferenceDocumentName(ownerID string) string {
	return announcementPreferenceDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func normalizeAnnouncementVersions(value any) []string {
	items := util.AsStringSlice(value)
	if len(items) > maxAnnouncementPreferenceVersions {
		items = items[len(items)-maxAnnouncementPreferenceVersions:]
	}
	result := make([]string, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		version := strings.TrimSpace(item)
		if version == "" || len(version) > 300 {
			continue
		}
		if _, ok := seen[version]; ok {
			continue
		}
		seen[version] = struct{}{}
		result = append(result, version)
	}
	return result
}

func appendUniqueAnnouncementVersion(items []string, version string) []string {
	result := make([]string, 0, len(items)+1)
	for _, item := range items {
		if item != version {
			result = append(result, item)
		}
	}
	result = append(result, version)
	if len(result) > maxAnnouncementPreferenceVersions {
		result = result[len(result)-maxAnnouncementPreferenceVersions:]
	}
	return result
}

func normalizeAnnouncementSnoozedDates(value any) map[string]string {
	result := map[string]string{}
	for version, rawDate := range util.StringMap(value) {
		version = strings.TrimSpace(version)
		date := strings.TrimSpace(util.Clean(rawDate))
		if version == "" || len(version) > 300 || !validAnnouncementLocalDate(date) {
			continue
		}
		result[version] = date
		if len(result) >= maxAnnouncementPreferenceVersions {
			break
		}
	}
	return result
}

func validAnnouncementLocalDate(value string) bool {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return false
	}
	for index, char := range value {
		if index == 4 || index == 7 {
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func (s *AnnouncementService) loadLocked() ([]Announcement, error) {
	if s.store == nil {
		return nil, fmt.Errorf("storage document backend is required")
	}
	raw, err := s.store.LoadJSONDocument(announcementDocumentName)
	if err != nil {
		return nil, err
	}
	items := make([]Announcement, 0)
	for _, candidate := range util.AsMapSlice(util.StringMap(raw)["items"]) {
		item, ok := storedAnnouncement(candidate)
		if ok {
			items = append(items, item)
		}
	}
	sortAnnouncements(items)
	return items, nil
}

func (s *AnnouncementService) saveLocked(items []Announcement) error {
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return s.store.SaveJSONDocument(announcementDocumentName, map[string]any{"items": items})
}

func storedAnnouncement(raw map[string]any) (Announcement, bool) {
	id := util.Clean(raw["id"])
	content := strings.TrimSpace(util.Clean(raw["content"]))
	createdAt := util.Clean(raw["created_at"])
	updatedAt := util.Clean(raw["updated_at"])
	if id == "" || content == "" || createdAt == "" || updatedAt == "" {
		return Announcement{}, false
	}
	title := strings.TrimSpace(util.Clean(raw["title"]))
	if title == "" {
		title = "系统公告"
	}
	return Announcement{
		ID:        id,
		Title:     title,
		Content:   content,
		Enabled:   util.ToBool(raw["enabled"]),
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}, true
}

func normalizeAnnouncementTitle(value any) (string, error) {
	title := strings.TrimSpace(util.Clean(value))
	if title == "" {
		title = "系统公告"
	}
	if utf8.RuneCountInString(title) > maxAnnouncementTitleRunes {
		return "", fmt.Errorf("title must not exceed %d characters", maxAnnouncementTitleRunes)
	}
	return title, nil
}

func normalizeAnnouncementContent(value any) (string, error) {
	content := strings.TrimSpace(util.Clean(value))
	if content == "" {
		return "", fmt.Errorf("content is required")
	}
	if utf8.RuneCountInString(content) > maxAnnouncementBodyRunes {
		return "", fmt.Errorf("content must not exceed %d characters", maxAnnouncementBodyRunes)
	}
	return content, nil
}

func sortAnnouncements(items []Announcement) {
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
}
