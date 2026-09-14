package service

import (
	"errors"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestWorkflowServiceChecksBothTemplateReferenceObjects(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		for _, targetID := range []string{"key-object", "url-object"} {
			for _, state := range []string{"pending", "missing"} {
				t.Run(operation+"/"+targetID+"/"+state, func(t *testing.T) {
					backendA, backendB := newWorkflowDeletionBackends(t)
					for _, objectID := range []string{"key-object", "url-object"} {
						if state != "missing" || objectID != targetID {
							if err := backendA.SaveStorageObject(model.StorageObject{ID: objectID, ObjectKey: objectID, CreatedBy: "alice", MIMEType: "image/png"}); err != nil {
								t.Fatalf("SaveStorageObject() error = %v", err)
							}
						}
					}
					if state == "pending" {
						if err := NewWorkflowService(backendA).ReserveStorageObjectDeletion("alice", targetID); err != nil {
							t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
						}
					}
					input := workflowWithDeletionTestReference("url-object")
					input.TemplateReferences[0].StorageKey = "server:key-object"
					service := NewWorkflowService(backendB)
					var err error
					if operation == "save" {
						_, err = service.Save("alice", input)
					} else {
						_, err = service.InitializeIfEmpty("alice", []CreativeWorkflow{input})
					}
					var validationErr WorkflowValidationError
					if !errors.As(err, &validationErr) {
						t.Fatalf("%s(%s %s) error = %v, want template validation error", operation, state, targetID, err)
					}
					items, err := service.List("alice")
					if err != nil || len(items) != 0 {
						t.Fatalf("List() after rejected creation = (%#v, %v)", items, err)
					}
				})
			}
		}
	}
}

func TestWorkflowServiceDeletionReservationProtectsBothTemplateReferenceObjects(t *testing.T) {
	backendA, backendB := newWorkflowDeletionBackends(t)
	for _, objectID := range []string{"key-object", "url-object"} {
		if err := backendA.SaveStorageObject(model.StorageObject{ID: objectID, ObjectKey: objectID, CreatedBy: "alice", MIMEType: "image/png"}); err != nil {
			t.Fatalf("SaveStorageObject() error = %v", err)
		}
	}
	input := workflowWithDeletionTestReference("url-object")
	input.TemplateReferences[0].StorageKey = "server:key-object"
	if _, err := NewWorkflowService(backendA).Save("alice", input); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	service := NewWorkflowService(backendB)
	for _, objectID := range []string{"key-object", "url-object"} {
		if err := service.ReserveStorageObjectDeletion("alice", objectID); !errors.Is(err, ErrStorageObjectInUse) {
			t.Errorf("ReserveStorageObjectDeletion(%s) error = %v, want object in use", objectID, err)
		}
	}
}

func TestWorkflowServiceSharedTemplatePendingDeletionBlocksCreation(t *testing.T) {
	for _, operation := range []string{"save", "initialize"} {
		for _, timing := range []string{"before", "during"} {
			t.Run(operation+"/"+timing, func(t *testing.T) {
				backendA, backendB := newWorkflowDeletionBackends(t)
				saveWorkflowTestStorageObject(t, backendA, "shared-object", "bob")
				serviceB := NewWorkflowService(backendB)
				reserve := func() {
					if err := serviceB.ReserveStorageObjectDeletion("bob", "shared-object"); err != nil {
						t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
					}
				}
				hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
				if timing == "during" {
					hooked.beforeSave = reserve
				} else {
					reserve()
				}
				input := workflowWithDeletionTestReference("shared-object")
				input.Scope = "public"
				input.TemplateReferences[0].Visibility = "public"
				serviceA := NewWorkflowService(hooked)
				var err error
				if operation == "save" {
					_, err = serviceA.Save("alice", input)
				} else {
					_, err = serviceA.InitializeIfEmpty("alice", []CreativeWorkflow{input})
				}
				var validationErr WorkflowValidationError
				if !errors.As(err, &validationErr) || !strings.Contains(err.Error(), "正在删除") {
					t.Fatalf("%s() error = %v, want pending deletion validation error", operation, err)
				}
				items, err := serviceB.List("alice")
				if err != nil || len(items) != 0 {
					t.Fatalf("List() after rejected creation = (%#v, %v)", items, err)
				}
			})
		}
	}
}

func TestWorkflowServiceDeletionReservationProtectsSharedTemplateReferences(t *testing.T) {
	for _, timing := range []string{"before", "during"} {
		t.Run(timing, func(t *testing.T) {
			backendA, backendB := newWorkflowDeletionBackends(t)
			saveWorkflowTestStorageObject(t, backendA, "shared-object", "bob")
			serviceB := NewWorkflowService(backendB)
			var created CreativeWorkflow
			create := func() {
				input := workflowWithDeletionTestReference("shared-object")
				input.TemplateReferences[0].Visibility = "public"
				var err error
				created, err = serviceB.Save("alice", input)
				if err != nil {
					t.Fatalf("Save(shared reference) error = %v", err)
				}
			}
			hooked := &workflowDeletionSaveHookBackend{Backend: backendA, JSONDocumentBackend: backendA, StorageObjectBackend: backendA}
			if timing == "during" {
				hooked.beforeSave = create
			} else {
				create()
			}
			serviceA := NewWorkflowService(hooked)
			if err := serviceA.ReserveStorageObjectDeletion("bob", "shared-object"); !errors.Is(err, ErrStorageObjectInUse) {
				t.Fatalf("ReserveStorageObjectDeletion() error = %v, want object in use", err)
			} else if strings.Contains(err.Error(), created.Name) {
				t.Fatalf("ReserveStorageObjectDeletion() error exposes another owner's workflow name: %v", err)
			}
			document, err := serviceB.loadLocked()
			if err != nil || len(document.PendingObjectDeletions) != 0 || len(document.Items) != 1 {
				t.Fatalf("document after rejected reservation = (%#v, %v)", document, err)
			}
			if err := serviceB.Delete("alice", created.ID); err != nil {
				t.Fatalf("Delete(workflow) error = %v", err)
			}
			if err := serviceA.ReserveStorageObjectDeletion("bob", "shared-object"); err != nil {
				t.Fatalf("ReserveStorageObjectDeletion() after reference removal error = %v", err)
			}
		})
	}
}
