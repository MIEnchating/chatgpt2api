package videocontract

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	videoModelContractDocumentName  = "video_model_contracts.json"
	videoModelContractSaveAttempts  = 3
	videoModelContractStoreVersion  = 5
	oldestVideoModelContractVersion = 3
	maxVideoModelContracts          = 100
)

type ManagedVideoModelContract struct {
	ID        string                      `json:"id"`
	Contract  protocol.VideoModelContract `json:"contract"`
	Enabled   bool                        `json:"enabled"`
	CreatedAt string                      `json:"created_at"`
	UpdatedAt string                      `json:"updated_at"`
}

type videoModelContractStoreDocument struct {
	Version int                         `json:"version"`
	Items   []ManagedVideoModelContract `json:"items"`
}

type VideoModelContractService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

type ImportedVideoModelContract struct {
	Contract protocol.VideoModelContract `json:"contract"`
	Enabled  bool                        `json:"enabled"`
}

func NewVideoModelContractService(backend storage.Backend) *VideoModelContractService {
	store, _ := backend.(storage.JSONDocumentBackend)
	return &VideoModelContractService{store: store}
}

func (s *VideoModelContractService) Initialize() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return err
	}
	return applyActiveVideoModelContracts(items)
}

func (s *VideoModelContractService) List() ([]ManagedVideoModelContract, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(items, func(i, j int) bool {
		return strings.ToLower(items[i].Contract.Name) < strings.ToLower(items[j].Contract.Name)
	})
	return items, nil
}

func (s *VideoModelContractService) ValidateCandidate(id string, contract protocol.VideoModelContract) (protocol.VideoModelContract, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return protocol.VideoModelContract{}, err
	}
	return validateVideoModelContractCandidate(items, strings.TrimSpace(id), contract)
}

func (s *VideoModelContractService) Create(contract protocol.VideoModelContract, enabled bool) (ManagedVideoModelContract, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return ManagedVideoModelContract{}, err
		}
		if len(items) >= maxVideoModelContracts {
			return ManagedVideoModelContract{}, fmt.Errorf("视频模型契约最多支持 %d 个", maxVideoModelContracts)
		}
		normalized, err := validateVideoModelContractCandidate(items, "", contract)
		if err != nil {
			return ManagedVideoModelContract{}, err
		}
		now := util.NowISO()
		item := ManagedVideoModelContract{ID: util.NewUUID(), Contract: normalized, Enabled: enabled, CreatedAt: now, UpdatedAt: now}
		items = append(items, item)
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return ManagedVideoModelContract{}, err
		}
		if err := applyActiveVideoModelContracts(items); err != nil {
			return ManagedVideoModelContract{}, err
		}
		return item, nil
	}
	return ManagedVideoModelContract{}, fmt.Errorf("保存视频模型契约失败")
}

func (s *VideoModelContractService) Import(values []ImportedVideoModelContract) (int, int, error) {
	if len(values) == 0 {
		return 0, 0, fmt.Errorf("导入文件中没有视频模型契约")
	}
	if len(values) > maxVideoModelContracts {
		return 0, 0, fmt.Errorf("单次最多导入 %d 个视频模型契约", maxVideoModelContracts)
	}
	normalized := make([]ImportedVideoModelContract, 0, len(values))
	importedContracts := make([]protocol.VideoModelContract, 0, len(values))
	for _, value := range values {
		contract, err := protocol.NormalizeVideoModelContract(value.Contract)
		if err != nil {
			return 0, 0, err
		}
		normalized = append(normalized, ImportedVideoModelContract{Contract: contract, Enabled: value.Enabled})
		importedContracts = append(importedContracts, contract)
	}
	if err := protocol.ValidateVideoContracts(importedContracts); err != nil {
		return 0, 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return 0, 0, err
		}
		created, updated := 0, 0
		now := util.NowISO()
		for _, value := range normalized {
			index := -1
			for current := range items {
				if strings.EqualFold(items[current].Contract.Name, value.Contract.Name) {
					index = current
					break
				}
			}
			if index >= 0 {
				items[index].Contract = value.Contract
				items[index].Enabled = value.Enabled
				items[index].UpdatedAt = now
				updated++
				continue
			}
			if len(items) >= maxVideoModelContracts {
				return 0, 0, fmt.Errorf("视频模型契约最多支持 %d 个", maxVideoModelContracts)
			}
			items = append(items, ManagedVideoModelContract{
				ID: util.NewUUID(), Contract: value.Contract, Enabled: value.Enabled, CreatedAt: now, UpdatedAt: now,
			})
			created++
		}
		validated, err := normalizeManagedVideoModelContracts(items)
		if err != nil {
			return 0, 0, err
		}
		if err := s.saveLocked(validated); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return 0, 0, err
		}
		if err := applyActiveVideoModelContracts(validated); err != nil {
			return 0, 0, err
		}
		return created, updated, nil
	}
	return 0, 0, fmt.Errorf("导入视频模型契约失败")
}

