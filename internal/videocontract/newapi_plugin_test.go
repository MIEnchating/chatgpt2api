package videocontract

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

func pluginContractFixture(t *testing.T) protocol.VideoModelContract {
	t.Helper()
	data, err := os.ReadFile("../../docs/examples/dramaya-grok-video-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Contracts []ImportedVideoModelContract `json:"contracts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document.Contracts[0].Contract
}

func pluginOptionsFixture() NewAPIVideoPluginOptions {
	return NewAPIVideoPluginOptions{Key: "example-video", Version: "1.0.0", BaseURL: "https://video.example.com", AuthMode: "bearer", DownloadMode: "signed_url", ResultFields: []string{"video_url", "data[0].url"}}
}

func TestGenerateNewAPIVideoPluginPreservesModelIDSpaces(t *testing.T) {
	contract, options := pluginContractFixture(t), pluginOptionsFixture()
	contract.Models = []string{"MiniMax H3 Max", "OpenAI Video"}
	contract.ModelProfiles = nil
	options.Models = append([]string(nil), contract.Models...)
	result, err := GenerateNewAPIVideoPlugin(contract, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range contract.Models {
		encoded, _ := json.Marshal(model)
		if !strings.Contains(result.Source, string(encoded)) {
			t.Fatalf("plugin rewrote model ID %q", model)
		}
	}
	for _, model := range []string{"MiniMax\tH3", "MiniMax\nH3", "MiniMax\rH3"} {
		contract.Models = []string{model}
		options.Models = []string{model}
		if _, err := GenerateNewAPIVideoPlugin(contract, options); err == nil {
			t.Fatalf("plugin accepted control whitespace in model ID: %q", model)
		}
	}
}

func TestGenerateNewAPIVideoPluginValidation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*protocol.VideoModelContract, *NewAPIVideoPluginOptions)
		want   string
	}{
		{"invalid key", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.Key = "../video" }, "插件标识"},
		{"oversized key", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.Key = strings.Repeat("a", 31) }, "插件标识"},
		{"invalid version", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.Version = "latest" }, "版本号"},
		{"relative base", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.BaseURL = "/" }, "上游地址"},
		{"invalid base scheme", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.BaseURL = "ftp://video.example.com"
		}, "HTTP(S)"},
		{"url credentials", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.BaseURL = "https://key@video.example.com"
		}, "密钥"},
		{"url query", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.BaseURL += "?key=secret" }, "查询参数"},
		{"empty url query", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.BaseURL += "?" }, "查询参数"},
		{"empty url fragment", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.BaseURL += "#" }, "片段"},
		{"url whitespace", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.BaseURL += "/some path" }, "空白"},
		{"url unicode host", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.BaseURL = "https://视频.example.com"
		}, "ASCII"},
		{"oversized base", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.BaseURL += "/" + strings.Repeat("a", 192)
		}, "191"},
		{"missing auth", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.AuthMode = "" }, "鉴权"},
		{"dangerous header", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.AuthMode = "header"
			o.AuthHeader = "Cookie"
		}, "请求头"},
		{"header injection", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.AuthMode = "header"
			o.AuthHeader = "X-Key\r\nX-Other"
		}, "请求头"},
		{"missing download", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.DownloadMode = "" }, "下载方式"},
		{"missing results", func(c *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			c.Polling.ResultFields = nil
			o.ResultFields = nil
		}, "视频地址字段"},
		{"unknown model", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.Models = []string{"unknown-video"}
		}, "完整模型 ID"},
		{"wildcard model", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) { o.Models = []string{"grok-*"} }, "完整模型 ID"},
		{"duplicate model", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.Models = []string{"grok-imagine-video", "grok-imagine-video"}
		}, "重复"},
		{"result path injection", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.ResultFields = []string{"video_url;alert(1)"}
		}, "字段路径"},
		{"prototype path", func(_ *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.ResultFields = []string{"constructor.prototype.url"}
		}, "保留名称"},
		{"authenticated wildcard", func(c *protocol.VideoModelContract, o *NewAPIVideoPluginOptions) {
			o.DownloadMode = "authenticated_url"
			c.Artifact.AllowedHosts = []string{"*.example.com"}
		}, "精确"},
		{"dedicated driver", func(c *protocol.VideoModelContract, _ *NewAPIVideoPluginOptions) {
			c.Driver = protocol.VideoContractDriverArk
		}, "专用请求转换"},
	} {
		t.Run(test.name, func(t *testing.T) {
			contract, options := pluginContractFixture(t), pluginOptionsFixture()
			test.mutate(&contract, &options)
			_, err := GenerateNewAPIVideoPlugin(contract, options)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestGenerateNewAPIVideoPluginAllowsHTTPChannelBaseURL(t *testing.T) {
	options := pluginOptionsFixture()
	options.BaseURL = "http://192.0.2.1:3000/"
	options.Version = "1.0.0-rc.1+build.20261023"
	result, err := GenerateNewAPIVideoPlugin(pluginContractFixture(t), options)
	if err != nil {
		t.Fatal(err)
	}
	if result.Options.BaseURL != "http://192.0.2.1:3000" {
		t.Fatalf("unexpected normalized base URL: %s", result.Options.BaseURL)
	}
}

func TestGenerateNewAPIVideoPluginReportsProviderDownloadPortRequirements(t *testing.T) {
	for _, tc := range []struct {
		name, baseURL, providerURL, downloadMode string
		wantPort                                 bool
	}{
		{"explicit port", "http://provider.example:3000", "", "task_content", true},
		{"documented port", "", "http://provider.example:3000", "task_content", true},
		{"configured address overrides document", "https://provider.example", "http://provider.example:3000", "task_content", false},
		{"default allowed port", "https://provider.example:8443", "", "task_content", false},
		{"channel address unknown", "", "", "task_content", false},
		{"signed URL can use another origin", "http://provider.example:3000", "", "signed_url", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contract, options := pluginContractFixture(t), pluginOptionsFixture()
			contract.Provider = &protocol.VideoContractProvider{BaseURL: tc.providerURL, AuthMode: "bearer"}
			options.BaseURL = tc.baseURL
			options.DownloadMode = tc.downloadMode
			result, err := GenerateNewAPIVideoPlugin(contract, options)
			if err != nil {
				t.Fatal(err)
			}
			warnings := strings.Join(result.Warnings, "\n")
			if strings.Contains(warnings, "追加 3000") != tc.wantPort {
				t.Fatalf("unexpected download port guidance: %s", warnings)
			}
			if options.BaseURL == "" && !strings.Contains(warnings, "不代表生产渠道或下载网络已验证") {
				t.Fatal("unknown channel address was treated as verified")
			}
			if result.Options.BaseURL != options.BaseURL {
				t.Fatal("port guidance rewrote the configured upstream")
			}
		})
	}
}

func TestGenerateNewAPIVideoPluginHonorsHostDurationLimit(t *testing.T) {
	contract := pluginContractFixture(t)
	contract.ModelProfiles = nil
	contract.Capability.Seconds = nil
	contract.Capability.SecondsRange = &protocol.VideoDurationRange{Min: 1, Step: 1}
	result, err := GenerateNewAPIVideoPlugin(contract, pluginOptionsFixture())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(result.Warnings, " "), "3600") || result.Contract.Capability.SecondsRange.Max != nil {
		t.Fatal("host limit must be disclosed without truncating the source contract")
	}
	contract.Capability.DefaultSeconds = 3601
	if _, err := GenerateNewAPIVideoPlugin(contract, pluginOptionsFixture()); err == nil || !strings.Contains(err.Error(), "3600") {
		t.Fatalf("expected host duration validation, got %v", err)
	}
}

func TestGenerateNewAPIVideoPluginContentDownloadWithoutResultFields(t *testing.T) {
	contract := pluginContractFixture(t)
	contract.Polling.ResultFields = nil
	contract.Artifact.ContentPath = "/v1/videos/{task_id}/content"
	options := pluginOptionsFixture()
	options.DownloadMode = "task_content"
	options.ResultFields = nil
	result, err := GenerateNewAPIVideoPlugin(contract, options)
	if err != nil {
		t.Fatal(err)
	}
	if result.Options.ResultFields == nil || len(result.Options.ResultFields) != 0 {
		t.Fatal("content downloads must expose an empty result_fields array for the dry-run client")
	}
}

func TestGenerateNewAPIVideoPluginForSeedanceAModelProfiles(t *testing.T) {
	data, err := os.ReadFile("../../docs/examples/newapi-seedance-a-contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Contracts []ImportedVideoModelContract `json:"contracts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Contracts) != 1 || len(document.Contracts[0].Contract.Models) != 2 || len(document.Contracts[0].Contract.ModelProfiles) != 2 {
		t.Fatalf("Seedance A contract must contain two model profiles: %#v", document.Contracts)
	}
	want := map[string]struct {
		seconds []int
		image   int
		video   int
		audio   int
	}{
		"seedance2.0-A": {seconds: []int{4, 15}, image: 9, video: 3, audio: 3},
		"seedance2.5-A": {seconds: []int{4, 30}, image: 30, video: 10, audio: 10},
	}
	contract, err := protocol.NormalizeVideoModelContract(document.Contracts[0].Contract)
	if err != nil {
		t.Fatalf("normalize Seedance A contract: %v", err)
	}
	for model, expected := range want {
		profile, ok := protocol.ResolveVideoModelContract(contract, model)
		if !ok {
			t.Fatalf("missing Seedance model profile %q", model)
		}
		if profile.Capability.Seconds[0] != expected.seconds[0] || profile.Capability.Seconds[len(profile.Capability.Seconds)-1] != expected.seconds[1] ||
			profile.Capability.References.Image != expected.image || profile.Capability.References.Video != expected.video || profile.Capability.References.Audio != expected.audio {
			t.Fatalf("%s capabilities do not match the supplied public parameters: %#v", model, profile.Capability)
		}
	}
	options := NewAPIVideoPluginOptions{Key: "dramaya-seedance", Version: "1.0.0", BaseURL: "https://video.dramaya.us", AuthMode: "bearer", DownloadMode: "signed_url", ResultFields: []string{"video_url", "data[0].url"}}
	result, err := GenerateNewAPIVideoPlugin(contract, options)
	if err != nil {
		t.Fatalf("generate combined Seedance plugin: %v", err)
	}
	pluginSource, err := os.ReadFile("../../integrations/newapi/dramaya-seedance/plugin.js")
	if err != nil || !strings.Contains(string(pluginSource), "seedance2.0-A") || !strings.Contains(string(pluginSource), "seedance2.5-A") || !strings.Contains(string(pluginSource), result.Options.Key) {
		t.Fatalf("checked-in combined Seedance plugin is incomplete: %v", err)
	}
	if strings.Contains(result.Source, "test-only-key") || len(result.TestCases) != 5 {
		t.Fatalf("generated plugin is incomplete or contains a test key: cases=%d", len(result.TestCases))
	}
	foundDefault := false
	for _, candidate := range protocol.DefaultVideoContracts() {
		if candidate.Name == contract.Name && len(candidate.Models) == 2 && len(candidate.ModelProfiles) == 2 {
			foundDefault = true
		}
	}
	if !foundDefault {
		t.Fatal("combined Seedance contract is missing from built-in defaults")
	}
	if contract.Artifact.Mode != "task_content" || contract.Artifact.Auth != "relay" {
		t.Fatal("Seedance client must download through the authenticated New API content endpoint")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required to validate the Seedance provider adapter")
	}
	cmd := exec.Command(node, "testdata/seedance_plugin_runtime.mjs", "../../integrations/newapi/dramaya-seedance/plugin.js")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Seedance provider adapter: %v\n%s", err, output)
	}
}

