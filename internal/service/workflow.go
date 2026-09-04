package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	workflowDocumentName       = "creative_workflows.json"
	workflowSaveAttempts       = 3
	maxWorkflowsPerOwner       = 200
	maxWorkflowVariables       = 100
	maxWorkflowVariableOptions = 200
	maxWorkflowNameRunes       = 200
	maxWorkflowPayloadBytes    = 512 << 10
)

var invalidWorkflowTemplateVariableKeyCharacterRE = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

var (
	ErrWorkflowNotFound     = errors.New("workflow not found")
	ErrWorkflowAccessDenied = errors.New("workflow access denied")
)

type WorkflowValidationError struct {
	Message string
}

func (e WorkflowValidationError) Error() string { return e.Message }

type WorkflowStorageError struct {
	Err error
}

func (e *WorkflowStorageError) Error() string {
	return "workflow storage: " + e.Err.Error()
}

func (e *WorkflowStorageError) Unwrap() error {
	return e.Err
}

func workflowValidationError(message string, args ...any) error {
	return WorkflowValidationError{Message: fmt.Sprintf(message, args...)}
}

func workflowStorageError(err error) error {
	if err == nil {
		return nil
	}
	var storageErr *WorkflowStorageError
	if errors.As(err, &storageErr) {
		return err
	}
	return &WorkflowStorageError{Err: err}
}

type WorkflowVariable struct {
	ID           string   `json:"id"`
	Key          string   `json:"key"`
	Label        string   `json:"label"`
	Type         string   `json:"type"`
	Required     bool     `json:"required"`
	DefaultValue string   `json:"default_value,omitempty"`
	Options      []string `json:"options"`
	Placeholder  string   `json:"placeholder,omitempty"`
}

type WorkflowGenerationConfig struct {
	Model          string `json:"model,omitempty"`
	ImageModel     string `json:"image_model,omitempty"`
	Quality        string `json:"quality"`
	Size           string `json:"size"`
	Count          string `json:"count"`
	APIMode        string `json:"api_mode"`
	Timeout        string `json:"timeout"`
	SystemPrompt   string `json:"system_prompt,omitempty"`
	PromptTemplate string `json:"prompt_template"`
	NegativePrompt string `json:"negative_prompt"`
}

type WorkflowSeriesConfig struct {
	TargetCount       string `json:"target_count"`
	PromptModel       string `json:"prompt_model,omitempty"`
	PromptChannelID   string `json:"prompt_channel_id,omitempty"`
	PromptInstruction string `json:"prompt_instruction,omitempty"`
	ReviewRequired    bool   `json:"review_required"`
	Concurrency       string `json:"concurrency"`
}

type CreativeWorkflow struct {
	ID           string                   `json:"id"`
	Revision     int64                    `json:"revision"`
	OwnerID      string                   `json:"owner_id"`
	Scope        string                   `json:"scope"`
	Mode         string                   `json:"mode"`
	Name         string                   `json:"name"`
	Category     string                   `json:"category,omitempty"`
	Description  string                   `json:"description,omitempty"`
	Variables    []WorkflowVariable       `json:"variables"`
	Config       WorkflowGenerationConfig `json:"config"`
	SeriesConfig WorkflowSeriesConfig     `json:"series_config"`
	CreatedAt    string                   `json:"created_at"`
	UpdatedAt    string                   `json:"updated_at"`
	LastRunAt    string                   `json:"last_run_at,omitempty"`
	Editable     bool                     `json:"editable"`
}

type WorkflowService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewWorkflowService(backend ...storage.Backend) *WorkflowService {
	return &WorkflowService{store: firstJSONDocumentStore(backend)}
}

func (s *WorkflowService) List(ownerID string) ([]CreativeWorkflow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	return visibleWorkflows(items, ownerID), nil
}

