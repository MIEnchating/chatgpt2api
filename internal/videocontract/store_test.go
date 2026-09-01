package videocontract

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
)

type scriptedVideoContractDocumentBackend struct {
	storage.Backend
	document         any
	conflictDocument any
	loadCalls        int
	saveCalls        int
	saveErrors       []error
}

func (b *scriptedVideoContractDocumentBackend) LoadJSONDocument(string) (any, error) {
	b.loadCalls++
	return b.document, nil
}

func (b *scriptedVideoContractDocumentBackend) SaveJSONDocument(_ string, value any) error {
	b.saveCalls++
	if len(b.saveErrors) > 0 {
		err := b.saveErrors[0]
		b.saveErrors = b.saveErrors[1:]
		if errors.Is(err, storage.ErrConcurrentRowUpdate) {
			b.document = b.conflictDocument
			b.conflictDocument = nil
		}
		return err
	}
	b.document = value
	return nil
}

func (b *scriptedVideoContractDocumentBackend) DeleteJSONDocument(string) error {
	b.document = nil
	return nil
}

func testVideoContract(t *testing.T, id, model string) protocol.VideoModelContract {
	t.Helper()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = id
	contract.Models = []string{model}
	return contract
}

func TestVideoModelContractServiceInitializeReloadsAfterConcurrentDefaultInsert(t *testing.T) {
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	publishedAt := "2026-08-31T00:00:00Z"
	peerContract := testVideoContract(t, "Peer contract", "peer/video-v1")
	peerDocument := videoModelContractStoreDocument{
		Version: videoModelContractStoreVersion,
		Items: []ManagedVideoModelContract{{
			ID:        "peer-contract",
			Contract:  peerContract,
			Enabled:   true,
			Revision:  1,
			Versions:  appendVideoContractVersion(nil, 1, peerContract, publishedAt),
			CreatedAt: publishedAt,
			UpdatedAt: publishedAt,
		}},
	}
	backend := &scriptedVideoContractDocumentBackend{
		conflictDocument: peerDocument,
		saveErrors:       []error{storage.ErrConcurrentRowUpdate},
	}

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	if backend.loadCalls != 2 || backend.saveCalls != 1 {
		t.Fatalf("storage calls = %d loads, %d saves; want 2 loads, 1 save", backend.loadCalls, backend.saveCalls)
	}
	stored, ok := backend.document.(videoModelContractStoreDocument)
	if !ok || len(stored.Items) != 1 || stored.Items[0].ID != "peer-contract" {
		t.Fatalf("stored document was overwritten: %#v", backend.document)
	}
	active, ok := protocol.VideoContractForModel("peer/video-v1")
	if !ok || active.Name != peerContract.Name {
		t.Fatalf("active peer contract = %#v, %v", active, ok)
	}
}

func TestVideoModelContractServiceInitializeReturnsStorageFailure(t *testing.T) {
	wantErr := errors.New("storage unavailable")
	backend := &scriptedVideoContractDocumentBackend{saveErrors: []error{wantErr}}

	err := NewVideoModelContractService(backend).Initialize()
	if !errors.Is(err, wantErr) {
		t.Fatalf("Initialize() error = %v, want %v", err, wantErr)
	}
	if backend.loadCalls != 1 || backend.saveCalls != 1 {
		t.Fatalf("storage calls = %d loads, %d saves; want 1 load, 1 save", backend.loadCalls, backend.saveCalls)
	}
}

func TestVideoModelContractServicePersistsAndRefreshesRuntime(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	created, err := service.Create(testVideoContract(t, "custom-video-v1", "custom/video-v1"), true)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" || !created.Enabled || created.CreatedAt == "" {
		t.Fatalf("Create() = %#v", created)
	}
	if contract, ok := protocol.VideoContractForModel("custom/video-v1"); !ok || contract.Name != created.Contract.Name {
		t.Fatalf("runtime contract = %#v, %v", contract, ok)
	}

	reloaded := NewVideoModelContractService(backend)
	if err := reloaded.Initialize(); err != nil {
		t.Fatalf("reloaded Initialize() error = %v", err)
	}
	items, err := reloaded.List()
	if err != nil || len(items) != len(protocol.DefaultVideoContracts())+1 {
		t.Fatalf("reloaded List() = %#v, error = %v", items, err)
	}
	if _, err := reloaded.SetEnabled(created.ID, false); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	if _, ok := protocol.VideoContractForModel("custom/video-v1"); ok {
		t.Fatal("disabled contract remained active")
	}
	deleted, err := reloaded.Delete(created.ID)
	if err != nil || !deleted {
		t.Fatalf("Delete() = %v, %v", deleted, err)
	}
}

