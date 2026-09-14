package service

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func (s *myAssetObjectStorageStub) DeleteDirectRecord(ownerID, objectID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	object, exists := s.objects[objectID]
	if !exists {
		return nil
	}
	if object.CreatedBy != ownerID || !object.Direct {
		return ErrStorageObjectAccessDenied
	}
	if s.deleteFailures[objectID] > 0 {
		s.deleteFailures[objectID]--
		return s.deleteErr
	}
	delete(s.objects, objectID)
	return nil
}

func seedMyAssetDirectObject(objects *myAssetObjectStorageStub, objectID, ownerID string) {
	objects.seedObject(objectID, ownerID, "image/png")
	objects.mu.Lock()
	defer objects.mu.Unlock()
	object := objects.objects[objectID]
	object.Direct = true
	objects.objects[objectID] = object
}

func assertMyAssetDirectFileRetained(t *testing.T, objects *myAssetObjectStorageStub, objectID string, recordExists bool) {
	t.Helper()
	objects.mu.Lock()
	defer objects.mu.Unlock()
	_, exists := objects.objects[objectID]
	if exists != recordExists || objects.uploads[objectID] != "fixture" || len(objects.deleteAttempts) != 0 {
		t.Fatalf("record exists = %v, file = %q, provider deletions = %v", exists, objects.uploads[objectID], objects.deleteAttempts)
	}
}

func TestMyAssetDirectRecordDeletionCoordinatesReferences(t *testing.T) {
	for _, referenceType := range []string{"canvas", "workflow"} {
		t.Run(referenceType, func(t *testing.T) {
			backend := newTestStorageBackend(t)
			objects := newMyAssetObjectStorageStub()
			seedMyAssetDirectObject(objects, "direct-image", "owner")
			object, _ := objects.InfoForIdentity("owner", false, "direct-image")
			if err := backend.(storage.StorageObjectBackend).SaveStorageObject(object); err != nil {
				t.Fatal(err)
			}
			canvas := NewCanvasDocumentService(backend)
			workflows := NewWorkflowService(backend)
			assets := NewMyAssetService(backend, objects, canvas, workflows)
			var removeReference func()
			switch referenceType {
			case "canvas":
				workspace, err := canvas.Workspace("owner")
				if err != nil {
					t.Fatal(err)
				}
				workspace.Document.Nodes = []CanvasNode{{ID: "image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, URL: "/api/files/direct-image/content?direct=1", StorageKey: "server:direct-image"}}
				saved, err := canvas.SaveAtRevision("owner", workspace.Document)
				if err != nil {
					t.Fatal(err)
				}
				removeReference = func() {
					if _, err := canvas.ClearAtRevision("owner", saved.ID, saved.Revision); err != nil {
						t.Fatal(err)
					}
				}
			case "workflow":
				input := referenceWorkflow()
				input.Scope = "private"
				input.TemplateReferences = []WorkflowTemplateReference{{ID: "template", Name: "Template", URL: "/api/files/direct-image/content?direct=1", StorageKey: "server:direct-image"}}
				saved, err := workflows.Save("owner", input)
				if err != nil {
					t.Fatal(err)
				}
				removeReference = func() {
					if err := workflows.Delete("owner", saved.ID); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := assets.DeleteDirectRecord(context.Background(), "owner", "direct-image"); !errors.Is(err, ErrStorageObjectInUse) {
				t.Fatalf("referenced record deletion error = %v", err)
			}
			assertMyAssetDirectFileRetained(t, objects, "direct-image", true)
			assertMyAssetPendingObjectDeletions(t, backend.(storage.JSONDocumentBackend), "owner", nil)
			removeReference()
			if err := assets.DeleteDirectRecord(context.Background(), "owner", "direct-image"); err != nil {
				t.Fatalf("unreferenced record deletion error = %v", err)
			}
			assertMyAssetDirectFileRetained(t, objects, "direct-image", false)
			assertMyAssetPendingObjectDeletions(t, backend.(storage.JSONDocumentBackend), "owner", nil)
		})
	}
}

func TestMyAssetDirectRecordDeletionRetainsModeAcrossInstancesAndRecovery(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendA.Close()
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendB.Close()
	objects := newMyAssetObjectStorageStub()
	seedMyAssetDirectObject(objects, "direct-image", "owner")
	objects.failDeletes("direct-image", 1)
	first := NewMyAssetService(backendA, objects)
	if err := first.DeleteDirectRecord(context.Background(), "owner", "direct-image"); !errors.Is(err, objects.deleteErr) {
		t.Fatalf("initial record deletion error = %v", err)
	}
	assertMyAssetDirectFileRetained(t, objects, "direct-image", true)
	second := NewMyAssetService(backendB, objects)
	input := MyAsset{ID: "image", Kind: "image", Title: "Image", URL: "/api/files/direct-image/content?direct=1", StorageKey: "server:direct-image"}
	if _, err := second.Upsert(context.Background(), "owner", false, input); err == nil || !strings.Contains(err.Error(), "pending deletion") {
		t.Fatalf("reference created while record deletion pending: %v", err)
	}
	if err := second.DeleteStorageObject(context.Background(), "owner", false, "direct-image", nil); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("changing pending deletion to provider deletion: %v", err)
	}
	groupName := "Retained group"
	if _, err := second.MutateGroup("owner", "create", MyAssetGroupMutation{ID: "group", Name: &groupName}); err != nil {
		t.Fatal(err)
	}
	raw, err := backendA.LoadJSONDocument(myAssetDocumentName("owner"))
	if err != nil {
		t.Fatal(err)
	}
	if got := util.AsStringSlice(util.StringMap(raw)[myAssetRecordOnlyDeletionsField]); !slices.Equal(got, []string{"direct-image"}) {
		t.Fatalf("record-only deletion mode after document mutation = %v", got)
	}
	restarted := NewMyAssetService(backendA, objects)
	if err := restarted.RetryAllPendingObjectDeletions(context.Background()); err != nil {
		t.Fatalf("record deletion recovery: %v", err)
	}
	assertMyAssetDirectFileRetained(t, objects, "direct-image", false)
	assertMyAssetPendingObjectDeletions(t, backendA, "owner", nil)
	raw, err = backendB.LoadJSONDocument(myAssetDocumentName("owner"))
	if err != nil {
		t.Fatal(err)
	}
	if got := util.AsStringSlice(util.StringMap(raw)[myAssetRecordOnlyDeletionsField]); len(got) != 0 {
		t.Fatalf("completed record deletion retained mode markers: %v", got)
	}
}

func TestMyAssetDirectRecordDeletionRejectsNonDirectObjects(t *testing.T) {
	backend := newTestStorageBackend(t)
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("server-image", "owner", "image/png")
	assets := NewMyAssetService(backend, objects)
	if err := assets.DeleteDirectRecord(context.Background(), "owner", "server-image"); !errors.Is(err, ErrStorageObjectAccessDenied) {
		t.Fatalf("non-direct record deletion error = %v", err)
	}
	assertMyAssetDirectFileRetained(t, objects, "server-image", true)
}
