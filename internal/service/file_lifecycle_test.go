package service

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
)

type fileLifecycleFixture struct {
	backend     *storage.DatabaseBackend
	files       *GenericStorageService
	lifecycle   *FileLifecycleService
	assets      *MyAssetService
	canvas      *CanvasDocumentService
	workflows   *WorkflowService
	now         time.Time
	databaseURL string
}

func newFileLifecycleFixture(t *testing.T) *fileLifecycleFixture {
	t.Helper()
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "files.db"))
	backend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	files, err := NewGenericStorageService(backend, &genericStorageTestSettings{setting: model.StorageSetting{}}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(files.Close)
	lifecycle, err := NewFileLifecycleService(backend)
	if err != nil {
		t.Fatal(err)
	}
	f := &fileLifecycleFixture{backend: backend, files: files, lifecycle: lifecycle, now: time.Now().Add(time.Hour), databaseURL: databaseURL}
	lifecycle.now = func() time.Time { return f.now }
	f.canvas = NewCanvasDocumentService(backend, func(owner, id string) error { _, err := files.InfoForIdentity(owner, false, id); return err })
	f.workflows = NewWorkflowService(backend)
	f.assets = NewMyAssetService(backend, files, f.canvas, f.workflows, lifecycle)
	f.canvas.SetFileReferenceProtector(lifecycle)
	f.workflows.SetFileReferenceProtector(lifecycle)
	f.assets.SetFileReferenceProtector(lifecycle)
	return f
}
func (f *fileLifecycleFixture) upload(t *testing.T) UploadedStorageObject {
	t.Helper()
	object, err := f.files.Upload(context.Background(), "alice", false, "video.mp4", "video/mp4", []byte("test media"), nil)
	if err != nil {
		t.Fatal(err)
	}
	return object
}
func (f *fileLifecycleFixture) assertExists(t *testing.T, id string, exists bool) {
	t.Helper()
	_, err := f.backend.LoadStorageObject(id)
	if exists && err != nil {
		t.Fatalf("object %s must survive: %v", id, err)
	}
	if !exists && !errors.Is(err, storage.ErrStorageObjectNotFound) {
		t.Fatalf("object %s should be reclaimed, got %v", id, err)
	}
}
func (f *fileLifecycleFixture) sweep(t *testing.T) {
	t.Helper()
	if err := f.lifecycle.Sweep(context.Background(), f.assets); err != nil {
		t.Fatal(err)
	}
}

func TestFileLifecycleProtectsPublicURLsInDocumentsAndUndoLeases(t *testing.T) {
	for _, suffix := range []string{".mp4", ".", ")", "]", ";"} {
		for _, historyOnly := range []bool{false, true} {
			f := newFileLifecycleFixture(t)
			uploaded := f.upload(t)
			object, err := f.backend.LoadStorageObject(uploaded.ID)
			if err != nil {
				t.Fatal(err)
			}
			object.PublicURL = "https://cdn.example.test/media/video" + suffix
			if err := f.backend.DeleteStorageObject(object.ID); err != nil {
				t.Fatal(err)
			}
			if err := f.backend.SaveStorageObject(object); err != nil {
				t.Fatal(err)
			}
			f.sweep(t)
			f.now = f.now.Add(fileOrphanGrace + time.Hour)
			document := map[string]any{"content": "[video](" + object.PublicURL + ")"}
			if historyOnly {
				document = map[string]any{"retained_storage_object_urls": []string{object.PublicURL}, "retained_storage_objects_until": f.now.Add(time.Hour).Format(time.RFC3339Nano)}
			}
			if err := f.backend.SaveJSONDocument("public-reference-test.json", document); err != nil {
				t.Fatal(err)
			}
			f.sweep(t)
			f.assertExists(t, object.ID, true)
			if !errors.Is(f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID), ErrStorageObjectInUse) {
				t.Fatal("public reference allowed deletion")
			}
			if !historyOnly {
				if err := f.backend.SaveJSONDocument("public-reference-test.json", map[string]any{}); err != nil {
					t.Fatal(err)
				}
			}
			f.now = f.now.Add(2 * time.Hour)
			f.sweep(t)
			f.assertExists(t, object.ID, true)
			f.now = f.now.Add(fileOrphanGrace + time.Second)
			f.sweep(t)
			f.assertExists(t, object.ID, false)
		}
	}
}

