package service

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
)

func referenceWorkflow() CreativeWorkflow {
	return CreativeWorkflow{
		Scope:       "public",
		Mode:        "single_image",
		Name:        "商品海报",
		Category:    "电商",
		Description: "根据商品信息生成海报",
		Variables: []WorkflowVariable{
			{ID: "product", Key: "product", Label: "商品名称", Type: "text", Required: true, Options: []string{}},
			{ID: "slogan", Key: "slogan", Label: "核心卖点", Type: "textarea", DefaultValue: "轻盈耐用", Options: []string{}},
		},
		Config: WorkflowGenerationConfig{
			Model:          "gpt-image-1.5",
			ImageModel:     "gpt-image-1.5",
			Quality:        "high",
			Size:           "1024x1536",
			Count:          "2",
			APIMode:        "responses",
			Timeout:        "900",
			SystemPrompt:   "保持商业摄影质感",
			PromptTemplate: "{{product}}，{{ slogan }}",
			NegativePrompt: "低清晰度",
		},
		SeriesConfig: WorkflowSeriesConfig{
			TargetCount:       "4",
			PromptModel:       "gpt-5.2",
			PromptChannelID:   "text-token",
			PromptInstruction: "保持一致",
			ReviewRequired:    true,
			Concurrency:       "3",
		},
	}
}

func TestWorkflowServiceCRUDVisibilityAndReferenceRun(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	created, err := workflows.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if created.OwnerID != "alice" || !created.Editable || created.Revision != 1 {
		t.Fatalf("created workflow = %#v", created)
	}
	if created.Config.APIMode != "responses" || created.SeriesConfig.PromptChannelID != "text-token" {
		t.Fatalf("reference configuration was not preserved: %#v", created)
	}
	visible, err := workflows.List("bob")
	if err != nil || len(visible) != 1 || visible[0].Editable {
		t.Fatalf("bob visible workflows = %#v, error = %v", visible, err)
	}
	created.Name = "更新后的商品海报"
	updated, err := workflows.Save("alice", created)
	if err != nil || updated.Name != created.Name || updated.Revision != 2 {
		t.Fatalf("updated workflow = %#v, error = %v", updated, err)
	}
	touched, err := workflows.TouchLastRun("alice", created.ID, "2026-08-26T08:00:00Z")
	if err != nil || touched.LastRunAt != "2026-08-26T08:00:00Z" || touched.Revision != updated.Revision {
		t.Fatalf("touched last run workflow = %#v, error = %v", touched, err)
	}
	if err := workflows.Delete("bob", created.ID); err == nil {
		t.Fatal("Delete() error = nil, want ownership error")
	}
	if err := workflows.Delete("alice", created.ID); err != nil {
		t.Fatalf("owner Delete() error = %v", err)
	}
}

func TestWorkflowServiceNormalizesDraftFieldsLikeReferenceFrontend(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	invalidVariable := referenceWorkflow()
	invalidVariable.Variables[0].Key = "product name"
	created, err := workflows.Save("alice", invalidVariable)
	if err != nil || created.Variables[0].Key != "product_name" {
		t.Fatalf("Save() normalized variable = %#v, error = %v", created.Variables, err)
	}
	missingTemplate := referenceWorkflow()
	missingTemplate.Config.PromptTemplate = ""
	if _, err := workflows.Save("alice", missingTemplate); err != nil {
		t.Fatalf("Save() missing template error = %v", err)
	}
}

func TestWorkflowServiceRejectsAmbiguousVariableIdentifiers(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(*CreativeWorkflow)
		wantError string
	}{
		{
			name: "empty normalized key",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Variables[0].Key = "   "
			},
			wantError: "第 1 个工作流变量缺少变量名",
		},
		{
			name: "duplicate normalized key",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Variables[0].Key = "product name"
				workflow.Variables[1].Key = "product/name"
			},
			wantError: `工作流变量名 "product_name" 重复`,
		},
		{
			name: "duplicate id",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Variables[1].ID = workflow.Variables[0].ID
			},
			wantError: `工作流变量 ID "product" 重复`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			workflow := referenceWorkflow()
			test.mutate(&workflow)
			_, err := NewWorkflowService(newTestStorageBackend(t)).Save("alice", workflow)
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Save() error = %v, want error containing %q", err, test.wantError)
			}
		})
	}
}

