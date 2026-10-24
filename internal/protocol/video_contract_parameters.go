package protocol

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strings"
	"unicode/utf8"
)

// Parameters are explicitly declared, typed inputs, never an arbitrary body passthrough.
type VideoModelParameter struct {
	Name      string   `json:"name"`
	Label     string   `json:"label"`
	Field     string   `json:"field"`
	Type      string   `json:"type"`
	Required  bool     `json:"required"`
	Default   any      `json:"default,omitempty"`
	Enum      []string `json:"enum,omitempty"`
	Minimum   *float64 `json:"minimum,omitempty"`
	Maximum   *float64 `json:"maximum,omitempty"`
	MaxLength int      `json:"max_length,omitempty"`
	Format    string   `json:"format,omitempty"`
	Modes     []string `json:"modes,omitempty"`
}

type VideoDurationRange struct {
	Min  int  `json:"min"`
	Max  *int `json:"max,omitempty"`
	Step int  `json:"step"`
}

type VideoPromptConstraint struct {
	Required  bool `json:"required"`
	MinLength int  `json:"min_length"`
	MaxLength int  `json:"max_length"`
}

func VideoDurationSupported(cap VideoModelContractCapability, seconds int) bool {
	if r := cap.SecondsRange; r != nil {
		return seconds <= 9007199254740991 && seconds >= r.Min && (r.Max == nil || seconds <= *r.Max) && r.Step > 0 && (seconds-r.Min)%r.Step == 0
	}
	return slices.Contains(cap.Seconds, seconds)
}

func ValidateVideoPrompt(cap VideoModelContractCapability, value any) error {
	rule := cap.Prompt
	if rule == nil {
		rule = &VideoPromptConstraint{Required: true}
	}
	if value == nil && !rule.Required {
		return nil
	}
	prompt, ok := value.(string)
	if !ok || rule.Required && strings.TrimSpace(prompt) == "" {
		return fmt.Errorf("请输入视频提示词")
	}
	length := utf8.RuneCountInString(prompt)
	if length < rule.MinLength || rule.MaxLength > 0 && length > rule.MaxLength {
		return fmt.Errorf("提示词长度不符合契约（至少 %d，最多 %d；0 表示未限制）", rule.MinLength, rule.MaxLength)
	}
	return nil
}

func VideoParameterActive(p VideoModelParameter, mode string) bool {
	return len(p.Modes) == 0 || slices.Contains(p.Modes, mode)
}

func parameterNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

func ValidateVideoParameter(p VideoModelParameter, value any) error {
	invalid := func() error {
		return fmt.Errorf("参数 %s 的值不符合声明的 %s 类型、范围或枚举", p.Name, p.Type)
	}
	switch p.Type {
	case "integer", "number":
		n, ok := parameterNumber(value)
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 9007199254740991 || p.Type == "integer" && math.Trunc(n) != n || p.Minimum != nil && n < *p.Minimum || p.Maximum != nil && n > *p.Maximum {
			return invalid()
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return invalid()
		}
	case "string":
		v, ok := value.(string)
		if !ok || p.Required && strings.TrimSpace(v) == "" || p.MaxLength > 0 && utf8.RuneCountInString(v) > p.MaxLength || len(p.Enum) > 0 && !slices.Contains(p.Enum, v) {
			return invalid()
		}
		if p.Format == "uri" {
			u, err := url.Parse(v)
			if err != nil || u.Hostname() == "" || u.User != nil || u.Scheme != "http" && u.Scheme != "https" || strings.ContainsAny(v, "\r\n\t ") {
				return invalid()
			}
		}
	default:
		return invalid()
	}
	return nil
}

// NormalizeVideoParameters preserves false and zero and rejects undeclared inputs.
func NormalizeVideoParameters(cap VideoModelContractCapability, mode string, input map[string]any) (map[string]any, error) {
	output := make(map[string]any)
	allowed := make(map[string]bool)
	for _, p := range cap.Parameters {
		if !VideoParameterActive(p, mode) {
			continue
		}
		allowed[p.Name] = true
		value, present := input[p.Name]
		if !present {
			value = p.Default
		}
		if value == nil {
			if present || p.Required {
				return nil, fmt.Errorf("请填写参数 %s（%s）", p.Label, p.Name)
			}
			continue
		}
		if err := ValidateVideoParameter(p, value); err != nil {
			return nil, err
		}
		output[p.Name] = value
	}
	for key := range input {
		if !allowed[key] {
			return nil, fmt.Errorf("当前模型或模式未声明参数 %s", key)
		}
	}
	return output, nil
}

func VideoParameterSample(p VideoModelParameter) any {
	if p.Default != nil {
		return p.Default
	}
	switch p.Type {
	case "boolean":
		return false
	case "integer", "number":
		if p.Minimum != nil {
			return *p.Minimum
		}
		if p.Maximum != nil && *p.Maximum < 0 {
			return *p.Maximum
		}
		return 0
	default:
		if len(p.Enum) > 0 {
			return p.Enum[0]
		}
		if p.Format == "uri" {
			return "https://dry-run.invalid/callback"
		}
		return "x"
	}
}