func TestFileLifecyclePublicURLWriteLeaseFencesConcurrentDeletion(t *testing.T) {
	f := newFileLifecycleFixture(t)
	uploaded := f.upload(t)
	object, err := f.backend.LoadStorageObject(uploaded.ID)
	if err != nil {
		t.Fatal(err)
	}
	object.PublicURL = "https://cdn.example.test/source.png"
	if err := f.backend.DeleteStorageObject(object.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.backend.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	release, err := f.lifecycle.ProtectStorageReferences(map[string]any{"image_url": object.PublicURL})
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID), ErrStorageObjectInUse) {
		t.Fatal("public URL write lease did not block deletion")
	}
	release()
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.ProtectStorageReferences(map[string]any{"image_url": object.PublicURL}); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("deletion fence failed: %v", err)
	}
}

func TestFileLifecycleCollectsUploadsWithoutAssetRecordsAfterDurableGrace(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	f.sweep(t)
	f.assertExists(t, object.ID, true)
	f.now = f.now.Add(fileOrphanGrace - time.Second)
	f.sweep(t)
	f.assertExists(t, object.ID, true)
	restarted, err := NewFileLifecycleService(f.backend)
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return f.now }
	f.lifecycle = restarted
	f.assets = NewMyAssetService(f.backend, f.files, f.canvas, f.workflows, restarted)
	f.now = f.now.Add(2 * time.Second)
	f.sweep(t)
	f.assertExists(t, object.ID, false)
}

func TestFileLifecycleProtectsAssetWorkflowCanvasAndHistoryReferences(t *testing.T) {
	for _, domain := range []string{"asset", "workflow", "canvas", "history"} {
		t.Run(domain, func(t *testing.T) {
			f := newFileLifecycleFixture(t)
			object := f.upload(t)
			f.sweep(t)
			switch domain {
			case "asset":
				_, err := f.assets.Upsert(context.Background(), "alice", false, MyAsset{ID: "video", Kind: "video", Title: "video", URL: object.URL, StorageKey: object.StorageKey, Tags: []string{}})
				if err != nil {
					t.Fatal(err)
				}
			case "workflow":
				if err := f.backend.SaveJSONDocument("workflows.json", map[string]any{"items": []any{map[string]any{"owner_id": "bob", "template_references": []any{map[string]any{"url": object.URL, "storageKey": object.StorageKey}}}}}); err != nil {
					t.Fatal(err)
				}
			case "canvas":
				document, err := loadCanvas(f.canvas, "alice")
				if err != nil {
					t.Fatal(err)
				}
				document.Nodes = []CanvasNode{{ID: "video", Type: "video", GenerationVideoModel: "video-test", GenerationVideoSeconds: 5, Title: "video", URL: object.URL, StorageKey: object.StorageKey, Width: 320, Height: 180}}
				if _, err := f.canvas.SaveAtRevision("alice", document); err != nil {
					t.Fatal(err)
				}
			case "history":
				history := NewImageConversationHistoryService(f.backend)
				history.SetFileReferenceProtector(f.lifecycle)
				_, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), "alice", []map[string]any{{"id": "conversation", "revision": 1, "updatedAt": time.Now().UTC().Format(time.RFC3339Nano), "turns": []any{map[string]any{"id": "turn", "images": []any{map[string]any{"url": object.URL}}}}}})
				if err != nil {
					t.Fatal(err)
				}
			}
			f.now = f.now.Add(2 * fileOrphanGrace)
			f.sweep(t)
			f.assertExists(t, object.ID, true)
			if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); !errors.Is(err, ErrStorageObjectInUse) {
				t.Fatalf("reserved referenced %s object: %v", domain, err)
			}
		})
	}
}

