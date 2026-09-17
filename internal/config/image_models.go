package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"chatgpt2api/internal/model"
)

func decodeImageModelDefinitions(value any) (map[string]model.ImageModelDefinition, error) {
	definitions := map[string]model.ImageModelDefinition{}
	if value == nil {
		return definitions, nil
	}
	var data []byte
	var err error
	if text, ok := value.(string); ok {
		data = []byte(text)
	} else {
		data, err = json.Marshal(value)
	}
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&definitions); err != nil {
		return nil, fmt.Errorf("图片模型配置无效: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("图片模型配置必须是单个 JSON 对象")
	}
	if definitions == nil {
		return nil, fmt.Errorf("图片模型配置必须是对象")
	}
	for name, definition := range definitions {
		if definition.AspectRatios == nil {
			definition.AspectRatios = []string{}
		}
		if definition.Resolutions == nil {
			definition.Resolutions = []string{}
		}
		if definition.QualityValues == nil {
			definition.QualityValues = []string{}
		}
		definitions[name] = definition
		if name == "" || name != strings.TrimSpace(name) {
			return nil, fmt.Errorf("图片模型名称不能为空或包含首尾空格")
		}
		if err := validateImageModelDefinition(definition); err != nil {
			return nil, fmt.Errorf("图片模型 %s: %w", name, err)
		}
	}
	return definitions, nil
}

func validateImageModelDefinition(d model.ImageModelDefinition) error {
	switch d.Protocol {
	case "openai-image", "google-gemini-image", "xai-image":
	default:
		return fmt.Errorf("不支持的图片协议 %q", d.Protocol)
	}
	if d.MaxReferenceImages < 0 || d.MaxReferenceImages > 100 || d.MaxOutputCount < 1 || d.MaxOutputCount > 15 {
		return fmt.Errorf("参考图数量必须为 0-100，生成数量必须为 1-15")
	}
	if d.Protocol != "openai-image" && (d.Mask || d.OutputControls || d.ExactDimensions) {
		return fmt.Errorf("当前协议不支持遮罩、输出格式或精确尺寸控制")
	}
	if d.Mask && d.MaxReferenceImages == 0 {
		return fmt.Errorf("遮罩编辑需要支持参考图")
	}
	if d.Protocol == "google-gemini-image" && (d.Streaming || len(d.QualityValues) > 0) {
		return fmt.Errorf("Gemini 协议使用分辨率控制，不支持流式或质量档位")
	}
	for _, ratio := range d.AspectRatios {
		parts := strings.Split(ratio, ":")
		if len(parts) != 2 {
			return fmt.Errorf("无效的画幅比例 %q", ratio)
		}
		for _, part := range parts {
			v, err := strconv.ParseFloat(part, 64)
			if err != nil || !(v > 0 && v <= 100) {
				return fmt.Errorf("无效的画幅比例 %q", ratio)
			}
		}
	}
	for _, resolution := range d.Resolutions {
		switch resolution {
		case "512", "1k", "2k", "4k", "1080p":
		default:
			return fmt.Errorf("无效的分辨率 %q", resolution)
		}
		if d.Protocol == "google-gemini-image" && resolution == "1080p" {
			return fmt.Errorf("Gemini 协议不支持 1080p 分辨率参数")
		}
	}
	for _, quality := range d.QualityValues {
		if quality != "low" && quality != "medium" && quality != "high" {
			return fmt.Errorf("无效的质量档位 %q", quality)
		}
	}
	return nil
}

func (s *Store) ImageModelDefinitions() map[string]model.ImageModelDefinition {
	definitions, _ := decodeImageModelDefinitions(s.settingValue("image_model_definitions", nil))
	if definitions == nil {
		return map[string]model.ImageModelDefinition{}
	}
	return definitions
}