func TestWorkflowServiceRejectsResourceExhaustingDefinitions(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(*CreativeWorkflow)
		wantError string
	}{
		{
			name: "long name",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Name = strings.Repeat("名", maxWorkflowNameRunes+1)
			},
			wantError: "工作流名称最多支持",
		},
		{
			name: "too many variables",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Variables = make([]WorkflowVariable, maxWorkflowVariables+1)
				for i := range workflow.Variables {
					workflow.Variables[i] = WorkflowVariable{ID: fmt.Sprintf("variable-%d", i), Key: fmt.Sprintf("variable_%d", i)}
				}
			},
			wantError: "每个工作流最多支持",
		},
		{
			name: "too many options",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Variables[0].Options = make([]string, maxWorkflowVariableOptions+1)
			},
			wantError: "第 1 个工作流变量最多支持",
		},
		{
			name: "oversized payload",
			mutate: func(workflow *CreativeWorkflow) {
				workflow.Config.PromptTemplate = strings.Repeat("x", maxWorkflowPayloadBytes)
			},
			wantError: "单个工作流配置不能超过",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			workflow := referenceWorkflow()
			test.mutate(&workflow)
			_, err := NewWorkflowService(newTestStorageBackend(t)).Save("alice", workflow)
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Save() error = %v, want error containing %q", err, test.wantError)
			}
		})
	}
}

func TestWorkflowServiceLimitsNewWorkflowsPerOwnerWithoutBlockingOtherOwnersOrUpdates(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := jsonDocumentStoreFromBackend(backend)
	items := make([]CreativeWorkflow, maxWorkflowsPerOwner)
	for i := range items {
		items[i] = CreativeWorkflow{
			ID:       fmt.Sprintf("workflow-%d", i),
			Revision: 1,
			OwnerID:  "alice",
			Name:     fmt.Sprintf("工作流 %d", i),
		}
	}
	if err := store.SaveJSONDocument(workflowDocumentName, map[string]any{"version": 3, "items": items}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}
	workflows := NewWorkflowService(backend)
	if _, err := workflows.Save("alice", referenceWorkflow()); err == nil || !strings.Contains(err.Error(), "每个用户最多保存") {
		t.Fatalf("Save(alice new) error = %v, want owner limit", err)
	}
	bobWorkflow := referenceWorkflow()
	bobWorkflow.Name = "Bob 工作流"
	bobWorkflow.Scope = "private"
	if _, err := workflows.Save("bob", bobWorkflow); err != nil {
		t.Fatalf("Save(bob new) error = %v", err)
	}
	visible, err := workflows.List("alice")
	if err != nil || len(visible) != maxWorkflowsPerOwner {
		t.Fatalf("List(alice) length = %d, error = %v", len(visible), err)
	}
	updated := visible[0]
	updated.Name = "已更新"
	if _, err := workflows.Save("alice", updated); err != nil {
		t.Fatalf("Save(alice existing) error = %v", err)
	}
}

