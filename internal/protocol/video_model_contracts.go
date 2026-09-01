package protocol

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
)

//go:embed video_model_contracts.json
var videoModelContractsJSON []byte

const VideoContractSnapshotPayloadKey = "video_contract_snapshot"

var (
	videoContractModelPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	videoContractRequestPathPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z][A-Za-z0-9_]{0,63}){0,7}$`)
	videoContractFieldPathPattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z][A-Za-z0-9_]{0,63}|\[[0-9]{1,3}\])*$`)
	videoContractMultipartFieldPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}(?:\[\])?$`)
	videoContractValuePattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`)
	videoContractHostPattern           = regexp.MustCompile(`^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
)

type VideoModelReferenceLimits struct {
	Image int `json:"image"`
	Video int `json:"video"`
	Audio int `json:"audio"`
	Total int `json:"total"`
}

type VideoModelContractCapability struct {
	Sizes                []string                  `json:"sizes"`
	Seconds              []int                     `json:"seconds"`
	Resolutions          []string                  `json:"resolutions"`
	DefaultSize          string                    `json:"default_size"`
	DefaultSeconds       int                       `json:"default_seconds"`
	DefaultResolution    string                    `json:"default_resolution"`
	References           VideoModelReferenceLimits `json:"references"`
	FirstFrameImageLimit int                       `json:"first_frame_image_limit"`
	ReferenceMode        bool                      `json:"reference_mode"`
	AudioControl         string                    `json:"audio_control"`
	Watermark            bool                      `json:"watermark"`
}

type VideoModelContractValidation struct {
	MaxPromptCharacters int `json:"max_prompt_characters"`
}

type VideoModelMaterialRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type VideoModelModeMaterials struct {
	FirstFrame VideoModelMaterialRange `json:"first_frame"`
	LastFrame  VideoModelMaterialRange `json:"last_frame"`
	Image      VideoModelMaterialRange `json:"image"`
	Video      VideoModelMaterialRange `json:"video"`
	Audio      VideoModelMaterialRange `json:"audio"`
	Total      VideoModelMaterialRange `json:"total"`
}

type VideoModelGenerationMode struct {
	ID           string                  `json:"id"`
	Label        string                  `json:"label"`
	Kind         string                  `json:"kind"`
	RequestValue string                  `json:"request_value"`
	Materials    VideoModelModeMaterials `json:"materials"`
}

type VideoModelContractGeneration struct {
	Selection   string                     `json:"selection"`
	DefaultMode string                     `json:"default_mode"`
	Modes       []VideoModelGenerationMode `json:"modes"`
}

type VideoModelContractRuleCondition struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value,omitempty"`
}

type VideoModelContractRuleUI struct {
	Show    []string `json:"show,omitempty"`
	Hide    []string `json:"hide,omitempty"`
	Disable []string `json:"disable,omitempty"`
}

type VideoModelContractRule struct {
	When        VideoModelContractRuleCondition `json:"when"`
	Require     []string                        `json:"require,omitempty"`
	RequireAny  []string                        `json:"require_any,omitempty"`
	Forbid      []string                        `json:"forbid,omitempty"`
	Limits      map[string]int                  `json:"limits,omitempty"`
	ForceValues map[string]string               `json:"force_values,omitempty"`
	UI          VideoModelContractRuleUI        `json:"ui,omitempty"`
	Message     string                          `json:"message"`
}

type VideoModelContractRequest struct {
	DurationField        string `json:"duration_field"`
	AspectRatioField     string `json:"aspect_ratio_field"`
	ResolutionField      string `json:"resolution_field"`
	GenerateAudioField   string `json:"generate_audio_field"`
	WatermarkField       string `json:"watermark_field"`
	GenerationModeField  string `json:"generation_mode_field"`
	FirstFrameField      string `json:"first_frame_field"`
	LastFrameField       string `json:"last_frame_field"`
	ReferenceImagesField string `json:"reference_images_field"`
	ReferenceVideosField string `json:"reference_videos_field"`
	ReferenceAudiosField string `json:"reference_audios_field"`
}

type VideoModelContractPolling struct {
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	TaskIDFields    []string `json:"task_id_fields"`
	StatusFields    []string `json:"status_fields"`
	ProgressFields  []string `json:"progress_fields"`
	ErrorFields     []string `json:"error_fields"`
	QueuedStatuses  []string `json:"queued_statuses"`
	RunningStatuses []string `json:"processing_statuses"`
	SuccessStatuses []string `json:"success_statuses"`
	FailureStatuses []string `json:"failure_statuses"`
	ResultFields    []string `json:"result_fields"`
}

type VideoModelContractTransport struct {
	LocalMaterial       string `json:"local_material"`
	MultipartFileField  string `json:"multipart_file_field"`
	MultipartRepeatable bool   `json:"multipart_repeatable"`
	MultipartMixedURLs  bool   `json:"multipart_mixed_urls"`
	CreatePath          string `json:"create_path"`
	QueryPath           string `json:"query_path"`
}

type VideoModelContractArtifact struct {
	Mode         string   `json:"mode"`
	ContentPath  string   `json:"content_path"`
	Auth         string   `json:"auth"`
	AllowedHosts []string `json:"allowed_hosts"`
}

type VideoModelContract struct {
	Name       string                       `json:"name"`
	Models     []string                     `json:"models"`
	Priority   int                          `json:"priority"`
	Driver     string                       `json:"driver"`
	Transport  VideoModelContractTransport  `json:"transport"`
	Artifact   VideoModelContractArtifact   `json:"artifact"`
	Capability VideoModelContractCapability `json:"capability"`
	Validation VideoModelContractValidation `json:"validation"`
	Generation VideoModelContractGeneration `json:"generation"`
	Rules      []VideoModelContractRule     `json:"rules"`
	Request    VideoModelContractRequest    `json:"request"`
	Polling    VideoModelContractPolling    `json:"polling"`
}

type videoModelContractDocument struct {
	Version   int                  `json:"version"`
	Contracts []VideoModelContract `json:"contracts"`
}

var (
	defaultVideoModelContracts = loadDefaultVideoModelContracts()
	videoModelContractsMu      sync.RWMutex
	videoModelContracts        = indexVideoModelContracts(defaultVideoModelContracts)
)

type videoModelContractWildcard struct {
	pattern       string
	literalCount  int
	wildcardCount int
	contract      VideoModelContract
}

