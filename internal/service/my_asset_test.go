package service

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type myAssetObjectStorageStub struct {
	mu             sync.Mutex
	nextID         int
	uploads        map[string]string
	objects        map[string]model.StorageObject
	deleted        []string
	deleteAttempts []string
	deleteFailures map[string]int
	deleteErr      error
	omitUploadID   bool
	deleteStarted  chan struct{}
	deleteRelease  <-chan struct{}
	deleteOnce     sync.Once
}

type myAssetFailNextDocumentSaveBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	documentName string
	failNext     int
	err          error
}

type myAssetCommitThenFailDocumentSaveBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	documentName string
	failNext     int
	err          error
}

func TestMyAssetItemMutationsPreserveConcurrentGeneratedMedia(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	objects.seedObject("video-a", "user-a", "video/mp4")
	objects.seedObject("video-b", "user-a", "video/mp4")
	assets := NewMyAssetService(backend, objects)
	upsertMyAssetFixtures(t, assets, "user-a", []MyAsset{{
		ID: "manual-image", Kind: "image", Title: "手动素材", URL: "/images/manual.png", Tags: []string{},
	}})
	generated := []MyAsset{
		{ID: "generated-video:task-a:0", Kind: "video", Title: "视频 A", URL: "/api/files/video-a/content", StorageKey: "server:video-a", MIMEType: "video/mp4", Source: "生成视频", Tags: []string{}},
		{ID: "generated-video:task-b:0", Kind: "video", Title: "视频 B", URL: "/api/files/video-b/content", StorageKey: "server:video-b", MIMEType: "video/mp4", Source: "无限画布", Tags: []string{}},
	}
	staleManualEdit := MyAsset{ID: "manual-image", Kind: "image", Title: "旧标签页改名", URL: "/images/manual.png", Tags: []string{}}
	var wait sync.WaitGroup
	errors := make(chan error, len(generated)+1)
	mutations := append(append([]MyAsset(nil), generated...), staleManualEdit)
	for _, item := range mutations {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, upsertErr := assets.Upsert(context.Background(), "user-a", false, item)
			errors <- upsertErr
		}()
	}
	wait.Wait()
	close(errors)
	for upsertErr := range errors {
		if upsertErr != nil {
			t.Fatalf("Upsert() error = %v", upsertErr)
		}
	}

	// Replaying a completed task must update the same record, not append one.
	generated[0].Title = "视频 A（已恢复）"
	if _, err := assets.Upsert(context.Background(), "user-a", false, generated[0]); err != nil {
		t.Fatalf("Upsert(replay) error = %v", err)
	}
	items, err := assets.List("user-a")
	if err != nil || len(items) != 3 {
		t.Fatalf("List() = (%#v, %v)", items, err)
	}
	byID := make(map[string]MyAsset, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}
	if byID[generated[0].ID].Title != "视频 A（已恢复）" || byID["manual-image"].Title != "旧标签页改名" {
		t.Fatalf("upserted items = %#v", items)
	}
	if deleted, err := assets.Delete(context.Background(), "user-a", false, "manual-image"); err != nil || !deleted {
		t.Fatalf("Delete() = (%v, %v)", deleted, err)
	}
	items, err = assets.List("user-a")
	if err != nil || len(items) != 2 || items[0].ID == "manual-image" || items[1].ID == "manual-image" {
		t.Fatalf("generated assets after stale item deletion = (%#v, %v)", items, err)
	}
}

func newMyAssetObjectStorageStub() *myAssetObjectStorageStub {
	return &myAssetObjectStorageStub{
		uploads: make(map[string]string), objects: make(map[string]model.StorageObject),
		deleteFailures: make(map[string]int), deleteErr: errors.New("injected object deletion failure"),
	}
}

func (s *myAssetObjectStorageStub) Upload(_ context.Context, ownerID string, _ bool, filename, contentType string, data []byte, _ *StorageObjectProviderInput) (UploadedStorageObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := fmt.Sprintf("text-%d", s.nextID)
	s.uploads[id] = string(data)
	s.objects[id] = model.StorageObject{ID: id, MIMEType: contentType, Bytes: int64(len(data)), CreatedBy: ownerID}
	uploadedID := id
	if s.omitUploadID {
		uploadedID = ""
	}
	return UploadedStorageObject{ID: uploadedID, URL: "/api/files/" + id + "/content", StorageKey: "server:" + id, Bytes: int64(len(data)), MIMEType: contentType}, nil
}

