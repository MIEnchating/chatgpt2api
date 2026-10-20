package videocontract

import (
	"path/filepath"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestReferenceForContractTracksPublishedSnapshotAcrossRename(t *testing.T) {
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "contracts.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	svc := NewVideoModelContractService(backend)
	if err := svc.Initialize(); err != nil {
		t.Fatal(err)
	}
	created, err := svc.Create(testVideoContract(t, "Original name", "reference-video"), true)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, ok := protocol.VideoContractForModel("reference-video")
	if !ok {
		t.Fatal("published contract was not installed")
	}
	reference, err := svc.ReferenceForContract(snapshot, "reference-video")
	if err != nil || reference["id"] != created.ID || reference["revision"] != 1 {
		t.Fatalf("initial reference = %#v, err = %v", reference, err)
	}
	updated := created.Contract
	updated.Name = "Renamed contract"
	if _, err := svc.Publish(created.ID, &updated, nil); err != nil {
		t.Fatal(err)
	}
	reference, err = svc.ReferenceForContract(snapshot, "reference-video")
	if err != nil || reference["id"] != created.ID || reference["name"] != "Original name" || util.ToInt(reference["revision"], 0) != 1 {
		t.Fatalf("old snapshot reference = %#v, err = %v", reference, err)
	}
	current, _ := protocol.VideoContractForModel("reference-video")
	reference, err = svc.ReferenceForContract(current, "reference-video")
	if err != nil || reference["id"] != created.ID || reference["name"] != updated.Name || util.ToInt(reference["revision"], 0) != 2 {
		t.Fatalf("new snapshot reference = %#v, err = %v", reference, err)
	}
}

func TestReferenceForContractPreservesModelProfileRevision(t *testing.T) {
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "profiles.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	svc := NewVideoModelContractService(backend)
	contract := testVideoContract(t, "Profile history", "profile-history-video")
	contract.ModelProfiles = []protocol.VideoModelContractProfile{{Model: contract.Models[0], Capability: contract.Capability, Generation: contract.Generation, Validation: contract.Validation, Rules: contract.Rules}}
	contract.ModelProfiles[0].Capability.DefaultSeconds = 8
	created, err := svc.Create(contract, true)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := protocol.VideoContractForModel(contract.Models[0])
	contract.ModelProfiles[0].Capability.DefaultSeconds = 9
	if _, err := svc.Publish(created.ID, &contract, nil); err != nil {
		t.Fatal(err)
	}
	reference, err := svc.ReferenceForContract(before, contract.Models[0])
	if err != nil || reference["revision"] != 1 || before.Capability.DefaultSeconds != 8 {
		t.Fatalf("old profile snapshot changed: %#v %v", reference, err)
	}
	after, _ := protocol.VideoContractForModel(contract.Models[0])
	reference, err = svc.ReferenceForContract(after, contract.Models[0])
	if err != nil || reference["revision"] != 2 || after.Capability.DefaultSeconds != 9 {
		t.Fatalf("new profile revision missing: %#v %v", reference, err)
	}
}