type videoModelContractRegistry struct {
	contracts []VideoModelContract
	exact     map[string]VideoModelContract
	wildcards []videoModelContractWildcard
}

func loadDefaultVideoModelContracts() []VideoModelContract {
	var document videoModelContractDocument
	if err := json.Unmarshal(videoModelContractsJSON, &document); err != nil {
		panic(err)
	}
	if document.Version != 4 {
		panic(fmt.Sprintf("unsupported video model contract version %d", document.Version))
	}
	contracts := make([]VideoModelContract, 0, len(document.Contracts))
	for _, contract := range document.Contracts {
		normalized, err := NormalizeVideoModelContract(contract)
		if err != nil {
			panic(err)
		}
		contracts = append(contracts, normalized)
	}
	if err := validateVideoContractCollection(contracts); err != nil {
		panic(err)
	}
	return contracts
}

func NormalizeVideoModelContract(contract VideoModelContract) (VideoModelContract, error) {
	contract = cloneVideoContract(contract)
	queuedStatusesMissing := contract.Polling.QueuedStatuses == nil
	runningStatusesMissing := contract.Polling.RunningStatuses == nil
	progressFieldsMissing := contract.Polling.ProgressFields == nil
	contract.Name = strings.TrimSpace(contract.Name)
	contract.Driver = strings.ToLower(strings.TrimSpace(contract.Driver))
	if contract.Driver == VideoContractDriverLegacyKling {
		contract.Driver = VideoContractDriverKling
	}
	contract.Transport.LocalMaterial = strings.ToLower(strings.TrimSpace(contract.Transport.LocalMaterial))
	contract.Transport.MultipartFileField = strings.TrimSpace(contract.Transport.MultipartFileField)
	contract.Transport.CreatePath = normalizeVideoContractEndpointPath(contract.Transport.CreatePath)
	contract.Transport.QueryPath = normalizeVideoContractEndpointPath(contract.Transport.QueryPath)
	if contract.Transport.LocalMaterial != "multipart" {
		contract.Transport.MultipartFileField = ""
		contract.Transport.MultipartRepeatable = false
		contract.Transport.MultipartMixedURLs = false
	}
	contract.Artifact.Mode = strings.ToLower(strings.TrimSpace(contract.Artifact.Mode))
	if contract.Artifact.Mode == "" {
		contract.Artifact.Mode = "response_url"
	}
	contract.Artifact.ContentPath = normalizeVideoContractEndpointPath(contract.Artifact.ContentPath)
	contract.Artifact.Auth = strings.ToLower(strings.TrimSpace(contract.Artifact.Auth))
	if contract.Artifact.Auth == "" {
		contract.Artifact.Auth = "none"
	}
	contract.Artifact.AllowedHosts = uniqueTrimmedStrings(contract.Artifact.AllowedHosts, true)
	contract.Models = uniqueTrimmedStrings(contract.Models, false)
	contract.Capability.Sizes = uniqueTrimmedStrings(contract.Capability.Sizes, false)
	contract.Capability.Resolutions = uniqueTrimmedStrings(contract.Capability.Resolutions, false)
	contract.Capability.Seconds = uniqueSortedInts(contract.Capability.Seconds)
	contract.Capability.DefaultSize = strings.TrimSpace(contract.Capability.DefaultSize)
	contract.Capability.DefaultResolution = strings.TrimSpace(contract.Capability.DefaultResolution)
	contract.Capability.AudioControl = strings.ToLower(strings.TrimSpace(contract.Capability.AudioControl))
	contract.Generation.Selection = strings.ToLower(strings.TrimSpace(contract.Generation.Selection))
	contract.Generation.DefaultMode = strings.TrimSpace(contract.Generation.DefaultMode)
	for index := range contract.Generation.Modes {
		mode := &contract.Generation.Modes[index]
		mode.ID = strings.TrimSpace(mode.ID)
		mode.Label = strings.TrimSpace(mode.Label)
		mode.Kind = strings.ToLower(strings.TrimSpace(mode.Kind))
		mode.RequestValue = strings.TrimSpace(mode.RequestValue)
	}
	contract.Capability = videoCapabilityWithGenerationModes(contract.Capability, contract.Generation.Modes)
	for index := range contract.Rules {
		rule := &contract.Rules[index]
		rule.When.Field = strings.ToLower(strings.TrimSpace(rule.When.Field))
		rule.When.Operator = strings.ToLower(strings.TrimSpace(rule.When.Operator))
		rule.When.Value = strings.TrimSpace(rule.When.Value)
		rule.Require = uniqueTrimmedStrings(rule.Require, true)
		rule.RequireAny = uniqueTrimmedStrings(rule.RequireAny, true)
		rule.Forbid = uniqueTrimmedStrings(rule.Forbid, true)
		rule.UI.Show = uniqueTrimmedStrings(rule.UI.Show, true)
		rule.UI.Hide = uniqueTrimmedStrings(rule.UI.Hide, true)
		rule.UI.Disable = uniqueTrimmedStrings(rule.UI.Disable, true)
		if len(rule.Require) > 0 && len(rule.RequireAny) > 0 {
			required := make(map[string]struct{}, len(rule.Require))
			for _, field := range rule.Require {
				required[field] = struct{}{}
			}
			filtered := rule.RequireAny[:0]
			for _, field := range rule.RequireAny {
				if _, exists := required[field]; !exists {
					filtered = append(filtered, field)
				}
			}
			rule.RequireAny = filtered
		}
		rule.Message = strings.TrimSpace(rule.Message)
		var err error
		rule.Limits, err = normalizedVideoContractIntMap(rule.Limits)
		if err != nil {
			return VideoModelContract{}, fmt.Errorf("条件规则 %d 的字段上限冲突: %w", index+1, err)
		}
		rule.ForceValues, err = normalizedVideoContractStringMap(rule.ForceValues)
		if err != nil {
			return VideoModelContract{}, fmt.Errorf("条件规则 %d 的强制字段值冲突: %w", index+1, err)
		}
	}
	contract.Polling.QueuedStatuses = uniqueTrimmedStrings(contract.Polling.QueuedStatuses, true)
	contract.Polling.RunningStatuses = uniqueTrimmedStrings(contract.Polling.RunningStatuses, true)
	contract.Polling.SuccessStatuses = uniqueTrimmedStrings(contract.Polling.SuccessStatuses, true)
	contract.Polling.FailureStatuses = uniqueTrimmedStrings(contract.Polling.FailureStatuses, true)
	contract.Polling.TaskIDFields = uniqueTrimmedStrings(contract.Polling.TaskIDFields, false)
	contract.Polling.StatusFields = uniqueTrimmedStrings(contract.Polling.StatusFields, false)
	contract.Polling.ProgressFields = uniqueTrimmedStrings(contract.Polling.ProgressFields, false)
	contract.Polling.ErrorFields = uniqueTrimmedStrings(contract.Polling.ErrorFields, false)
	contract.Polling.ResultFields = uniqueTrimmedStrings(contract.Polling.ResultFields, false)
	// Version 3 contracts created before active status tracking only declared
	// terminal states. NewAPI's public /v1/videos response uses these defaults.
	if queuedStatusesMissing {
		contract.Polling.QueuedStatuses = []string{"queued"}
	}
	if runningStatusesMissing {
		contract.Polling.RunningStatuses = []string{"in_progress"}
	}
	if progressFieldsMissing {
		contract.Polling.ProgressFields = []string{"progress"}
	}
	requestFields := []*string{
		&contract.Request.DurationField, &contract.Request.AspectRatioField, &contract.Request.ResolutionField,
		&contract.Request.GenerateAudioField, &contract.Request.WatermarkField, &contract.Request.GenerationModeField, &contract.Request.FirstFrameField,
		&contract.Request.LastFrameField, &contract.Request.ReferenceImagesField, &contract.Request.ReferenceVideosField,
		&contract.Request.ReferenceAudiosField,
	}
	for _, field := range requestFields {
		*field = strings.TrimSpace(*field)
	}
	if err := ValidateVideoModelContract(contract); err != nil {
		return VideoModelContract{}, err
	}
	return contract, nil
}

