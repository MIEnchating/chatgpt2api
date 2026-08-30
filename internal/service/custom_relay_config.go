package service

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	customRelayConfigDocumentDir = "custom_relay_configs"
	customRelayTokenPrefix       = "__custom_relay__:"
	maxCustomRelayConfigs        = 20
	maxCustomRelayBaseURLLength  = 2048
	maxCustomRelayAPIKeyLength   = 16384
)

var customRelayKinds = []string{"text", "image", "video", "audio"}

type CustomRelayConfig struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
}

type CustomRelayConfigStatus struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
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

func CustomRelayTokenName(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	return customRelayTokenPrefix + id
}

func CustomRelayConfigIDFromTokenName(name string) string {
	name = strings.TrimSpace(name)
	if !strings.HasPrefix(name, customRelayTokenPrefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(name, customRelayTokenPrefix))
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

func (s *CustomRelayConfigService) Config(ownerID, id string) (CustomRelayConfig, error) {
	ownerID = strings.TrimSpace(ownerID)
	id = strings.TrimSpace(id)
	if ownerID == "" {
		return CustomRelayConfig{}, fmt.Errorf("owner_id is required")
	}
	if id == "" {
		return CustomRelayConfig{}, fmt.Errorf("custom relay config id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return CustomRelayConfig{}, err
	}
	return configs[id], nil
}

func (s *CustomRelayConfigService) Statuses(ownerID string) ([]CustomRelayConfigStatus, error) {
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
	statuses := make([]CustomRelayConfigStatus, 0, len(configs))
	for _, config := range configs {
		statuses = append(statuses, customRelayConfigStatus(config))
	}
	sort.Slice(statuses, func(i, j int) bool {
		if statuses[i].Kind != statuses[j].Kind {
			return statuses[i].Kind < statuses[j].Kind
		}
		if !strings.EqualFold(statuses[i].Name, statuses[j].Name) {
			return strings.ToLower(statuses[i].Name) < strings.ToLower(statuses[j].Name)
		}
		return statuses[i].ID < statuses[j].ID
	})
	return statuses, nil
}

func (s *CustomRelayConfigService) Create(ownerID, kind, name, baseURL, apiKey string) (CustomRelayConfigStatus, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("owner_id is required")
	}
	config, err := normalizeCustomRelayConfig(CustomRelayConfig{ID: util.NewUUID(), Kind: kind, Name: name, BaseURL: baseURL, APIKey: apiKey})
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	if len(configs) >= maxCustomRelayConfigs {
		return CustomRelayConfigStatus{}, fmt.Errorf("自定义 API 配置最多支持 %d 条", maxCustomRelayConfigs)
	}
	configs[config.ID] = config
	if err := s.saveLocked(ownerID, configs); err != nil {
		return CustomRelayConfigStatus{}, err
	}
	return customRelayConfigStatus(config), nil
}

func (s *CustomRelayConfigService) Update(ownerID, id, name, baseURL, apiKey string) (CustomRelayConfigStatus, error) {
	ownerID = strings.TrimSpace(ownerID)
	id = strings.TrimSpace(id)
	if ownerID == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("owner_id is required")
	}
	if id == "" {
		return CustomRelayConfigStatus{}, fmt.Errorf("custom relay config id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	current, exists := configs[id]
	if !exists {
		return CustomRelayConfigStatus{}, fmt.Errorf("custom relay config was not found")
	}
	if strings.TrimSpace(apiKey) == "" {
		apiKey = current.APIKey
	}
	config, err := normalizeCustomRelayConfig(CustomRelayConfig{ID: id, Kind: current.Kind, Name: name, BaseURL: baseURL, APIKey: apiKey})
	if err != nil {
		return CustomRelayConfigStatus{}, err
	}
	configs[id] = config
	if err := s.saveLocked(ownerID, configs); err != nil {
		return CustomRelayConfigStatus{}, err
	}
	return customRelayConfigStatus(config), nil
}

func (s *CustomRelayConfigService) Delete(ownerID, id string) error {
	ownerID = strings.TrimSpace(ownerID)
	id = strings.TrimSpace(id)
	if ownerID == "" {
		return fmt.Errorf("owner_id is required")
	}
	if id == "" {
		return fmt.Errorf("custom relay config id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.loadLocked(ownerID)
	if err != nil {
		return err
	}
	delete(configs, id)
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
	configs := make(map[string]CustomRelayConfig)
	for key, value := range util.StringMap(raw) {
		item := util.StringMap(value)
		config, normalizeErr := normalizeCustomRelayConfig(CustomRelayConfig{
			ID: key, Kind: util.Clean(item["kind"]), Name: util.Clean(item["name"]),
			BaseURL: util.Clean(item["base_url"]), APIKey: util.Clean(item["api_key"]),
		})
		if normalizeErr == nil {
			configs[config.ID] = config
		}
	}
	return configs, nil
}

func (s *CustomRelayConfigService) saveLocked(ownerID string, configs map[string]CustomRelayConfig) error {
	return saveStoredJSON(s.store, customRelayConfigDocumentName(ownerID), configs)
}

func customRelayConfigDocumentName(ownerID string) string {
	return customRelayConfigDocumentDir + "/" + util.SHA256Hex(strings.TrimSpace(ownerID)) + ".json"
}

func customRelayConfigStatus(config CustomRelayConfig) CustomRelayConfigStatus {
	configured := config.BaseURL != "" && config.APIKey != ""
	return CustomRelayConfigStatus{
		ID: config.ID, Kind: config.Kind, Name: config.Name, TokenName: CustomRelayTokenName(config.ID),
		BaseURL: config.BaseURL, HasKey: config.APIKey != "", Configured: configured,
	}
}

func normalizeCustomRelayConfig(config CustomRelayConfig) (CustomRelayConfig, error) {
	config.ID = strings.TrimSpace(config.ID)
	config.Kind = NormalizeCustomRelayKind(config.Kind)
	config.Name = strings.TrimSpace(config.Name)
	config.APIKey = strings.TrimSpace(config.APIKey)
	if config.ID == "" || config.Kind == "" {
		return CustomRelayConfig{}, fmt.Errorf("custom relay config is invalid")
	}
	if config.Name == "" {
		return CustomRelayConfig{}, fmt.Errorf("配置名称不能为空")
	}
	if len([]rune(config.Name)) > 100 {
		return CustomRelayConfig{}, fmt.Errorf("配置名称不能超过 100 个字符")
	}
	baseURL, err := normalizeCustomRelayBaseURL(config.BaseURL)
	if err != nil {
		return CustomRelayConfig{}, err
	}
	config.BaseURL = baseURL
	if config.APIKey == "" {
		return CustomRelayConfig{}, fmt.Errorf("API Key is required")
	}
	if len(config.APIKey) > maxCustomRelayAPIKeyLength {
		return CustomRelayConfig{}, fmt.Errorf("API Key is too long")
	}
	return config, nil
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
