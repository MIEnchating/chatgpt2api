package videocontract

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedNewAPIVideoPluginModelDiscovery(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required to execute generated JavaScript")
	}
	plugins := map[string]NewAPIVideoPluginResult{}
	for _, scenario := range []struct{ name, path, auth string }{
		{"static", "", "bearer"},
		{"standard", "/v1/models", "bearer"},
		{"custom", " /models ", "bearer"},
		{"header", "/v1/models", "header"},
		{"public", "/v1/models", "none"},
	} {
		options := pluginOptionsFixture()
		options.AuthMode = scenario.auth
		options.ModelsPath = scenario.path
		if scenario.auth == "header" {
			options.AuthHeader = "X-API-Key"
		}
		options.Models = []string{"grok-imagine-video"}
		result, err := GenerateNewAPIVideoPlugin(pluginContractFixture(t), options)
		if err != nil {
			t.Fatal(err)
		}
		plugins[scenario.name] = result
	}
	data, err := json.Marshal(plugins)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "plugins.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "testdata/newapi_plugin_models.mjs", path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("model discovery: %v\n%s", err, output)
	} else {
		t.Log(strings.TrimSpace(string(output)))
	}
}

func TestGenerateNewAPIVideoPluginRejectsInvalidModelListPaths(t *testing.T) {
	for _, path := range []string{"v1/models", "https://example.com/v1/models", "//example.com/models", "/v1/models?api_key=secret", "/v1/models#fragment", "/v1/{model}", "/v1/../models", "/v1/%2e%2e/models", "/v1//models", "/v1\\models", "/v1/\nmodels", "/" + strings.Repeat("m", 512)} {
		t.Run(path, func(t *testing.T) {
			options := pluginOptionsFixture()
			options.ModelsPath = path
			if _, err := GenerateNewAPIVideoPlugin(pluginContractFixture(t), options); err == nil || !strings.Contains(err.Error(), "模型列表路径") {
				t.Fatalf("invalid model list path accepted: %q, error=%v", path, err)
			}
		})
	}
}
