package service

import (
	"fmt"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const relayAPIKeyDocumentDir = "relay_api_keys"

type RelayAPIKeyService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewRelayAPIKeyService(backend ...storage.Backend) *RelayAPIKeyService {
	return &RelayAPIKeyService{store: firstJSONDocumentStore(backend)}
}

func (s *RelayAPIKeyService) Status(ownerID string) map[string]any {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return relayAPIKeyStatus("", "")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key, updatedAt := s.loadLocked(ownerID)
	return relayAPIKeyStatus(key, updatedAt)
}

func (s *RelayAPIKeyService) Get(ownerID string) (string, bool) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return "", false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key, _ := s.loadLocked(ownerID)
	if key == "" {
		return "", false
	}
	return key, true
}

func (s *RelayAPIKeyService) Save(ownerID, apiKey string) (map[string]any, error) {
	ownerID = util.Clean(ownerID)
	apiKey = util.Clean(apiKey)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("RelayAI Key is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	updatedAt := util.NowISO()
	if err := saveStoredJSON(s.store, relayAPIKeyDocumentName(ownerID), map[string]any{
		"api_key":    apiKey,
		"updated_at": updatedAt,
	}); err != nil {
		return nil, err
	}
	return relayAPIKeyStatus(apiKey, updatedAt), nil
}

func (s *RelayAPIKeyService) Delete(ownerID string) (map[string]any, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	if s.store == nil {
		return nil, fmt.Errorf("storage document backend is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.store.DeleteJSONDocument(relayAPIKeyDocumentName(ownerID)); err != nil {
		return nil, err
	}
	return relayAPIKeyStatus("", ""), nil
}

func (s *RelayAPIKeyService) loadLocked(ownerID string) (string, string) {
	raw := loadStoredJSON(s.store, relayAPIKeyDocumentName(ownerID))
	doc := util.StringMap(raw)
	return util.Clean(doc["api_key"]), util.Clean(doc["updated_at"])
}

func relayAPIKeyDocumentName(ownerID string) string {
	return relayAPIKeyDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func relayAPIKeyStatus(apiKey, updatedAt string) map[string]any {
	apiKey = util.Clean(apiKey)
	return map[string]any{
		"has_key":     apiKey != "",
		"key_preview": maskRelayAPIKey(apiKey),
		"updated_at":  updatedAt,
	}
}

func maskRelayAPIKey(value string) string {
	value = util.Clean(value)
	if value == "" {
		return ""
	}
	if len(value) <= 10 {
		prefix := value
		if len(prefix) > 3 {
			prefix = prefix[:3]
		}
		return prefix + "****"
	}
	return value[:7] + "********" + value[len(value)-4:]
}