func (s *VideoModelContractService) Update(id string, contract protocol.VideoModelContract, enabled bool) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return nil, err
		}
		index := -1
		for current := range items {
			if items[current].ID == id {
				index = current
				break
			}
		}
		if index < 0 {
			return nil, nil
		}
		normalized, err := validateVideoModelContractCandidate(items, id, contract)
		if err != nil {
			return nil, err
		}
		items[index].Contract = normalized
		items[index].Enabled = enabled
		items[index].UpdatedAt = util.NowISO()
		updated := items[index]
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return nil, err
		}
		if err := applyActiveVideoModelContracts(items); err != nil {
			return nil, err
		}
		return &updated, nil
	}
	return nil, fmt.Errorf("更新视频模型契约失败")
}

func (s *VideoModelContractService) SetEnabled(id string, enabled bool) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return nil, err
		}
		index := -1
		for current := range items {
			if items[current].ID == id {
				index = current
				break
			}
		}
		if index < 0 {
			return nil, nil
		}
		items[index].Enabled = enabled
		items[index].UpdatedAt = util.NowISO()
		updated := items[index]
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return nil, err
		}
		if err := applyActiveVideoModelContracts(items); err != nil {
			return nil, err
		}
		return &updated, nil
	}
	return nil, fmt.Errorf("更新视频模型契约状态失败")
}

func (s *VideoModelContractService) Delete(id string) (bool, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return false, err
		}
		next := make([]ManagedVideoModelContract, 0, len(items))
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
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return false, err
		}
		if err := applyActiveVideoModelContracts(next); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, fmt.Errorf("删除视频模型契约失败")
}

func (s *VideoModelContractService) loadLocked() ([]ManagedVideoModelContract, error) {
	var value any
	var err error
	if s.store != nil {
		value, err = s.store.LoadJSONDocument(videoModelContractDocumentName)
	}
	if err != nil {
		return nil, err
	}
	if value == nil {
		items := defaultManagedVideoModelContracts()
		if err := s.saveLocked(items); err != nil {
			return nil, err
		}
		return items, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return nil, fmt.Errorf("解析视频模型契约失败: %w", err)
	}
	if header.Version < oldestVideoModelContractVersion || header.Version > videoModelContractStoreVersion {
		return nil, fmt.Errorf("不支持的视频模型契约存储版本 %d", header.Version)
	}
	var document videoModelContractStoreDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("解析视频模型契约失败: %w", err)
	}
	migrated := header.Version < videoModelContractStoreVersion
	for index := range document.Items {
		if strings.EqualFold(strings.TrimSpace(document.Items[index].Contract.Driver), "newapi-video") {
			document.Items[index].Contract.Driver = protocol.VideoContractDriverOpenAI
			migrated = true
		} else if strings.EqualFold(strings.TrimSpace(document.Items[index].Contract.Driver), protocol.VideoContractDriverLegacyKling) {
			document.Items[index].Contract.Driver = protocol.VideoContractDriverKling
			migrated = true
		}
		if header.Version < videoModelContractStoreVersion && migrateDefaultMiniMaxH3Rules(&document.Items[index]) {
			migrated = true
		}
	}
	items, err := normalizeManagedVideoModelContracts(document.Items)
	if err != nil {
		return nil, err
	}
	if migrated {
		if err := s.saveLocked(items); err != nil {
			return nil, fmt.Errorf("迁移视频模型契约接口协议失败: %w", err)
		}
	}
	return items, nil
}