func TestFileLifecycleCanvasHistoryLeaseAndProjectDeletion(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	document, err := loadCanvas(f.canvas, "alice")
	if err != nil {
		t.Fatal(err)
	}
	document.RetainedStorageObjectIDs = []string{object.ID}
	document.RetainedStorageObjectsUntil = time.Now().Add(100 * 24 * time.Hour).Format(time.RFC3339Nano)
	saved, err := f.canvas.SaveAtRevision("alice", document)
	if err != nil {
		t.Fatal(err)
	}
	until, err := time.Parse(time.RFC3339Nano, saved.RetainedStorageObjectsUntil)
	if err != nil || until.After(time.Now().Add(25*time.Hour)) {
		t.Fatalf("server did not bound history lease: %s", saved.RetainedStorageObjectsUntil)
	}
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("history reference lost: %v", err)
	}
	// Eviction removes the history claim in the same project CAS as the nodes.
	saved.RetainedStorageObjectIDs = nil
	saved, err = f.canvas.SaveAtRevision("alice", saved)
	if err != nil {
		t.Fatal(err)
	}
	if saved.RetainedStorageObjectsUntil != "" {
		t.Fatal("empty history kept expiry")
	}
	f.sweep(t)
	f.now = f.now.Add(fileOrphanGrace + time.Second)
	f.sweep(t)
	f.assertExists(t, object.ID, false)

	second := f.upload(t)
	saved.Nodes = []CanvasNode{{ID: "media", Type: "video", GenerationVideoModel: "video-test", GenerationVideoSeconds: 5, Title: "video", URL: second.URL, StorageKey: second.StorageKey, Width: 320, Height: 180}}
	saved, err = f.canvas.SaveAtRevision("alice", saved)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.canvas.UpdateProjectAtRevision("alice", "delete", saved.ID, "", saved.Revision); err != nil {
		t.Fatal(err)
	}
	f.sweep(t)
	f.now = f.now.Add(fileOrphanGrace + time.Second)
	f.sweep(t)
	f.assertExists(t, second.ID, false)
}

func TestFileReferenceIDsIgnoreExpiredHistoryAndKeepNestedMedia(t *testing.T) {
	now := time.Now()
	value := map[string]any{"retained_storage_object_ids": []string{"expired"}, "retained_storage_objects_until": now.Add(-time.Second).Format(time.RFC3339Nano), "agent_sessions": []any{map[string]any{"url": "/api/files/agent/content"}}, "director_project": map[string]any{"key": "server:director"}}
	ids, err := fileReferenceIDs(value, now)
	if err != nil || !slices.Equal(ids, []string{"agent", "director"}) {
		t.Fatalf("references = %v, %v", ids, err)
	}
	value["retained_storage_objects_until"] = now.Add(time.Hour).Format(time.RFC3339Nano)
	ids, err = fileReferenceIDs(value, now)
	if err != nil || !slices.Contains(ids, "expired") {
		t.Fatalf("live history lost: %v, %v", ids, err)
	}
}

type fileLifecycleFailingObjectDeleter struct {
	*GenericStorageService
	fail bool
}

func (d *fileLifecycleFailingObjectDeleter) Delete(ctx context.Context, owner string, admin bool, id string, provider *StorageObjectProviderInput) error {
	if d.fail {
		d.fail = false
		return errors.New("provider unavailable")
	}
	return d.GenericStorageService.Delete(ctx, owner, admin, id, provider)
}
func TestFileLifecycleProviderFailureSurvivesRestartAndRetries(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	deleter := &fileLifecycleFailingObjectDeleter{GenericStorageService: f.files, fail: true}
	f.assets = NewMyAssetService(f.backend, deleter, f.canvas, f.workflows, f.lifecycle)
	f.sweep(t)
	f.now = f.now.Add(fileOrphanGrace + time.Second)
	if err := f.lifecycle.Sweep(context.Background(), f.assets); err == nil {
		t.Fatal("provider failure was hidden")
	}
	f.assertExists(t, object.ID, true)
	state, err := f.lifecycle.loadLocked()
	if err != nil || state.Orphans[object.ID].Attempts != 1 || !state.Deleting[object.ID] {
		t.Fatalf("retry state was not durable: %#v, %v", state, err)
	}
	restarted, err := NewFileLifecycleService(f.backend)
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return f.now }
	f.lifecycle = restarted
	f.assets = NewMyAssetService(f.backend, f.files, f.canvas, f.workflows, restarted)
	f.now = f.now.Add(3 * time.Minute)
	f.sweep(t)
	f.assertExists(t, object.ID, false)
}