func TestWorkflowServiceStillReadsExistingDefinitionsAboveNewWriteLimits(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := jsonDocumentStoreFromBackend(backend)
	legacy := referenceWorkflow()
	legacy.ID = "existing-large-workflow"
	legacy.Revision = 1
	legacy.OwnerID = "alice"
	legacy.Name = strings.Repeat("名", maxWorkflowNameRunes+1)
	if err := store.SaveJSONDocument(workflowDocumentName, map[string]any{"version": 3, "items": []CreativeWorkflow{legacy}}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	items, err := NewWorkflowService(backend).List("alice")
	if err != nil || len(items) != 1 || items[0].Name != legacy.Name {
		t.Fatalf("List() = (%#v, %v), want existing workflow unchanged", items, err)
	}
}

func TestWorkflowServiceLoadsLegacyVariablesWithoutIDs(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := jsonDocumentStoreFromBackend(backend)
	if err := store.SaveJSONDocument(workflowDocumentName, map[string]any{
		"version": 1,
		"items": []map[string]any{{
			"id":       "legacy-workflow",
			"owner_id": "alice",
			"name":     "旧工作流",
			"variables": []map[string]any{
				{"key": "subject name", "type": "text"},
				{"key": "style", "type": "text"},
			},
		}},
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	items, err := NewWorkflowService(backend).List("alice")
	if err != nil || len(items) != 1 || len(items[0].Variables) != 2 {
		t.Fatalf("List() = (%#v, %v)", items, err)
	}
	variables := items[0].Variables
	if variables[0].Key != "subject_name" || variables[0].ID == "" || variables[1].ID == "" || variables[0].ID == variables[1].ID || items[0].Revision != 1 {
		t.Fatalf("normalized legacy variables = %#v", variables)
	}
}

func TestWorkflowServiceRejectsStaleClientRevision(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	base, err := workflows.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save(base) error = %v", err)
	}
	current := base
	current.Name = "当前编辑"
	current, err = workflows.Save("alice", current)
	if err != nil {
		t.Fatalf("Save(current) error = %v", err)
	}

	stale := base
	stale.Name = "旧快照编辑"
	if _, err := workflows.Save("alice", stale); !errors.Is(err, storage.ErrConcurrentRowUpdate) {
		t.Fatalf("Save(stale) error = %v, want concurrent mutation", err)
	}
	items, err := workflows.List("alice")
	if err != nil || len(items) != 1 || items[0].Name != current.Name || items[0].Revision != current.Revision {
		t.Fatalf("workflows after stale save = %#v, error = %v", items, err)
	}
}

func TestWorkflowServicePreservesReferenceSeriesParameters(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	workflow := referenceWorkflow()
	workflow.Mode = "multi_image_series"
	workflow.SeriesConfig.TargetCount = "12"
	workflow.SeriesConfig.Concurrency = "5"
	created, err := workflows.Save("alice", workflow)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if created.Mode != "multi_image_series" || created.SeriesConfig.TargetCount != "12" || created.SeriesConfig.Concurrency != "5" || !created.SeriesConfig.ReviewRequired {
		t.Fatalf("series workflow = %#v", created)
	}
	workflow.ID = ""
	workflow.Name = "边界归一化"
	workflow.SeriesConfig.TargetCount = "99"
	workflow.SeriesConfig.Concurrency = "0"
	workflow.Config.Count = "30"
	created, err = workflows.Save("alice", workflow)
	if err != nil {
		t.Fatalf("Save() bounds error = %v", err)
	}
	if created.SeriesConfig.TargetCount != "99" || created.SeriesConfig.Concurrency != "0" || created.Config.Count != "30" {
		t.Fatalf("preserved parameters = %#v", created)
	}
}

func TestWorkflowServicePrivateScopeDoesNotGrantAdministratorOwnership(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	private := referenceWorkflow()
	private.Scope = "private"
	created, err := workflows.Save("alice", private)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	visible, err := workflows.List("administrator")
	if err != nil {
		t.Fatalf("administrator List() error = %v", err)
	}
	if len(visible) != 0 {
		t.Fatalf("administrator private workflows = %#v, want none", visible)
	}
	created.Name = "管理员修改"
	if _, err := workflows.Save("administrator", created); err == nil {
		t.Fatal("administrator Save() error = nil, want ownership error")
	}
	if err := workflows.Delete("administrator", created.ID); err == nil {
		t.Fatal("administrator Delete() error = nil, want ownership error")
	}
}

func TestWorkflowServicePreservesUnknownIDAndDeleteIsIdempotent(t *testing.T) {
	backend := newTestStorageBackend(t)
	workflows := NewWorkflowService(backend)
	workflow := referenceWorkflow()
	workflow.ID = "imported-workflow-id"
	created, err := workflows.Save("alice", workflow)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if created.ID != workflow.ID {
		t.Fatalf("created ID = %q, want %q", created.ID, workflow.ID)
	}

	reloaded, err := NewWorkflowService(backend).List("alice")
	if err != nil || len(reloaded) != 1 || reloaded[0].ID != workflow.ID || !reloaded[0].Editable {
		t.Fatalf("reloaded workflows = %#v, error = %v", reloaded, err)
	}
	if err := workflows.Delete("alice", "missing-workflow-id"); err != nil {
		t.Fatalf("Delete() missing error = %v", err)
	}
}

func TestWorkflowServiceMergesConcurrentDatabaseCreates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflows.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))

	first := referenceWorkflow()
	first.Name = "工作流 A"
	second := referenceWorkflow()
	second.Name = "工作流 B"
	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.Save("alice", first)
		errorsCh <- saveErr
	}()
	go func() {
		_, saveErr := serviceB.Save("alice", second)
		errorsCh <- saveErr
	}()
	for range 2 {
		if saveErr := <-errorsCh; saveErr != nil {
			t.Fatalf("concurrent Save() error = %v", saveErr)
		}
	}

	items, err := serviceA.List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("concurrent creates lost a workflow: %#v", items)
	}
}

