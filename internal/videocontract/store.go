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
	videoModelContractStoreVersion  = 8
	oldestVideoModelContractVersion = 3
	maxVideoModelContracts          = 100
	maxVideoModelContractVersions   = 8
	legacyKlingVideoContractDriver  = "kling-videos"
)

type VideoModelContractVersion struct {
	Revision    int                         `json:"revision"`
	Contract    protocol.VideoModelContract `json:"contract"`
	PublishedAt string                      `json:"published_at"`
}

type ManagedVideoModelContract struct {
	ID             string                       `json:"id"`
	Contract       protocol.VideoModelContract  `json:"contract"`
	Draft          *protocol.VideoModelContract `json:"draft,omitempty"`
	DraftEnabled   *bool                        `json:"draft_enabled,omitempty"`
	Enabled        bool                         `json:"enabled"`
	Revision       int                          `json:"revision"`
	Versions       []VideoModelContractVersion  `json:"versions,omitempty"`
	CreatedAt      string                       `json:"created_at"`
	UpdatedAt      string                       `json:"updated_at"`
	DraftUpdatedAt string                       `json:"draft_updated_at,omitempty"`
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
	var lastErr error
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err == nil {
			return applyActiveVideoModelContracts(items)
		}
		if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
			return err
		}
		lastErr = err
	}
	return lastErr
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
		item := ManagedVideoModelContract{ID: util.NewUUID(), Contract: normalized, Enabled: enabled, Revision: 1, CreatedAt: now, UpdatedAt: now}
		item.Versions = appendVideoContractVersion(nil, item.Revision, normalized, now)
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
				items[index].Revision++
				items[index].Versions = appendVideoContractVersion(items[index].Versions, items[index].Revision, value.Contract, now)
				items[index].Draft = nil
				items[index].DraftEnabled = nil
				items[index].DraftUpdatedAt = ""
				items[index].UpdatedAt = now
				updated++
				continue
			}
			if len(items) >= maxVideoModelContracts {
				return 0, 0, fmt.Errorf("视频模型契约最多支持 %d 个", maxVideoModelContracts)
			}
			items = append(items, ManagedVideoModelContract{
				ID: util.NewUUID(), Contract: value.Contract, Enabled: value.Enabled, Revision: 1,
				Versions: appendVideoContractVersion(nil, 1, value.Contract, now), CreatedAt: now, UpdatedAt: now,
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
	var updated ManagedVideoModelContract
	changed, err := s.mutateLocked(refreshActiveVideoModelContracts, "更新视频模型契约失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return items, false, nil
		}
		normalized, err := validateVideoModelContractCandidate(items, id, contract)
		if err != nil {
			return nil, false, err
		}
		items[index].Contract = normalized
		items[index].Enabled = enabled
		now := util.NowISO()
		items[index].Revision++
		items[index].Versions = appendVideoContractVersion(items[index].Versions, items[index].Revision, normalized, now)
		items[index].Draft = nil
		items[index].DraftEnabled = nil
		items[index].DraftUpdatedAt = ""
		items[index].UpdatedAt = now
		updated = items[index]
		return items, true, nil
	})
	if err != nil || !changed {
		return nil, err
	}
	return &updated, nil
}

func (s *VideoModelContractService) SaveDraft(id string, contract protocol.VideoModelContract, enabled bool) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	var updated ManagedVideoModelContract
	changed, err := s.mutateLocked(preserveActiveVideoModelContracts, "保存视频模型契约草稿失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return items, false, nil
		}
		normalized, err := validateVideoModelContractCandidate(items, id, contract)
		if err != nil {
			return nil, false, err
		}
		now := util.NowISO()
		items[index].Draft = &normalized
		items[index].DraftEnabled = &enabled
		items[index].DraftUpdatedAt = now
		updated = items[index]
		return items, true, nil
	})
	if err != nil || !changed {
		return nil, err
	}
	return &updated, nil
}