type fileLifecycleFailingBackend struct {
	*storage.DatabaseBackend
	failScan, failSave bool
}

func (b *fileLifecycleFailingBackend) VisitJSONDocuments(ctx context.Context, visit func(string, any) error) error {
	if b.failScan {
		return errors.New("reference scan unavailable")
	}
	return b.DatabaseBackend.VisitJSONDocuments(ctx, visit)
}
func (b *fileLifecycleFailingBackend) SaveJSONDocument(name string, value any) error {
	if b.failSave && name == fileLifecycleDocument {
		return errors.New("outbox unavailable")
	}
	return b.DatabaseBackend.SaveJSONDocument(name, value)
}
func TestFileLifecycleReadAndOutboxFailuresNeverDelete(t *testing.T) {
	for _, failure := range []string{"scan", "outbox"} {
		t.Run(failure, func(t *testing.T) {
			f := newFileLifecycleFixture(t)
			object := f.upload(t)
			f.sweep(t)
			f.now = f.now.Add(2 * fileOrphanGrace)
			backend := &fileLifecycleFailingBackend{DatabaseBackend: f.backend, failScan: failure == "scan", failSave: failure == "outbox"}
			lifecycle, err := NewFileLifecycleService(backend)
			if err != nil {
				t.Fatal(err)
			}
			lifecycle.now = func() time.Time { return f.now }
			assets := NewMyAssetService(backend, f.files, f.canvas, f.workflows, lifecycle)
			if err := lifecycle.Sweep(context.Background(), assets); err == nil {
				t.Fatal("expected failure")
			}
			f.assertExists(t, object.ID, true)
		})
	}
}

type fileLifecycleScanBarrier struct {
	*storage.DatabaseBackend
	entered, release chan struct{}
	once             sync.Once
}

func (b *fileLifecycleScanBarrier) VisitJSONDocuments(ctx context.Context, visit func(string, any) error) error {
	err := b.DatabaseBackend.VisitJSONDocuments(ctx, visit)
	b.once.Do(func() { close(b.entered); <-b.release })
	return err
}
func TestFileLifecycleConcurrentClaimWinsAgainstStaleDeletionScan(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	second, err := storage.NewDatabaseBackend(f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	barrier := &fileLifecycleScanBarrier{DatabaseBackend: f.backend, entered: make(chan struct{}), release: make(chan struct{})}
	deleter, err := NewFileLifecycleService(barrier)
	if err != nil {
		t.Fatal(err)
	}
	claimant, err := NewFileLifecycleService(second)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- deleter.ReserveStorageObjectDeletion("alice", object.ID) }()
	select {
	case <-barrier.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("scan did not start")
	}
	release, err := claimant.ProtectStorageReferences(map[string]any{"url": object.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	close(barrier.release)
	if err := <-result; !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("stale scan deleted a concurrent claim: %v", err)
	}
}

type fileLifecycleAliasBackend struct {
	*storage.DatabaseBackend
	alias model.StorageObject
}

func (b *fileLifecycleAliasBackend) LoadStorageObject(id string) (model.StorageObject, error) {
	if id == b.alias.ID {
		return b.alias, nil
	}
	return b.DatabaseBackend.LoadStorageObject(id)
}

func TestFileLifecycleDeletionFenceRejectsNewClaimsAndProtectsPhysicalAliases(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	original, err := f.backend.LoadStorageObject(object.ID)
	if err != nil {
		t.Fatal(err)
	}
	alias := original
	alias.ID = "shared-alias"
	alias.Direct = true
	alias.CreatedBy = "bob"
	// The database rejects duplicate keys. Exercise the deletion guard with an
	// inventory adapter that resolves two registrations to one provider object.
	if err := f.backend.SaveStorageObject(alias); err == nil {
		t.Fatal("database accepted duplicate physical key")
	}
	f.lifecycle, err = NewFileLifecycleService(&fileLifecycleAliasBackend{DatabaseBackend: f.backend, alias: alias})
	if err != nil {
		t.Fatal(err)
	}
	release, err := f.lifecycle.ProtectStorageReferences("server:" + alias.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("shared physical object unprotected: %v", err)
	}
	release()
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.ProtectStorageReferences(object.URL); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("claim crossed deletion fence: %v", err)
	}
	if _, err := f.lifecycle.ProtectStorageReferences("server:" + alias.ID); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("alias crossed deletion fence: %v", err)
	}
}

