package service

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	ImageConversationSessionActive = "active"
	ImageConversationSessionFailed = "failed"

	imageConversationSessionDocumentName = "image_conversation_sessions.json"
)

type ImageConversationSession struct {
	OwnerID                 string    `json:"owner_id"`
	FrontendConversationID  string    `json:"frontend_conversation_id"`
	AccessToken             string    `json:"access_token"`
	UpstreamConversationID  string    `json:"upstream_conversation_id"`
	UpstreamParentMessageID string    `json:"upstream_parent_message_id"`
	Status                  string    `json:"status"`
	CreatedAt               time.Time `json:"created_at"`
	LastUsedAt              time.Time `json:"last_used_at"`
}

type ImageConversationSessionService struct {
	mu      sync.RWMutex
	path    string
	store   storage.JSONDocumentBackend
	docName string
	items   map[string]ImageConversationSession
	loadErr error
}

func NewImageConversationSessionService(path string, backends ...storage.Backend) *ImageConversationSessionService {
	s := &ImageConversationSessionService{
		path:    path,
		store:   firstJSONDocumentStore(backends),
		docName: imageConversationSessionDocumentName,
		items:   map[string]ImageConversationSession{},
	}
	s.items, s.loadErr = s.load()
	return s
}

func (s *ImageConversationSessionService) Get(ownerID, frontendConversationID string) (ImageConversationSession, bool) {
	if s == nil {
		return ImageConversationSession{}, false
	}
	key := imageConversationSessionKey(ownerID, frontendConversationID)
	if key == "" {
		return ImageConversationSession{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return ImageConversationSession{}, false
	}
	item, ok := s.items[key]
	return item, ok
}

func (s *ImageConversationSessionService) Bind(item ImageConversationSession) error {
	if s == nil {
		return nil
	}
	item.OwnerID = util.Clean(item.OwnerID)
	item.FrontendConversationID = util.Clean(item.FrontendConversationID)
	item.AccessToken = strings.TrimSpace(item.AccessToken)
	item.UpstreamConversationID = util.Clean(item.UpstreamConversationID)
	item.UpstreamParentMessageID = util.Clean(item.UpstreamParentMessageID)
	key := imageConversationSessionKey(item.OwnerID, item.FrontendConversationID)
	if key == "" || item.AccessToken == "" || item.UpstreamConversationID == "" || item.UpstreamParentMessageID == "" {
		return nil
	}

	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return err
	}
	previous, existed := s.items[key]
	if existing, ok := s.items[key]; ok && item.CreatedAt.IsZero() {
		item.CreatedAt = existing.CreatedAt
	}
	if item.CreatedAt.IsZero() {
		item.CreatedAt = now
	}
	if item.LastUsedAt.IsZero() {
		item.LastUsedAt = now
	}
	item.Status = ImageConversationSessionActive
	if s.items == nil {
		s.items = map[string]ImageConversationSession{}
	}
	s.items[key] = item
	if err := s.saveMergedLocked(); err != nil {
		s.restoreAfterSaveFailureLocked(key, previous, existed)
		return err
	}
	return nil
}

func (s *ImageConversationSessionService) Invalidate(ownerID, frontendConversationID string) error {
	if s == nil {
		return nil
	}
	key := imageConversationSessionKey(ownerID, frontendConversationID)
	if key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return err
	}
	item, ok := s.items[key]
	if !ok {
		return nil
	}
	previous := item
	item.Status = ImageConversationSessionFailed
	item.LastUsedAt = time.Now().UTC()
	s.items[key] = item
	if err := s.saveMergedLocked(); err != nil {
		s.restoreAfterSaveFailureLocked(key, previous, true)
		return err
	}
	return nil
}

func (s *ImageConversationSessionService) Cleanup(maxAge time.Duration) (int, error) {
	if s == nil || maxAge <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-maxAge)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return 0, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		removedItems := make(map[string]ImageConversationSession)
		for key, item := range s.items {
			lastUsed := item.LastUsedAt
			if lastUsed.IsZero() {
				lastUsed = item.CreatedAt
			}
			if !lastUsed.IsZero() && lastUsed.Before(cutoff) {
				removedItems[key] = item
				delete(s.items, key)
			}
		}
		if len(removedItems) == 0 {
			return 0, nil
		}
		err := s.persistLocked()
		if err == nil {
			return len(removedItems), nil
		}
		if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt < 2 {
			items, loadErr := s.load()
			if loadErr != nil {
				for key, item := range removedItems {
					s.items[key] = item
				}
				return 0, loadErr
			}
			s.items = items
			continue
		}
		for key, item := range removedItems {
			s.items[key] = item
		}
		return 0, err
	}
	return 0, nil
}

