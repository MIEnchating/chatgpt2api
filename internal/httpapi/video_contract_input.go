package httpapi

import (
	"fmt"
	"unicode/utf8"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

// Submission and preview share one normalization pass. Queued tasks contain
// these canonical values, so request mapping must not apply rules a second time.
func normalizeVideoContractInput(body map[string]any, contract protocol.VideoModelContract) error {
	refs := removeVideoFrameAliases(util.AsStringSlice(body["reference_image_urls"]), videoFrameAliases(body))
	videos := util.AsStringSlice(body["reference_video_urls"])
	audios := util.AsStringSlice(body["reference_audio_urls"])
	kind, valid := videoContractGenerationKind(body, contract)
	if !valid {
		return fmt.Errorf("generation_mode 不属于当前视频模型契约")
	}
	mode, supported := protocol.VideoContractModeForKind(contract, kind)
	if !supported {
		return fmt.Errorf("当前模型不支持所选生成模式")
	}
	body["generation_mode"] = firstNonEmpty(mode.RequestValue, mode.ID)
	body["reference_mode"] = "first-frame"
	if kind == "reference" {
		body["reference_mode"] = "reference"
	}
	counts := videoContractMaterialCounts(kind, body, refs, videos, audios)
	if err := protocol.ValidateVideoContractModeMaterials(contract, kind, counts); err != nil {
		return err
	}
	body["seconds"] = util.ToInt(body["seconds"], contract.Capability.DefaultSeconds)
	body["size"] = firstNonEmpty(util.Clean(body["size"]), contract.Capability.DefaultSize)
	body["resolution"] = firstNonEmpty(util.Clean(body["resolution"]), contract.Capability.DefaultResolution)
	body["generate_audio"] = contract.Capability.AudioControl == "always" || contract.Capability.AudioControl == "toggle" && util.ToBool(body["generate_audio"])
	body["watermark"] = contract.Capability.Watermark && util.ToBool(body["watermark"])
	values := videoContractRuleValues(body, contract)
	protocol.ApplyVideoContractForcedValues(contract, values)
	if contract.Capability.AudioControl != "toggle" {
		values["generate_audio"] = contract.Capability.AudioControl == "always"
	}
	if !contract.Capability.Watermark {
		values["watermark"] = false
	}
	if err := protocol.ValidateVideoContractRuleValues(contract, values); err != nil {
		return err
	}
	for field, bodyField := range map[string]string{
		"duration": "seconds", "size": "size", "resolution": "resolution",
		"generate_audio": "generate_audio", "watermark": "watermark",
	} {
		body[bodyField] = values[field]
	}
	prompt := util.Clean(body["prompt"])
	if prompt == "" {
		return fmt.Errorf("请输入视频提示词")
	}
	if utf8.RuneCountInString(prompt) > contract.Validation.MaxPromptCharacters {
		return fmt.Errorf("当前视频模型提示词最多支持 %d 个字符", contract.Validation.MaxPromptCharacters)
	}
	if !protocol.VideoContractSupports(contract, util.Clean(body["size"]), util.ToInt(body["seconds"], 0), util.Clean(body["resolution"])) {
		return fmt.Errorf("当前视频模型不支持所选视频参数")
	}
	return nil
}