func (s *myAssetObjectStorageStub) InfoForIdentity(ownerID string, admin bool, id string) (model.StorageObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	object, exists := s.objects[id]
	if !exists {
		return model.StorageObject{}, storage.ErrStorageObjectNotFound
	}
	if !admin && object.CreatedBy != ownerID {
		return model.StorageObject{}, errors.New("storage object permission denied")
	}
	return object, nil
}

func (s *myAssetObjectStorageStub) Delete(ctx context.Context, _ string, _ bool, id string, _ *StorageObjectProviderInput) error {
	if s.deleteStarted != nil {
		s.deleteOnce.Do(func() { close(s.deleteStarted) })
	}
	if s.deleteRelease != nil {
		select {
		case <-s.deleteRelease:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteAttempts = append(s.deleteAttempts, id)
	if s.deleteFailures[id] > 0 {
		s.deleteFailures[id]--
		return s.deleteErr
	}
	delete(s.uploads, id)
	delete(s.objects, id)
	s.deleted = append(s.deleted, id)
	return nil
}

func (s *myAssetObjectStorageStub) seedObject(id, ownerID, mimeType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads[id] = "fixture"
	s.objects[id] = model.StorageObject{ID: id, CreatedBy: ownerID, MIMEType: mimeType, Bytes: int64(len("fixture"))}
}

func (s *myAssetObjectStorageStub) failDeletes(id string, count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteFailures[id] = count
}

func TestMyAssetStorageDeletionCoordinatesCanvasReferences(t *testing.T) {
	backend := newTestStorageBackend(t)
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("object-a", "owner", "image/png")
	canvas := NewCanvasDocumentService(backend)
	assets := NewMyAssetService(backend, objects, canvas)

	workspace, err := canvas.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	workspace.Document.Nodes = []CanvasNode{{
		ID: "stored-image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
		URL: "/api/files/object-a/content", StorageKey: "server:object-a",
	}}
	saved, err := canvas.SaveAtRevision("owner", workspace.Document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}

	if err := assets.DeleteStorageObject(context.Background(), "owner", false, "object-a", nil); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("DeleteStorageObject(referenced) error = %v, want ErrStorageObjectInUse", err)
	}
	objects.mu.Lock()
	deleteAttempts := append([]string(nil), objects.deleteAttempts...)
	_, objectExists := objects.objects["object-a"]
	objects.mu.Unlock()
	if len(deleteAttempts) != 0 || !objectExists {
		t.Fatalf("referenced object deletion attempts = %v exists = %v", deleteAttempts, objectExists)
	}
	assets.mu.Lock()
	document, err := assets.loadDocumentLocked("owner")
	assets.mu.Unlock()
	if err != nil || len(document.pendingObjectDeletions) != 0 {
		t.Fatalf("pending deletion after reference conflict = (%v, %v)", document.pendingObjectDeletions, err)
	}

	if _, err := canvas.ClearAtRevision("owner", saved.ID, saved.Revision); err != nil {
		t.Fatalf("ClearAtRevision() error = %v", err)
	}
	if err := assets.DeleteStorageObject(context.Background(), "owner", false, "object-a", nil); err != nil {
		t.Fatalf("DeleteStorageObject(unreferenced) error = %v", err)
	}
	objects.mu.Lock()
	_, objectExists = objects.objects["object-a"]
	objects.mu.Unlock()
	if objectExists {
		t.Fatal("unreferenced object still exists after deletion")
	}
	canvas.mu.Lock()
	workspaceState, err := canvas.loadWorkspaceLocked("owner")
	canvas.mu.Unlock()
	if err != nil || len(workspaceState.PendingStorageObjectDeletions) != 0 {
		t.Fatalf("canvas deletion fence after completion = (%v, %v)", workspaceState.PendingStorageObjectDeletions, err)
	}
}

func TestMyAssetUpsertPreservesMonotonicDocumentGeneration(t *testing.T) {
	backend := newTestStorageBackend(t)
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("image-a", "owner", "image/png")
	assets := NewMyAssetService(backend, objects)
	item := MyAsset{
		ID: "image", Kind: "image", Title: "First", URL: "/api/files/image-a/content",
		StorageKey: "server:image-a", MIMEType: "image/png", Tags: []string{},
	}
	if _, err := assets.Upsert(context.Background(), "owner", false, item); err != nil {
		t.Fatalf("Upsert(first) error = %v", err)
	}
	firstRaw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(myAssetDocumentName("owner"))
	if err != nil {
		t.Fatalf("LoadJSONDocument(first) error = %v", err)
	}
	firstGeneration := util.ToInt(util.StringMap(firstRaw)[myAssetDocumentGenerationField], 0)

	item.Title = "Second"
	if _, err := assets.Upsert(context.Background(), "owner", false, item); err != nil {
		t.Fatalf("Upsert(second) error = %v", err)
	}
	secondRaw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(myAssetDocumentName("owner"))
	if err != nil {
		t.Fatalf("LoadJSONDocument(second) error = %v", err)
	}
	secondGeneration := util.ToInt(util.StringMap(secondRaw)[myAssetDocumentGenerationField], 0)
	if firstGeneration < 1 || secondGeneration <= firstGeneration {
		t.Fatalf("asset generations = %d then %d, want strictly increasing", firstGeneration, secondGeneration)
	}
}

func TestMyAssetPendingDeletionRecoversAfterServiceRestartWithoutOwnerRequest(t *testing.T) {
	backend := newTestStorageBackend(t)
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("object-a", "owner", "image/png")
	objects.failDeletes("object-a", 1)
	firstCanvas := NewCanvasDocumentService(backend)
	first := NewMyAssetService(backend, objects, firstCanvas)
	if err := first.DeleteStorageObject(context.Background(), "owner", false, "object-a", nil); err == nil {
		t.Fatal("DeleteStorageObject() error = nil, want injected provider failure")
	}

	restartedCanvas := NewCanvasDocumentService(backend)
	restarted := NewMyAssetService(backend, objects, restartedCanvas)
	if err := restarted.RetryAllPendingObjectDeletions(context.Background()); err != nil {
		t.Fatalf("RetryAllPendingObjectDeletions() error = %v", err)
	}
	objects.mu.Lock()
	_, exists := objects.objects["object-a"]
	attempts := append([]string(nil), objects.deleteAttempts...)
	objects.mu.Unlock()
	if exists || len(attempts) != 2 {
		t.Fatalf("recovered object exists = %v, deletion attempts = %v", exists, attempts)
	}
	restarted.mu.Lock()
	document, err := restarted.loadDocumentLocked("owner")
	restarted.mu.Unlock()
	if err != nil || document.ownerID != "owner" || len(document.pendingObjectDeletions) != 0 {
		t.Fatalf("recovered document = owner %q pending %v error %v", document.ownerID, document.pendingObjectDeletions, err)
	}
}

func (b *myAssetFailNextDocumentSaveBackend) SaveJSONDocument(name string, value any) error {
	if name == b.documentName && b.failNext > 0 {
		b.failNext--
		return b.err
	}
	return b.JSONDocumentBackend.SaveJSONDocument(name, value)
}

func (b *myAssetCommitThenFailDocumentSaveBackend) SaveJSONDocument(name string, value any) error {
	if err := b.JSONDocumentBackend.SaveJSONDocument(name, value); err != nil {
		return err
	}
	if name == b.documentName && b.failNext > 0 {
		b.failNext--
		return b.err
	}
	return nil
}

func TestMyAssetsArePersistentAndPersonal(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	objects.seedObject("image-1", "user-a", "image/png")
	assets := NewMyAssetService(backend, objects)
	want := []MyAsset{
		{ID: "asset-1", Kind: "text", Title: "镜头提示词", Content: "电影感近景", Tags: []string{"电影", "电影"}, Visibility: MyAssetPublic, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z"},
		{ID: "asset-2", Kind: "image", Title: "参考图", URL: "/images/reference.png", StorageKey: "server:image-1", Tags: []string{}},
		{ID: "asset-3", Kind: "video", Title: "参考视频", URL: "/videos/reference.mp4", MIMEType: "video/mp4", Bytes: 4096, Width: 1920, Height: 1080, DurationMs: 5200, Tags: []string{}, Source: "画布", Note: "人物动作参考"},
		{ID: "asset-4", Kind: "audio", Title: "参考音频", URL: "/audio-references/reference.mp3", MIMEType: "audio/mpeg", Bytes: 1024, DurationMs: 3100, Tags: []string{}},
	}
	upsertMyAssetFixtures(t, assets, "user-a", want)
	got, err := NewMyAssetService(backend, objects).List("user-a")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("List() = %#v", got)
	}
	byID := make(map[string]MyAsset, len(got))
	for _, item := range got {
		byID[item.ID] = item
	}
	if len(byID["asset-1"].Tags) != 1 || byID["asset-2"].Kind != "image" || byID["asset-3"].Kind != "video" || byID["asset-4"].Kind != "audio" {
		t.Fatalf("normalized assets = %#v", got)
	}
	video := byID["asset-3"]
	if video.MIMEType != "video/mp4" || video.Bytes != 4096 || video.Width != 1920 || video.Height != 1080 || video.DurationMs != 5200 || video.Source != "画布" || video.Note != "人物动作参考" {
		t.Fatalf("video metadata was not persisted: %#v", video)
	}
	text := byID["asset-1"]
	if text.StorageKey == "" || text.URL == "" || text.MIMEType != "text/plain; charset=utf-8" || text.Bytes != int64(len([]byte(text.Content))) {
		t.Fatalf("text storage metadata was not persisted: %#v", text)
	}
	if byID["asset-2"].StorageKey != "server:image-1" {
		t.Fatalf("image storage key was not persisted: %#v", byID["asset-2"])
	}
	other, err := assets.List("user-b")
	if err != nil || len(other) != 0 {
		t.Fatalf("List(other) = %#v, %v", other, err)
	}
	if _, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "bad", Kind: "image", Title: "bad", URL: "blob:temporary"}); err == nil {
		t.Fatal("Upsert() accepted a transient blob URL")
	}
	if _, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "bad", Kind: "video", Title: "bad", URL: "/video.mp4", DurationMs: -1}); err == nil {
		t.Fatal("Upsert() accepted negative media metadata")
	}
	if _, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "bad", Kind: "text", Title: "bad", Content: "bad", Visibility: "everyone"}); err == nil {
		t.Fatal("Upsert() accepted invalid visibility")
	}
}

