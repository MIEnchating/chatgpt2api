package protocol

import (
	"fmt"
	"strconv"
	"strings"
)

type VideoContractDryRunResult struct {
	Contract     string   `json:"contract"`
	Passed       bool     `json:"passed"`
	ModelsTested int      `json:"models_tested"`
	ModesTested  int      `json:"modes_tested"`
	Checks       []string `json:"checks"`
}

// DryRunVideoModelContracts checks generated contracts against representative,
// no-network request constraints before they are shown for review.
func DryRunVideoModelContracts(contracts []VideoModelContract) ([]VideoContractDryRunResult, error) {
	if len(contracts) == 0 {
		return nil, fmt.Errorf("干跑测试没有收到视频模型契约")
	}
	normalized := make([]VideoModelContract, len(contracts))
	for index, contract := range contracts {
		value, err := NormalizeVideoModelContract(contract)
		if err != nil {
			return nil, fmt.Errorf("契约 %q 规范化失败: %w", contract.Name, err)
		}
		normalized[index] = value
	}
	if err := ValidateVideoContracts(normalized); err != nil {
		return nil, fmt.Errorf("契约集合校验失败: %w", err)
	}

	results := make([]VideoContractDryRunResult, 0, len(normalized))
	for _, contract := range normalized {
		result := VideoContractDryRunResult{Contract: contract.Name, Passed: true, Checks: []string{"契约结构、模型与字段映射", "各模型、各生成模式的代表性参数与素材约束", "轮询路径与状态配置"}}
		cases, err := BuildVideoContractDryRunCases(contract)
		if err != nil {
			return nil, err
		}
		result.ModelsTested = len(contract.Models)
		result.ModesTested = len(cases)

		results = append(results, result)
	}
	return results, nil
}

// VideoContractDryRunCase contains canonical inputs and independently checked
// expected values, shared by contract review and generated-plugin execution.
type VideoContractDryRunCase struct {
	Model    string                   `json:"model"`
	Mode     VideoModelGenerationMode `json:"mode"`
	Input    map[string]any           `json:"input"`
	Expected map[string]any           `json:"expected"`
}

func BuildVideoContractDryRunCases(contract VideoModelContract) ([]VideoContractDryRunCase, error) {
	var cases []VideoContractDryRunCase
	for _, pattern := range contract.Models {
		model := strings.ReplaceAll(pattern, "*", "dry-run")
		effective, ok := ResolveVideoModelContract(contract, model)
		if !ok {
			return nil, fmt.Errorf("契约 %q：模型 %q 无法匹配", contract.Name, model)
		}
		for _, mode := range effective.Generation.Modes {
			input, expected, err := dryRunModeSample(effective, mode)
			if err != nil {
				return nil, fmt.Errorf("契约 %q 干跑失败：模型 %q，模式 %q：%w", contract.Name, model, mode.ID, err)
			}
			cases = append(cases, VideoContractDryRunCase{Model: model, Mode: mode, Input: input, Expected: expected})
		}
	}
	return cases, nil
}

func dryRunModeSample(contract VideoModelContract, mode VideoModelGenerationMode) (map[string]any, map[string]any, error) {
	// Explore only material counts relevant to minima, limits and rule triggers.
	// Each mode has at most three active material kinds.
	ranges := []VideoModelMaterialRange{mode.Materials.FirstFrame, mode.Materials.LastFrame, mode.Materials.Image, mode.Materials.Video, mode.Materials.Audio}
	fields := []string{"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"}
	candidates := make([][]int, len(fields))
	for i, r := range ranges {
		add := func(n int) {
			if n < r.Min || n > r.Max {
				return
			}
			for _, existing := range candidates[i] {
				if existing == n {
					return
				}
			}
			candidates[i] = append(candidates[i], n)
		}
		add(r.Min)
		add(1)
		add(r.Max)
		add(mode.Materials.Total.Min)
		for _, rule := range contract.Rules {
			if rule.When.Field == fields[i] && rule.When.Operator == "equals" {
				if n, err := strconv.Atoi(rule.When.Value); err == nil {
					add(n)
				}
			}
			if n, ok := rule.Limits[fields[i]]; ok {
				add(n)
			}
		}
		// Exhaust the bounded range so a valid combined minimum is not missed.
		for n := r.Min; n <= r.Max; n++ {
			add(n)
		}
	}
	counts := make([]int, len(fields))
	var sample, expected map[string]any
	var lastErr error
	var search func(int) bool
	search = func(index int) bool {
		if index < len(fields) {
			total, minimum, maximum := 0, 0, 0
			for _, count := range counts[:index] {
				total += count
			}
			for _, r := range ranges[index:] {
				minimum += r.Min
				maximum += r.Max
			}
			if total+minimum > mode.Materials.Total.Max || total+maximum < mode.Materials.Total.Min {
				return false
			}
			for _, count := range candidates[index] {
				counts[index] = count
				if search(index + 1) {
					return true
				}
			}
			return false
		}
		materials := VideoModelMaterialCounts{FirstFrame: counts[0], LastFrame: counts[1], Image: counts[2], Video: counts[3], Audio: counts[4]}
		if err := ValidateVideoContractModeMaterials(contract, mode.Kind, materials); err != nil {
			return false
		}
		// Match the material-based inference used by the runtime.
		if contract.Request.GenerationModeField == "" && mode.Kind != "text" && counts[0]+counts[1]+counts[2]+counts[3]+counts[4] == 0 {
			return false
		}
		values := map[string]any{
			"duration": contract.Capability.DefaultSeconds, "size": contract.Capability.DefaultSize,
			"resolution": contract.Capability.DefaultResolution, "generate_audio": contract.Capability.AudioControl == "always", "watermark": false,
		}
		for i, field := range fields {
			values[field] = counts[i]
		}
		original := make(map[string]any, len(values))
		for key, value := range values {
			original[key] = value
		}
		ApplyVideoContractForcedValues(contract, values)
		if contract.Capability.AudioControl != "toggle" {
			values["generate_audio"] = contract.Capability.AudioControl == "always"
		}
		if !contract.Capability.Watermark {
			values["watermark"] = false
		}
		if err := ValidateVideoContractRuleValues(contract, values); err != nil {
			lastErr = err
			return false
		}
		seconds, _ := values["duration"].(int)
		size, _ := values["size"].(string)
		resolution, _ := values["resolution"].(string)
		if !VideoContractSupports(contract, size, seconds, resolution) {
			lastErr = fmt.Errorf("规则强制值不在可选参数范围内")
			return false
		}
		parameters := map[string]any{}
		for _, parameter := range contract.Capability.Parameters {
			if VideoParameterActive(parameter, mode.Kind) {
				parameters[parameter.Name] = VideoParameterSample(parameter)
			}
		}
		normalized, err := NormalizeVideoParameters(contract.Capability, mode.Kind, parameters)
		if err != nil {
			lastErr = err
			return false
		}
		if len(normalized) > 0 {
			original["parameters"] = normalized
			values["parameters"] = normalized
		}
		sample, expected = original, values
		return true
	}
	if !search(0) {
		if lastErr == nil {
			lastErr = fmt.Errorf("素材数量范围无法构造可推断模式的代表性请求")
		}
		return nil, nil, fmt.Errorf("默认参数代表性样本未通过（不表示所有参数组合均无效）：%w", lastErr)
	}
	return sample, expected, nil
}
