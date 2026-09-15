package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"path"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

var (
	ErrInvalidAgentSkill  = errors.New("invalid agent skill")
	ErrAgentSkillNotFound = errors.New("agent skill not found")
	ErrAgentSkillConflict = errors.New("agent skill revision conflict")
)

type AgentSkill struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Content     string            `json:"content"`
	Files       map[string]string `json:"files,omitempty"`
	Scope       string            `json:"scope"`
	Enabled     bool              `json:"enabled"`
	Revision    int64             `json:"revision"`
	UpdatedAt   string            `json:"updated_at"`
}

type AgentSkillInput struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Content     string            `json:"content"`
	Files       map[string]string `json:"files"`
	Enabled     bool              `json:"enabled"`
	Revision    int64             `json:"revision"`
}

type AgentSkillService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewAgentSkillService(backend storage.Backend) *AgentSkillService {
	return &AgentSkillService{store: jsonDocumentStoreFromBackend(backend)}
}

func (s *AgentSkillService) List(ownerID string, systemOnly bool) ([]AgentSkill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.load("", true)
	if err != nil || systemOnly {
		return items, err
	}
	visible := make([]AgentSkill, 0, len(items))
	for _, item := range items {
		if item.Enabled {
			visible = append(visible, item)
		}
	}
	personal, err := s.load(ownerID, false)
	if err != nil {
		return nil, err
	}
	return append(visible, personal...), nil
}

func (s *AgentSkillService) Get(ownerID, id string, systemOnly bool) (AgentSkill, error) {
	items, err := s.List(ownerID, systemOnly)
	if err != nil {
		return AgentSkill{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return AgentSkill{}, ErrAgentSkillNotFound
}

func (s *AgentSkillService) ReadFile(ownerID, id, filename string) (string, error) {
	if !validAgentSkillPath(filename) {
		return "", fmt.Errorf("%w: 附属文件路径无效", ErrInvalidAgentSkill)
	}
	item, err := s.Get(ownerID, id, false)
	if err != nil {
		return "", err
	}
	content, exists := item.Files[filename]
	if !exists || !item.Enabled {
		return "", ErrAgentSkillNotFound
	}
	return content, nil
}

func (s *AgentSkillService) Save(ownerID, id string, system bool, input AgentSkillInput) (AgentSkill, error) {
	if err := validateAgentSkillInput(input, system); err != nil {
		return AgentSkill{}, err
	}
	if id != "" && input.Revision < 1 {
		return AgentSkill{}, fmt.Errorf("%w: 更新需要当前版本号", ErrInvalidAgentSkill)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		items, err := s.load(ownerID, system)
		if err != nil {
			return AgentSkill{}, err
		}
		item := AgentSkill{Name: strings.TrimSpace(input.Name), Description: strings.TrimSpace(input.Description), Content: input.Content, Files: maps.Clone(input.Files), Enabled: input.Enabled, Revision: 1, UpdatedAt: util.NowISO(), Scope: "personal"}
		if system {
			item.Scope = "system"
		}
		if id == "" {
			if len(items) >= 100 {
				return AgentSkill{}, fmt.Errorf("%w: 最多保存 100 个 Skill", ErrInvalidAgentSkill)
			}
			item.ID = item.Scope + "-" + util.NewHex(16)
			items = append(items, item)
		} else {
			index := slices.IndexFunc(items, func(existing AgentSkill) bool { return existing.ID == id })
			if index < 0 {
				return AgentSkill{}, ErrAgentSkillNotFound
			}
			if items[index].Revision != input.Revision {
				return AgentSkill{}, ErrAgentSkillConflict
			}
			item.ID, item.Revision = id, input.Revision+1
			items[index] = item
		}
		if err := s.store.SaveJSONDocument(agentSkillDocumentName(ownerID, system), map[string]any{"items": items}); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				continue
			}
			return AgentSkill{}, err
		}
		return item, nil
	}
	return AgentSkill{}, ErrAgentSkillConflict
}

func (s *AgentSkillService) Delete(ownerID, id string, system bool, revision int64) error {
	if id == "" || revision < 1 {
		return fmt.Errorf("%w: 删除需要 Skill ID 和版本号", ErrInvalidAgentSkill)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		items, err := s.load(ownerID, system)
		if err != nil {
			return err
		}
		index := slices.IndexFunc(items, func(item AgentSkill) bool { return item.ID == id })
		if index < 0 {
			return ErrAgentSkillNotFound
		}
		if items[index].Revision != revision {
			return ErrAgentSkillConflict
		}
		items = append(items[:index], items[index+1:]...)
		if err := s.store.SaveJSONDocument(agentSkillDocumentName(ownerID, system), map[string]any{"items": items}); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				continue
			}
			return err
		}
		return nil
	}
	return ErrAgentSkillConflict
}