func TestMyAssetsVisibleScopeHonorsVisibilityAndAdminAccess(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	countingBackend := newCountingImageDocumentBackend(t, backend)
	assets := NewMyAssetService(countingBackend, newMyAssetObjectStorageStub())
	upsertMyAssetFixtures(t, assets, "user-a", []MyAsset{
		{ID: "alice-private", Kind: "text", Title: "Alice private", Content: "private", Visibility: MyAssetPrivate},
		{ID: "alice-public", Kind: "text", Title: "Alice public", Content: "public", Visibility: MyAssetPublic},
	})
	upsertMyAssetFixtures(t, assets, "user-b", []MyAsset{
		{ID: "bob-private", Kind: "text", Title: "Bob private", Content: "private"},
		{ID: "bob-public", Kind: "text", Title: "Bob public", Content: "public", Visibility: MyAssetPublic},
	})
	owners := []MyAssetOwner{{ID: "user-a", Name: "Alice"}, {ID: "user-b", Name: "Bob"}}

	countingBackend.loadCalls = 0
	countingBackend.prefixCalls = 0
	visible, err := assets.ListVisible("user-b", false, owners)
	if err != nil {
		t.Fatalf("ListVisible(user-b) error = %v", err)
	}
	if len(visible) != 3 {
		t.Fatalf("ListVisible(user-b) = %#v", visible)
	}
	if countingBackend.prefixCalls != 1 || countingBackend.loadCalls != 0 {
		t.Fatalf("ListVisible() prefix calls = %d, per-owner loads = %d", countingBackend.prefixCalls, countingBackend.loadCalls)
	}
	byID := make(map[string]MyAsset, len(visible))
	for _, item := range visible {
		byID[item.ID] = item
	}
	if _, exists := byID["alice-private"]; exists {
		t.Fatalf("ordinary user saw private asset: %#v", visible)
	}
	if !byID["bob-private"].Owned || byID["alice-public"].Owned || byID["alice-public"].OwnerName != "Alice" {
		t.Fatalf("visible ownership metadata = %#v", visible)
	}

	adminVisible, err := assets.ListVisible("admin", true, owners)
	if err != nil {
		t.Fatalf("ListVisible(admin) error = %v", err)
	}
	if len(adminVisible) != 4 {
		t.Fatalf("ListVisible(admin) = %#v", adminVisible)
	}

	userGovernance, err := assets.TextGovernance("user-b", false, owners)
	if err != nil {
		t.Fatalf("TextGovernance(user-b) error = %v", err)
	}
	if userGovernance.Count != 3 || userGovernance.Bytes != int64(len("public")*2+len("private")) {
		t.Fatalf("TextGovernance(user-b) = %#v", userGovernance)
	}
	adminGovernance, err := assets.TextGovernance("admin", true, owners)
	if err != nil {
		t.Fatalf("TextGovernance(admin) error = %v", err)
	}
	if adminGovernance.Count != 4 || adminGovernance.Bytes != int64(len("public")*2+len("private")*2) {
		t.Fatalf("TextGovernance(admin) = %#v", adminGovernance)
	}
}