func (s *ImageConversationSessionService) load() (map[string]ImageConversationSession, error) {
	raw, err := loadStoredJSON(s.store, s.docName)
	if err != nil {
		return map[string]ImageConversationSession{}, err
	}
	if obj, ok := raw.(map[string]any); ok {
		raw = obj["sessions"]
	}
	items := map[string]ImageConversationSession{}
	for _, rawItem := range util.AsMapSlice(raw) {
		item := ImageConversationSession{
			OwnerID:                 util.Clean(rawItem["owner_id"]),
			FrontendConversationID:  util.Clean(rawItem["frontend_conversation_id"]),
			AccessToken:             strings.TrimSpace(util.Clean(rawItem["access_token"])),
			UpstreamConversationID:  util.Clean(rawItem["upstream_conversation_id"]),
			UpstreamParentMessageID: util.Clean(rawItem["upstream_parent_message_id"]),
			Status:                  util.Clean(rawItem["status"]),
			CreatedAt:               parseImageConversationSessionTime(rawItem["created_at"]),
			LastUsedAt:              parseImageConversationSessionTime(rawItem["last_used_at"]),
		}
		key := imageConversationSessionKey(item.OwnerID, item.FrontendConversationID)
		if key == "" || item.AccessToken == "" || item.UpstreamConversationID == "" || item.UpstreamParentMessageID == "" {
			continue
		}
		if item.Status != ImageConversationSessionFailed {
			item.Status = ImageConversationSessionActive
		}
		items[key] = item
	}
	return items, nil
}

func (s *ImageConversationSessionService) ensureLoadedLocked() error {
	if s.loadErr == nil {
		return nil
	}
	items, err := s.load()
	if err != nil {
		s.loadErr = err
		return err
	}
	s.items = items
	s.loadErr = nil
	return nil
}

func (s *ImageConversationSessionService) saveMergedLocked() error {
	for attempt := 0; attempt < 3; attempt++ {
		err := s.persistLocked()
		if !errors.Is(err, storage.ErrConcurrentRowUpdate) || attempt == 2 {
			return err
		}
		remote, loadErr := s.load()
		if loadErr != nil {
			return loadErr
		}
		s.items = mergeImageConversationSessions(remote, s.items)
	}
	return nil
}

func (s *ImageConversationSessionService) persistLocked() error {
	if s.store == nil {
		return nil
	}
	items := make([]ImageConversationSession, 0, len(s.items))
	for _, item := range s.items {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].LastUsedAt.After(items[j].LastUsedAt)
	})
	return saveStoredJSON(s.store, s.docName, map[string]any{"sessions": items})
}

func mergeImageConversationSessions(remote, local map[string]ImageConversationSession) map[string]ImageConversationSession {
	merged := make(map[string]ImageConversationSession, len(remote)+len(local))
	for key, item := range remote {
		merged[key] = item
	}
	for key, item := range local {
		current, exists := merged[key]
		if !exists || imageConversationSessionNewer(item, current) {
			merged[key] = item
		}
	}
	return merged
}

func imageConversationSessionNewer(candidate, current ImageConversationSession) bool {
	candidateTime := candidate.LastUsedAt
	if candidateTime.IsZero() {
		candidateTime = candidate.CreatedAt
	}
	currentTime := current.LastUsedAt
	if currentTime.IsZero() {
		currentTime = current.CreatedAt
	}
	if !candidateTime.Equal(currentTime) {
		return candidateTime.After(currentTime)
	}
	if candidate.Status != current.Status {
		return candidate.Status == ImageConversationSessionFailed
	}
	return true
}

func (s *ImageConversationSessionService) restoreAfterSaveFailureLocked(key string, previous ImageConversationSession, existed bool) {
	if items, err := s.load(); err == nil {
		s.items = items
		return
	}
	if existed {
		s.items[key] = previous
	} else {
		delete(s.items, key)
	}
}

func imageConversationSessionKey(ownerID, frontendConversationID string) string {
	ownerID = util.Clean(ownerID)
	frontendConversationID = util.Clean(frontendConversationID)
	if ownerID == "" || frontendConversationID == "" {
		return ""
	}
	return ownerID + "\x00" + frontendConversationID
}

func parseImageConversationSessionTime(value any) time.Time {
	if t, ok := value.(time.Time); ok {
		return t
	}
	text := util.Clean(value)
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, text); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