func TestVideoModelContractServiceMigratesLegacyGatewayDriver(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	contract := protocol.DefaultVideoContracts()[0]
	contract.Driver = "newapi-video"
	document := videoModelContractStoreDocument{Version: 5, Items: []ManagedVideoModelContract{{
		ID: "legacy-contract", Contract: contract, Enabled: true, CreatedAt: "2026-08-30T00:00:00Z", UpdatedAt: "2026-08-30T00:00:00Z",
	}}}
	if err := backend.SaveJSONDocument(videoModelContractDocumentName, document); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	items, err := service.List()
	if err != nil || len(items) != 1 || items[0].Contract.Driver != protocol.VideoContractDriverOpenAI || items[0].Contract.Artifact.Mode != "task_content" || items[0].Contract.Artifact.Auth != "relay" {
		t.Fatalf("List() = %#v, error = %v", items, err)
	}
	raw, err := backend.LoadJSONDocument(videoModelContractDocumentName)
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	data, _ := json.Marshal(raw)
	if strings.Contains(string(data), "newapi-video") || !strings.Contains(string(data), protocol.VideoContractDriverOpenAI) {
		t.Fatalf("legacy driver was not persisted as migrated: %s", data)
	}
}

func TestVideoModelContractServiceMigratesDefaultMiniMaxH3RulesOnce(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "海螺-MiniMax H3"
	contract.Models = []string{"minimax-h3-768p"}
	contract.Rules = nil
	document := videoModelContractStoreDocument{Version: 4, Items: []ManagedVideoModelContract{{
		ID: "legacy-h3", Contract: contract, Enabled: true, CreatedAt: "2026-08-30T00:00:00Z", UpdatedAt: "2026-08-30T00:00:00Z",
	}}}
	if err := backend.SaveJSONDocument(videoModelContractDocumentName, document); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	items, err := service.List()
	if err != nil || len(items) != 1 || len(items[0].Contract.Rules) != 2 {
		t.Fatalf("List() = %#v, error = %v", items, err)
	}
	if got := items[0].Contract.Rules[1].Forbid; !reflect.DeepEqual(got, []string{"reference_image", "reference_video", "reference_audio"}) {
		t.Fatalf("migrated forbid fields = %#v", got)
	}

	items[0].Contract.Rules = items[0].Contract.Rules[:1]
	if _, err := service.Update(items[0].ID, items[0].Contract, true); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	reloaded := NewVideoModelContractService(backend)
	if err := reloaded.Initialize(); err != nil {
		t.Fatalf("reloaded Initialize() error = %v", err)
	}
	items, err = reloaded.List()
	if err != nil || len(items) != 1 || len(items[0].Contract.Rules) != 1 {
		t.Fatalf("user-edited rules were migrated again: %#v, error = %v", items, err)
	}
}

func TestVideoModelContractServiceRejectsConflicts(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	if _, err := service.Create(testVideoContract(t, "custom-video-v1", "minimax-h3-768p"), true); err == nil {
		t.Fatal("Create() accepted a built-in model collision")
	}
	if _, err := service.Create(testVideoContract(t, "MiniMax H3 v1.8", "custom/video-v1"), true); err == nil {
		t.Fatal("Create() accepted a duplicate name")
	}
}

func TestDefaultVideoModelContractCanBeEditedAndDeleted(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	items, err := service.List()
	if err != nil || len(items) != 1 {
		t.Fatalf("List() = %#v, error = %v", items, err)
	}
	contract := items[0].Contract
	contract.Name = "可编辑的 H3 契约"
	updated, err := service.Update(items[0].ID, contract, true)
	if err != nil || updated == nil || updated.Contract.Name != contract.Name {
		t.Fatalf("Update() = %#v, error = %v", updated, err)
	}
	if deleted, err := service.Delete(items[0].ID); err != nil || !deleted {
		t.Fatalf("Delete() = %v, error = %v", deleted, err)
	}
	reloaded := NewVideoModelContractService(backend)
	if err := reloaded.Initialize(); err != nil {
		t.Fatalf("reloaded Initialize() error = %v", err)
	}
	items, err = reloaded.List()
	if err != nil || len(items) != 0 {
		t.Fatalf("deleted default contract was restored: %#v, error = %v", items, err)
	}
}