func TestMyAssetTextStorageMigratesUpdatesAndDeletesObjects(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	if err := saveStoredJSON(jsonDocumentStoreFromBackend(backend), myAssetDocumentName("user-a"), map[string]any{"items": []MyAsset{{
		ID: "legacy-text", Kind: "text", Title: "旧文本", Content: "旧正文", Visibility: MyAssetPrivate,
	}}}); err != nil {
		t.Fatalf("save legacy asset: %v", err)
	}
	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	migrated, err := assets.EnsureTextStorage(context.Background(), "user-a", false)
	if err != nil || len(migrated) != 1 || migrated[0].StorageKey != "server:text-1" || objects.uploads["text-1"] != "旧正文" {
		t.Fatalf("EnsureTextStorage() = (%#v, %v), uploads=%#v", migrated, err, objects.uploads)
	}

	updated := migrated[0]
	updated.Content = "新正文"
	updated.UpdatedAt = "2026-08-28T01:00:00Z"
	replaced, err := assets.Upsert(context.Background(), "user-a", false, updated)
	if err != nil || replaced.StorageKey != "server:text-2" || objects.uploads["text-2"] != "新正文" {
		t.Fatalf("Upsert(updated) = (%#v, %v), uploads=%#v", replaced, err, objects.uploads)
	}
	if len(objects.deleted) != 1 || objects.deleted[0] != "text-1" {
		t.Fatalf("updated text deleted objects = %#v", objects.deleted)
	}

	if deleted, err := assets.Delete(context.Background(), "user-a", false, updated.ID); err != nil || !deleted {
		t.Fatalf("Delete(text) = (%v, %v)", deleted, err)
	}
	if len(objects.deleted) != 2 || objects.deleted[1] != "text-2" || len(objects.uploads) != 0 {
		t.Fatalf("deleted text objects = %#v, uploads=%#v", objects.deleted, objects.uploads)
	}
}