func videoCapabilityWithGenerationModes(capability VideoModelContractCapability, modes []VideoModelGenerationMode) VideoModelContractCapability {
	frameLimit := 0
	references := VideoModelReferenceLimits{}
	referenceMode := false
	for _, mode := range modes {
		if mode.Kind == "image" {
			frameLimit = maxInt(frameLimit, mode.Materials.FirstFrame.Max+mode.Materials.LastFrame.Max)
		}
		if mode.Kind == "reference" {
			referenceMode = true
			references.Image = maxInt(references.Image, mode.Materials.Image.Max)
			references.Video = maxInt(references.Video, mode.Materials.Video.Max)
			references.Audio = maxInt(references.Audio, mode.Materials.Audio.Max)
			references.Total = maxInt(references.Total, mode.Materials.Total.Max)
		}
	}
	capability.FirstFrameImageLimit = frameLimit
	capability.ReferenceMode = referenceMode
	capability.References = references
	return capability
}

func normalizedVideoContractIntMap(values map[string]int) (map[string]int, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make(map[string]int, len(values))
	for key, value := range values {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		if existing, exists := result[key]; exists && existing != value {
			return nil, fmt.Errorf("字段 %q 配置了不一致的值", key)
		}
		result[key] = value
	}
	return result, nil
}

func normalizedVideoContractStringMap(values map[string]string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make(map[string]string, len(values))
	for key, value := range values {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		value = strings.TrimSpace(value)
		if key == "generate_audio" || key == "watermark" {
			value = strings.ToLower(value)
		}
		if existing, exists := result[key]; exists && existing != value {
			return nil, fmt.Errorf("字段 %q 配置了不一致的值", key)
		}
		result[key] = value
	}
	return result, nil
}

var videoContractRuleFields = map[string]struct{}{
	"first_frame": {}, "last_frame": {}, "reference_image": {}, "reference_video": {}, "reference_audio": {},
	"generate_audio": {}, "size": {}, "resolution": {}, "duration": {}, "watermark": {},
}

func validateVideoContractGeneration(generation VideoModelContractGeneration) error {
	if generation.Selection != "infer" {
		return fmt.Errorf("生成模式选择仅支持 infer")
	}
	if len(generation.Modes) == 0 || len(generation.Modes) > 3 {
		return fmt.Errorf("每个契约必须配置 1-3 个生成模式")
	}
	ids := make(map[string]struct{}, len(generation.Modes))
	kinds := make(map[string]struct{}, len(generation.Modes))
	defaultKind := ""
	for _, mode := range generation.Modes {
		if !videoContractValuePattern.MatchString(mode.ID) {
			return fmt.Errorf("生成模式标识 %q 格式无效", mode.ID)
		}
		if _, exists := ids[strings.ToLower(mode.ID)]; exists {
			return fmt.Errorf("生成模式标识 %q 重复", mode.ID)
		}
		ids[strings.ToLower(mode.ID)] = struct{}{}
		if len([]rune(mode.Label)) < 1 || len([]rune(mode.Label)) > 40 {
			return fmt.Errorf("生成模式名称必须为 1-40 个字符")
		}
		if !stringSliceContains([]string{"text", "image", "reference"}, mode.Kind) {
			return fmt.Errorf("生成模式类型仅支持 text、image 或 reference")
		}
		if _, exists := kinds[mode.Kind]; exists {
			return fmt.Errorf("生成模式类型 %q 重复", mode.Kind)
		}
		kinds[mode.Kind] = struct{}{}
		if strings.EqualFold(mode.ID, generation.DefaultMode) {
			defaultKind = mode.Kind
		}
		if mode.RequestValue != "" && !videoContractValuePattern.MatchString(mode.RequestValue) {
			return fmt.Errorf("生成模式请求值 %q 格式无效", mode.RequestValue)
		}
		ranges := []struct {
			name  string
			value VideoModelMaterialRange
		}{
			{"首帧", mode.Materials.FirstFrame}, {"尾帧", mode.Materials.LastFrame},
			{"参考图片", mode.Materials.Image}, {"参考视频", mode.Materials.Video},
			{"参考音频", mode.Materials.Audio}, {"素材合计", mode.Materials.Total},
		}
		for _, item := range ranges {
			if item.value.Min < 0 || item.value.Max < 0 || item.value.Min > item.value.Max || item.value.Max > 80 {
				return fmt.Errorf("生成模式 %s 的%s范围无效", mode.Label, item.name)
			}
		}
		if mode.Materials.FirstFrame.Max > 1 || mode.Materials.LastFrame.Max > 1 {
			return fmt.Errorf("生成模式 %s 的首帧和尾帧上限不能超过 1", mode.Label)
		}
		switch mode.Kind {
		case "text":
			if mode.Materials.FirstFrame.Max+mode.Materials.LastFrame.Max+mode.Materials.Image.Max+mode.Materials.Video.Max+mode.Materials.Audio.Max > 0 {
				return fmt.Errorf("文生视频模式不能接收素材")
			}
		case "image":
			if mode.Materials.FirstFrame.Max == 0 {
				return fmt.Errorf("图生视频模式必须支持首帧")
			}
			if mode.Materials.Image.Max+mode.Materials.Video.Max+mode.Materials.Audio.Max > 0 {
				return fmt.Errorf("图生视频模式不能配置普通参考素材")
			}
		case "reference":
			if mode.Materials.FirstFrame.Max+mode.Materials.LastFrame.Max > 0 {
				return fmt.Errorf("参考素材生视频模式不能配置首尾帧")
			}
			if mode.Materials.Image.Max+mode.Materials.Video.Max+mode.Materials.Audio.Max == 0 {
				return fmt.Errorf("参考素材生视频模式必须支持至少一类参考素材")
			}
		}
		materialMax := mode.Materials.FirstFrame.Max + mode.Materials.LastFrame.Max + mode.Materials.Image.Max + mode.Materials.Video.Max + mode.Materials.Audio.Max
		largestMaterialMax := maxInt(mode.Materials.FirstFrame.Max, mode.Materials.LastFrame.Max)
		largestMaterialMax = maxInt(largestMaterialMax, mode.Materials.Image.Max)
		largestMaterialMax = maxInt(largestMaterialMax, mode.Materials.Video.Max)
		largestMaterialMax = maxInt(largestMaterialMax, mode.Materials.Audio.Max)
		if mode.Materials.Total.Max < largestMaterialMax || mode.Materials.Total.Max > materialMax {
			return fmt.Errorf("生成模式 %s 的素材总上限必须介于单类上限和各类上限之和之间", mode.Label)
		}
	}
	if _, exists := ids[strings.ToLower(generation.DefaultMode)]; !exists {
		return fmt.Errorf("默认生成模式必须属于已配置模式")
	}
	if defaultKind != "text" {
		return fmt.Errorf("自动推断契约的默认生成模式必须是文生视频")
	}
	return nil
}

