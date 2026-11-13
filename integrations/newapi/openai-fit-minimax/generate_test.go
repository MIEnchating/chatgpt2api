package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/videocontract"
)

func TestMiniMaxContractsImportPersistAndRegister(t *testing.T) {
	data, err := os.ReadFile("contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Version   int                                        `json:"version"`
		Contracts []videocontract.ImportedVideoModelContract `json:"contracts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 4 || len(document.Contracts) != 1 || len(document.Contracts[0].Contract.Models) != 5 || len(document.Contracts[0].Contract.ModelProfiles) != 5 {
		t.Fatal("expected one importable v4 contract with five model profiles")
	}
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "contracts.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	service := videocontract.NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatal(err)
	}
	before, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	created, updated, err := service.Import(document.Contracts)
	if err != nil || created != 1 || updated != 0 {
		t.Fatalf("first import: created=%d updated=%d err=%v", created, updated, err)
	}
	service = videocontract.NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatal(err)
	}
	items, err := service.List()
	if err != nil || len(items) != len(before)+1 {
		t.Fatalf("persisted import: count=%d err=%v", len(items), err)
	}
	var contracts []protocol.VideoModelContract
	audioControls := map[string]string{
		"minimax H3-self": "none", "minimax H3 768 Spica": "none",
		"minimax-h3-chovy": "always", "minimax H3": "always", "minimax-H3-super": "always",
	}
	for _, model := range document.Contracts[0].Contract.Models {
		contract, ok := protocol.VideoContractForModel(model)
		if !ok || contract.Name != document.Contracts[0].Contract.Name || contract.Polling.IntervalSeconds != 15 || contract.Polling.TimeoutSeconds != 3600 {
			t.Fatalf("incorrect registered contract for %s: %#v", model, contract)
		}
		if contract.Capability.AudioControl != audioControls[model] || contract.Request.GenerateAudioField != "" {
			t.Errorf("%s: documented native audio=%s requires no supplier audio switch, got %s / %q", model, audioControls[model], contract.Capability.AudioControl, contract.Request.GenerateAudioField)
		}
		var imageLimit int
		for _, mode := range contract.Generation.Modes {
			if mode.Materials.Image.Max > imageLimit {
				imageLimit = mode.Materials.Image.Max
			}
		}
		if contract.Generation.DefaultMode != "text-to-video" || imageLimit != contract.Capability.References.Image || imageLimit == 0 {
			t.Errorf("%s: text default must preserve image reference modes", model)
		}
		contracts = append(contracts, contract)
	}
	if _, err := protocol.DryRunVideoModelContracts([]protocol.VideoModelContract{contracts[0]}); err != nil {
		t.Fatal(err)
	}
	plugin, err := videocontract.GenerateNewAPIVideoPlugin(contracts[0], videocontract.NewAPIVideoPluginOptions{
		Key: "openai-fit-minimax", Version: "1.2.0", BaseURL: "https://openai.fit",
		Models: contracts[0].Models, AuthMode: "bearer", DownloadMode: "task_content",
	})
	if err != nil {
		t.Fatalf("generate plugin from combined contract: %v", err)
	}
	if strings.Contains(plugin.Source, "material_upload") {
		t.Fatal("supplier upload configuration must not be embedded in the NewAPI plugin")
	}
	for _, model := range contracts[0].Models {
		resolved, ok := protocol.ResolveVideoModelContract(contracts[0], model)
		if !ok || resolved.Request.DurationField == "" || resolved.Transport.CreatePath != "/v1/videos" {
			t.Fatalf("model profile %q lost request or transport settings: %#v", model, resolved)
		}
	}
	created, updated, err = service.Import(document.Contracts)
	if err != nil || created != 0 || updated != 1 {
		t.Fatalf("repeat import: created=%d updated=%d err=%v", created, updated, err)
	}
}
