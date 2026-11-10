package service

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
)

type RelayModelPricingCache struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewRelayModelPricingCache(backend storage.Backend) *RelayModelPricingCache {
	return &RelayModelPricingCache{store: jsonDocumentStoreFromBackend(backend)}
}

func relayModelPricingDocument(baseURL, group string) string {
	return fmt.Sprintf("relay_model_pricing/%x.json", sha256.Sum256([]byte(baseURL+"\x00"+group)))
}

func (s *RelayModelPricingCache) Load(baseURL, group string) (map[string]model.RelayModelPricing, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := storage.LoadJSONDocumentBounded(s.store, relayModelPricingDocument(baseURL, group))
	if err != nil || value == nil {
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var prices map[string]model.RelayModelPricing
	if err := json.Unmarshal(data, &prices); err != nil {
		return nil, fmt.Errorf("decode cached relay model pricing: %w", err)
	}
	return prices, nil
}

func (s *RelayModelPricingCache) Save(baseURL, group string, prices map[string]model.RelayModelPricing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	name := relayModelPricingDocument(baseURL, group)
	if _, err := storage.LoadJSONDocumentBounded(s.store, name); err != nil {
		return err
	}
	return storage.SaveJSONDocumentBounded(s.store, name, prices)
}