func migrateDefaultMiniMaxH3Rules(item *ManagedVideoModelContract) bool {
	var currentDefault protocol.VideoModelContract
	for _, contract := range protocol.DefaultVideoContracts() {
		if contract.Name == "MiniMax H3 v1.8" {
			currentDefault = contract
			break
		}
	}
	if currentDefault.Name == "" || !isMiniMaxH3Contract(item.Contract) {
		return false
	}
	legacyRules := []protocol.VideoModelContractRule{{
		When:    protocol.VideoModelContractRuleCondition{Field: "last_frame", Operator: "present"},
		Require: []string{"first_frame"},
		Message: "添加尾帧前必须先添加首帧",
	}}
	if len(item.Contract.Rules) > 0 && !reflect.DeepEqual(item.Contract.Rules, legacyRules) {
		return false
	}
	item.Contract.Rules = currentDefault.Rules
	item.UpdatedAt = util.NowISO()
	return true
}

func isMiniMaxH3Contract(contract protocol.VideoModelContract) bool {
	for _, model := range contract.Models {
		switch strings.ToLower(strings.TrimSpace(model)) {
		case "minimax-h3-768p", "minimax-h3-768p-enhanced":
			return true
		}
	}
	return false
}

func (s *VideoModelContractService) saveLocked(items []ManagedVideoModelContract) error {
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}
	return s.store.SaveJSONDocument(videoModelContractDocumentName, videoModelContractStoreDocument{Version: videoModelContractStoreVersion, Items: items})
}

func validateVideoModelContractCandidate(items []ManagedVideoModelContract, existingID string, contract protocol.VideoModelContract) (protocol.VideoModelContract, error) {
	normalized, err := protocol.NormalizeVideoModelContract(contract)
	if err != nil {
		return protocol.VideoModelContract{}, err
	}
	contracts := make([]protocol.VideoModelContract, 0, len(items)+1)
	for _, item := range items {
		if item.ID != existingID {
			contracts = append(contracts, item.Contract)
		}
	}
	contracts = append(contracts, normalized)
	if err := protocol.ValidateVideoContracts(contracts); err != nil {
		return protocol.VideoModelContract{}, err
	}
	return normalized, nil
}

func applyActiveVideoModelContracts(items []ManagedVideoModelContract) error {
	contracts := make([]protocol.VideoModelContract, 0, len(items))
	for _, item := range items {
		if item.Enabled {
			contracts = append(contracts, item.Contract)
		}
	}
	return protocol.ReplaceVideoContracts(contracts)
}

func defaultManagedVideoModelContracts() []ManagedVideoModelContract {
	now := util.NowISO()
	contracts := protocol.DefaultVideoContracts()
	items := make([]ManagedVideoModelContract, 0, len(contracts))
	for _, contract := range contracts {
		items = append(items, ManagedVideoModelContract{
			ID: util.NewUUID(), Contract: contract, Enabled: true, CreatedAt: now, UpdatedAt: now,
		})
	}
	return items
}

func normalizeManagedVideoModelContracts(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, error) {
	if len(items) > maxVideoModelContracts {
		return nil, fmt.Errorf("视频模型契约数量超过限制")
	}
	ids := make(map[string]struct{}, len(items))
	contracts := make([]protocol.VideoModelContract, 0, len(items))
	for index := range items {
		items[index].ID = strings.TrimSpace(items[index].ID)
		if items[index].ID == "" {
			items[index].ID = util.NewUUID()
		}
		if _, exists := ids[items[index].ID]; exists {
			return nil, fmt.Errorf("视频模型契约内部 ID 重复")
		}
		ids[items[index].ID] = struct{}{}
		normalized, err := protocol.NormalizeVideoModelContract(items[index].Contract)
		if err != nil {
			return nil, fmt.Errorf("契约 %q 无效: %w", items[index].Contract.Name, err)
		}
		items[index].Contract = normalized
		contracts = append(contracts, normalized)
	}
	if err := protocol.ValidateVideoContracts(contracts); err != nil {
		return nil, err
	}
	return items, nil
}