func validateVideoContractRules(rules []VideoModelContractRule) error {
	if len(rules) > 32 {
		return fmt.Errorf("条件规则不能超过 32 条")
	}
	for index, rule := range rules {
		if _, ok := videoContractRuleFields[rule.When.Field]; !ok {
			return fmt.Errorf("条件规则 %d 的字段无效", index+1)
		}
		if rule.When.Operator != "present" && rule.When.Operator != "equals" {
			return fmt.Errorf("条件规则 %d 的操作符仅支持 present 或 equals", index+1)
		}
		if rule.When.Operator == "equals" && rule.When.Value == "" {
			return fmt.Errorf("条件规则 %d 缺少比较值", index+1)
		}
		if len([]rune(rule.Message)) < 1 || len([]rune(rule.Message)) > 200 {
			return fmt.Errorf("条件规则 %d 的提示必须为 1-200 个字符", index+1)
		}
		required := make(map[string]struct{}, len(rule.Require)+len(rule.RequireAny))
		for _, field := range append(append([]string{}, rule.Require...), rule.RequireAny...) {
			if _, ok := videoContractRuleFields[field]; !ok {
				return fmt.Errorf("条件规则 %d 包含无效字段 %q", index+1, field)
			}
			required[field] = struct{}{}
		}
		for _, field := range rule.Forbid {
			if _, ok := videoContractRuleFields[field]; !ok {
				return fmt.Errorf("条件规则 %d 包含无效字段 %q", index+1, field)
			}
			if _, exists := required[field]; exists {
				return fmt.Errorf("条件规则 %d 的必需与禁止字段不能重复", index+1)
			}
		}
		for field, limit := range rule.Limits {
			if _, ok := videoContractRuleFields[field]; !ok || limit < 0 || limit > 80 {
				return fmt.Errorf("条件规则 %d 的字段上限无效", index+1)
			}
		}
		for field, value := range rule.ForceValues {
			if _, ok := videoContractRuleFields[field]; !ok || value == "" || len([]rune(value)) > 100 {
				return fmt.Errorf("条件规则 %d 的强制字段值无效", index+1)
			}
		}
		shown := make(map[string]struct{}, len(rule.UI.Show))
		for _, field := range rule.UI.Show {
			if _, ok := videoContractRuleFields[field]; !ok {
				return fmt.Errorf("条件规则 %d 包含无效的显示字段 %q", index+1, field)
			}
			shown[field] = struct{}{}
		}
		hidden := make(map[string]struct{}, len(rule.UI.Hide))
		for _, field := range rule.UI.Hide {
			if _, ok := videoContractRuleFields[field]; !ok {
				return fmt.Errorf("条件规则 %d 包含无效的隐藏字段 %q", index+1, field)
			}
			if _, exists := shown[field]; exists {
				return fmt.Errorf("条件规则 %d 的显示与隐藏字段不能重复", index+1)
			}
			hidden[field] = struct{}{}
		}
		for _, field := range rule.UI.Disable {
			if _, ok := videoContractRuleFields[field]; !ok {
				return fmt.Errorf("条件规则 %d 包含无效的禁用字段 %q", index+1, field)
			}
			if _, exists := hidden[field]; exists {
				return fmt.Errorf("条件规则 %d 的隐藏与禁用字段不能重复", index+1)
			}
		}
	}
	return nil
}

type VideoModelMaterialCounts struct {
	FirstFrame int
	LastFrame  int
	Image      int
	Video      int
	Audio      int
}

func VideoContractModeForKind(contract VideoModelContract, kind string) (VideoModelGenerationMode, bool) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	for _, mode := range contract.Generation.Modes {
		if mode.Kind == kind {
			return mode, true
		}
	}
	return VideoModelGenerationMode{}, false
}