func TestVideoModelContractServiceImportsBundleAtomically(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	defaults, err := service.List()
	if err != nil || len(defaults) != 1 {
		t.Fatalf("List() = %#v, error = %v", defaults, err)
	}
	updatedContract := defaults[0].Contract
	updatedContract.Models = []string{"imported/default-video"}
	newContract := testVideoContract(t, "Imported custom video", "imported/custom-video")
	created, updated, err := service.Import([]ImportedVideoModelContract{
		{Contract: updatedContract, Enabled: false},
		{Contract: newContract, Enabled: true},
	})
	if err != nil || created != 1 || updated != 1 {
		t.Fatalf("Import() = created %d, updated %d, error %v", created, updated, err)
	}
	items, err := service.List()
	if err != nil || len(items) != 2 {
		t.Fatalf("List() = %#v, error = %v", items, err)
	}
	if _, ok := protocol.VideoContractForModel("imported/default-video"); ok {
		t.Fatal("disabled imported contract remained active")
	}
	if _, ok := protocol.VideoContractForModel("imported/custom-video"); !ok {
		t.Fatal("enabled imported contract was not installed")
	}

	conflicting := testVideoContract(t, "Conflicting video", "imported/custom-video")
	if _, _, err := service.Import([]ImportedVideoModelContract{{Contract: conflicting, Enabled: true}}); err == nil {
		t.Fatal("Import() accepted a model collision")
	}
	afterFailure, err := service.List()
	if err != nil || len(afterFailure) != 2 {
		t.Fatalf("failed import changed stored contracts: %#v, error = %v", afterFailure, err)
	}
}

func TestVideoModelContractDraftPublishAndRollbackLifecycle(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "contracts.db")
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	service := NewVideoModelContractService(backend)
	if err := service.Initialize(); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	created, err := service.Create(testVideoContract(t, "Version one", "versioned/video"), true)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Revision != 1 || len(created.Versions) != 1 {
		t.Fatalf("created version metadata = %#v", created)
	}

	draft := created.Contract
	draft.Name = "Version two"
	saved, err := service.SaveDraft(created.ID, draft, false)
	if err != nil || saved == nil || saved.Draft == nil || saved.DraftEnabled == nil || *saved.DraftEnabled {
		t.Fatalf("SaveDraft() = %#v, error = %v", saved, err)
	}
	active, ok := protocol.VideoContractForModel("versioned/video")
	if !ok || active.Name != "Version one" {
		t.Fatalf("draft changed active contract = %#v, %v", active, ok)
	}

	published, err := service.Publish(created.ID, nil, nil)
	if err != nil || published == nil || published.Revision != 2 || published.Contract.Name != "Version two" || published.Enabled {
		t.Fatalf("Publish() = %#v, error = %v", published, err)
	}
	if _, ok := protocol.VideoContractForModel("versioned/video"); ok {
		t.Fatal("draft enabled state was not applied on publish")
	}

	rolledBack, err := service.Rollback(created.ID, 1)
	if err != nil || rolledBack == nil || rolledBack.Revision != 3 || rolledBack.Contract.Name != "Version one" {
		t.Fatalf("Rollback() = %#v, error = %v", rolledBack, err)
	}
	versions, err := service.Versions(created.ID)
	if err != nil || len(versions) != 3 || versions[0].Revision != 3 || versions[2].Revision != 1 {
		t.Fatalf("Versions() = %#v, error = %v", versions, err)
	}
}