func (s *WorkflowService) InitializeIfEmpty(ownerID string, inputs []CreativeWorkflow) ([]CreativeWorkflow, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return nil, errors.New("owner_id is required")
	}
	if len(inputs) == 0 {
		return nil, workflowValidationError("starter workflows are required")
	}
	if len(inputs) > maxWorkflowsPerOwner {
		return nil, workflowValidationError("每个用户最多保存 %d 个工作流", maxWorkflowsPerOwner)
	}

	now := util.NowISO()
	candidates := make([]CreativeWorkflow, 0, len(inputs))
	for _, input := range inputs {
		candidate := *copyWorkflow(&input)
		candidate.ID = util.NewUUID()
		candidate.OwnerID = ownerID
		candidate.CreatedAt = now
		candidate.UpdatedAt = now
		candidate.LastRunAt = ""
		candidate.Revision = 1
		candidate.Editable = true
		if err := normalizeWorkflow(&candidate); err != nil {
			return nil, err
		}
		if err := validateWorkflowSaveLimits(candidate); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < workflowSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return nil, err
		}
		if visible := visibleWorkflows(items, ownerID); len(visible) > 0 {
			return visible, nil
		}
		if workflowOwnerCount(items, ownerID)+len(candidates) > maxWorkflowsPerOwner {
			return nil, workflowValidationError("每个用户最多保存 %d 个工作流", maxWorkflowsPerOwner)
		}
		for _, candidate := range candidates {
			stored := candidate
			stored.Editable = false
			items = append(items, stored)
		}
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < workflowSaveAttempts {
				continue
			}
			return nil, err
		}
		return visibleWorkflows(items, ownerID), nil
	}
	return nil, fmt.Errorf("failed to initialize workflows")
}

func visibleWorkflows(items []CreativeWorkflow, ownerID string) []CreativeWorkflow {
	result := make([]CreativeWorkflow, 0, len(items))
	for _, item := range items {
		if item.OwnerID != ownerID && item.Scope != "public" {
			continue
		}
		item.Editable = item.OwnerID == ownerID
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	return result
}

func (s *WorkflowService) Save(ownerID string, input CreativeWorkflow) (CreativeWorkflow, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return CreativeWorkflow{}, errors.New("owner_id is required")
	}
	input = *copyWorkflow(&input)
	creating := strings.TrimSpace(input.ID) == ""
	if creating {
		input.ID = util.NewUUID()
		input.Revision = 0
	}
	now := util.NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < workflowSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return CreativeWorkflow{}, err
		}
		index, current := workflowByID(items, input.ID)
		if current != nil && current.OwnerID != ownerID {
			return CreativeWorkflow{}, ErrWorkflowAccessDenied
		}
		candidate := input
		if index < 0 {
			if !creating && input.Revision != 0 {
				return CreativeWorkflow{}, workflowConcurrentMutationError(input.ID)
			}
			if workflowOwnerCount(items, ownerID) >= maxWorkflowsPerOwner {
				return CreativeWorkflow{}, workflowValidationError("每个用户最多保存 %d 个工作流", maxWorkflowsPerOwner)
			}
			candidate.OwnerID = ownerID
			candidate.CreatedAt = now
			candidate.UpdatedAt = now
			candidate.LastRunAt = ""
			candidate.Revision = 1
		} else {
			if input.Revision != current.Revision {
				return CreativeWorkflow{}, workflowConcurrentMutationError(input.ID)
			}
			if current.Revision == math.MaxInt64 {
				return CreativeWorkflow{}, errors.New("workflow revision limit reached")
			}
			candidate.OwnerID = current.OwnerID
			candidate.CreatedAt = current.CreatedAt
			candidate.UpdatedAt = latestWorkflowTimestamp(current.UpdatedAt, now)
			candidate.LastRunAt = current.LastRunAt
			candidate.Revision = current.Revision + 1
		}
		candidate.Editable = true
		if err := normalizeWorkflow(&candidate); err != nil {
			return CreativeWorkflow{}, err
		}
		if err := validateWorkflowSaveLimits(candidate); err != nil {
			return CreativeWorkflow{}, err
		}
		stored := candidate
		stored.Editable = false
		if index < 0 {
			items = append(items, stored)
		} else {
			items[index] = stored
		}
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < workflowSaveAttempts {
				continue
			}
			return CreativeWorkflow{}, err
		}
		return candidate, nil
	}
	return CreativeWorkflow{}, fmt.Errorf("failed to save workflow")
}

