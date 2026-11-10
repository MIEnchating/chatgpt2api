package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	if document.Version != 4 || len(document.Contracts) != 5 {
		t.Fatal("expected five importable v4 contracts")
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
	if err != nil || created != 5 || updated != 0 {
		t.Fatalf("first import: created=%d updated=%d err=%v", created, updated, err)
	}
	service = videocontract.NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatal(err)
	}
	items, err := service.List()
	if err != nil || len(items) != len(before)+5 {
		t.Fatalf("persisted import: count=%d err=%v", len(items), err)
	}
	var contracts []protocol.VideoModelContract
	for _, item := range document.Contracts {
		model := item.Contract.Models[0]
		contract, ok := protocol.VideoContractForModel(model)
		if !ok || contract.Name != item.Contract.Name || contract.Polling.IntervalSeconds != 15 || contract.Polling.TimeoutSeconds != 3600 {
			t.Fatalf("incorrect registered contract for %s: %#v", model, contract)
		}
		contracts = append(contracts, contract)
	}
	if _, err := protocol.DryRunVideoModelContracts(contracts); err != nil {
		t.Fatal(err)
	}
	created, updated, err = service.Import(document.Contracts)
	if err != nil || created != 0 || updated != 5 {
		t.Fatalf("repeat import: created=%d updated=%d err=%v", created, updated, err)
	}
}
