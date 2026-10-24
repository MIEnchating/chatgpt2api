package videocontract

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestGeneratedPluginExtendedParameterRuntime(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required")
	}
	c := pluginContractFixture(t)
	effective, ok := protocol.ResolveVideoModelContract(c, "grok-imagine-video-1.5")
	if !ok {
		t.Fatal("missing fixture")
	}
	c = effective
	c.Models = []string{"extended-video"}
	c.Capability.Seconds = nil
	c.Capability.SecondsRange = &protocol.VideoDurationRange{Min: 1, Step: 1}
	c.Capability.Prompt = &protocol.VideoPromptConstraint{Required: false, MinLength: 1, MaxLength: 40}
	c.Request.WatermarkField, c.Request.GenerateAudioField = "aigc_watermark", "generate_audio"
	c.Capability.Watermark, c.Capability.AudioControl = false, "none"
	c.Request.ReferenceValueType = "scalar"
	c.Request.ReferenceImagesField, c.Request.ReferenceVideosField = "input_reference", "input_reference"
	for i := range c.Generation.Modes {
		if c.Generation.Modes[i].Kind == "reference" {
			c.Generation.Modes[i].Materials.Video.Max = 1
		}
	}
	c.Capability.Parameters = []protocol.VideoModelParameter{
		{Name: "seed", Label: "Seed", Field: "seed", Type: "integer"},
		{Name: "prompt_enhance", Label: "Enhance", Field: "prompt_enhance", Type: "boolean"},
		{Name: "prompt_expansion_mode", Label: "Expansion", Field: "prompt_expansion_mode", Type: "string", Required: true, Enum: []string{"balanced", "quality"}},
		{Name: "callback_url", Label: "Callback", Field: "callback_url", Type: "string", Format: "uri"},
	}
	result, err := GenerateNewAPIVideoPlugin(c, pluginOptionsFixture())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	path := filepath.Join(t.TempDir(), "plugin.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "testdata/newapi_plugin_parameters.mjs", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("runtime: %v\n%s", err, out)
	}
	options := pluginOptionsFixture()
	options.BaseURL = ""
	result, err = GenerateNewAPIVideoPlugin(c, options)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(result)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(node, "testdata/newapi_plugin_parameters.mjs", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("channel-configured URL runtime: %v\n%s", err, out)
	}
	c.Transport.LocalMaterial = "multipart"
	c.Transport.MultipartFields = map[string]string{"reference_image": "input_reference", "reference_video": "input_reference"}
	c.Transport.MultipartFileField = ""
	result, err = GenerateNewAPIVideoPlugin(c, pluginOptionsFixture())
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(result)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(node, "testdata/newapi_plugin_multipart.mjs", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("multipart runtime: %v\n%s", err, out)
	}
	c.Request.ReferenceValueType = "array"
	c.Request.ReferenceImagesField = "media.images"
	c.Request.ReferenceVideosField = "media.videos"
	c.Request.FirstFrameField, c.Request.LastFrameField = "frames[0]", "frames[1]"
	c.Transport.MultipartFields = map[string]string{"first_frame": "image_url", "last_frame": "end_image_url", "reference_image": "images[]", "reference_video": "videos"}
	c.Transport.MultipartRepeatable = true
	for i := range c.Generation.Modes {
		if c.Generation.Modes[i].Kind == "reference" {
			c.Generation.Modes[i].Materials.Image.Max = 2
			c.Generation.Modes[i].Materials.Video.Max = 1
			c.Generation.Modes[i].Materials.Total.Max = 3
		}
	}
	c.Generation.Modes = append(c.Generation.Modes, protocol.VideoModelGenerationMode{ID: "frames", Label: "Frames", Kind: "image", Materials: protocol.VideoModelModeMaterials{
		FirstFrame: protocol.VideoModelMaterialRange{Min: 1, Max: 1}, LastFrame: protocol.VideoModelMaterialRange{Max: 1}, Total: protocol.VideoModelMaterialRange{Min: 1, Max: 2},
	}})
	result, err = GenerateNewAPIVideoPlugin(c, pluginOptionsFixture())
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(result)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(node, "testdata/newapi_plugin_multifile.mjs", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("multiple file runtime: %v\n%s", err, out)
	}
}
