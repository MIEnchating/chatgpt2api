package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const workflowDocumentName = "creative_workflows.json"

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
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return CreativeWorkflow{}, err
	}
	now := util.NowISO()
	index := -1
	for i := range items {
		if input.ID != "" && items[i].ID == input.ID {
			index = i
			if items[i].OwnerID != ownerID {
				return CreativeWorkflow{}, errors.New("只能编辑自己的工作流")
			}
			break
		}
	}
	if index < 0 {
		if strings.TrimSpace(input.ID) == "" {
			input.ID = util.NewUUID()
		}
		input.OwnerID = ownerID
		input.CreatedAt = now
	} else {
		input.OwnerID = items[index].OwnerID
		input.CreatedAt = items[index].CreatedAt
	}
	input.UpdatedAt = now
	input.Editable = true
	if err := normalizeWorkflow(&input); err != nil {
		return CreativeWorkflow{}, err
	}
	stored := input
	stored.Editable = false
	if index < 0 {
		items = append(items, stored)
	} else {
		items[index] = stored
	}
	if err := s.saveLocked(items); err != nil {
		return CreativeWorkflow{}, err
	}
	return input, nil
}

func (s *WorkflowService) Delete(ownerID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return err
	}
	next := make([]CreativeWorkflow, 0, len(items))
	found := false
	for _, item := range items {
		if item.ID != strings.TrimSpace(id) {
			next = append(next, item)
			continue
		}
		found = true
		if item.OwnerID != ownerID {
			return errors.New("只能删除自己的工作流")
		}
	}
	if !found {
		return nil
	}
	return s.saveLocked(next)
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
	for i := range item.Variables {
		variable := &item.Variables[i]
		if variable.ID == "" {
			variable.ID = util.NewUUID()
		}
		variable.Key = sanitizeWorkflowTemplateVariableKey(strings.TrimSpace(variable.Key))
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
	item.Config.PromptTemplate = strings.TrimSpace(item.Config.PromptTemplate)
	normalizeWorkflowConfig(&item.Config)
	normalizeSeriesConfig(&item.SeriesConfig)
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
