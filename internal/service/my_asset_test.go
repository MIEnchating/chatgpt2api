package service

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"chatgpt2api/internal/storage"
)

type myAssetObjectStorageStub struct {
	nextID  int
	uploads map[string]string
	deleted []string
}

func TestMyAssetItemMutationsPreserveConcurrentGeneratedMedia(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	assets := NewMyAssetService(backend, newMyAssetObjectStorageStub())
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
	return &myAssetObjectStorageStub{uploads: make(map[string]string)}
}

func (s *myAssetObjectStorageStub) Upload(_ context.Context, _ string, _ bool, filename, contentType string, data []byte, _ *StorageObjectProviderInput) (UploadedStorageObject, error) {
	s.nextID++
	id := fmt.Sprintf("text-%d", s.nextID)
	s.uploads[id] = string(data)
	return UploadedStorageObject{ID: id, URL: "/api/files/" + id + "/content", StorageKey: "server:" + id, Bytes: int64(len(data)), MIMEType: contentType}, nil
}

func (s *myAssetObjectStorageStub) Delete(_ context.Context, _ string, _ bool, id string, _ *StorageObjectProviderInput) error {
	delete(s.uploads, id)
	s.deleted = append(s.deleted, id)
	return nil
}

func TestMyAssetsArePersistentAndPersonal(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "assets.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer backend.Close()

	objects := newMyAssetObjectStorageStub()
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

func upsertMyAssetFixtures(t *testing.T, assets *MyAssetService, ownerID string, items []MyAsset) {
	t.Helper()
	for _, item := range items {
		if _, err := assets.Upsert(context.Background(), ownerID, false, item); err != nil {
			t.Fatalf("Upsert(%s, %s) error = %v", ownerID, item.ID, err)
		}
	}
}