func validateVideoContractParameters(contract VideoModelContract) error {
	cap := contract.Capability
	if r := cap.SecondsRange; r != nil {
		if len(cap.Seconds) != 0 || r.Min < 1 || r.Min > 9007199254740991 || r.Step < 1 || r.Step > 9007199254740991 || r.Max != nil && *r.Max > 9007199254740991 || r.Max != nil && *r.Max < r.Min || !VideoDurationSupported(cap, cap.DefaultSeconds) {
			return fmt.Errorf("时长范围必须有效且与 seconds 枚举互斥，默认时长须在范围内")
		}
	}
	if p := cap.Prompt; p != nil && (p.MinLength < 0 || p.MinLength > 100000 || p.MaxLength < 0 || p.MaxLength > 100000 || p.MaxLength > 0 && p.MinLength > p.MaxLength) {
		return fmt.Errorf("提示词长度约束无效")
	}
	if len(cap.Parameters) > 32 {
		return fmt.Errorf("最多声明 32 个附加参数")
	}
	seen := map[string]bool{}
	for _, p := range cap.Parameters {
		if !videoContractMultipartFieldPattern.MatchString(p.Name) || strings.Contains(p.Name, "[") || !safeVideoParameterPath(p.Name) || !safeVideoParameterPath(p.Field) || strings.TrimSpace(p.Label) == "" || len(p.Label) > 200 || seen[p.Name] {
			return fmt.Errorf("参数 %q 的名称、标签或映射无效或重复", p.Name)
		}
		seen[p.Name] = true
		if !slices.Contains([]string{"integer", "number", "boolean", "string"}, p.Type) {
			return fmt.Errorf("参数 %s 类型无效", p.Name)
		}
		if p.Minimum != nil && (math.IsNaN(*p.Minimum) || math.IsInf(*p.Minimum, 0)) || p.Maximum != nil && (math.IsNaN(*p.Maximum) || math.IsInf(*p.Maximum, 0)) || p.Minimum != nil && p.Maximum != nil && *p.Minimum > *p.Maximum {
			return fmt.Errorf("参数 %s 数值范围无效", p.Name)
		}
		if p.Type == "integer" && (p.Minimum != nil && math.Trunc(*p.Minimum) != *p.Minimum || p.Maximum != nil && math.Trunc(*p.Maximum) != *p.Maximum) {
			return fmt.Errorf("参数 %s 的整数边界无效", p.Name)
		}
		if p.Type != "integer" && p.Type != "number" && (p.Minimum != nil || p.Maximum != nil) || p.Type != "string" && (len(p.Enum) > 0 || p.MaxLength != 0 || p.Format != "") || p.MaxLength < 0 || p.MaxLength > 100000 || len(p.Enum) > 128 || p.Format != "" && p.Format != "uri" {
			return fmt.Errorf("参数 %s 的约束与类型不匹配", p.Name)
		}
		for _, mode := range p.Modes {
			if _, ok := VideoContractModeForKind(contract, mode); !ok {
				return fmt.Errorf("参数 %s 的模式 %s 未声明", p.Name, mode)
			}
		}
		if p.Default != nil {
			if err := ValidateVideoParameter(p, p.Default); err != nil {
				return err
			}
		}
	}
	if contract.Request.ReferenceValueType != "" && contract.Request.ReferenceValueType != "array" && contract.Request.ReferenceValueType != "scalar" {
		return fmt.Errorf("参考素材编码仅支持 array 或 scalar")
	}
	if contract.Request.ReferenceValueType == "scalar" {
		for _, mode := range contract.Generation.Modes {
			if mode.Kind == "reference" && mode.Materials.Total.Max > 1 {
				return fmt.Errorf("单值参考字段每次最多接受一份素材")
			}
		}
	}
	return nil
}

func safeVideoParameterPath(path string) bool {
	if !videoContractRequestPathPattern.MatchString(path) {
		return false
	}
	for _, part := range videoRequestPathSegmentPattern.FindAllString(path, -1) {
		if part == "__proto__" || part == "constructor" || part == "prototype" {
			return false
		}
	}
	return true
}

func validateVideoContractMultipartFields(contract VideoModelContract) error {
	fields := contract.Transport.MultipartFields
	if len(fields) == 0 {
		return nil
	}
	if contract.Transport.LocalMaterial != "multipart" || contract.Transport.MultipartFileField != "" {
		return fmt.Errorf("具名文件路由仅用于 multipart，不能同时配置统一文件字段")
	}
	roles := []string{"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"}
	for role, field := range fields {
		if !slices.Contains(roles, role) || !videoContractMultipartFieldPattern.MatchString(field) {
			return fmt.Errorf("无效的文件路由 %s: %s", role, field)
		}
	}
	for _, mode := range contract.Generation.Modes {
		limits := []int{mode.Materials.FirstFrame.Max, mode.Materials.LastFrame.Max, mode.Materials.Image.Max, mode.Materials.Video.Max, mode.Materials.Audio.Max}
		for i, limit := range limits {
			if limit > 0 && fields[roles[i]] == "" {
				return fmt.Errorf("缺少 %s 的文件路由", roles[i])
			}
		}
		if mode.Kind == "reference" && contract.Request.ReferenceValueType == "scalar" {
			paths := []string{contract.Request.ReferenceImagesField, contract.Request.ReferenceVideosField, contract.Request.ReferenceAudiosField}
			routes := map[string]string{}
			for i, path := range paths {
				if limits[i+2] == 0 || path == "" {
					continue
				}
				field := fields[roles[i+2]]
				if previous, exists := routes[path]; exists && previous != field {
					return fmt.Errorf("共用单值素材字段 %s 的文件路由必须一致", path)
				}
				routes[path] = field
			}
		}
	}
	return nil
}