func ValidateVideoContractModeMaterials(contract VideoModelContract, kind string, counts VideoModelMaterialCounts) error {
	mode, ok := VideoContractModeForKind(contract, kind)
	if !ok {
		return fmt.Errorf("当前模型不支持%s", videoGenerationKindLabel(kind))
	}
	values := []struct {
		label      string
		count      int
		rangeValue VideoModelMaterialRange
	}{
		{"首帧", counts.FirstFrame, mode.Materials.FirstFrame},
		{"尾帧", counts.LastFrame, mode.Materials.LastFrame},
		{"参考图片", counts.Image, mode.Materials.Image},
		{"参考视频", counts.Video, mode.Materials.Video},
		{"参考音频", counts.Audio, mode.Materials.Audio},
	}
	for _, value := range values {
		if value.count < value.rangeValue.Min {
			return fmt.Errorf("%s至少需要 %d 个%s", mode.Label, value.rangeValue.Min, value.label)
		}
		if value.count > value.rangeValue.Max {
			if value.rangeValue.Max == 0 {
				return fmt.Errorf("%s不能使用%s", mode.Label, value.label)
			}
			return fmt.Errorf("%s最多支持 %d 个%s", mode.Label, value.rangeValue.Max, value.label)
		}
	}
	total := counts.FirstFrame + counts.LastFrame + counts.Image + counts.Video + counts.Audio
	if total < mode.Materials.Total.Min {
		return fmt.Errorf("%s至少需要 %d 个素材", mode.Label, mode.Materials.Total.Min)
	}
	if total > mode.Materials.Total.Max {
		return fmt.Errorf("%s素材合计最多支持 %d 个", mode.Label, mode.Materials.Total.Max)
	}
	return nil
}

func ValidateVideoContractRuleValues(contract VideoModelContract, values map[string]any) error {
	for _, rule := range contract.Rules {
		if !videoContractRuleMatches(rule.When, values) {
			continue
		}
		for _, field := range rule.Require {
			if !videoContractValuePresent(values[field]) {
				return fmt.Errorf("%s", rule.Message)
			}
		}
		if len(rule.RequireAny) > 0 {
			hasAny := false
			for _, field := range rule.RequireAny {
				if videoContractValuePresent(values[field]) {
					hasAny = true
					break
				}
			}
			if !hasAny {
				return fmt.Errorf("%s", rule.Message)
			}
		}
		for _, field := range rule.Forbid {
			if videoContractValuePresent(values[field]) {
				return fmt.Errorf("%s", rule.Message)
			}
		}
		for field, limit := range rule.Limits {
			if videoContractValueCount(values[field]) > limit {
				return fmt.Errorf("%s", rule.Message)
			}
		}
	}
	return nil
}

func ApplyVideoContractForcedValues(contract VideoModelContract, values map[string]any) {
	for _, rule := range contract.Rules {
		if !videoContractRuleMatches(rule.When, values) {
			continue
		}
		for field, value := range rule.ForceValues {
			if parsed, ok := parseVideoContractForcedValue(field, value); ok {
				values[field] = parsed
			}
		}
	}
}

func parseVideoContractForcedValue(field, value string) (any, bool) {
	value = strings.TrimSpace(value)
	switch field {
	case "duration":
		parsed, err := strconv.Atoi(value)
		const maxExactInteger = int64(1<<53 - 1)
		if err != nil || int64(parsed) < -maxExactInteger || int64(parsed) > maxExactInteger {
			return nil, false
		}
		return parsed, true
	case "generate_audio", "watermark":
		parsed, err := strconv.ParseBool(value)
		return parsed, err == nil
	default:
		return value, value != ""
	}
}

func videoContractRuleMatches(condition VideoModelContractRuleCondition, values map[string]any) bool {
	value := values[condition.Field]
	if condition.Operator == "present" {
		return videoContractValuePresent(value)
	}
	return strings.EqualFold(strings.TrimSpace(fmt.Sprint(value)), condition.Value)
}

func videoContractValuePresent(value any) bool {
	return videoContractValueCount(value) > 0
}

func videoContractValueCount(value any) int {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case string:
		if strings.TrimSpace(typed) != "" {
			return 1
		}
		return 0
	case int:
		if typed != 0 {
			return typed
		}
		return 0
	case []string:
		return len(typed)
	case []any:
		return len(typed)
	default:
		return 1
	}
}

func videoGenerationKindLabel(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "text":
		return "文生视频"
	case "image":
		return "图生视频"
	case "reference":
		return "参考素材生视频"
	default:
		return "该生成模式"
	}
}

