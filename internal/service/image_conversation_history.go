package service

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const imageConversationHistoryDocumentDir = "image_conversations"

type ImageConversationHistoryService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewImageConversationHistoryService(backend storage.Backend) *ImageConversationHistoryService {
	return &ImageConversationHistoryService{store: jsonDocumentStoreFromBackend(backend)}
}

func (s *ImageConversationHistoryService) List(ownerID string) ([]map[string]any, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(ownerID)
}

func (s *ImageConversationHistoryService) Merge(ownerID string, incoming []map[string]any) ([]map[string]any, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	items, err := s.loadLocked(ownerID)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]map[string]any, len(items)+len(incoming))
	for _, item := range items {
		byID[util.Clean(item["id"])] = item
	}
	for _, raw := range incoming {
		item, normalizeErr := normalizeImageConversationHistoryItem(raw)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		id := util.Clean(item["id"])
		current := byID[id]
		if current == nil || imageConversationUpdatedAt(item) >= imageConversationUpdatedAt(current) {
			byID[id] = item
		}
	}
	merged := make([]map[string]any, 0, len(byID))
	for _, item := range byID {
		merged = append(merged, item)
	}
	sortImageConversationHistory(merged)
	if err := s.saveLocked(ownerID, merged); err != nil {
		return nil, err
	}
	return merged, nil
}

func (s *ImageConversationHistoryService) Delete(ownerID, conversationID string) ([]map[string]any, bool, error) {
	ownerID = util.Clean(ownerID)
	conversationID = util.Clean(conversationID)
	if ownerID == "" || conversationID == "" {
		return nil, false, fmt.Errorf("owner_id and conversation id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	items, err := s.loadLocked(ownerID)
	if err != nil {
		return nil, false, err
	}
	next := make([]map[string]any, 0, len(items))
	removed := false
	for _, item := range items {
		if util.Clean(item["id"]) == conversationID {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return items, false, nil
	}
	if err := s.saveLocked(ownerID, next); err != nil {
		return nil, false, err
	}
	return next, true, nil
}

func (s *ImageConversationHistoryService) Clear(ownerID string) error {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return s.store.DeleteJSONDocument(imageConversationHistoryDocumentName(ownerID))
}

func (s *ImageConversationHistoryService) loadLocked(ownerID string) ([]map[string]any, error) {
	if s.store == nil {
		return nil, fmt.Errorf("storage document backend is required")
	}
	raw, err := s.store.LoadJSONDocument(imageConversationHistoryDocumentName(ownerID))
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0)
	for _, candidate := range util.AsMapSlice(util.StringMap(raw)["items"]) {
		item, normalizeErr := normalizeImageConversationHistoryItem(candidate)
		if normalizeErr == nil {
			items = append(items, item)
		}
	}
	sortImageConversationHistory(items)
	return items, nil
}

func (s *ImageConversationHistoryService) saveLocked(ownerID string, items []map[string]any) error {
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return s.store.SaveJSONDocument(imageConversationHistoryDocumentName(ownerID), map[string]any{"items": items})
}

func imageConversationHistoryDocumentName(ownerID string) string {
	return imageConversationHistoryDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func normalizeImageConversationHistoryItem(raw map[string]any) (map[string]any, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("conversation is not valid json")
	}
	item := map[string]any{}
	if err := json.Unmarshal(data, &item); err != nil {
		return nil, fmt.Errorf("conversation is not valid json")
	}
	id := util.Clean(item["id"])
	if id == "" || len(id) > 200 {
		return nil, fmt.Errorf("conversation id is required")
	}
	updatedAt := strings.TrimSpace(util.Clean(item["updatedAt"]))
	if updatedAt == "" {
		return nil, fmt.Errorf("conversation updatedAt is required")
	}
	if _, ok := item["turns"].([]any); !ok {
		return nil, fmt.Errorf("conversation turns are required")
	}
	item["id"] = id
	item["updatedAt"] = updatedAt
	return item, nil
}

func imageConversationUpdatedAt(item map[string]any) string {
	return strings.TrimSpace(util.Clean(item["updatedAt"]))
}

func sortImageConversationHistory(items []map[string]any) {
	sort.SliceStable(items, func(i, j int) bool {
		return imageConversationUpdatedAt(items[i]) > imageConversationUpdatedAt(items[j])
	})
}
