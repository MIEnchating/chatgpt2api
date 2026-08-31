package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	workflowDocumentName = "creative_workflows.json"
	workflowSaveAttempts = 3
)

var invalidWorkflowTemplateVariableKeyCharacterRE = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

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
	result := make([]CreativeWorkflow, 0, len(items))
	for _, item := range items {
		if item.OwnerID != ownerID && item.Scope != "public" {
			continue
		}
		item.Editable = item.OwnerID == ownerID
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	return result, nil
}

func (s *WorkflowService) Save(ownerID string, input CreativeWorkflow) (CreativeWorkflow, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return CreativeWorkflow{}, errors.New("owner_id is required")
	}
	input = *copyWorkflow(&input)
	if strings.TrimSpace(input.ID) == "" {
		input.ID = util.NewUUID()
	}
	now := util.NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	var expected *CreativeWorkflow
	for attempt := 0; attempt < workflowSaveAttempts; attempt++ {
		items, err := s.loadLocked()
		if err != nil {
			return CreativeWorkflow{}, err
		}
		index, current := workflowByID(items, input.ID)
		if attempt == 0 {
			expected = copyWorkflow(current)
		} else if !sameWorkflow(expected, current) {
			return CreativeWorkflow{}, workflowConcurrentMutationError(input.ID)
		}
		if current != nil && current.OwnerID != ownerID {
			return CreativeWorkflow{}, errors.New("只能编辑自己的工作流")
		}
		candidate := input
		if index < 0 {
			candidate.OwnerID = ownerID
			candidate.CreatedAt = now
		} else {
			candidate.OwnerID = current.OwnerID
			candidate.CreatedAt = current.CreatedAt
		}
		candidate.UpdatedAt = now
		candidate.Editable = true
		if err := normalizeWorkflow(&candidate); err != nil {
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
			return errors.New("只能删除自己的工作流")
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

func normalizeWorkflow(item *CreativeWorkflow) error {
	item.Name = strings.TrimSpace(item.Name)
	item.Category = strings.TrimSpace(item.Category)
	item.Description = strings.TrimSpace(item.Description)
	if item.Name == "" {
		return errors.New("请输入工作流名称")
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
		variable.Key = sanitizeWorkflowTemplateVariableKey(strings.TrimSpace(variable.Key))
		if variable.Key == "" {
			return fmt.Errorf("第 %d 个工作流变量缺少变量名", i+1)
		}
		if previous, exists := keyIndexes[variable.Key]; exists {
			return fmt.Errorf("工作流变量名 %q 重复（第 %d 和第 %d 个变量）", variable.Key, previous+1, i+1)
		}
		keyIndexes[variable.Key] = i
		if previous, exists := idIndexes[variable.ID]; exists {
			return fmt.Errorf("工作流变量 ID %q 重复（第 %d 和第 %d 个变量）", variable.ID, previous+1, i+1)
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
		return []CreativeWorkflow{}, err
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var document struct {
		Items []CreativeWorkflow `json:"items"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if document.Items == nil {
		document.Items = []CreativeWorkflow{}
	}
	for i := range document.Items {
		if err := normalizeWorkflow(&document.Items[i]); err != nil {
			identifier := strings.TrimSpace(document.Items[i].ID)
			if identifier == "" {
				identifier = fmt.Sprintf("第 %d 条", i+1)
			}
			return nil, fmt.Errorf("工作流 %s 的存储数据无效: %w", identifier, err)
		}
	}
	return document.Items, nil
}

func (s *WorkflowService) saveLocked(items []CreativeWorkflow) error {
	if items == nil {
		items = []CreativeWorkflow{}
	}
	return saveStoredJSON(s.store, workflowDocumentName, map[string]any{"version": 2, "items": items})
}