func (s *WorkflowService) TouchLastRun(ownerID, id, lastRunAt string) (CreativeWorkflow, error) {
	ownerID = strings.TrimSpace(ownerID)
	id = strings.TrimSpace(id)
	if ownerID == "" {
		return CreativeWorkflow{}, errors.New("owner_id is required")
	}
	if id == "" {
		return CreativeWorkflow{}, errors.New("workflow id is required")
	}
	parsedLastRunAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(lastRunAt))
	if err != nil {
		return CreativeWorkflow{}, workflowValidationError("last_run_at must be an RFC3339 timestamp")
	}
	lastRunAt = parsedLastRunAt.UTC().Format(time.RFC3339Nano)

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < workflowSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return CreativeWorkflow{}, err
		}
		index, current := workflowByID(items, id)
		if index < 0 {
			return CreativeWorkflow{}, fmt.Errorf("%w: %q", ErrWorkflowNotFound, id)
		}
		if current.OwnerID != ownerID {
			return CreativeWorkflow{}, ErrWorkflowAccessDenied
		}
		if !workflowTimestampAfter(lastRunAt, current.LastRunAt) {
			result := *copyWorkflow(current)
			result.Editable = true
			return result, nil
		}

		candidate := *copyWorkflow(current)
		candidate.LastRunAt = lastRunAt
		candidate.UpdatedAt = latestWorkflowTimestamp(current.UpdatedAt, lastRunAt)
		candidate.Editable = false
		items[index] = candidate
		if err := s.saveLocked(items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < workflowSaveAttempts {
				continue
			}
			return CreativeWorkflow{}, err
		}
		candidate.Editable = true
		return candidate, nil
	}
	return CreativeWorkflow{}, fmt.Errorf("failed to update workflow last run")
}

func (s *WorkflowService) Delete(ownerID, id string) error {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	var expected *CreativeWorkflow
	for attempt := 0; attempt < workflowSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return err
		}
		_, current := workflowByID(items, id)
		if attempt == 0 {
			if current == nil {
				return nil
			}
			expected = copyWorkflow(current)
		} else if current == nil {
			return nil
		} else if !sameWorkflow(expected, current) {
			return workflowConcurrentMutationError(id)
		}
		if current.OwnerID != ownerID {
			return ErrWorkflowAccessDenied
		}
		next := make([]CreativeWorkflow, 0, len(items))
		for _, item := range items {
			if item.ID != id {
				next = append(next, item)
			}
		}
		if err := s.saveLocked(next); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < workflowSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("failed to delete workflow")
}

func workflowByID(items []CreativeWorkflow, id string) (int, *CreativeWorkflow) {
	for index := range items {
		if items[index].ID == id {
			return index, &items[index]
		}
	}
	return -1, nil
}

func workflowOwnerCount(items []CreativeWorkflow, ownerID string) int {
	count := 0
	for i := range items {
		if items[i].OwnerID == ownerID {
			count++
		}
	}
	return count
}

func validateWorkflowSaveLimits(item CreativeWorkflow) error {
	if utf8.RuneCountInString(item.Name) > maxWorkflowNameRunes {
		return workflowValidationError("工作流名称最多支持 %d 个字符", maxWorkflowNameRunes)
	}
	if len(item.Variables) > maxWorkflowVariables {
		return workflowValidationError("每个工作流最多支持 %d 个变量", maxWorkflowVariables)
	}
	for i := range item.Variables {
		if len(item.Variables[i].Options) > maxWorkflowVariableOptions {
			return workflowValidationError("第 %d 个工作流变量最多支持 %d 个选项", i+1, maxWorkflowVariableOptions)
		}
	}
	if workflowTextBytes(item) > maxWorkflowPayloadBytes {
		return workflowValidationError("单个工作流配置不能超过 %d KiB", maxWorkflowPayloadBytes>>10)
	}
	data, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("encode workflow: %w", err)
	}
	if len(data) > maxWorkflowPayloadBytes {
		return workflowValidationError("单个工作流配置不能超过 %d KiB", maxWorkflowPayloadBytes>>10)
	}
	return nil
}

