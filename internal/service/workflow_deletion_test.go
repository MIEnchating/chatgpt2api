package service

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
)

func newWorkflowDeletionBackends(t *testing.T) (*storage.DatabaseBackend, *storage.DatabaseBackend) {
	t.Helper()
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "workflows.db"))
	open := func() *storage.DatabaseBackend {
		backend, err := storage.NewDatabaseBackend(databaseURL)
		if err != nil {
			t.Fatalf("NewDatabaseBackend() error = %v", err)
		}
		t.Cleanup(func() { _ = backend.Close() })
		return backend
	}
	return open(), open()
}

func workflowWithDeletionTestReference(objectID string) CreativeWorkflow {
	workflow := referenceWorkflow()
	workflow.Scope = "private"
	workflow.TemplateReferences = []WorkflowTemplateReference{{
		ID: "template", Name: "Template", URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
	}}
	return workflow
}

func TestWorkflowServicePendingDeletionBlocksAllCreationPathsAcrossInstances(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		for _, instance := range []string{"same", "other", "restarted"} {
			t.Run(operation+"/"+instance, func(t *testing.T) {
				backendA, backendB := newWorkflowDeletionBackends(t)
				serviceA := NewWorkflowService(backendA)
				serviceB := NewWorkflowService(backendB)
				if err := serviceA.ReserveStorageObjectDeletion("alice", "template-object"); err != nil {
					t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
				}
				switch instance {
				case "same":
					serviceB = serviceA
				case "restarted":
					serviceB = NewWorkflowService(backendB)
				}
				workflow := workflowWithDeletionTestReference("template-object")
				var err error
				if operation == "save" {
					_, err = serviceB.Save("alice", workflow)
				} else {
					_, err = serviceB.InitializeIfEmpty("alice", []CreativeWorkflow{workflow})
				}
				if err == nil || !strings.Contains(err.Error(), "正在删除") {
					t.Fatalf("%s(pending template) error = %v, want pending deletion validation error", operation, err)
				}
				items, err := serviceA.List("alice")
				if err != nil || len(items) != 0 {
					t.Fatalf("List() after rejection = (%#v, %v), want no workflows", items, err)
				}
			})
		}
	}
}

func TestWorkflowServiceDocumentMutationsPreservePendingDeletion(t *testing.T) {
	for _, operation := range []string{"save", "initialize", "touch", "delete"} {
		t.Run(operation, func(t *testing.T) {
			backendA, backendB := newWorkflowDeletionBackends(t)
			serviceA := NewWorkflowService(backendA)
			serviceB := NewWorkflowService(backendB)
			input := referenceWorkflow()
			input.Scope = "private"
			var existing CreativeWorkflow
			if operation == "touch" || operation == "delete" {
				var err error
				existing, err = serviceA.Save("bob", input)
				if err != nil {
					t.Fatalf("Save(seed) error = %v", err)
				}
			}
			if err := serviceA.ReserveStorageObjectDeletion("alice", "template-object"); err != nil {
				t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
			}
			var err error
			switch operation {
			case "save":
				_, err = serviceB.Save("bob", input)
			case "initialize":
				_, err = serviceB.InitializeIfEmpty("bob", []CreativeWorkflow{input})
			case "touch":
				_, err = serviceB.TouchLastRun("bob", existing.ID, "2026-09-14T12:00:00Z")
			case "delete":
				err = serviceB.Delete("bob", existing.ID)
			}
			if err != nil {
				t.Fatalf("%s() error = %v", operation, err)
			}
			_, err = NewWorkflowService(backendA).Save("alice", workflowWithDeletionTestReference("template-object"))
			if err == nil || !strings.Contains(err.Error(), "正在删除") {
				t.Fatalf("Save(pending template) after %s error = %v", operation, err)
			}
		})
	}
}

type workflowDeletionSaveHookBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.StorageObjectBackend
	beforeSave func()
}

func (b *workflowDeletionSaveHookBackend) SaveJSONDocument(name string, value any) error {
	if b.beforeSave != nil {
		hook := b.beforeSave
		b.beforeSave = nil
		hook()
	}
	return b.JSONDocumentBackend.SaveJSONDocument(name, value)
}

func TestWorkflowServiceCreationReloadsConcurrentPendingDeletion(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		t.Run(operation, func(t *testing.T) {
			backendA, backendB := newWorkflowDeletionBackends(t)
			saveWorkflowTestStorageObject(t, backendA, "template-object", "alice")
			serviceB := NewWorkflowService(backendB)
			hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
			hooked.beforeSave = func() {
				if err := serviceB.ReserveStorageObjectDeletion("alice", "template-object"); err != nil {
					t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
				}
			}
			serviceA := NewWorkflowService(hooked)
			input := workflowWithDeletionTestReference("template-object")
			var err error
			if operation == "save" {
				_, err = serviceA.Save("alice", input)
			} else {
				_, err = serviceA.InitializeIfEmpty("alice", []CreativeWorkflow{input})
			}
			if err == nil || !strings.Contains(err.Error(), "正在删除") {
				t.Fatalf("%s() across concurrent deletion reservation error = %v", operation, err)
			}
			items, err := serviceB.List("alice")
			if err != nil || len(items) != 0 {
				t.Fatalf("List() after rejected creation = (%#v, %v)", items, err)
			}
		})
	}
}