func TestWorkflowServiceInitializesStarterSetOnceAcrossConcurrentInstances(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflow-initialize.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))

	first := referenceWorkflow()
	first.Name = "初始工作流 A"
	first.Scope = "public"
	second := referenceWorkflow()
	second.Name = "初始工作流 B"
	second.Scope = "public"
	starters := []CreativeWorkflow{first, second}
	type initializeResult struct {
		items []CreativeWorkflow
		err   error
	}
	results := make(chan initializeResult, 2)
	go func() {
		items, initializeErr := serviceA.InitializeIfEmpty("alice", starters)
		results <- initializeResult{items: items, err: initializeErr}
	}()
	go func() {
		items, initializeErr := serviceB.InitializeIfEmpty("alice", starters)
		results <- initializeResult{items: items, err: initializeErr}
	}()
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("InitializeIfEmpty() error = %v", result.err)
		}
		if len(result.items) != 2 {
			t.Fatalf("InitializeIfEmpty() items = %#v, want one starter set", result.items)
		}
	}

	items, err := NewWorkflowService(backendA).List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("stored starter workflows = %#v, want exactly two", items)
	}
	names := map[string]bool{}
	for _, item := range items {
		names[item.Name] = true
	}
	if !names[first.Name] || !names[second.Name] {
		t.Fatalf("stored starter workflow names = %#v", names)
	}
}

func TestWorkflowServiceMergesConcurrentDatabaseDeletes(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflow-deletes.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	seed := NewWorkflowService(backendA)
	first, err := seed.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save(first) error = %v", err)
	}
	secondInput := referenceWorkflow()
	secondInput.Name = "第二个工作流"
	second, err := seed.Save("alice", secondInput)
	if err != nil {
		t.Fatalf("Save(second) error = %v", err)
	}

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))
	errorsCh := make(chan error, 2)
	go func() { errorsCh <- serviceA.Delete("alice", first.ID) }()
	go func() { errorsCh <- serviceB.Delete("alice", second.ID) }()
	for range 2 {
		if deleteErr := <-errorsCh; deleteErr != nil {
			t.Fatalf("concurrent Delete() error = %v", deleteErr)
		}
	}

	items, err := serviceA.List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("concurrent deletes restored a workflow: %#v", items)
	}
}

func TestWorkflowServiceRejectsConcurrentUpdatesToSameWorkflow(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflow-updates.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	seed := NewWorkflowService(backendA)
	base, err := seed.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save(seed) error = %v", err)
	}

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))
	first := base
	first.Name = "并发更新 A"
	second := base
	second.Name = "并发更新 B"
	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.Save("alice", first)
		errorsCh <- saveErr
	}()
	go func() {
		_, saveErr := serviceB.Save("alice", second)
		errorsCh <- saveErr
	}()
	assertOneWorkflowMutationConflict(t, errorsCh)

	items, err := seed.List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 || items[0].Name != first.Name && items[0].Name != second.Name {
		t.Fatalf("concurrent update result = %#v", items)
	}
}

func TestWorkflowServiceMergesConcurrentSaveAndLastRunTouch(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflow-last-run.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	seed := NewWorkflowService(backendA)
	base, err := seed.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save(seed) error = %v", err)
	}

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))
	updated := base
	updated.Name = "并发编辑后的名称"
	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.Save("alice", updated)
		errorsCh <- saveErr
	}()
	go func() {
		_, touchErr := serviceB.TouchLastRun("alice", base.ID, "2026-08-26T08:00:00Z")
		errorsCh <- touchErr
	}()
	for range 2 {
		if mutationErr := <-errorsCh; mutationErr != nil {
			t.Fatalf("concurrent save/touch error = %v", mutationErr)
		}
	}

	items, err := seed.List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 || items[0].Name != updated.Name || items[0].LastRunAt != "2026-08-26T08:00:00Z" || items[0].Revision != base.Revision+1 {
		t.Fatalf("concurrent save/touch result = %#v", items)
	}
}

func TestWorkflowServiceRejectsConcurrentSaveAndDeleteOfSameWorkflow(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-workflow-save-delete.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })
	seed := NewWorkflowService(backendA)
	base, err := seed.Save("alice", referenceWorkflow())
	if err != nil {
		t.Fatalf("Save(seed) error = %v", err)
	}

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewWorkflowService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewWorkflowService(newFirstSaveBarrierBackend(t, backendB, barrier))
	updated := base
	updated.Name = "并发保存"
	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.Save("alice", updated)
		errorsCh <- saveErr
	}()
	go func() { errorsCh <- serviceB.Delete("alice", base.ID) }()
	assertOneWorkflowMutationConflict(t, errorsCh)

	items, err := seed.List("alice")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) > 1 || len(items) == 1 && items[0].Name != updated.Name {
		t.Fatalf("concurrent save/delete result = %#v", items)
	}
}