func TestMyAssetDeletePersistsFailedObjectCleanupForRetry(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	stored, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"})
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	objectID := storageObjectIDFromKey(stored.StorageKey)
	objects.failDeletes(objectID, 1)

	deleted, err := assets.Delete(context.Background(), "user-a", false, stored.ID)
	if !deleted || err != nil {
		t.Fatalf("Delete() = (%v, %v), want committed deletion success", deleted, err)
	}
	if items, listErr := assets.List("user-a"); listErr != nil || len(items) != 0 {
		t.Fatalf("List() after deletion = (%#v, %v)", items, listErr)
	}
	assertMyAssetPendingObjectDeletions(t, backend, "user-a", []string{objectID})

	reloaded := NewMyAssetService(backend, objects)
	if items, ensureErr := reloaded.EnsureTextStorage(context.Background(), "user-a", false); ensureErr != nil || len(items) != 0 {
		t.Fatalf("EnsureTextStorage() = (%#v, %v), want cleanup-only success", items, ensureErr)
	}
	assertMyAssetPendingObjectDeletions(t, backend, "user-a", nil)
	if _, exists := objects.uploads[objectID]; exists {
		t.Fatalf("object %q still exists after cleanup retry", objectID)
	}
}

func TestMyAssetTextReplacementPersistsFailedObjectCleanupForRetry(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	stored, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "old"})
	if err != nil {
		t.Fatalf("Upsert(initial) error = %v", err)
	}
	oldObjectID := storageObjectIDFromKey(stored.StorageKey)
	objects.failDeletes(oldObjectID, 1)
	stored.Content = "new"
	replaced, err := assets.Upsert(context.Background(), "user-a", false, stored)
	if replaced.StorageKey == stored.StorageKey || err != nil {
		t.Fatalf("Upsert(replace) = (%#v, %v), want committed replacement success", replaced, err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, "user-a", []string{oldObjectID})

	reloaded := NewMyAssetService(backend, objects)
	if err := reloaded.RetryAllPendingObjectDeletions(context.Background(), "user-a"); err != nil {
		t.Fatalf("RetryAllPendingObjectDeletions() error = %v", err)
	}
	if objects.nextID != 2 {
		t.Fatalf("uploads = %d, want 2", objects.nextID)
	}
	assertMyAssetPendingObjectDeletions(t, backend, "user-a", nil)
	if _, exists := objects.uploads[oldObjectID]; exists {
		t.Fatalf("replaced object %q still exists after cleanup retry", oldObjectID)
	}
}