func TestWorkflowServiceDeletionReservationReloadsConcurrentReference(t *testing.T) {
	backendA, backendB := newWorkflowDeletionBackends(t)
	saveWorkflowTestStorageObject(t, backendA, "template-object", "alice")
	serviceB := NewWorkflowService(backendB)
	hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
	hooked.beforeSave = func() {
		if _, err := serviceB.Save("alice", workflowWithDeletionTestReference("template-object")); err != nil {
			t.Fatalf("Save(concurrent reference) error = %v", err)
		}
	}
	if err := NewWorkflowService(hooked).ReserveStorageObjectDeletion("alice", "template-object"); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("ReserveStorageObjectDeletion() across concurrent creation error = %v", err)
	}
	document, err := serviceB.loadLocked()
	if err != nil || len(document.PendingObjectDeletions) != 0 || len(document.Items) != 1 {
		t.Fatalf("document after rejected reservation = (%#v, %v)", document, err)
	}
}

func TestWorkflowServiceCompleteDeletionPreservesConcurrentReservationsAndWorkflows(t *testing.T) {
	backendA, backendB := newWorkflowDeletionBackends(t)
	serviceB := NewWorkflowService(backendB)
	if err := serviceB.ReserveStorageObjectDeletion("alice", "completed-object"); err != nil {
		t.Fatalf("ReserveStorageObjectDeletion(seed) error = %v", err)
	}
	hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
	hooked.beforeSave = func() {
		for _, ownerID := range []string{"alice", "bob"} {
			if err := serviceB.ReserveStorageObjectDeletion(ownerID, "pending-object"); err != nil {
				t.Fatalf("ReserveStorageObjectDeletion(%s) error = %v", ownerID, err)
			}
		}
		if _, err := serviceB.Save("alice", referenceWorkflow()); err != nil {
			t.Fatalf("Save(concurrent workflow) error = %v", err)
		}
	}
	if err := NewWorkflowService(hooked).CompleteStorageObjectDeletion("alice", "completed-object"); err != nil {
		t.Fatalf("CompleteStorageObjectDeletion() error = %v", err)
	}
	document, err := serviceB.loadLocked()
	if err != nil {
		t.Fatalf("loadLocked() error = %v", err)
	}
	if len(document.Items) != 1 {
		t.Fatalf("workflows after deletion completion = %#v", document.Items)
	}
	for _, ownerID := range []string{"alice", "bob"} {
		if !slices.Equal(document.PendingObjectDeletions[ownerID], []string{"pending-object"}) {
			t.Fatalf("pending deletions for %s = %#v", ownerID, document.PendingObjectDeletions[ownerID])
		}
	}
	for _, ownerID := range []string{"alice", "bob"} {
		if err := NewWorkflowService(backendA).CompleteStorageObjectDeletion(ownerID, "pending-object"); err != nil {
			t.Fatalf("CompleteStorageObjectDeletion(%s) error = %v", ownerID, err)
		}
	}
	document, err = serviceB.loadLocked()
	if err != nil || len(document.PendingObjectDeletions) != 0 {
		t.Fatalf("pending deletions after completion = (%#v, %v)", document.PendingObjectDeletions, err)
	}
}

func saveWorkflowTestStorageObject(t *testing.T, backend storage.StorageObjectBackend, id, ownerID string) {
	t.Helper()
	if err := backend.SaveStorageObject(model.StorageObject{ID: id, CreatedBy: ownerID, MIMEType: "image/png"}); err != nil {
		t.Fatalf("SaveStorageObject() error = %v", err)
	}
}