func (s *VideoModelContractService) Publish(id string, contract *protocol.VideoModelContract, enabled *bool) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	var updated ManagedVideoModelContract
	changed, err := s.mutateLocked(refreshActiveVideoModelContracts, "发布视频模型契约失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return items, false, nil
		}
		candidate := items[index].Draft
		if contract != nil {
			candidate = contract
		}
		if candidate == nil {
			return nil, false, fmt.Errorf("没有可发布的视频模型契约草稿")
		}
		normalized, err := validateVideoModelContractCandidate(items, id, *candidate)
		if err != nil {
			return nil, false, err
		}
		now := util.NowISO()
		items[index].Contract = normalized
		items[index].Revision++
		items[index].Versions = appendVideoContractVersion(items[index].Versions, items[index].Revision, normalized, now)
		items[index].Draft = nil
		items[index].DraftUpdatedAt = ""
		items[index].UpdatedAt = now
		if enabled != nil {
			items[index].Enabled = *enabled
		} else if items[index].DraftEnabled != nil {
			items[index].Enabled = *items[index].DraftEnabled
		}
		items[index].DraftEnabled = nil
		updated = items[index]
		return items, true, nil
	})
	if err != nil || !changed {
		return nil, err
	}
	return &updated, nil
}

func (s *VideoModelContractService) Versions(id string) ([]VideoModelContractVersion, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	index := managedVideoContractIndex(items, id)
	if index < 0 {
		return nil, nil
	}
	versions := append([]VideoModelContractVersion(nil), items[index].Versions...)
	sort.SliceStable(versions, func(i, j int) bool { return versions[i].Revision > versions[j].Revision })
	return versions, nil
}

func (s *VideoModelContractService) Rollback(id string, revision int) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	var updated ManagedVideoModelContract
	changed, err := s.mutateLocked(refreshActiveVideoModelContracts, "回滚视频模型契约失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return items, false, nil
		}
		var target *protocol.VideoModelContract
		for _, version := range items[index].Versions {
			if version.Revision == revision {
				contract := version.Contract
				target = &contract
				break
			}
		}
		if target == nil {
			return nil, false, fmt.Errorf("视频模型契约版本不存在")
		}
		normalized, err := validateVideoModelContractCandidate(items, id, *target)
		if err != nil {
			return nil, false, err
		}
		now := util.NowISO()
		items[index].Contract = normalized
		items[index].Revision++
		items[index].Versions = appendVideoContractVersion(items[index].Versions, items[index].Revision, normalized, now)
		items[index].Draft = nil
		items[index].DraftEnabled = nil
		items[index].DraftUpdatedAt = ""
		items[index].UpdatedAt = now
		updated = items[index]
		return items, true, nil
	})
	if err != nil || !changed {
		return nil, err
	}
	return &updated, nil
}

func (s *VideoModelContractService) SetEnabled(id string, enabled bool) (*ManagedVideoModelContract, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	var updated ManagedVideoModelContract
	changed, err := s.mutateLocked(refreshActiveVideoModelContracts, "更新视频模型契约状态失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return items, false, nil
		}
		items[index].Enabled = enabled
		items[index].UpdatedAt = util.NowISO()
		updated = items[index]
		return items, true, nil
	})
	if err != nil || !changed {
		return nil, err
	}
	return &updated, nil
}

func (s *VideoModelContractService) Delete(id string) (bool, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mutateLocked(refreshActiveVideoModelContracts, "删除视频模型契约失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
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
			return items, false, nil
		}
		return next, true, nil
	})
}

type videoModelContractMutation func([]ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error)

type activeVideoModelContractMutationPolicy bool

const (
	preserveActiveVideoModelContracts activeVideoModelContractMutationPolicy = false
	refreshActiveVideoModelContracts  activeVideoModelContractMutationPolicy = true
)