func assertOneWorkflowMutationConflict(t *testing.T, errorsCh <-chan error) {
	t.Helper()
	successes := 0
	conflicts := 0
	for range 2 {
		err := <-errorsCh
		switch {
		case err == nil:
			successes++
		case errors.Is(err, storage.ErrConcurrentRowUpdate):
			conflicts++
		default:
			t.Fatalf("concurrent mutation error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent mutation results: successes = %d, conflicts = %d", successes, conflicts)
	}
}

func TestWorkflowServiceRejectsInvalidPersistedWorkflow(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := jsonDocumentStoreFromBackend(backend)
	if err := store.SaveJSONDocument(workflowDocumentName, map[string]any{
		"version": 2,
		"items": []map[string]any{{
			"id":       "broken-workflow",
			"owner_id": "alice",
			"name":     "   ",
		}},
	}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	_, err := NewWorkflowService(backend).List("alice")
	if err == nil || !strings.Contains(err.Error(), "broken-workflow") || !strings.Contains(err.Error(), "请输入工作流名称") {
		t.Fatalf("List() error = %v, want persisted workflow validation error", err)
	}
	var storageErr *WorkflowStorageError
	var validationErr WorkflowValidationError
	if !errors.As(err, &storageErr) || !errors.As(err, &validationErr) {
		t.Fatalf("List() error = %T %v, want storage boundary preserving validation cause", err, err)
	}
}

func TestWorkflowServiceIgnoresRemovedDAGFields(t *testing.T) {
	workflows := NewWorkflowService(newTestStorageBackend(t))
	created, err := workflows.Save("alice", CreativeWorkflow{
		Name:      "当前工作流",
		Variables: []WorkflowVariable{{Key: "subject", Label: "主题", Type: "text", Required: true}},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if created.Config.PromptTemplate != "" || created.Config.ImageModel != "" || created.Config.Size != "auto" || created.Config.Count != "1" {
		t.Fatalf("removed DAG fields affected current contract = %#v", created)
	}
}

func TestNormalizeWorkflowAgentDraftMatchesReferenceContract(t *testing.T) {
	draft, warnings, err := NormalizeWorkflowAgentDraft("```json\n{\"name\":\"商品图\",\"scope\":\"public\",\"variables\":[{\"key\":\"product name/名称\"}]}\n```", "private")
	if err != nil {
		t.Fatalf("NormalizeWorkflowAgentDraft() error = %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %#v", warnings)
	}
	if draft["scope"] != "private" {
		t.Fatalf("scope = %#v", draft["scope"])
	}
	variables, ok := draft["variables"].([]any)
	if !ok || len(variables) != 1 {
		t.Fatalf("variables = %#v", draft["variables"])
	}
	variable, _ := variables[0].(map[string]any)
	if variable["key"] != "product_name___" {
		t.Fatalf("sanitized key = %#v", variable["key"])
	}
}

func TestNormalizeWorkflowAgentDraftUsesRequestedPublicScope(t *testing.T) {
	draft, _, err := NormalizeWorkflowAgentDraft(`{"name":"商品图","scope":"private"}`, "public")
	if err != nil {
		t.Fatalf("NormalizeWorkflowAgentDraft() error = %v", err)
	}
	if draft["scope"] != "public" {
		t.Fatalf("scope = %#v, want requested public scope", draft["scope"])
	}
}

func TestNormalizeWorkflowAgentDraftRejectsAmbiguousVariables(t *testing.T) {
	_, _, err := NormalizeWorkflowAgentDraft(`{
		"name":"商品图",
		"variables":[
			{"key":"product name","type":"text"},
			{"key":"product/name","type":"text"}
		]
	}`, "private")
	if err == nil || !strings.Contains(err.Error(), `工作流变量名 "product_name" 重复`) {
		t.Fatalf("NormalizeWorkflowAgentDraft() error = %v", err)
	}
}

func TestNormalizeWorkflowAgentDraftRejectsNonJSON(t *testing.T) {
	if _, _, err := NormalizeWorkflowAgentDraft("没有 JSON", "public"); err == nil || !strings.Contains(err.Error(), "格式异常") {
		t.Fatalf("NormalizeWorkflowAgentDraft() error = %v", err)
	}
}

func TestWorkflowAgentMessagesIncludesOnlyInlineImageReferences(t *testing.T) {
	messages := WorkflowAgentMessages("创建商品海报", []string{
		"data:image/png;base64,AAAA",
		"https://example.com/image.png",
	})
	if len(messages) != 2 || messages[0]["content"] != WorkflowAgentSystemPrompt {
		t.Fatalf("messages = %#v", messages)
	}
	content, ok := messages[1]["content"].([]map[string]any)
	if !ok || len(content) != 2 {
		t.Fatalf("user content = %#v", messages[1]["content"])
	}
	if content[0]["type"] != "text" || content[1]["type"] != "image_url" {
		t.Fatalf("user content = %#v", content)
	}
}
