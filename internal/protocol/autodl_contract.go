package protocol

import (
	"fmt"
	"math"

	"chatgpt2api/internal/model"
)

// The draft preserves the workflow's declared ranges and required materials.
func AutoDLVideoContract(workflow model.AutoDLWorkflow) (VideoModelContract, error) {
	if AutoDLWorkflowKind(workflow) != "video" {
		return VideoModelContract{}, fmt.Errorf("该工作流不是视频工作流")
	}
	duration, ok := workflow.InputRules["duration"]
	if !ok {
		return VideoModelContract{}, fmt.Errorf("工作流未声明 duration，请手动配置固定时长契约")
	}
	normalized, err := autoDLRuleValue(duration, duration.Default)
	if err != nil {
		return VideoModelContract{}, fmt.Errorf("工作流默认时长无效: %w", err)
	}
	seconds, ok := normalized.(float64)
	if !ok || seconds != math.Trunc(seconds) {
		return VideoModelContract{}, fmt.Errorf("视频工作流时长必须为整数秒")
	}
	minimum, maximum := seconds, seconds
	if duration.Min != nil {
		minimum = math.Ceil(*duration.Min)
	}
	if duration.Max != nil {
		maximum = math.Floor(*duration.Max)
	}
	if minimum < 1 || maximum > 3600 || maximum < minimum || maximum-minimum >= 60 {
		return VideoModelContract{}, fmt.Errorf("工作流时长范围无法表示为 1 至 60 个整数秒选项")
	}
	choices := make([]int, 0, int(maximum-minimum+1))
	for value := int(minimum); value <= int(maximum); value++ {
		choices = append(choices, value)
	}
	images := autoDLReferenceFields(workflow.InputRules, "ref_image")
	videos := autoDLReferenceFields(workflow.InputRules, "ref_video")
	audios := autoDLReferenceFields(workflow.InputRules, "ref_audio")
	frames := 0
	if _, ok := workflow.InputRules["first_frame"]; ok {
		frames++
	}
	if _, ok := workflow.InputRules["last_frame"]; ok {
		frames++
	}
	contract := VideoModelContract{
		Name: workflow.Name, Models: []string{workflow.UUID}, Driver: VideoContractDriverAutoDL,
		Transport:  VideoModelContractTransport{LocalMaterial: "url"},
		Artifact:   VideoModelContractArtifact{Mode: "response_url", Auth: "none"},
		Capability: VideoModelContractCapability{Seconds: choices, DefaultSeconds: int(seconds), AudioControl: "none"},
		Validation: VideoModelContractValidation{MaxPromptCharacters: 12000},
		Generation: VideoModelContractGeneration{Selection: "infer"},
		Request:    VideoModelContractRequest{DurationField: "duration", DurationValueType: "number"},
		Polling:    VideoModelContractPolling{IntervalSeconds: 2, TimeoutSeconds: 2700, TaskIDFields: []string{"data.task_id"}, StatusFields: []string{"data.status"}, QueuedStatuses: []string{"queued", "pending"}, RunningStatuses: []string{"running", "processing", "in_progress"}, SuccessStatuses: []string{"completed", "success", "succeeded"}, FailureStatuses: []string{"failed", "error", "cancelled"}, ResultFields: []string{"data.results"}},
	}
	if contract.Name == "" {
		contract.Name = workflow.UUID
	}
	if prompt, ok := workflow.InputRules["prompt"]; ok && prompt.MaxLength != nil {
		contract.Validation.MaxPromptCharacters = *prompt.MaxLength
	}
	required := func(fields []string) int {
		count := 0
		for _, field := range fields {
			if workflow.InputRules[field].Required {
				count++
			}
		}
		return count
	}
	frameFields := []string{}
	if frames > 0 {
		frameFields = append(frameFields, "first_frame")
	}
	if frames > 1 {
		frameFields = append(frameFields, "last_frame")
	}
	mustHaveMaterials := required(images)+required(videos)+required(audios)+required(frameFields) > 0
	if !mustHaveMaterials {
		contract.Generation.Modes = append(contract.Generation.Modes, VideoModelGenerationMode{ID: "text-to-video", Label: "文生视频", Kind: "text", RequestValue: "text-to-video"})
	}
	if len(images)+len(videos)+len(audios) == 0 && frames > 0 {
		contract.Capability.FirstFrameImageLimit = frames
		contract.Request.FirstFrameField = "first_frame"
		if frames > 1 {
			contract.Request.LastFrameField = "last_frame"
		}
		contract.Generation.Modes = append(contract.Generation.Modes, VideoModelGenerationMode{ID: "image-to-video", Label: "首尾帧生视频", Kind: "image", RequestValue: "image-to-video", Materials: VideoModelModeMaterials{FirstFrame: VideoModelMaterialRange{Min: 1, Max: 1}, LastFrame: VideoModelMaterialRange{Min: required(frameFields[1:]), Max: frames - 1}, Total: VideoModelMaterialRange{Min: max(1, required(frameFields)), Max: frames}}})
	} else if len(images)+len(videos)+len(audios) > 0 {
		limits := VideoModelReferenceLimits{Image: len(images) + frames, Video: len(videos), Audio: len(audios), Total: len(images) + frames + len(videos) + len(audios)}
		contract.Capability.References = limits
		contract.Capability.ReferenceMode = true
		if limits.Image > 0 {
			contract.Request.ReferenceImagesField = "reference_image_urls"
		}
		if limits.Video > 0 {
			contract.Request.ReferenceVideosField = "reference_video_urls"
		}
		if limits.Audio > 0 {
			contract.Request.ReferenceAudiosField = "reference_audio_urls"
		}
		minImages, minVideos, minAudio := required(images)+required(frameFields), required(videos), required(audios)
		contract.Generation.Modes = append(contract.Generation.Modes, VideoModelGenerationMode{ID: "reference-to-video", Label: "参考素材生视频", Kind: "reference", RequestValue: "reference-to-video", Materials: VideoModelModeMaterials{Image: VideoModelMaterialRange{Min: minImages, Max: limits.Image}, Video: VideoModelMaterialRange{Min: minVideos, Max: limits.Video}, Audio: VideoModelMaterialRange{Min: minAudio, Max: limits.Audio}, Total: VideoModelMaterialRange{Min: max(1, minImages+minVideos+minAudio), Max: limits.Total}}})
	}
	if len(contract.Generation.Modes) == 0 {
		return VideoModelContract{}, fmt.Errorf("工作流没有可表达的生成模式")
	}
	contract.Generation.DefaultMode = contract.Generation.Modes[0].ID
	return NormalizeVideoModelContract(contract)
}