func TestMyAssetUploadRollbackPersistsFailedObjectCleanupForRetry(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	failingBackend := &myAssetFailNextDocumentSaveBackend{
		Backend: backend, JSONDocumentBackend: backend, documentName: myAssetDocumentName(ownerID),
		failNext: 1, err: errors.New("injected asset document save failure"),
	}
	objects := newMyAssetObjectStorageStub()
	objects.omitUploadID = true
	objects.failDeletes("text-1", 1)
	assets := NewMyAssetService(failingBackend, objects)
	input := MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"}
	if _, err := assets.Upsert(context.Background(), ownerID, false, input); err == nil || !strings.Contains(err.Error(), "injected asset document save failure") || !strings.Contains(err.Error(), "injected object deletion failure") {
		t.Fatalf("Upsert(failed save) error = %v, want save and rollback cleanup errors", err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, []string{"text-1"})

	reloaded := NewMyAssetService(backend, objects)
	if err := reloaded.RetryAllPendingObjectDeletions(context.Background(), ownerID); err != nil {
		t.Fatalf("RetryAllPendingObjectDeletions() error = %v", err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, nil)
	if _, exists := objects.uploads["text-1"]; exists {
		t.Fatal("rolled-back object still exists after cleanup retry")
	}

	stored, err := reloaded.Upsert(context.Background(), ownerID, false, input)
	if err != nil || stored.StorageKey != "server:text-2" {
		t.Fatalf("Upsert(retry) = (%#v, %v)", stored, err)
	}
}

func TestMyAssetCleanupDoesNotDeleteReferencedObject(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	objectID := "active-text"
	if err := saveStoredJSON(jsonDocumentStoreFromBackend(backend), myAssetDocumentName(ownerID), map[string]any{
		"items":                            []MyAsset{{ID: "text", Kind: "text", Title: "Text", Content: "body", StorageKey: "server:" + objectID}},
		myAssetPendingObjectDeletionsField: []string{objectID},
	}); err != nil {
		t.Fatalf("save asset document: %v", err)
	}
	objects := newMyAssetObjectStorageStub()
	objects.uploads[objectID] = "body"

	if err := NewMyAssetService(backend, objects).RetryAllPendingObjectDeletions(context.Background(), ownerID); err != nil {
		t.Fatalf("RetryAllPendingObjectDeletions() error = %v", err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, nil)
	if _, exists := objects.uploads[objectID]; !exists {
		t.Fatalf("referenced object %q was deleted", objectID)
	}
	if len(objects.deleteAttempts) != 0 {
		t.Fatalf("referenced object deletion attempts = %#v", objects.deleteAttempts)
	}
}

func TestMyAssetUploadRollbackDoesNotDeleteCommittedObject(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	commitThenFail := &myAssetCommitThenFailDocumentSaveBackend{
		Backend: backend, JSONDocumentBackend: backend, documentName: myAssetDocumentName(ownerID),
		failNext: 1, err: errors.New("injected uncertain asset document save"),
	}
	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(commitThenFail, objects)
	if _, err := assets.Upsert(context.Background(), ownerID, false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"}); err == nil || !strings.Contains(err.Error(), "injected uncertain asset document save") {
		t.Fatalf("Upsert() error = %v, want uncertain save error", err)
	}

	items, err := NewMyAssetService(backend, objects).List(ownerID)
	if err != nil || len(items) != 1 || items[0].StorageKey != "server:text-1" {
		t.Fatalf("List() after uncertain save = (%#v, %v)", items, err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, nil)
	if _, exists := objects.uploads["text-1"]; !exists {
		t.Fatal("object referenced by the committed document was deleted")
	}
	if len(objects.deleteAttempts) != 0 {
		t.Fatalf("referenced object deletion attempts = %#v", objects.deleteAttempts)
	}
}

func TestMyAssetSlowObjectDeletionDoesNotBlockReads(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	stored, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"})
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	objects.deleteStarted = make(chan struct{})
	release := make(chan struct{})
	objects.deleteRelease = release
	deleteDone := make(chan error, 1)
	go func() {
		_, deleteErr := assets.Delete(context.Background(), "user-a", false, stored.ID)
		deleteDone <- deleteErr
	}()

	select {
	case <-objects.deleteStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("object deletion did not start")
	}
	listDone := make(chan error, 1)
	go func() {
		_, listErr := assets.List("user-a")
		listDone <- listErr
	}()
	select {
	case listErr := <-listDone:
		if listErr != nil {
			t.Fatalf("List() error = %v", listErr)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("List() was blocked by remote object deletion")
	}
	close(release)
	if deleteErr := <-deleteDone; deleteErr != nil {
		t.Fatalf("Delete() error = %v", deleteErr)
	}
}

func TestMyAssetRejectsPendingDeletedAndIncompatibleStorageObjects(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	stored, err := assets.Upsert(context.Background(), "user-a", false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"})
	if err != nil {
		t.Fatalf("Upsert(text) error = %v", err)
	}
	objectID := storageObjectIDFromKey(stored.StorageKey)
	objects.failDeletes(objectID, 1)
	if deleted, deleteErr := assets.Delete(context.Background(), "user-a", false, stored.ID); deleteErr != nil || !deleted {
		t.Fatalf("Delete(text) = (%v, %v)", deleted, deleteErr)
	}
	_, err = assets.Upsert(context.Background(), "user-a", false, MyAsset{
		ID: "pending", Kind: "image", Title: "Pending", URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
	})
	if err == nil || !strings.Contains(err.Error(), "pending deletion") {
		t.Fatalf("Upsert(pending object) error = %v", err)
	}
	if err := assets.RetryAllPendingObjectDeletions(context.Background(), "user-a"); err != nil {
		t.Fatalf("RetryAllPendingObjectDeletions() error = %v", err)
	}
	_, err = assets.Upsert(context.Background(), "user-a", false, MyAsset{
		ID: "deleted", Kind: "video", Title: "Deleted", URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
	})
	if err == nil || !errors.Is(err, storage.ErrStorageObjectNotFound) {
		t.Fatalf("Upsert(deleted object) error = %v", err)
	}

	objects.seedObject("other-owner", "user-b", "image/png")
	_, err = assets.Upsert(context.Background(), "user-a", true, MyAsset{
		ID: "foreign", Kind: "image", Title: "Foreign", URL: "/api/files/other-owner/content", StorageKey: "server:other-owner",
	})
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("Upsert(foreign object) error = %v", err)
	}
	objects.seedObject("wrong-mime", "user-a", "video/mp4")
	_, err = assets.Upsert(context.Background(), "user-a", false, MyAsset{
		ID: "wrong-kind", Kind: "image", Title: "Wrong kind", URL: "/api/files/wrong-mime/content", StorageKey: "server:wrong-mime",
	})
	if err == nil || !strings.Contains(err.Error(), "incompatible") {
		t.Fatalf("Upsert(incompatible object) error = %v", err)
	}
}

func TestMyAssetKeepsUploadedObjectWhenCleanupOutboxCannotPersist(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	failingBackend := &myAssetFailNextDocumentSaveBackend{
		Backend: backend, JSONDocumentBackend: backend, documentName: myAssetDocumentName(ownerID),
		failNext: 2, err: errors.New("injected asset document save failure"),
	}
	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(failingBackend, objects)
	_, err = assets.Upsert(context.Background(), ownerID, false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"})
	if err == nil || !strings.Contains(err.Error(), "persist text asset cleanup") {
		t.Fatalf("Upsert() error = %v", err)
	}
	if _, exists := objects.uploads["text-1"]; !exists {
		t.Fatal("untracked uploaded object was deleted without a durable cleanup entry")
	}
	if len(objects.deleteAttempts) != 0 {
		t.Fatalf("object deletion attempts = %#v", objects.deleteAttempts)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, nil)
}

func TestMyAssetRequestCleanupIsBoundedAndLeavesDurableWork(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	objects := newMyAssetObjectStorageStub()
	assets := NewMyAssetService(backend, objects)
	stored, err := assets.Upsert(context.Background(), ownerID, false, MyAsset{ID: "text", Kind: "text", Title: "Text", Content: "body"})
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	objectID := storageObjectIDFromKey(stored.StorageKey)
	objects.deleteStarted = make(chan struct{})
	objects.deleteRelease = make(chan struct{})
	startedAt := time.Now()
	deleted, err := assets.Delete(context.Background(), ownerID, false, stored.ID)
	if err != nil || !deleted {
		t.Fatalf("Delete() = (%v, %v)", deleted, err)
	}
	if elapsed := time.Since(startedAt); elapsed > 2*myAssetRequestCleanupTimeout {
		t.Fatalf("Delete() cleanup took %v, want at most %v", elapsed, 2*myAssetRequestCleanupTimeout)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, []string{objectID})
}

func TestMyAssetRequestCleanupProcessesOnePendingObject(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("old-a", ownerID, "text/plain")
	objects.seedObject("old-b", ownerID, "text/plain")
	if err := saveStoredJSON(jsonDocumentStoreFromBackend(backend), myAssetDocumentName(ownerID), map[string]any{
		"items":                            []MyAsset{},
		myAssetPendingObjectDeletionsField: []string{"old-a", "old-b"},
	}); err != nil {
		t.Fatalf("save asset cleanup queue: %v", err)
	}
	assets := NewMyAssetService(backend, objects)
	if err := assets.retryPendingObjectDeletionsForRequest(context.Background(), ownerID, false); err != nil {
		t.Fatalf("retryPendingObjectDeletionsForRequest() error = %v", err)
	}
	assertMyAssetPendingObjectDeletions(t, backend, ownerID, []string{"old-b"})
	if len(objects.deleted) != 1 || objects.deleted[0] != "old-a" {
		t.Fatalf("deleted objects = %#v", objects.deleted)
	}
}

func TestMyAssetExplicitObjectDeletionCoordinatesAcrossInstances(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	defer backendA.Close()
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	defer backendB.Close()

	ownerID := "user-a"
	objectID := "shared-image"
	objects := newMyAssetObjectStorageStub()
	objects.seedObject(objectID, ownerID, "image/png")
	assetsA := NewMyAssetService(backendA, objects)
	assetsB := NewMyAssetService(backendB, objects)
	objects.deleteStarted = make(chan struct{})
	release := make(chan struct{})
	objects.deleteRelease = release
	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- assetsA.DeleteStorageObject(context.Background(), ownerID, false, objectID, nil)
	}()
	select {
	case <-objects.deleteStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("explicit object deletion did not start")
	}
	input := MyAsset{ID: "image", Kind: "image", Title: "Image", URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID}
	if _, err := assetsB.Upsert(context.Background(), ownerID, false, input); err == nil || !strings.Contains(err.Error(), "pending deletion") {
		t.Fatalf("Upsert(during deletion) error = %v", err)
	}
	close(release)
	if err := <-deleteDone; err != nil {
		t.Fatalf("DeleteStorageObject() error = %v", err)
	}
	if _, err := assetsB.Upsert(context.Background(), ownerID, false, input); err == nil || !errors.Is(err, storage.ErrStorageObjectNotFound) {
		t.Fatalf("Upsert(after deletion) error = %v", err)
	}
	raw, err := backendB.LoadJSONDocument(myAssetDocumentName(ownerID))
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	if generation := util.ToInt(util.StringMap(raw)[myAssetDocumentGenerationField], 0); generation < 2 {
		t.Fatalf("asset document generation = %d, want tombstone add and removal", generation)
	}
}

func TestMyAssetExplicitObjectDeletionRejectsReferencedObject(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	ownerID := "user-a"
	objects := newMyAssetObjectStorageStub()
	objects.seedObject("active-image", ownerID, "image/png")
	assets := NewMyAssetService(backend, objects)
	input := MyAsset{ID: "image", Kind: "image", Title: "Image", URL: "/api/files/active-image/content", StorageKey: "server:active-image"}
	if _, err := assets.Upsert(context.Background(), ownerID, false, input); err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if err := assets.DeleteStorageObject(context.Background(), ownerID, false, "active-image", nil); !errors.Is(err, ErrStorageObjectInUse) {
		t.Fatalf("DeleteStorageObject(referenced) error = %v", err)
	}
	if _, exists := objects.objects["active-image"]; !exists {
		t.Fatal("referenced object was deleted")
	}
}

func assertMyAssetPendingObjectDeletions(t *testing.T, store storage.JSONDocumentBackend, ownerID string, want []string) {
	t.Helper()
	raw, err := store.LoadJSONDocument(myAssetDocumentName(ownerID))
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	got := appendMyAssetObjectDeletionIDs(nil, util.AsStringSlice(util.StringMap(raw)[myAssetPendingObjectDeletionsField])...)
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("pending object deletions = %#v, want %#v", got, want)
	}
}

func upsertMyAssetFixtures(t *testing.T, assets *MyAssetService, ownerID string, items []MyAsset) {
	t.Helper()
	for _, item := range items {
		if _, err := assets.Upsert(context.Background(), ownerID, false, item); err != nil {
			t.Fatalf("Upsert(%s, %s) error = %v", ownerID, item.ID, err)
		}
	}
}