func workflowTextBytes(item CreativeWorkflow) int {
	total := len(item.ID) + len(item.OwnerID) + len(item.Scope) + len(item.Mode) + len(item.Name) + len(item.Category) + len(item.Description)
	total += len(item.CreatedAt) + len(item.UpdatedAt) + len(item.LastRunAt)
	total += len(item.Config.Model) + len(item.Config.ImageModel) + len(item.Config.Quality) + len(item.Config.Size)
	total += len(item.Config.Count) + len(item.Config.APIMode) + len(item.Config.Timeout) + len(item.Config.SystemPrompt)
	total += len(item.Config.PromptTemplate) + len(item.Config.NegativePrompt)
	total += len(item.SeriesConfig.TargetCount) + len(item.SeriesConfig.PromptModel) + len(item.SeriesConfig.PromptChannelID)
	total += len(item.SeriesConfig.PromptInstruction) + len(item.SeriesConfig.Concurrency)
	for i := range item.Variables {
		variable := item.Variables[i]
		total += len(variable.ID) + len(variable.Key) + len(variable.Label) + len(variable.Type)
		total += len(variable.DefaultValue) + len(variable.Placeholder)
		for _, option := range variable.Options {
			total += len(option)
		}
	}
	return total
}

func copyWorkflow(item *CreativeWorkflow) *CreativeWorkflow {
	if item == nil {
		return nil
	}
	cloned := *item
	if item.Variables != nil {
		cloned.Variables = make([]WorkflowVariable, len(item.Variables))
		copy(cloned.Variables, item.Variables)
	}
	for index := range cloned.Variables {
		if item.Variables[index].Options != nil {
			cloned.Variables[index].Options = make([]string, len(item.Variables[index].Options))
			copy(cloned.Variables[index].Options, item.Variables[index].Options)
		}
	}
	return &cloned
}

func sameWorkflow(expected, current *CreativeWorkflow) bool {
	if expected == nil || current == nil {
		return expected == current
	}
	return reflect.DeepEqual(*expected, *current)
}

func workflowConcurrentMutationError(id string) error {
	return fmt.Errorf("%w: workflow %q changed during the operation", storage.ErrConcurrentRowUpdate, id)
}

func workflowTimestampAfter(candidate, current string) bool {
	candidateTime, candidateErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(candidate))
	if candidateErr != nil {
		return false
	}
	currentTime, currentErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(current))
	return currentErr != nil || candidateTime.After(currentTime)
}

func latestWorkflowTimestamp(current, candidate string) string {
	if workflowTimestampAfter(candidate, current) {
		return candidate
	}
	return current
}

func normalizeWorkflow(item *CreativeWorkflow) error {
	item.Name = strings.TrimSpace(item.Name)
	item.Category = strings.TrimSpace(item.Category)
	item.Description = strings.TrimSpace(item.Description)
	if item.Name == "" {
		return workflowValidationError("请输入工作流名称")
	}
	if strings.EqualFold(strings.TrimSpace(item.Scope), "public") {
		item.Scope = "public"
	} else {
		item.Scope = "private"
	}
	if item.Mode != "multi_image_series" {
		item.Mode = "single_image"
	}
	if err := normalizeWorkflowVariables(item.Variables); err != nil {
		return err
	}
	item.Config.PromptTemplate = strings.TrimSpace(item.Config.PromptTemplate)
	normalizeWorkflowConfig(&item.Config)
	normalizeSeriesConfig(&item.SeriesConfig)
	return nil
}