func (s *AgentSkillService) load(ownerID string, system bool) ([]AgentSkill, error) {
	if !system && strings.TrimSpace(ownerID) == "" {
		return nil, fmt.Errorf("%w: owner_id is required", ErrInvalidAgentSkill)
	}
	if s.store == nil {
		return nil, errors.New("agent skill storage is unavailable")
	}
	raw, err := s.store.LoadJSONDocument(agentSkillDocumentName(ownerID, system))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		if system {
			return defaultAgentSkills(), nil
		}
		return []AgentSkill{}, nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var document struct {
		Items *[]AgentSkill `json:"items"`
	}
	if err := json.Unmarshal(encoded, &document); err != nil {
		return nil, err
	}
	if document.Items == nil {
		return nil, errors.New("invalid stored agent skill document: items must be an array")
	}
	return *document.Items, nil
}

func agentSkillDocumentName(ownerID string, system bool) string {
	if system {
		return "agent_skills/system.json"
	}
	digest := sha256.Sum256([]byte(ownerID))
	return "agent_skills/users/" + hex.EncodeToString(digest[:]) + ".json"
}

func validateAgentSkillInput(input AgentSkillInput, system bool) error {
	invalid := func(message string) error { return fmt.Errorf("%w: %s", ErrInvalidAgentSkill, message) }
	if strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > 80 || !utf8.ValidString(input.Name) {
		return invalid("名称不能为空且最多 80 字")
	}
	if utf8.RuneCountInString(input.Description) > 500 || !utf8.ValidString(input.Description) {
		return invalid("说明最多 500 字")
	}
	if strings.TrimSpace(input.Content) == "" || len(input.Content) > 128*1024 || !utf8.ValidString(input.Content) {
		return invalid("正文不能为空且不能超过 128 KiB")
	}
	if !system && len(input.Files) > 0 {
		return invalid("个人 Skill 使用单个 Markdown 文件")
	}
	if len(input.Files) > 30 {
		return invalid("附属文件最多 30 个")
	}
	total := len(input.Content)
	for filename, content := range input.Files {
		if !validAgentSkillPath(filename) || len(content) > 128*1024 || !utf8.ValidString(content) {
			return invalid("附属文件仅允许相对路径的 Markdown 或文本，每个最多 128 KiB")
		}
		total += len(content)
	}
	if total > 512*1024 {
		return invalid("Skill 总大小不能超过 512 KiB")
	}
	return nil
}

func validAgentSkillPath(filename string) bool {
	if filename == "" || len(filename) > 240 || !utf8.ValidString(filename) || strings.ContainsAny(filename, "\\:") || strings.IndexFunc(filename, unicode.IsControl) >= 0 || strings.HasPrefix(filename, "/") || path.Clean(filename) != filename || filename == ".." || strings.HasPrefix(filename, "../") {
		return false
	}
	ext := strings.ToLower(path.Ext(filename))
	return ext == ".md" || ext == ".txt"
}

func defaultAgentSkills() []AgentSkill {
	return []AgentSkill{
		{ID: "system-storyboard", Name: "分镜创作", Description: "将故事目标转成可审阅的剧本和分镜节点。", Content: "先阅读当前画布和用户要求，确认主题、受众、画幅与总时长。将完整剧本保存在文本节点，逐镜描述时间、画面、机位、对白和声音。为角色与场景建立一致性参考。按用户选择的自动生成设置创建或生成媒体；未确认的重大创作选择先询问。需要分镜格式时读取 references/storyboard.md。", Files: map[string]string{"references/storyboard.md": "每个镜头包含：序号、起止时间、主体动作、构图/机位、对白/旁白、环境声、参考节点。相邻镜头总时长连续，人物服饰和场景光线保持一致。"}, Scope: "system", Enabled: true, Revision: 1},
		{ID: "system-product", Name: "产品视觉", Description: "围绕产品参考素材建立一致的商业视觉方案。", Content: "以用户的产品参考为事实来源，先确认用途、受众、画幅、品牌色和必保留细节。不可改写产品商标、包装文字和结构。先给出可选择的视觉方向，再按确认方向创建主视觉及系列图片，保留每张图的来源连线。按当前生成开关决定是否提交媒体任务。", Scope: "system", Enabled: true, Revision: 1},
		{ID: "system-organize", Name: "整理画布", Description: "按创作关系检查并整理节点、连线和分组。", Content: "先查询画布节点和连线，按角色、场景、分镜、成品划分分组。仅在用户要求排列时改变布局，保留所有节点内容和生成参数，不主动删除。说明发现的重复素材、缺失引用和失败任务，并请用户明确需要删除的节点。", Scope: "system", Enabled: true, Revision: 1},
	}
}