func TestWorkflowServiceCreationRejectsTemplateAfterDeletionCompletes(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		for _, concurrent := range []bool{false, true} {
			name := operation
			if concurrent {
				name += "/concurrent"
			}
			t.Run(name, func(t *testing.T) {
				backendA, backendB := newWorkflowDeletionBackends(t)
				saveWorkflowTestStorageObject(t, backendA, "template-object", "alice")
				serviceB := NewWorkflowService(backendB)
				completeDeletion := func() {
					if err := serviceB.ReserveStorageObjectDeletion("alice", "template-object"); err != nil {
						t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
					}
					if err := backendB.DeleteStorageObject("template-object"); err != nil {
						t.Fatalf("DeleteStorageObject() error = %v", err)
					}
					if err := serviceB.CompleteStorageObjectDeletion("alice", "template-object"); err != nil {
						t.Fatalf("CompleteStorageObjectDeletion() error = %v", err)
					}
				}
				hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
				if concurrent {
					hooked.beforeSave = completeDeletion
				} else {
					completeDeletion()
				}
				serviceA := NewWorkflowService(hooked)
				input := workflowWithDeletionTestReference("template-object")
				var err error
				if operation == "save" {
					_, err = serviceA.Save("alice", input)
				} else {
					_, err = serviceA.InitializeIfEmpty("alice", []CreativeWorkflow{input})
				}
				var validationErr WorkflowValidationError
				if !errors.As(err, &validationErr) {
					t.Fatalf("%s(deleted template) error = %v, want validation error", operation, err)
				}
				items, err := serviceB.List("alice")
				if err != nil || len(items) != 0 {
					t.Fatalf("List() after rejection = (%#v, %v)", items, err)
				}
			})
		}
	}
}

type workflowStorageObjectErrorBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.StorageObjectBackend
	err error
}

func (b *workflowStorageObjectErrorBackend) LoadStorageObject(string) (model.StorageObject, error) {
	return model.StorageObject{}, b.err
}

func TestWorkflowServiceCreationPreservesTemplateStorageErrors(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		t.Run(operation, func(t *testing.T) {
			backend := newTestStorageBackend(t)
			injected := errors.New("injected object read error")
			failing := &workflowStorageObjectErrorBackend{
				Backend: backend, JSONDocumentBackend: backend.(storage.JSONDocumentBackend),
				StorageObjectBackend: backend.(storage.StorageObjectBackend), err: injected,
			}
			service := NewWorkflowService(failing)
			input := workflowWithDeletionTestReference("template-object")
			var err error
			if operation == "save" {
				_, err = service.Save("alice", input)
			} else {
				_, err = service.InitializeIfEmpty("alice", []CreativeWorkflow{input})
			}
			var storageErr *WorkflowStorageError
			if !errors.As(err, &storageErr) || !errors.Is(err, injected) {
				t.Fatalf("%s() error = %v, want wrapped storage error", operation, err)
			}
		})
	}
}

func TestWorkflowServicePreservesAvailableTemplateReferenceSemantics(t *testing.T) {
	for _, referenceKind := range []string{"storage key", "local URL", "public cross owner", "external URL"} {
		t.Run(referenceKind, func(t *testing.T) {
			backend := newTestStorageBackend(t)
			objects := backend.(storage.StorageObjectBackend)
			input := workflowWithDeletionTestReference("template-object")
			switch referenceKind {
			case "storage key":
				input.TemplateReferences[0].URL = "https://images.example.test/template.png"
				saveWorkflowTestStorageObject(t, objects, "template-object", "alice")
			case "local URL":
				input.TemplateReferences[0].StorageKey = ""
				saveWorkflowTestStorageObject(t, objects, "template-object", "alice")
			case "public cross owner":
				input.Scope = "public"
				input.TemplateReferences[0].Visibility = "public"
				saveWorkflowTestStorageObject(t, objects, "template-object", "bob")
			case "external URL":
				input.TemplateReferences[0].StorageKey = ""
				input.TemplateReferences[0].URL = "https://images.example.test/template.png"
			}
			created, err := NewWorkflowService(backend).Save("alice", input)
			if err != nil || len(created.TemplateReferences) != 1 {
				t.Fatalf("Save(%s) = (%#v, %v)", referenceKind, created, err)
			}
		})
	}
}

func TestWorkflowServiceListsHistoricalMissingTemplateButRejectsUpdatingIt(t *testing.T) {
	backend := newTestStorageBackend(t)
	objects := backend.(storage.StorageObjectBackend)
	saveWorkflowTestStorageObject(t, objects, "template-object", "alice")
	service := NewWorkflowService(backend)
	created, err := service.Save("alice", workflowWithDeletionTestReference("template-object"))
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := objects.DeleteStorageObject("template-object"); err != nil {
		t.Fatalf("DeleteStorageObject() error = %v", err)
	}
	reloaded := NewWorkflowService(backend)
	items, err := reloaded.List("alice")
	if err != nil || len(items) != 1 || items[0].ID != created.ID {
		t.Fatalf("List() with missing historical template = (%#v, %v)", items, err)
	}
	created.Name = "Updated workflow"
	if _, err := reloaded.Save("alice", created); err == nil {
		t.Fatal("Save(update with missing template) error = nil, want validation error")
	}
	created.TemplateReferences = nil
	if _, err := reloaded.Save("alice", created); err != nil {
		t.Fatalf("Save(remove missing template) error = %v", err)
	}
}