func ValidateVideoModelContract(contract VideoModelContract) error {
	if length := len([]rune(contract.Name)); length < 1 || length > 100 {
		return fmt.Errorf("契约名称必须为 1-100 个字符")
	}
	if len(contract.Models) == 0 || len(contract.Models) > 20 {
		return fmt.Errorf("每个契约必须配置 1-20 个模型名称")
	}
	for _, model := range contract.Models {
		if !validVideoContractModelPattern(model) {
			return fmt.Errorf("模型名称 %q 格式无效", model)
		}
	}
	if contract.Priority < -1000 || contract.Priority > 1000 {
		return fmt.Errorf("契约优先级必须在 -1000 到 1000 之间")
	}
	if !IsSupportedVideoContractDriver(contract.Driver) {
		return fmt.Errorf("传输驱动仅支持 %s", strings.Join(SupportedVideoContractDrivers(), "、"))
	}
	if contract.Transport.LocalMaterial != "url" && contract.Transport.LocalMaterial != "multipart" {
		return fmt.Errorf("本地素材提交方式仅支持 url 或 multipart")
	}
	if contract.Transport.LocalMaterial == "multipart" {
		if !videoContractMultipartFieldPattern.MatchString(contract.Transport.MultipartFileField) {
			return fmt.Errorf("multipart 文件字段 %q 格式无效", contract.Transport.MultipartFileField)
		}
	}
	if err := validateVideoContractEndpointPaths(contract); err != nil {
		return err
	}
	if !stringSliceContains([]string{"response_url", "task_content"}, contract.Artifact.Mode) {
		return fmt.Errorf("视频产物获取方式仅支持 response_url 或 task_content")
	}
	if !stringSliceContains([]string{"none", "relay"}, contract.Artifact.Auth) {
		return fmt.Errorf("视频产物鉴权仅支持 none 或 relay")
	}
	if contract.Artifact.Mode == "task_content" {
		if !validVideoContractTaskPath(contract.Artifact.ContentPath) {
			return fmt.Errorf("任务产物路径必须是包含 {task_id} 的绝对路径")
		}
		if contract.Artifact.Auth != "relay" {
			return fmt.Errorf("任务产物路径必须使用 relay 鉴权")
		}
	} else if contract.Artifact.ContentPath != "" {
		return fmt.Errorf("从响应地址获取产物时不能配置任务产物路径")
	}
	for _, host := range contract.Artifact.AllowedHosts {
		if !videoContractHostPattern.MatchString(host) || strings.Contains(host, "..") {
			return fmt.Errorf("视频产物允许域名 %q 格式无效", host)
		}
	}
	capability := contract.Capability
	if len(capability.Sizes) > 32 || len(capability.Seconds) == 0 || len(capability.Seconds) > 60 || len(capability.Resolutions) > 16 {
		return fmt.Errorf("视频参数选项数量超出限制")
	}
	for _, value := range append(append([]string{}, capability.Sizes...), capability.Resolutions...) {
		if !videoContractValuePattern.MatchString(value) {
			return fmt.Errorf("视频参数值 %q 格式无效", value)
		}
	}
	for _, seconds := range capability.Seconds {
		if seconds < 1 || seconds > 3600 {
			return fmt.Errorf("视频时长必须在 1-3600 秒之间")
		}
	}
	if !intSliceContains(capability.Seconds, capability.DefaultSeconds) {
		return fmt.Errorf("默认时长必须属于可选时长")
	}
	if len(capability.Sizes) > 0 && !stringSliceContainsFold(capability.Sizes, capability.DefaultSize) {
		return fmt.Errorf("默认画幅必须属于可选画幅")
	}
	if len(capability.Resolutions) > 0 && !stringSliceContainsFold(capability.Resolutions, capability.DefaultResolution) {
		return fmt.Errorf("默认清晰度必须属于可选清晰度")
	}
	if !stringSliceContains([]string{"none", "toggle", "always"}, capability.AudioControl) {
		return fmt.Errorf("音频控制仅支持 none、toggle 或 always")
	}
	limits := capability.References
	if limits.Image < 0 || limits.Image > 50 || limits.Video < 0 || limits.Video > 20 || limits.Audio < 0 || limits.Audio > 20 || limits.Total < 0 || limits.Total > 80 || capability.FirstFrameImageLimit < 0 || capability.FirstFrameImageLimit > 2 {
		return fmt.Errorf("参考素材数量超出允许范围")
	}
	if limits.Total > 0 && (limits.Total < maxInt(limits.Image, limits.Video, limits.Audio) || limits.Total > limits.Image+limits.Video+limits.Audio) {
		return fmt.Errorf("参考素材总上限必须介于单类上限和各类上限之和之间")
	}
	if !capability.ReferenceMode && limits.Image+limits.Video+limits.Audio > 0 {
		return fmt.Errorf("配置参考素材上限时必须启用多模态参考模式")
	}
	if contract.Validation.MaxPromptCharacters < 1 || contract.Validation.MaxPromptCharacters > 100000 {
		return fmt.Errorf("提示词上限必须在 1-100000 个字符之间")
	}
	if err := validateVideoContractGeneration(contract.Generation); err != nil {
		return err
	}
	if contract.Driver == VideoContractDriverKling {
		for _, mode := range contract.Generation.Modes {
			if mode.Kind == "reference" {
				return fmt.Errorf("kling-video 传输驱动仅支持文生视频和图生视频")
			}
		}
	}
	if err := validateVideoContractRules(contract.Rules); err != nil {
		return err
	}
	if contract.Polling.IntervalSeconds < 1 || contract.Polling.IntervalSeconds > 300 || contract.Polling.TimeoutSeconds < contract.Polling.IntervalSeconds || contract.Polling.TimeoutSeconds > 86400 {
		return fmt.Errorf("轮询间隔或超时时间无效")
	}
	resultFieldsInvalid := len(contract.Polling.ResultFields) > 20 || contract.Artifact.Mode == "response_url" && len(contract.Polling.ResultFields) == 0
	if len(contract.Polling.TaskIDFields) == 0 || len(contract.Polling.TaskIDFields) > 20 || len(contract.Polling.StatusFields) == 0 || len(contract.Polling.StatusFields) > 20 || len(contract.Polling.ProgressFields) > 20 || len(contract.Polling.ErrorFields) > 20 || len(contract.Polling.QueuedStatuses) == 0 || len(contract.Polling.QueuedStatuses) > 20 || len(contract.Polling.RunningStatuses) == 0 || len(contract.Polling.RunningStatuses) > 20 || len(contract.Polling.SuccessStatuses) == 0 || len(contract.Polling.SuccessStatuses) > 20 || len(contract.Polling.FailureStatuses) == 0 || len(contract.Polling.FailureStatuses) > 20 || resultFieldsInvalid {
		return fmt.Errorf("轮询状态和结果字段不能为空或超过 20 项")
	}
	statusGroups := [][]string{
		contract.Polling.QueuedStatuses,
		contract.Polling.RunningStatuses,
		contract.Polling.SuccessStatuses,
		contract.Polling.FailureStatuses,
	}
	for _, status := range append(append(append(append([]string{}, statusGroups[0]...), statusGroups[1]...), statusGroups[2]...), statusGroups[3]...) {
		if !videoContractValuePattern.MatchString(status) {
			return fmt.Errorf("轮询状态 %q 格式无效", status)
		}
	}
	for groupIndex, group := range statusGroups {
		for _, status := range group {
			for otherIndex := groupIndex + 1; otherIndex < len(statusGroups); otherIndex++ {
				if stringSliceContainsFold(statusGroups[otherIndex], status) {
					return fmt.Errorf("排队、处理中、成功和失败状态不能重复")
				}
			}
		}
	}
	fields := []struct {
		name     string
		required bool
	}{
		{contract.Request.DurationField, len(capability.Seconds) > 0},
		{contract.Request.AspectRatioField, len(capability.Sizes) > 0},
		{contract.Request.ResolutionField, len(capability.Resolutions) > 0},
		{contract.Request.GenerateAudioField, capability.AudioControl == "toggle"},
		{contract.Request.WatermarkField, capability.Watermark},
		{contract.Request.GenerationModeField, false},
		{contract.Request.FirstFrameField, capability.FirstFrameImageLimit > 0},
		{contract.Request.LastFrameField, capability.FirstFrameImageLimit > 1},
		{contract.Request.ReferenceImagesField, limits.Image > 0},
		{contract.Request.ReferenceVideosField, limits.Video > 0},
		{contract.Request.ReferenceAudiosField, limits.Audio > 0},
	}
	for _, field := range fields {
		if field.required && field.name == "" {
			return fmt.Errorf("必需的请求字段映射不能为空")
		}
		if field.name != "" && !videoContractRequestPathPattern.MatchString(field.name) {
			return fmt.Errorf("请求字段 %q 格式无效", field.name)
		}
	}
	responseFields := append([]string{}, contract.Polling.TaskIDFields...)
	responseFields = append(responseFields, contract.Polling.StatusFields...)
	responseFields = append(responseFields, contract.Polling.ProgressFields...)
	responseFields = append(responseFields, contract.Polling.ErrorFields...)
	responseFields = append(responseFields, contract.Polling.ResultFields...)
	for _, field := range responseFields {
		if !videoContractFieldPathPattern.MatchString(field) {
			return fmt.Errorf("响应字段路径 %q 格式无效", field)
		}
	}
	return nil
}

func normalizeVideoContractEndpointPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "/") {
		return value
	}
	return "/" + value
}

func validVideoContractEndpointPath(value string) bool {
	return strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") && !strings.ContainsAny(value, "\r\n?#") && !strings.Contains(value, "://")
}

func validVideoContractTaskPath(value string) bool {
	return validVideoContractEndpointPath(value) && strings.Count(value, "{task_id}") == 1
}

func validateVideoContractEndpointPaths(contract VideoModelContract) error {
	if contract.Transport.CreatePath != "" && !validVideoContractEndpointPath(contract.Transport.CreatePath) {
		return fmt.Errorf("任务创建路径必须是站内绝对路径")
	}
	if contract.Transport.QueryPath != "" && !validVideoContractTaskPath(contract.Transport.QueryPath) {
		return fmt.Errorf("任务查询路径必须是包含 {task_id} 的绝对路径")
	}
	if contract.Driver == VideoContractDriverCustom && (contract.Transport.CreatePath == "" || contract.Transport.QueryPath == "") {
		return fmt.Errorf("custom-video 必须配置任务创建路径和查询路径")
	}
	return nil
}

func DefaultVideoContracts() []VideoModelContract {
	return cloneVideoContracts(defaultVideoModelContracts)
}

func ActiveVideoContracts() []VideoModelContract {
	videoModelContractsMu.RLock()
	defer videoModelContractsMu.RUnlock()
	contracts := cloneVideoContracts(videoModelContracts.contracts)
	sort.Slice(contracts, func(i, j int) bool { return contracts[i].Name < contracts[j].Name })
	return contracts
}

func ReplaceVideoContracts(contracts []VideoModelContract) error {
	normalized := make([]VideoModelContract, 0, len(contracts))
	for _, contract := range contracts {
		value, err := NormalizeVideoModelContract(contract)
		if err != nil {
			return err
		}
		normalized = append(normalized, value)
	}
	if err := validateVideoContractCollection(normalized); err != nil {
		return err
	}
	registry := indexVideoModelContracts(normalized)
	videoModelContractsMu.Lock()
	videoModelContracts = registry
	videoModelContractsMu.Unlock()
	return nil
}

func ValidateVideoContracts(contracts []VideoModelContract) error {
	normalized := make([]VideoModelContract, 0, len(contracts))
	for _, contract := range contracts {
		value, err := NormalizeVideoModelContract(contract)
		if err != nil {
			return err
		}
		normalized = append(normalized, value)
	}
	return validateVideoContractCollection(normalized)
}

func VideoContractForModel(model string) (VideoModelContract, bool) {
	key := strings.ToLower(strings.TrimSpace(model))
	if key == "" {
		return VideoModelContract{}, false
	}
	videoModelContractsMu.RLock()
	defer videoModelContractsMu.RUnlock()
	if contract, ok := videoModelContracts.exact[key]; ok {
		return cloneVideoContract(contract), true
	}
	for _, candidate := range videoModelContracts.wildcards {
		if videoContractGlobMatches(candidate.pattern, key) {
			return cloneVideoContract(candidate.contract), true
		}
	}
	return VideoModelContract{}, false
}

func VideoContractMatchesModel(contract VideoModelContract, model string) bool {
	key := strings.ToLower(strings.TrimSpace(model))
	if key == "" {
		return false
	}
	for _, pattern := range contract.Models {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == key || strings.Contains(pattern, "*") && videoContractGlobMatches(pattern, key) {
			return true
		}
	}
	return false
}

func validateVideoContractCollection(contracts []VideoModelContract) error {
	names := make(map[string]struct{}, len(contracts))
	patterns := make(map[string]string)
	wildcards := make([]videoModelContractWildcard, 0)
	for _, contract := range contracts {
		nameKey := strings.ToLower(strings.TrimSpace(contract.Name))
		if _, exists := names[nameKey]; exists {
			return fmt.Errorf("契约名称 %q 已存在", contract.Name)
		}
		names[nameKey] = struct{}{}
		for _, model := range contract.Models {
			key := strings.ToLower(strings.TrimSpace(model))
			if owner, exists := patterns[key]; exists {
				return fmt.Errorf("模型匹配规则 %q 已由契约 %q 管理", model, owner)
			}
			patterns[key] = contract.Name
			if strings.Contains(key, "*") {
				wildcards = append(wildcards, newVideoModelContractWildcard(key, contract))
			}
		}
	}
	for left := 0; left < len(wildcards); left++ {
		for right := left + 1; right < len(wildcards); right++ {
			a, b := wildcards[left], wildcards[right]
			if a.literalCount != b.literalCount || a.wildcardCount != b.wildcardCount || a.contract.Priority != b.contract.Priority {
				continue
			}
			if videoContractGlobsOverlap(a.pattern, b.pattern) {
				return fmt.Errorf("模型匹配规则 %q 与 %q 优先级相同且存在重叠，请调整规则或契约优先级", a.pattern, b.pattern)
			}
		}
	}
	return nil
}