func TestVideoModelContractMutationsRetryWithLatestDocument(t *testing.T) {
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	publishedAt := "2026-08-31T00:00:00Z"
	originalContract := testVideoContract(t, "CAS original", "cas/video-v1")
	currentContract := testVideoContract(t, "CAS current", "cas/video-v1")
	draftContract := testVideoContract(t, "CAS draft", "cas/video-v1")
	desiredContract := testVideoContract(t, "CAS desired", "cas/video-v1")
	peerContract := testVideoContract(t, "CAS peer", "cas/peer-video-v1")
	sentinelContract := testVideoContract(t, "CAS runtime sentinel", "cas/runtime-sentinel-v1")
	draftEnabled := false
	baseItem := ManagedVideoModelContract{
		ID:           "cas-contract",
		Contract:     currentContract,
		Draft:        &draftContract,
		DraftEnabled: &draftEnabled,
		Enabled:      true,
		Revision:     2,
		Versions: []VideoModelContractVersion{
			{Revision: 1, Contract: originalContract, PublishedAt: publishedAt},
			{Revision: 2, Contract: currentContract, PublishedAt: publishedAt},
		},
		CreatedAt:      publishedAt,
		UpdatedAt:      publishedAt,
		DraftUpdatedAt: publishedAt,
	}
	peerItem := ManagedVideoModelContract{
		ID:        "peer-contract",
		Contract:  peerContract,
		Enabled:   true,
		Revision:  1,
		Versions:  appendVideoContractVersion(nil, 1, peerContract, publishedAt),
		CreatedAt: publishedAt,
		UpdatedAt: publishedAt,
	}

	type mutationResult struct {
		item    *ManagedVideoModelContract
		deleted bool
	}
	tests := []struct {
		name                   string
		mutate                 func(*VideoModelContractService) (mutationResult, error)
		wantContractName       string
		wantDraftName          string
		wantRevision           int
		wantEnabled            bool
		wantDeleted            bool
		preservesActiveRuntime bool
	}{
		{
			name: "update",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				item, err := service.Update(baseItem.ID, desiredContract, false)
				return mutationResult{item: item}, err
			},
			wantContractName: desiredContract.Name,
			wantRevision:     3,
		},
		{
			name: "save draft",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				item, err := service.SaveDraft(baseItem.ID, desiredContract, false)
				return mutationResult{item: item}, err
			},
			wantContractName:       currentContract.Name,
			wantDraftName:          desiredContract.Name,
			wantRevision:           2,
			wantEnabled:            true,
			preservesActiveRuntime: true,
		},
		{
			name: "publish",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				item, err := service.Publish(baseItem.ID, nil, nil)
				return mutationResult{item: item}, err
			},
			wantContractName: draftContract.Name,
			wantRevision:     3,
		},
		{
			name: "rollback",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				item, err := service.Rollback(baseItem.ID, 1)
				return mutationResult{item: item}, err
			},
			wantContractName: originalContract.Name,
			wantRevision:     3,
			wantEnabled:      true,
		},
		{
			name: "set enabled",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				item, err := service.SetEnabled(baseItem.ID, false)
				return mutationResult{item: item}, err
			},
			wantContractName: currentContract.Name,
			wantDraftName:    draftContract.Name,
			wantRevision:     2,
		},
		{
			name: "delete",
			mutate: func(service *VideoModelContractService) (mutationResult, error) {
				deleted, err := service.Delete(baseItem.ID)
				return mutationResult{deleted: deleted}, err
			},
			wantDeleted: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := protocol.ReplaceVideoContracts([]protocol.VideoModelContract{sentinelContract}); err != nil {
				t.Fatalf("ReplaceVideoContracts() error = %v", err)
			}
			initialDocument := videoModelContractStoreDocument{
				Version: videoModelContractStoreVersion,
				Items:   []ManagedVideoModelContract{baseItem},
			}
			peerDocument := videoModelContractStoreDocument{
				Version: videoModelContractStoreVersion,
				Items:   []ManagedVideoModelContract{baseItem, peerItem},
			}
			backend := &scriptedVideoContractDocumentBackend{
				document:         initialDocument,
				conflictDocument: peerDocument,
				saveErrors:       []error{storage.ErrConcurrentRowUpdate},
			}
			result, err := test.mutate(NewVideoModelContractService(backend))
			if err != nil {
				t.Fatalf("mutation error = %v", err)
			}
			if backend.loadCalls != 2 || backend.saveCalls != 2 {
				t.Fatalf("storage calls = %d loads, %d saves; want 2 loads, 2 saves", backend.loadCalls, backend.saveCalls)
			}
			stored, ok := backend.document.(videoModelContractStoreDocument)
			if !ok {
				t.Fatalf("stored document type = %T", backend.document)
			}
			if managedVideoContractIndex(stored.Items, peerItem.ID) < 0 {
				t.Fatalf("concurrent peer item was overwritten: %#v", stored.Items)
			}

			index := managedVideoContractIndex(stored.Items, baseItem.ID)
			if test.wantDeleted {
				if !result.deleted || result.item != nil || index >= 0 {
					t.Fatalf("delete result = %#v, stored items = %#v", result, stored.Items)
				}
			} else {
				if result.deleted || result.item == nil || index < 0 {
					t.Fatalf("mutation result = %#v, stored items = %#v", result, stored.Items)
				}
				item := stored.Items[index]
				if item.Contract.Name != test.wantContractName || item.Revision != test.wantRevision || item.Enabled != test.wantEnabled {
					t.Fatalf("stored item = %#v", item)
				}
				if test.wantDraftName == "" {
					if item.Draft != nil {
						t.Fatalf("stored draft = %#v, want nil", item.Draft)
					}
				} else if item.Draft == nil || item.Draft.Name != test.wantDraftName {
					t.Fatalf("stored draft = %#v, want %q", item.Draft, test.wantDraftName)
				}
			}

			_, sentinelActive := protocol.VideoContractForModel(sentinelContract.Models[0])
			_, peerActive := protocol.VideoContractForModel(peerContract.Models[0])
			active, contractActive := protocol.VideoContractForModel(currentContract.Models[0])
			if test.preservesActiveRuntime {
				if !sentinelActive || peerActive || contractActive {
					t.Fatalf("draft save refreshed runtime: sentinel=%v peer=%v contract=%#v, %v", sentinelActive, peerActive, active, contractActive)
				}
				return
			}
			if sentinelActive || !peerActive {
				t.Fatalf("active runtime was not refreshed: sentinel=%v peer=%v", sentinelActive, peerActive)
			}
			if !test.wantDeleted && test.wantEnabled {
				if !contractActive || active.Name != test.wantContractName {
					t.Fatalf("active contract = %#v, %v; want %q", active, contractActive, test.wantContractName)
				}
			} else if contractActive {
				t.Fatalf("inactive contract remained in runtime: %#v", active)
			}
		})
	}
}