func TestFileLifecycleCancelledTaskProtectsInputsUntilWorkerExits(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	entered, releaseHandler := make(chan struct{}), make(chan struct{})
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		close(entered)
		<-releaseHandler
		return nil, context.Canceled
	}
	tasks := newImageTaskService(f.backend, nil, handler, nil, func() int { return 30 })
	tasks.SetFileReferenceProtector(f.lifecycle)
	closed := false
	defer func() {
		if !closed {
			close(releaseHandler)
		}
		_ = tasks.Close()
	}()
	identity := Identity{ID: "alice", Role: AuthRoleUser}
	_, err := tasks.SubmitEdit(context.Background(), identity, "running", "edit", "model", "1:1", "", "", []any{map[string]any{"url": object.URL}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("task did not start")
	}
	if _, err := tasks.CancelTask(identity, "running"); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.DeleteTasks(identity, []string{"running"}); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("cancelled running worker lost input: %v", err)
	}
	close(releaseHandler)
	closed = true
	tasks.taskWorkers.Wait()
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); err != nil {
		t.Fatalf("worker exit did not release input: %v", err)
	}
}

func TestFileReferenceIDsFindSerializedToolResultsAndMarkdownAttachments(t *testing.T) {
	ids, err := fileReferenceIDs(map[string]any{"messages": []any{map[string]any{"content": `{"result":{"url":"/api/files/tool-image/content"}}`}, map[string]any{"content": `![result](/api/files/markdown-image/content?download=1)`}, map[string]any{"content": `{"storage_key":"server:tool-video"}`}}}, time.Now())
	if err != nil || !slices.Equal(ids, []string{"markdown-image", "tool-image", "tool-video"}) {
		t.Fatalf("embedded references = %v, %v", ids, err)
	}
}

func TestFileLifecycleExpiredBrowserLeaseIsReclaimedWithoutReopening(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	document, err := loadCanvas(f.canvas, "alice")
	if err != nil {
		t.Fatal(err)
	}
	document.RetainedStorageObjectIDs = []string{object.ID}
	if _, err = f.canvas.SaveAtRevision("alice", document); err != nil {
		t.Fatal(err)
	}
	f.sweep(t)
	workspace, err := f.canvas.loadWorkspaceLocked("alice")
	if err != nil {
		t.Fatal(err)
	}
	workspace.Projects[0].RetainedStorageObjectsUntil = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if err := f.canvas.saveWorkspaceLocked("alice", &workspace); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(2 * fileOrphanGrace)
	f.sweep(t)
	f.assertExists(t, object.ID, true)
	f.now = f.now.Add(fileOrphanGrace + time.Second)
	f.sweep(t)
	f.assertExists(t, object.ID, false)
}

func TestFileLifecycleTaskInputReferencesSurviveReload(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/generated.png"}}}, nil
	}
	tasks := newImageTaskService(f.backend, nil, handler, nil, func() int { return 30 })
	tasks.SetFileReferenceProtector(f.lifecycle)
	defer tasks.Close()
	identity := Identity{ID: "alice", Role: AuthRoleUser}
	if _, err := tasks.SubmitEdit(context.Background(), identity, "persisted", "edit", "model", "1:1", "", "", []any{map[string]any{"url": object.URL}}, 1); err != nil {
		t.Fatal(err)
	}
	waitForTaskStatus(t, tasks, identity, "persisted", TaskStatusSuccess)
	tasks.taskWorkers.Wait()
	if err := tasks.Close(); err != nil {
		t.Fatal(err)
	}
	reloaded := newImageTaskService(f.backend, nil, nil, nil, func() int { return 30 })
	defer reloaded.Close()
	if _, err := reloaded.ListTasksWithError(identity, []string{"persisted"}); err != nil {
		t.Fatal(err)
	}
	if err := reloaded.saveWithRetryLocked(); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.ReserveStorageObjectDeletion("alice", object.ID); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("persisted task lost input reference: %v", err)
	}
}