func indexVideoModelContracts(contracts []VideoModelContract) videoModelContractRegistry {
	owned := cloneVideoContracts(contracts)
	result := videoModelContractRegistry{
		contracts: owned,
		exact:     make(map[string]VideoModelContract),
	}
	for _, contract := range owned {
		for _, model := range contract.Models {
			key := strings.ToLower(strings.TrimSpace(model))
			if strings.Contains(key, "*") {
				result.wildcards = append(result.wildcards, newVideoModelContractWildcard(key, contract))
			} else {
				result.exact[key] = contract
			}
		}
	}
	sort.SliceStable(result.wildcards, func(i, j int) bool {
		left, right := result.wildcards[i], result.wildcards[j]
		if left.literalCount != right.literalCount {
			return left.literalCount > right.literalCount
		}
		if left.wildcardCount != right.wildcardCount {
			return left.wildcardCount < right.wildcardCount
		}
		if left.contract.Priority != right.contract.Priority {
			return left.contract.Priority > right.contract.Priority
		}
		if left.pattern != right.pattern {
			return left.pattern < right.pattern
		}
		return left.contract.Name < right.contract.Name
	})
	return result
}

func validVideoContractModelPattern(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len([]rune(value)) > 128 || strings.Count(value, "*") > 8 {
		return false
	}
	if value == "*" {
		return true
	}
	return videoContractModelPattern.MatchString(strings.ReplaceAll(value, "*", "a"))
}

func newVideoModelContractWildcard(pattern string, contract VideoModelContract) videoModelContractWildcard {
	return videoModelContractWildcard{
		pattern:       pattern,
		literalCount:  len([]rune(strings.ReplaceAll(pattern, "*", ""))),
		wildcardCount: strings.Count(pattern, "*"),
		contract:      contract,
	}
}

func videoContractGlobMatches(pattern, value string) bool {
	patternRunes, valueRunes := []rune(pattern), []rune(value)
	patternIndex, valueIndex, starIndex, starValueIndex := 0, 0, -1, 0
	for valueIndex < len(valueRunes) {
		if patternIndex < len(patternRunes) && patternRunes[patternIndex] == valueRunes[valueIndex] {
			patternIndex++
			valueIndex++
			continue
		}
		if patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*' {
			starIndex = patternIndex
			patternIndex++
			starValueIndex = valueIndex
			continue
		}
		if starIndex >= 0 {
			patternIndex = starIndex + 1
			starValueIndex++
			valueIndex = starValueIndex
			continue
		}
		return false
	}
	for patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(patternRunes)
}

func videoContractGlobsOverlap(left, right string) bool {
	type state struct{ left, right int }
	leftRunes, rightRunes := []rune(left), []rune(right)
	queue := []state{{}}
	visited := map[state]struct{}{}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if _, ok := visited[current]; ok {
			continue
		}
		visited[current] = struct{}{}
		if current.left == len(leftRunes) && current.right == len(rightRunes) {
			return true
		}
		leftStar := current.left < len(leftRunes) && leftRunes[current.left] == '*'
		rightStar := current.right < len(rightRunes) && rightRunes[current.right] == '*'
		if leftStar {
			queue = append(queue, state{current.left + 1, current.right})
		}
		if rightStar {
			queue = append(queue, state{current.left, current.right + 1})
		}
		switch {
		case leftStar && current.right < len(rightRunes) && !rightStar:
			queue = append(queue, state{current.left, current.right + 1})
		case rightStar && current.left < len(leftRunes) && !leftStar:
			queue = append(queue, state{current.left + 1, current.right})
		case current.left < len(leftRunes) && current.right < len(rightRunes) && !leftStar && !rightStar && leftRunes[current.left] == rightRunes[current.right]:
			queue = append(queue, state{current.left + 1, current.right + 1})
		}
	}
	return false
}

func cloneVideoContracts(contracts []VideoModelContract) []VideoModelContract {
	cloned := make([]VideoModelContract, len(contracts))
	for index, contract := range contracts {
		cloned[index] = cloneVideoContract(contract)
	}
	return cloned
}

func cloneVideoContract(contract VideoModelContract) VideoModelContract {
	contract.Models = slices.Clone(contract.Models)
	contract.Artifact.AllowedHosts = slices.Clone(contract.Artifact.AllowedHosts)
	contract.Capability.Sizes = slices.Clone(contract.Capability.Sizes)
	contract.Capability.Seconds = slices.Clone(contract.Capability.Seconds)
	contract.Capability.Resolutions = slices.Clone(contract.Capability.Resolutions)
	contract.Generation.Modes = slices.Clone(contract.Generation.Modes)
	contract.Rules = slices.Clone(contract.Rules)
	for ruleIndex := range contract.Rules {
		rule := &contract.Rules[ruleIndex]
		rule.Require = slices.Clone(rule.Require)
		rule.RequireAny = slices.Clone(rule.RequireAny)
		rule.Forbid = slices.Clone(rule.Forbid)
		rule.Limits = maps.Clone(rule.Limits)
		rule.ForceValues = maps.Clone(rule.ForceValues)
		rule.UI.Show = slices.Clone(rule.UI.Show)
		rule.UI.Hide = slices.Clone(rule.UI.Hide)
		rule.UI.Disable = slices.Clone(rule.UI.Disable)
	}
	contract.Polling.TaskIDFields = slices.Clone(contract.Polling.TaskIDFields)
	contract.Polling.StatusFields = slices.Clone(contract.Polling.StatusFields)
	contract.Polling.ProgressFields = slices.Clone(contract.Polling.ProgressFields)
	contract.Polling.ErrorFields = slices.Clone(contract.Polling.ErrorFields)
	contract.Polling.QueuedStatuses = slices.Clone(contract.Polling.QueuedStatuses)
	contract.Polling.RunningStatuses = slices.Clone(contract.Polling.RunningStatuses)
	contract.Polling.SuccessStatuses = slices.Clone(contract.Polling.SuccessStatuses)
	contract.Polling.FailureStatuses = slices.Clone(contract.Polling.FailureStatuses)
	contract.Polling.ResultFields = slices.Clone(contract.Polling.ResultFields)
	return contract
}

func uniqueTrimmedStrings(values []string, lower bool) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if lower {
			value = strings.ToLower(value)
		}
		key := strings.ToLower(value)
		if value == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
}

func uniqueSortedInts(values []int) []int {
	seen := make(map[int]struct{}, len(values))
	result := make([]int, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Ints(result)
	return result
}

func stringSliceContains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func stringSliceContainsFold(values []string, value string) bool {
	for _, item := range values {
		if strings.EqualFold(item, value) {
			return true
		}
	}
	return false
}

func intSliceContains(values []int, value int) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func maxInt(values ...int) int {
	maximum := 0
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}