func TestGenerateNewAPIVideoPluginDeterministicAndOwned(t *testing.T) {
	contract, options := pluginContractFixture(t), pluginOptionsFixture()
	options.Models = []string{" grok-imagine-video-1.5 "}
	before, _ := json.Marshal(contract)
	result, err := GenerateNewAPIVideoPlugin(contract, options)
	if err != nil {
		t.Fatal(err)
	}
	again, err := GenerateNewAPIVideoPlugin(contract, options)
	if err != nil || !reflect.DeepEqual(result, again) {
		t.Fatal("generation must be deterministic")
	}
	after, _ := json.Marshal(contract)
	if string(before) != string(after) || options.Models[0] != " grok-imagine-video-1.5 " {
		t.Fatal("caller data mutated")
	}
	if result.Filename != "example-video-1.0.0.js" || !strings.Contains(result.Source, "credentialless: true") || !strings.Contains(result.Source, "中文") && !strings.Contains(result.Source, "视频插件") {
		t.Fatal("incomplete plugin")
	}
	if len(result.Warnings) == 0 {
		t.Fatal("expected deployment instructions")
	}
}

func TestGeneratedNewAPIVideoPluginRuntime(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required to execute generated JavaScript")
	}
	contract, options := pluginContractFixture(t), pluginOptionsFixture()
	sources := map[string]string{}
	add := func(name string, c protocol.VideoModelContract, o NewAPIVideoPluginOptions) {
		t.Helper()
		result, err := GenerateNewAPIVideoPlugin(c, o)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		sources[name] = result.Source
	}
	add("dramaya", contract, options)
	options.BaseURL = "  "
	add("no-base", contract, options)
	options.BaseURL = pluginOptionsFixture().BaseURL
	options.DownloadMode = "task_content"
	add("content", contract, options)
	options.DownloadMode = "authenticated_url"
	contract.Artifact.AllowedHosts = []string{"media.example.com"}
	options.AuthMode, options.AuthHeader = "header", "X-API-Key"
	add("header", contract, options)
	options.AuthMode, options.DownloadMode = "none", "signed_url"
	add("public", contract, options)
	contract, options = pluginContractFixture(t), pluginOptionsFixture()
	contract.Request.DurationField = "input.settings.duration"
	contract.Request.DurationValueType = "string"
	contract.Request.ReferenceImagesField = "input.media[0].urls"
	contract.Polling.TaskIDFields = []string{"data.task_id"}
	contract.Polling.StatusFields = []string{"data.state"}
	options.ResultFields = []string{"data.output.videos"}
	add("nested", contract, options)
	contract, options = pluginContractFixture(t), pluginOptionsFixture()
	for i := range contract.ModelProfiles {
		contract.ModelProfiles[i].Rules = []protocol.VideoModelContractRule{
			{When: protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "9"}, ForceValues: map[string]string{"duration": "10"}, Message: "nine to ten"},
			{When: protocol.VideoModelContractRuleCondition{Field: "duration", Operator: "equals", Value: "8"}, ForceValues: map[string]string{"duration": "9"}, Message: "eight to nine"},
			{When: protocol.VideoModelContractRuleCondition{Field: "resolution", Operator: "equals", Value: "1080p"}, Require: []string{"reference_image"}, Message: "1080p requires reference image"},
		}
	}
	add("rules", contract, options)
	data, _ := json.Marshal(sources)
	path := filepath.Join(t.TempDir(), "plugins.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "testdata/newapi_plugin_runtime.mjs", path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("generated runtime: %v\n%s", err, output)
	}
	t.Log(strings.TrimSpace(string(output)))
}