func (s *VideoModelContractService) mutateLocked(activePolicy activeVideoModelContractMutationPolicy, exhaustedMessage string, mutate videoModelContractMutation) (bool, error) {
	for attempt := 0; attempt < videoModelContractSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return false, err
		}
		next, changed, err := mutate(items)
		if err != nil || !changed {
			return false, err
		}
		if err := s.saveLocked(next); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < videoModelContractSaveAttempts {
				continue
			}
			return false, err
		}
		if activePolicy == refreshActiveVideoModelContracts {
			if err := applyActiveVideoModelContracts(next); err != nil {
				return false, err
			}
		}
		return true, nil
	}
	return false, fmt.Errorf("%s", exhaustedMessage)
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
		if header.Version < 6 {
			migratePreV6ManagedVideoModelContract(&document.Items[index])
		}
		if header.Version < 7 {
			migrateV6ManagedVideoModelContract(&document.Items[index])
		}
		if header.Version < 8 {
			migrateV7ManagedVideoModelContract(&document.Items[index])
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

func migratePreV6ManagedVideoModelContract(item *ManagedVideoModelContract) {
	if item == nil {
		return
	}
	if item.Contract.Artifact.Mode == "" {
		migrateLegacyVideoArtifact(&item.Contract)
	}
	if migrateDefaultMiniMaxH3Rules(&item.Contract) {
		item.UpdatedAt = util.NowISO()
	}
	if item.Draft != nil {
		if item.Draft.Artifact.Mode == "" {
			migrateLegacyVideoArtifact(item.Draft)
		}
		migrateDefaultMiniMaxH3Rules(item.Draft)
	}
	for index := range item.Versions {
		contract := &item.Versions[index].Contract
		if contract.Artifact.Mode == "" {
			migrateLegacyVideoArtifact(contract)
		}
		migrateDefaultMiniMaxH3Rules(contract)
	}
}

func migrateV6ManagedVideoModelContract(item *ManagedVideoModelContract) {
	if item == nil {
		return
	}
	if !migrateV6VideoModelContract(&item.Contract) {
		item.Enabled = false
	}
	if item.Draft != nil && !migrateV6VideoModelContract(item.Draft) {
		disabled := false
		item.DraftEnabled = &disabled
	}
	for index := range item.Versions {
		migrateV6VideoModelContract(&item.Versions[index].Contract)
	}
}

func migrateV7ManagedVideoModelContract(item *ManagedVideoModelContract) {
	if item == nil {
		return
	}
	migrateV7VideoModelContract(&item.Contract)
	if item.Draft != nil {
		migrateV7VideoModelContract(item.Draft)
	}
	for index := range item.Versions {
		migrateV7VideoModelContract(&item.Versions[index].Contract)
	}
}

func migrateV7VideoModelContract(contract *protocol.VideoModelContract) {
	if contract == nil || strings.TrimSpace(contract.Request.DurationValueType) != "" {
		return
	}
	field := strings.ToLower(strings.TrimSpace(contract.Request.DurationField))
	leaf := field
	if index := strings.LastIndexByte(field, '.'); index >= 0 {
		leaf = field[index+1:]
	}
	if contract.Driver == protocol.VideoContractDriverOpenAI || leaf == "seconds" {
		contract.Request.DurationValueType = "string"
		return
	}
	contract.Request.DurationValueType = "number"
}

func migrateV6VideoModelContract(contract *protocol.VideoModelContract) bool {
	if contract == nil {
		return true
	}
	switch {
	case strings.EqualFold(strings.TrimSpace(contract.Driver), "newapi-video"):
		contract.Driver = protocol.VideoContractDriverOpenAI
	case strings.EqualFold(strings.TrimSpace(contract.Driver), legacyKlingVideoContractDriver):
		contract.Driver = protocol.VideoContractDriverKling
	}

	usable := migrateV6VideoContractPaths(contract)
	migrateV6VideoContractModeSelectors(contract)
	for index := range contract.Generation.Modes {
		materials := &contract.Generation.Modes[index].Materials
		minimum := materials.FirstFrame.Min + materials.LastFrame.Min + materials.Image.Min + materials.Video.Min + materials.Audio.Min
		if materials.Total.Max >= minimum {
			continue
		}
		materials.Total.Max = min(minimum, 80)
		if minimum > materials.Total.Max {
			reduceV6VideoMaterialMinimums(materials, minimum-materials.Total.Max)
		}
	}
	for ruleIndex := range contract.Rules {
		rule := &contract.Rules[ruleIndex]
		for field, limit := range rule.Limits {
			if limit == 0 && containsFoldTrimmed(rule.Require, field) {
				delete(rule.Limits, field)
			}
		}
		for field, value := range rule.ForceValues {
			if _, ok := protocol.ParseVideoContractForcedValue(strings.ToLower(strings.TrimSpace(field)), value); !ok {
				delete(rule.ForceValues, field)
			}
		}
	}
	return usable
}

func migrateV6VideoContractPaths(contract *protocol.VideoModelContract) bool {
	createPath := escapeV6VideoPathPlaceholders(contract.Transport.CreatePath, true)
	queryPath := escapeV6VideoPathPlaceholders(contract.Transport.QueryPath, true)
	contract.Artifact.ContentPath = escapeV6VideoPathPlaceholders(contract.Artifact.ContentPath, true)

	if contract.Driver != protocol.VideoContractDriverCustom {
		if (createPath == "") != (queryPath == "") || strings.Contains(createPath, "{task_id}") {
			createPath = ""
			queryPath = ""
		}
		contract.Transport.CreatePath = createPath
		contract.Transport.QueryPath = queryPath
		return true
	}

	if queryPath == "" && createPath != "" {
		if strings.Contains(createPath, "{task_id}") {
			queryPath = createPath
		} else {
			queryPath = strings.TrimRight(createPath, "/") + "/{task_id}"
		}
	}
	if createPath == "" || strings.Contains(createPath, "{task_id}") {
		if derived, ok := v6VideoCreatePathFromQuery(queryPath); ok {
			createPath = derived
		} else if createPath != "" {
			createPath = escapeV6VideoPathPlaceholders(createPath, false)
		} else if queryPath != "" {
			// The old contract could not submit without a create path. Keep the
			// declared query endpoint as a literal, disabled compatibility value.
			createPath = escapeV6VideoPathPlaceholders(queryPath, false)
			contract.Transport.CreatePath = createPath
			contract.Transport.QueryPath = queryPath
			return false
		}
	}
	contract.Transport.CreatePath = createPath
	contract.Transport.QueryPath = queryPath
	return createPath != "" && queryPath != ""
}

func escapeV6VideoPathPlaceholders(value string, preserveTaskID bool) string {
	value = strings.TrimSpace(value)
	const taskMarker = "\x00video-task-id\x00"
	if preserveTaskID {
		value = strings.Replace(value, "{task_id}", taskMarker, 1)
	}
	value = strings.ReplaceAll(value, "{", "%7B")
	value = strings.ReplaceAll(value, "}", "%7D")
	return strings.Replace(value, taskMarker, "{task_id}", 1)
}

func v6VideoCreatePathFromQuery(queryPath string) (string, bool) {
	queryPath = strings.TrimSuffix(strings.TrimSpace(queryPath), "/")
	if !strings.HasSuffix(queryPath, "/{task_id}") {
		return "", false
	}
	createPath := strings.TrimSuffix(queryPath, "/{task_id}")
	if createPath == "" {
		createPath = "/"
	}
	return createPath, true
}

func migrateV6VideoContractModeSelectors(contract *protocol.VideoModelContract) {
	owners := make(map[string]int, len(contract.Generation.Modes)*2)
	for index, mode := range contract.Generation.Modes {
		owners[strings.ToLower(strings.TrimSpace(mode.ID))] = index
	}
	for index := range contract.Generation.Modes {
		mode := &contract.Generation.Modes[index]
		requestValue := strings.ToLower(strings.TrimSpace(mode.RequestValue))
		if requestValue == "" || strings.EqualFold(requestValue, mode.ID) {
			continue
		}
		if owner, exists := owners[requestValue]; exists && owner != index {
			mode.RequestValue = mode.ID
			continue
		}
		owners[requestValue] = index
	}
}

func reduceV6VideoMaterialMinimums(materials *protocol.VideoModelModeMaterials, excess int) {
	minimums := []*int{
		&materials.Audio.Min,
		&materials.Video.Min,
		&materials.Image.Min,
		&materials.LastFrame.Min,
		&materials.FirstFrame.Min,
	}
	for _, minimum := range minimums {
		removed := min(*minimum, excess)
		*minimum -= removed
		excess -= removed
		if excess == 0 {
			return
		}
	}
}

func containsFoldTrimmed(values []string, candidate string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func migrateLegacyVideoArtifact(contract *protocol.VideoModelContract) {
	if contract == nil {
		return
	}
	if strings.EqualFold(strings.TrimSpace(contract.Driver), protocol.VideoContractDriverKling) || strings.EqualFold(strings.TrimSpace(contract.Driver), legacyKlingVideoContractDriver) {
		contract.Artifact = protocol.VideoModelContractArtifact{Mode: "response_url", Auth: "none"}
		return
	}
	contract.Artifact = protocol.VideoModelContractArtifact{
		Mode: "task_content", ContentPath: "/v1/videos/{task_id}/content", Auth: "relay",
	}
}

func migrateDefaultMiniMaxH3Rules(contract *protocol.VideoModelContract) bool {
	if contract == nil {
		return false
	}
	var currentDefault protocol.VideoModelContract
	for _, contract := range protocol.DefaultVideoContracts() {
		if contract.Name == "MiniMax H3 v1.8" {
			currentDefault = contract
			break
		}
	}
	if currentDefault.Name == "" || !isMiniMaxH3Contract(*contract) {
		return false
	}
	legacyRules := []protocol.VideoModelContractRule{{
		When:    protocol.VideoModelContractRuleCondition{Field: "last_frame", Operator: "present"},
		Require: []string{"first_frame"},
		Message: "添加尾帧前必须先添加首帧",
	}}
	if len(contract.Rules) > 0 && !reflect.DeepEqual(contract.Rules, legacyRules) {
		return false
	}
	contract.Rules = currentDefault.Rules
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
			ID: util.NewUUID(), Contract: contract, Enabled: true, Revision: 1,
			Versions: appendVideoContractVersion(nil, 1, contract, now), CreatedAt: now, UpdatedAt: now,
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
		if items[index].Revision < 1 {
			items[index].Revision = 1
		}
		if items[index].Draft != nil {
			draft, draftErr := protocol.NormalizeVideoModelContract(*items[index].Draft)
			if draftErr != nil {
				return nil, fmt.Errorf("契约 %q 草稿无效: %w", items[index].Contract.Name, draftErr)
			}
			items[index].Draft = &draft
		}
		versions := make([]VideoModelContractVersion, 0, min(len(items[index].Versions), maxVideoModelContractVersions))
		seenRevisions := make(map[int]struct{}, len(items[index].Versions))
		for _, version := range items[index].Versions {
			if version.Revision < 1 || version.Revision > items[index].Revision {
				return nil, fmt.Errorf("契约 %q 版本号无效", items[index].Contract.Name)
			}
			if _, exists := seenRevisions[version.Revision]; exists {
				return nil, fmt.Errorf("契约 %q 版本号重复", items[index].Contract.Name)
			}
			seenRevisions[version.Revision] = struct{}{}
			version.Contract, err = protocol.NormalizeVideoModelContract(version.Contract)
			if err != nil {
				return nil, fmt.Errorf("契约 %q 历史版本无效: %w", items[index].Contract.Name, err)
			}
			versions = append(versions, version)
		}
		if len(versions) == 0 {
			publishedAt := items[index].UpdatedAt
			if publishedAt == "" {
				publishedAt = util.NowISO()
			}
			versions = appendVideoContractVersion(nil, items[index].Revision, normalized, publishedAt)
		}
		items[index].Versions = trimVideoContractVersions(versions)
		contracts = append(contracts, normalized)
	}
	if err := protocol.ValidateVideoContracts(contracts); err != nil {
		return nil, err
	}
	return items, nil
}

func managedVideoContractIndex(items []ManagedVideoModelContract, id string) int {
	for index := range items {
		if items[index].ID == id {
			return index
		}
	}
	return -1
}

func appendVideoContractVersion(versions []VideoModelContractVersion, revision int, contract protocol.VideoModelContract, publishedAt string) []VideoModelContractVersion {
	versions = append(versions, VideoModelContractVersion{Revision: revision, Contract: contract, PublishedAt: publishedAt})
	return trimVideoContractVersions(versions)
}

func trimVideoContractVersions(versions []VideoModelContractVersion) []VideoModelContractVersion {
	sort.SliceStable(versions, func(i, j int) bool { return versions[i].Revision < versions[j].Revision })
	if len(versions) > maxVideoModelContractVersions {
		versions = versions[len(versions)-maxVideoModelContractVersions:]
	}
	return append([]VideoModelContractVersion(nil), versions...)
}
