package videocontract

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"chatgpt2api/internal/protocol"
)

//go:embed newapi_plugin.js
var newAPIVideoPluginRuntime string

type NewAPIVideoPluginOptions struct {
	Key          string   `json:"key"`
	Version      string   `json:"version"`
	BaseURL      string   `json:"base_url"`
	Models       []string `json:"models"`
	AuthMode     string   `json:"auth_mode"`
	AuthHeader   string   `json:"auth_header"`
	DownloadMode string   `json:"download_mode"`
	ResultFields []string `json:"result_fields"`
}

type NewAPIVideoPluginResult struct {
	Filename  string                             `json:"filename"`
	Source    string                             `json:"source"`
	Warnings  []string                           `json:"warnings"`
	Contract  protocol.VideoModelContract        `json:"contract"`
	Options   NewAPIVideoPluginOptions           `json:"options"`
	TestCases []protocol.VideoContractDryRunCase `json:"test_cases"`
}

var (
	newAPIPluginKeyPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,29}$`)
	newAPIPluginVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	newAPIPluginHeaderPattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)
	newAPIPluginPathPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z][A-Za-z0-9_]{0,63}|\[[0-9]{1,3}\]){0,15}$`)
	newAPIPluginModelPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$`)
)

// GenerateNewAPIVideoPlugin compiles a validated contract into a self-contained
// module. It never reads credentials, contacts a provider, or changes a contract.
func GenerateNewAPIVideoPlugin(input protocol.VideoModelContract, options NewAPIVideoPluginOptions) (NewAPIVideoPluginResult, error) {
	var result NewAPIVideoPluginResult
	contract, err := protocol.NormalizeVideoModelContract(input)
	if err != nil {
		return result, err
	}
	options.Key = strings.TrimSpace(options.Key)
	options.Version = strings.TrimSpace(options.Version)
	options.BaseURL = strings.TrimSpace(options.BaseURL)
	options.Models = append([]string(nil), options.Models...)
	options.ResultFields = append([]string{}, options.ResultFields...)
	if !newAPIPluginKeyPattern.MatchString(options.Key) {
		return result, fmt.Errorf("插件标识须为 1-30 位小写字母、数字、下划线或连字符，并以字母或数字开头")
	}
	if !newAPIPluginVersionPattern.MatchString(options.Version) {
		return result, fmt.Errorf("插件版本号须符合 SemVer，例如 1.0.0 或 1.0.0-rc.1")
	}
	if options.BaseURL != "" {
		u, err := url.Parse(options.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(options.BaseURL, "?#\\") {
			return result, fmt.Errorf("上游地址必须是 HTTP(S) Base URL，不能包含密钥、查询参数或片段")
		}
		for _, character := range options.BaseURL {
			if unicode.IsSpace(character) || unicode.IsControl(character) {
				return result, fmt.Errorf("上游地址不能包含空白或控制字符")
			}
		}
		for _, character := range u.Hostname() {
			if character > unicode.MaxASCII {
				return result, fmt.Errorf("上游域名须使用 ASCII 字符；国际化域名请填写 punycode")
			}
		}
		u.Host = strings.ToLower(u.Host)
		options.BaseURL = strings.TrimRight(u.String(), "/")
		if len(options.BaseURL) > 191 {
			return result, fmt.Errorf("上游 Base URL 规范化后不能超过 191 个字符")
		}
	}
	switch contract.Driver {
	case protocol.VideoContractDriverArk, protocol.VideoContractDriverAutoDL, protocol.VideoContractDriverVolcengine:
		return result, fmt.Errorf("%s 驱动包含专用请求转换或工作流配置，不能仅凭字段契约生成通用插件", contract.Driver)
	}
	if contract.Transport.CreatePath == "" {
		if contract.Driver == protocol.VideoContractDriverKling || contract.Driver == "custom-video" {
			return result, fmt.Errorf("请先在契约中明确填写上游任务创建路径和查询路径")
		}
		contract.Transport.CreatePath = "/v1/videos"
		contract.Transport.QueryPath = "/v1/videos/{task_id}"
	}
	options.AuthHeader = strings.TrimSpace(options.AuthHeader)
	switch options.AuthMode {
	case "bearer", "none":
		options.AuthHeader = ""
	case "header":
		if !newAPIPluginHeaderPattern.MatchString(options.AuthHeader) {
			return result, fmt.Errorf("请填写有效的 API Key 请求头名称，例如 X-API-Key")
		}
		for _, denied := range []string{"authorization", "cookie", "host", "referer", "origin", "content-type", "content-length", "accept-encoding", "connection", "proxy-connection", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"} {
			if strings.EqualFold(options.AuthHeader, denied) {
				return result, fmt.Errorf("%s 不能作为自定义 Key 请求头；Authorization 请选 Bearer 鉴权", options.AuthHeader)
			}
		}
	default:
		return result, fmt.Errorf("请选择上游鉴权方式")
	}
	if len(options.Models) == 0 {
		options.Models = append([]string(nil), contract.Models...)
	}
	if len(options.Models) > 20 {
		return result, fmt.Errorf("一个插件最多声明 20 个完整模型 ID")
	}
	profiles := make([]protocol.VideoModelContractProfile, 0, len(options.Models))
	seen := map[string]bool{}
	hostDurationLimited := false
	for index, model := range options.Models {
		model = strings.TrimSpace(model)
		if !newAPIPluginModelPattern.MatchString(model) || !protocol.VideoContractMatchesModel(contract, model) {
			return result, fmt.Errorf("模型 %q 必须是当前契约匹配的完整模型 ID，不能包含通配符", model)
		}
		if seen[strings.ToLower(model)] {
			return result, fmt.Errorf("模型 ID 重复: %s", model)
		}
		seen[strings.ToLower(model)] = true
		options.Models[index] = model
		resolved, _ := protocol.ResolveVideoModelContract(contract, model)
		if r := resolved.Capability.SecondsRange; r != nil && (r.Max == nil || *r.Max > 3600) {
			hostDurationLimited = true
		}
		for _, seconds := range resolved.Capability.Seconds {
			if seconds > 3600 {
				hostDurationLimited = true
			}
		}
		profiles = append(profiles, protocol.VideoModelContractProfile{Model: model, Capability: resolved.Capability, Generation: resolved.Generation, Rules: resolved.Rules})
	}
	if len(options.ResultFields) == 0 {
		options.ResultFields = append([]string{}, contract.Polling.ResultFields...)
	}
	switch options.DownloadMode {
	case "signed_url", "authenticated_url":
		if len(options.ResultFields) == 0 {
			return result, fmt.Errorf("此下载方式需要填写上游查询响应中的视频地址字段，例如 video_url；不要填写任务 ID 字段")
		}
		if options.DownloadMode == "authenticated_url" {
			for _, host := range contract.Artifact.AllowedHosts {
				if strings.Contains(host, "*") {
					return result, fmt.Errorf("带 Key 下载需要精确的允许域名，不能使用通配符: %s", host)
				}
			}
		}
	case "task_content":
		if contract.Artifact.ContentPath == "" {
			return result, fmt.Errorf("请先在契约中配置任务产物路径，或选择从查询响应读取视频地址")
		}
	default:
		return result, fmt.Errorf("请选择插件下载方式；中转的 content 路由不代表供应商的实际下载协议")
	}
	if len(options.ResultFields) > 20 {
		return result, fmt.Errorf("视频结果字段最多填写 20 个")
	}
	paths := append([]string{}, contract.Polling.TaskIDFields...)
	paths = append(paths, contract.Polling.StatusFields...)
	paths = append(paths, contract.Polling.ProgressFields...)
	paths = append(paths, contract.Polling.ErrorFields...)
	paths = append(paths, options.ResultFields...)
	requestJSON, _ := json.Marshal(contract.Request)
	var requestFields map[string]string
	_ = json.Unmarshal(requestJSON, &requestFields)
	for key, path := range requestFields {
		if key != "duration_value_type" && key != "reference_value_type" && path != "" {
			paths = append(paths, path)
		}
	}
	for _, path := range paths {
		if !newAPIPluginPathPattern.MatchString(path) {
			return result, fmt.Errorf("生成插件不支持该字段路径: %s", path)
		}
		for _, segment := range strings.FieldsFunc(path, func(r rune) bool { return r == '.' || r == '[' || r == ']' }) {
			if segment == "__proto__" || segment == "constructor" || segment == "prototype" {
				return result, fmt.Errorf("字段路径包含保留名称: %s", path)
			}
		}
	}
	contract.Models = append([]string(nil), options.Models...)
	contract.ModelProfiles = profiles
	encoded, err := json.MarshalIndent(struct {
		Contract protocol.VideoModelContract `json:"contract"`
		Options  NewAPIVideoPluginOptions    `json:"options"`
	}{contract, options}, "", "  ")
	if err != nil {
		return result, err
	}
	result.TestCases, err = protocol.BuildVideoContractDryRunCases(contract)
	if err != nil {
		return result, err
	}
	for _, sample := range result.TestCases {
		if duration, _ := sample.Expected["duration"].(int); duration > 3600 {
			return result, fmt.Errorf("模型 %s 的默认或规则强制时长超过 New API 秒数用量上限 3600 秒", sample.Model)
		}
	}
	result.Contract, result.Options = contract, options
	result.Filename = options.Key + "-" + options.Version + ".js"
	result.Source = "// Generated from a video contract without API keys. Configure credentials in the New API channel.\nconst CONFIG = " + string(encoded) + ";\n\n" + newAPIVideoPluginRuntime
	result.Warnings = []string{
		"生成过程不请求上游，也不验证供应商权限或计费。上传前核对 Base URL、请求路径和鉴权方式。",
		"插件按当前契约字段接收 JSON 或已声明的 multipart；openai_video 只声明视频路由，不自动把 seconds/size 等字段转换为其他别名。",
		"只提供用量字段，不内置售价；实际价格、轮询调度和任务超时由 New API 管理。相同标识和版本的源码变更需使用新版本号。",
	}
	if options.BaseURL == "" {
		result.Warnings = append(result.Warnings, "插件未设置默认上游地址，请在 New API 渠道中填写 Base URL，并核对 SSRF 保护允许的下载端口；本地干跑使用测试地址，不代表生产渠道或下载网络已验证。")
	}
	providerURL := options.BaseURL
	if providerURL == "" && contract.Provider != nil {
		providerURL = contract.Provider.BaseURL
	}
	if parsed, parseErr := url.Parse(providerURL); options.DownloadMode == "task_content" && parseErr == nil {
		switch port := parsed.Port(); port {
		case "", "80", "443", "8080", "8443":
		default:
			result.Warnings = append(result.Warnings, fmt.Sprintf("上游地址使用 %s 端口，未包含在 New API 默认的 SSRF 下载端口列表中；若生产仍使用默认限制，请在“SSRF 保护 → 允许的端口”保留原列表并追加 %s。生成任务成功不代表下载会被允许，本地干跑不验证生产设置。", port, port))
		}
	}
	if hostDurationLimited {
		result.Warnings = append(result.Warnings, "此契约的时长范围超出 New API 的秒数用量上限。生成插件仅接受不超过 3600 秒的请求，原契约范围保持不变。")
	}
	if options.DownloadMode != "signed_url" {
		result.Warnings = append(result.Warnings, "带凭据的文件下载不能自动跨域跳转；供应商若返回 CDN 签名地址，请选择“查询签名地址后下载”并填写准确结果字段。")
	}
	return result, nil
}
