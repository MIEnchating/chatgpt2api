package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/videocontract"
)

func main() {
	if len(os.Args) != 2 && (len(os.Args) != 3 || os.Args[2] != "--additional-models") {
		panic("usage: go run ./integrations/newapi/xzapi/generate.go OUTPUT_DIRECTORY [--additional-models]")
	}
	data, err := os.ReadFile("integrations/newapi/xzapi/contract.json")
	if err != nil {
		panic(err)
	}
	var document struct {
		Contracts []videocontract.ImportedVideoModelContract `json:"contracts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		panic(err)
	}
	if len(document.Contracts) != 1 {
		panic("expected one shared XZAPI contract")
	}
	contract := document.Contracts[0].Contract
	version := "1.1.0"
	if len(os.Args) == 3 {
		version = "1.4.0"
		templates := make(map[string]protocol.VideoModelContractProfile)
		for _, profile := range contract.ModelProfiles {
			templates[profile.Model] = profile
		}
		contract.Models = nil
		contract.ModelProfiles = nil
		for _, entry := range []struct{ model, template, resolution string }{
			{"0121-seedance-2-0-480p", "ch1309-sd-2.0-480p", "480p"},
			{"0121-seedance-2-0-720p", "ch1309-sd-2.0-720p", "720p"},
			{"0122-seedance-2-5-480p", "1311-seedance-2-5-480p", "480p"},
			{"0122-seedance-2-5-720p", "1311-seedance-2-5-720p", "720p"},
			{"0122-seedance-2-5-1080p", "1311-seedance-2-5-720p", "1080p"},
			{"ch0105-sd-2.0-480p-fast", "ch0112-sd-2.0-480p-fast", "480p"},
			{"ch0105-sd-2.0-720p-fast", "ch0112-sd-2.0-720p-fast", "720p"},
			{"ch0108-sd-2.5-1080p", "ch0107-sd-2.5-720p", "1080p"},
		} {
			profile, ok := templates[entry.template]
			if !ok {
				panic("missing model profile: " + entry.template)
			}
			profile.Model = entry.model
			profile.Capability.Resolutions = []string{entry.resolution}
			profile.Capability.DefaultResolution = entry.resolution
			// XZAPI lists per-media limits but no shared limit for these models.
			refs := &profile.Capability.References
			refs.Total = refs.Image + refs.Video + refs.Audio
			profile.Generation.Modes = append([]protocol.VideoModelGenerationMode(nil), profile.Generation.Modes...)
			for i := range profile.Generation.Modes {
				mode := &profile.Generation.Modes[i]
				if mode.Kind == "reference" {
					mode.Materials.Total.Max = refs.Total
				}
			}
			contract.Models = append(contract.Models, profile.Model)
			contract.ModelProfiles = append(contract.ModelProfiles, profile)
		}
	}
	result, err := videocontract.GenerateNewAPIVideoPlugin(contract, videocontract.NewAPIVideoPluginOptions{
		Key: "xzapi-video", Version: version, BaseURL: "https://api.xzapi.vip",
		Models: contract.Models, AuthMode: "bearer", DownloadMode: "task_content",
	})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(os.Args[1], "generated.js"), []byte(result.Source), 0644); err != nil {
		panic(err)
	}
	reports, err := protocol.DryRunVideoModelContracts([]protocol.VideoModelContract{contract})
	if err != nil {
		panic(err)
	}
	data, err = json.MarshalIndent(reports, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(os.Args[1], "contract-dry-run.json"), append(data, '\n'), 0644); err != nil {
		panic(err)
	}
}
