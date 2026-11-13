package service

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
)

// CanvasAgentVideoModel contains public capabilities and internal model defaults.
type CanvasAgentVideoModel struct {
	Model        string         `json:"model"`
	Capabilities map[string]any `json:"capabilities"`
	Defaults     map[string]any `json:"-"`
}

// SetVideoModels supplies the configured model list, never a browser-provided list.
func (s *CanvasAgentService) SetVideoModels(models func() []CanvasAgentVideoModel) {
	s.videoModels = models
}

func (s *CanvasAgentService) videoModel(model string) (CanvasAgentVideoModel, bool) {
	if s.videoModels != nil {
		for _, entry := range s.videoModels() {
			if entry.Model == model {
				return entry, true
			}
		}
	}
	return CanvasAgentVideoModel{}, false
}

func canvasAgentConfiguredVideoModel(doc CanvasDocument) string {
	var config struct {
		VideoModel string `json:"videoModel"`
	}
	_ = json.Unmarshal(doc.AgentConfig, &config)
	return strings.TrimSpace(config.VideoModel)
}

func (w *canvasAgentWorker) refreshVideoGenerationConfig() {
	if w.service == nil || w.service.videoModels == nil {
		return
	}
	if w.req.Generation == nil {
		w.req.Generation = map[string]any{}
	}
	model := canvasAgentConfiguredVideoModel(w.doc)
	if model == "" {
		model = util.Clean(w.req.Generation["videoModel"])
	}
	entry, available := w.service.videoModel(model)
	capabilities := entry.Capabilities
	if !available {
		capabilities = map[string]any{"contractConfigured": false, "audioControl": "unknown"}
	}
	w.req.Generation["videoModel"] = model
	caps := agentMap(w.req.Generation["capabilities"])
	caps["video"] = capabilities
	w.req.Generation["capabilities"] = caps
	w.req.Generation["videoSupportsAudio"] = nil
	if capabilities["contractConfigured"] == true {
		w.req.Generation["videoSupportsAudio"] = capabilities["audioControl"] != "none"
		for key, value := range entry.Defaults {
			w.req.Generation[key] = value
		}
	}
}

func (w *canvasAgentWorker) videoModelTool(name string, args map[string]any) map[string]any {
	if w.service == nil || w.service.videoModels == nil {
		return agentError("video_models_unavailable", "无法读取服务端视频模型列表")
	}
	models := w.service.videoModels()
	if name == "list_video_models" {
		items := make([]map[string]any, 0, len(models))
		for _, entry := range models {
			items = append(items, map[string]any{"model": entry.Model, "capabilities": entry.Capabilities})
		}
		return map[string]any{"ok": true, "currentModel": w.req.Generation["videoModel"], "models": items}
	}
	model := util.Clean(args["model"])
	entry, available := w.service.videoModel(model)
	if !available {
		return agentError("video_model_unavailable", "此视频模型不在服务端可用列表中，请先调用 list_video_models")
	}
	if entry.Capabilities["contractConfigured"] != true {
		return agentError("video_contract_missing", "此视频模型未配置启用的契约，声音能力未知；请先在视频模型契约设置中配置，不能推断为不支持声音")
	}
	config := map[string]any{}
	if len(w.doc.AgentConfig) > 0 {
		if err := json.Unmarshal(w.doc.AgentConfig, &config); err != nil {
			return agentError("invalid_agent_config", "当前画布模型配置无法读取")
		}
	}
	if config == nil {
		config = map[string]any{}
	}
	config["videoModel"] = model
	w.doc.AgentConfig, _ = json.Marshal(config)
	w.refreshVideoGenerationConfig()
	return map[string]any{"ok": true, "model": model, "scope": "canvas", "capabilities": agentMap(w.req.Generation["capabilities"])["video"], "submitted": false}
}

func normalizeCanvasAgentVideoParameters(capabilities map[string]any, input map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(capabilities["parameters"])
	if err != nil {
		return nil, err
	}
	var declarations []struct {
		Name      string   `json:"name"`
		Label     string   `json:"label"`
		Type      string   `json:"type"`
		Required  bool     `json:"required"`
		Default   any      `json:"default"`
		Enum      []string `json:"enum"`
		Minimum   *float64 `json:"minimum"`
		Maximum   *float64 `json:"maximum"`
		MaxLength int      `json:"max_length"`
		Format    string   `json:"format"`
		Modes     []string `json:"modes"`
	}
	if err := json.Unmarshal(encoded, &declarations); err != nil {
		return nil, fmt.Errorf("视频模型参数契约无效")
	}
	mode := util.Clean(capabilities["defaultMode"])
	if mode == "" {
		mode = "text"
	}
	output := make(map[string]any, len(input)+len(declarations))
	allowed := make(map[string]bool, len(declarations))
	for _, declaration := range declarations {
		if len(declaration.Modes) > 0 && !slices.Contains(declaration.Modes, mode) {
			continue
		}
		allowed[declaration.Name] = true
		value, present := input[declaration.Name]
		if !present {
			value = declaration.Default
		}
		if value == nil {
			if present || declaration.Required {
				return nil, fmt.Errorf("请填写参数 %s（%s）", declaration.Label, declaration.Name)
			}
			continue
		}
		if err := validateCanvasAgentVideoParameter(declaration.Name, declaration.Type, declaration.Required, declaration.Enum, declaration.Minimum, declaration.Maximum, declaration.MaxLength, declaration.Format, value); err != nil {
			return nil, err
		}
		output[declaration.Name] = value
	}
	for name := range input {
		if !allowed[name] {
			return nil, fmt.Errorf("当前模型或模式未声明参数 %s", name)
		}
	}
	return output, nil
}

func validateCanvasAgentVideoParameter(name, kind string, required bool, enum []string, minimum, maximum *float64, maxLength int, format string, value any) error {
	invalid := func() error {
		return fmt.Errorf("参数 %s 的值不符合声明的 %s 类型、范围或枚举", name, kind)
	}
	switch kind {
	case "integer", "number":
		var number float64
		switch typed := value.(type) {
		case float64:
			number = typed
		case int:
			number = float64(typed)
		case int64:
			number = float64(typed)
		default:
			return invalid()
		}
		if math.IsNaN(number) || math.IsInf(number, 0) || math.Abs(number) > 9007199254740991 || kind == "integer" && math.Trunc(number) != number || minimum != nil && number < *minimum || maximum != nil && number > *maximum {
			return invalid()
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return invalid()
		}
	case "string":
		text, ok := value.(string)
		if !ok || required && strings.TrimSpace(text) == "" || maxLength > 0 && len([]rune(text)) > maxLength || len(enum) > 0 && !slices.Contains(enum, text) {
			return invalid()
		}
		if format == "uri" {
			parsed, err := url.Parse(text)
			if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || strings.ContainsAny(text, "\r\n\t ") {
				return invalid()
			}
		}
	default:
		return invalid()
	}
	return nil
}
