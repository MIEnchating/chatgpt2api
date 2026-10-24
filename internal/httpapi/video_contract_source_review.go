package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"

	"chatgpt2api/internal/protocol"
)

type videoSourceForm struct {
	Template   string `json:"template_id"`
	Parameters struct {
		Required []string `json:"required"`
	} `json:"parameters"`
	Example struct {
		Model string `json:"model"`
	} `json:"example"`
}

// Catalog JSON remains independently inspectable after it is assembled into
// model input. Do not trust generated evidence to enumerate the source models.
func reviewVideoSourceRequirements(source string, contracts []protocol.VideoModelContract) (map[string][]string, error) {
	issues := map[string][]string{}
	var visit func(map[string]json.RawMessage) error
	visit = func(document map[string]json.RawMessage) error {
		if raw := document["data"]; len(raw) > 0 {
			var data map[string]json.RawMessage
			if json.Unmarshal(raw, &data) == nil {
				if err := visit(data); err != nil {
					return err
				}
			}
		}
		var modelType string
		_ = json.Unmarshal(document["model_type"], &modelType)
		if modelType != "video" {
			return nil
		}
		var endpoints []struct {
			Method string            `json:"method"`
			Forms  []videoSourceForm `json:"forms"`
		}
		if json.Unmarshal(document["endpoints"], &endpoints) != nil {
			return nil
		}
		for _, endpoint := range endpoints {
			if endpoint.Method != "POST" {
				continue
			}
			for _, form := range endpoint.Forms {
				model := form.Example.Model
				if model == "" {
					continue
				}
				var effective protocol.VideoModelContract
				found := false
				for _, contract := range contracts {
					if resolved, ok := protocol.ResolveVideoModelContract(contract, model); ok {
						effective, found = resolved, true
						break
					}
				}
				if !found {
					return fmt.Errorf("源文档模型 %q 未生成契约，请补齐，不得跳过模型", model)
				}
				kind := ""
				for _, candidate := range []string{"text", "image", "reference"} {
					if strings.HasSuffix(form.Template, candidate+"_to_video") {
						kind = candidate
					}
				}
				if kind != "" {
					if _, ok := protocol.VideoContractModeForKind(effective, kind); !ok {
						issues[model] = append(issues[model], model+"：源文档声明的 "+kind+" 模式未覆盖")
					}
				}
				request := effective.Request
				paths := []string{"model", request.DurationField, request.GenerationModeField}
				if effective.Capability.Prompt == nil || effective.Capability.Prompt.Required {
					paths = append(paths, "prompt")
				}
				if effective.Capability.DefaultSize != "" {
					paths = append(paths, request.AspectRatioField)
				}
				if effective.Capability.DefaultResolution != "" {
					paths = append(paths, request.ResolutionField)
				}
				for _, mode := range effective.Generation.Modes {
					if kind != "" && mode.Kind != kind {
						continue
					}
					for _, material := range []struct {
						minimum int
						path    string
					}{
						{mode.Materials.FirstFrame.Min, request.FirstFrameField}, {mode.Materials.LastFrame.Min, request.LastFrameField},
						{mode.Materials.Image.Min, request.ReferenceImagesField}, {mode.Materials.Video.Min, request.ReferenceVideosField}, {mode.Materials.Audio.Min, request.ReferenceAudiosField},
					} {
						if material.minimum > 0 {
							paths = append(paths, material.path)
						}
					}
				}
				if effective.Capability.Watermark {
					paths = append(paths, request.WatermarkField)
				}
				if effective.Capability.AudioControl != "none" {
					paths = append(paths, request.GenerateAudioField)
				}
				for _, parameter := range effective.Capability.Parameters {
					if kind == "" || protocol.VideoParameterActive(parameter, kind) {
						if parameter.Required || parameter.Default != nil {
							paths = append(paths, parameter.Field)
						}
					}
				}
				for _, required := range form.Parameters.Required {
					covered := false
					for _, path := range paths {
						if required == path {
							covered = true
							break
						}
					}
					if !covered {
						issues[model] = append(issues[model], fmt.Sprintf("%s：文档必填字段 %s 未映射或未设为必填", model, required))
					}
				}
			}
		}
		return nil
	}
	for offset := 0; offset < len(source); {
		i := strings.IndexByte(source[offset:], '{')
		if i < 0 {
			break
		}
		offset += i
		decoder := json.NewDecoder(strings.NewReader(source[offset:]))
		var document map[string]json.RawMessage
		if decoder.Decode(&document) != nil {
			offset++
			continue
		}
		offset += int(decoder.InputOffset())
		if err := visit(document); err != nil {
			return nil, err
		}
	}
	for model, values := range issues {
		issues[model] = uniqueTrimmedWarningStrings(values)
	}
	return issues, nil
}