func normalizeWorkflowVariables(variables []WorkflowVariable) error {
	keyIndexes := make(map[string]int, len(variables))
	idIndexes := make(map[string]int, len(variables))
	for i := range variables {
		variable := &variables[i]
		variable.ID = strings.TrimSpace(variable.ID)
		if variable.ID == "" {
			variable.ID = util.NewUUID()
		}
		variable.Key = strings.TrimSpace(variable.Key)
		if variable.Key == "" {
			return workflowValidationError("第 %d 个工作流变量缺少变量名", i+1)
		}
		if sanitizeWorkflowTemplateVariableKey(variable.Key) != variable.Key {
			return workflowValidationError("工作流变量名 %q 只能包含字母、数字、下划线、点和连字符", variable.Key)
		}
		if previous, exists := keyIndexes[variable.Key]; exists {
			return workflowValidationError("工作流变量名 %q 重复（第 %d 和第 %d 个变量）", variable.Key, previous+1, i+1)
		}
		keyIndexes[variable.Key] = i
		if previous, exists := idIndexes[variable.ID]; exists {
			return workflowValidationError("工作流变量 ID %q 重复（第 %d 和第 %d 个变量）", variable.ID, previous+1, i+1)
		}
		idIndexes[variable.ID] = i

		variable.Label = strings.TrimSpace(variable.Label)
		variable.Type = strings.ToLower(strings.TrimSpace(variable.Type))
		if variable.Label == "" {
			variable.Label = variable.Key
		}
		switch variable.Type {
		case "text", "textarea", "select", "number", "boolean":
		default:
			variable.Type = "text"
		}
		if variable.Options == nil {
			variable.Options = []string{}
		}
	}
	return nil
}

func sanitizeWorkflowTemplateVariableKey(value string) string {
	return invalidWorkflowTemplateVariableKeyCharacterRE.ReplaceAllString(value, "_")
}

func normalizeWorkflowConfig(config *WorkflowGenerationConfig) {
	if config.ImageModel == "" {
		config.ImageModel = config.Model
	}
	if config.Model == "" {
		config.Model = config.ImageModel
	}
	if config.Quality == "" {
		config.Quality = "auto"
	}
	if config.Size == "" {
		config.Size = "auto"
	}
	if config.APIMode == "" {
		config.APIMode = "images"
	}
	if config.Count == "" {
		config.Count = "1"
	}
	if config.Timeout == "" {
		config.Timeout = "600"
	}
}

func normalizeSeriesConfig(config *WorkflowSeriesConfig) {
	if config.TargetCount == "" {
		config.TargetCount = "4"
	}
	if config.Concurrency == "" {
		config.Concurrency = "3"
	}
}

func (s *WorkflowService) loadLocked() ([]CreativeWorkflow, error) {
	raw, err := loadStoredJSON(s.store, workflowDocumentName)
	if err != nil || raw == nil {
		return []CreativeWorkflow{}, workflowStorageError(err)
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, workflowStorageError(err)
	}
	var document struct {
		Items []CreativeWorkflow `json:"items"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, workflowStorageError(err)
	}
	if document.Items == nil {
		document.Items = []CreativeWorkflow{}
	}
	for i := range document.Items {
		if document.Items[i].Revision <= 0 {
			document.Items[i].Revision = 1
		}
		if err := normalizeWorkflow(&document.Items[i]); err != nil {
			identifier := strings.TrimSpace(document.Items[i].ID)
			if identifier == "" {
				identifier = fmt.Sprintf("第 %d 条", i+1)
			}
			return nil, workflowStorageError(fmt.Errorf("工作流 %s 的存储数据无效: %w", identifier, err))
		}
	}
	return document.Items, nil
}

func (s *WorkflowService) saveLocked(items []CreativeWorkflow) error {
	if items == nil {
		items = []CreativeWorkflow{}
	}
	return workflowStorageError(saveStoredJSON(s.store, workflowDocumentName, map[string]any{"version": 3, "items": items}))
}
