package service

import (
	"fmt"
	"net/url"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	customRelayConfigDocumentDir = "custom_relay_configs"
	customRelayTokenPrefix       = "__custom_relay__:"
	maxCustomRelayBaseURLLength  = 2048
	maxCustomRelayAPIKeyLength   = 16384
)

var customRelayKinds = []string{"text", "image", "video", "audio"}

type CustomRelayConfig struct {
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
}

type CustomRelayConfigStatus struct {
	Kind       string `json:"kind"`
	TokenName  string `json:"token_name"`
	BaseURL    string `json:"base_url"`
	HasKey     bool   `json:"has_key"`
	Configured bool   `json:"configured"`
}

type CustomRelayConfigService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewCustomRelayConfigService(backend storage.Backend) *CustomRelayConfigService {
	return &CustomRelayConfigService{store: jsonDocumentStoreFromBackend(backend)}
}

func CustomRelayKinds() []string {
	return append([]string(nil), customRelayKinds...)
}

func CustomRelayTokenName(kind string) string {
	kind = NormalizeCustomRelayKind(kind)
	if kind == "" {
		return ""
	}
	return customRelayTokenPrefix + kind
}

func CustomRelayKindFromTokenName(name string) string {
	name = strings.TrimSpace(name)
	if !strings.HasPrefix(name, customRelayTokenPrefix) {
		return ""
	}
	return NormalizeCustomRelayKind(strings.TrimPrefix(name, customRelayTokenPrefix))
}

func NormalizeCustomRelayKind(kind string) string {
	kind = strings.ToLower(strings.TrimSpace(kind))
	for _, candidate := range customRelayKinds {
		if kind == candidate {
			return kind
		}
	}
	return ""
}

func (s *CustomRelayConfigService) Config(ownerID, kind string) (CustomRelayConfig, error) {
	ownerID = strings.TrimSpace(ownerID)
	kind = NormalizeCustomRelayKind(kind)
	if ownerID == "" {
		return CustomRelayConfig{}, fmt.Errorf("owner_id is required")
	}
	if kind == "" {
		return CustomRelayConfig{}, fmt.Errorf("custom relay kind is not supported")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return CustomRelayConfig{}, err
	}
	return configs[kind], nil
}

func (s *CustomRelayConfigService) Statuses(ownerID string) (map[string]CustomRelayConfigStatus, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return nil, err
	}
	statuses := make(map[string]CustomRelayConfigStatus, len(customRelayKinds))
	for _, kind := range customRelayKinds {
		statuses[kind] = customRelayConfigStatus(kind, configs[kind])
	}
	return statuses, nil
}

func (s *CustomRelayConfigService) Update(ownerID, kind, baseURL, apiKey string) (CustomRelayConfigStatus, error) {
	ownerID = strings.TrimSpace(ownerID)
	kind = NormalizeCustomRelayKind(kind)
	if ownerID == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("owner_id is required")
	}
	if kind == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("custom relay kind is not supported")
	}
	normalizedBaseURL, err := normalizeCustomRelayBaseURL(baseURL)
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	apiKey = strings.TrimSpace(apiKey)
	if len(apiKey) > maxCustomRelayAPIKeyLength {
		return CustomRelayConfigStatus{}, fmt.Errorf("API Key is too long")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	current := configs[kind]
	if apiKey == "" {
		apiKey = current.APIKey
	}
	if apiKey == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("API Key is required")
	}
	configs[kind] = CustomRelayConfig{BaseURL: normalizedBaseURL, APIKey: apiKey}
	if err := s.saveLocked(ownerID, configs); err != nil {
		return CustomRelayConfigStatus{}, err
	}
	return customRelayConfigStatus(kind, configs[kind]), nil
}

func (s *CustomRelayConfigService) Delete(ownerID, kind string) error {
	ownerID = strings.TrimSpace(ownerID)
	kind = NormalizeCustomRelayKind(kind)
	if ownerID == "" {
		return fmt.Errorf("owner_id is required")
	}
	if kind == "" {
		return fmt.Errorf("custom relay kind is not supported")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return err
	}
	delete(configs, kind)
	return s.saveLocked(ownerID, configs)
}

func (s *CustomRelayConfigService) loadLocked(ownerID string) (map[string]CustomRelayConfig, error) {
	if s.store == nil {
		return nil, fmt.Errorf("storage document backend is required")
	}
	raw, err := s.store.LoadJSONDocument(customRelayConfigDocumentName(ownerID))
	if err != nil {
		return nil, err
	}
	configs := make(map[string]CustomRelayConfig, len(customRelayKinds))
	for key, value := range util.StringMap(raw) {
		kind := NormalizeCustomRelayKind(key)
		item := util.StringMap(value)
		if kind == "" || len(item) == 0 {
			continue
		}
		baseURL, normalizeErr := normalizeCustomRelayBaseURL(util.Clean(item["base_url"]))
		apiKey := strings.TrimSpace(util.Clean(item["api_key"]))
		if normalizeErr != nil || apiKey == "" || len(apiKey) > maxCustomRelayAPIKeyLength {
			continue
		}
		configs[kind] = CustomRelayConfig{BaseURL: baseURL, APIKey: apiKey}
	}
	return configs, nil
}

func (s *CustomRelayConfigService) saveLocked(ownerID string, configs map[string]CustomRelayConfig) error {
	return saveStoredJSON(s.store, customRelayConfigDocumentName(ownerID), configs)
}

func customRelayConfigDocumentName(ownerID string) string {
	return customRelayConfigDocumentDir + "/" + util.SHA256Hex(strings.TrimSpace(ownerID)) + ".json"
}

func customRelayConfigStatus(kind string, config CustomRelayConfig) CustomRelayConfigStatus {
	configured := config.BaseURL != "" && config.APIKey != ""
	return CustomRelayConfigStatus{
		Kind: kind, TokenName: CustomRelayTokenName(kind), BaseURL: config.BaseURL,
		HasKey: config.APIKey != "", Configured: configured,
	}
}

func normalizeCustomRelayBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		return "", fmt.Errorf("Base URL is required")
	}
	if len(value) > maxCustomRelayBaseURLLength {
		return "", fmt.Errorf("Base URL is too long")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("Base URL must be an absolute http(s) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("Base URL must not contain credentials, query parameters, or fragments")
	}
	return value, nil
}
