package storage

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestDatabaseBackendStorageObjectLifecycle(t *testing.T) {
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	object := model.StorageObject{
		ID: "object-1", ProviderID: "provider-1", Bucket: "bucket", ObjectKey: "canvas/user/file.mp4",
		PublicURL: "https://cdn.example.test/canvas/user/file.mp4", MIMEType: "video/mp4", Bytes: 123,
		Width: 1920, Height: 1080, SHA256: "hash", Direct: true, CreatedBy: "user-1", CreatedAt: "2026-08-26T00:00:00Z",
	}
	if err := backend.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	loaded, err := backend.LoadStorageObject(object.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != object {
		t.Fatalf("LoadStorageObject() = %#v, want %#v", loaded, object)
	}
	if err := backend.DeleteStorageObject(object.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.LoadStorageObject(object.ID); !errors.Is(err, ErrStorageObjectNotFound) {
		t.Fatalf("LoadStorageObject(deleted) error = %v", err)
	}
}

func TestStorageObjectUsageUsesProviderMIMEIndex(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "storage.db"))
	var plan string
	if err := backend.db.QueryRow(`EXPLAIN QUERY PLAN SELECT mime_type, COUNT(*), COALESCE(SUM(bytes), 0)
		FROM storage_objects WHERE provider_id = ? GROUP BY mime_type`, "provider-1").Scan(new(int), new(int), new(int), &plan); err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	if !strings.Contains(plan, "idx_storage_objects_provider_mime") {
		t.Fatalf("storage usage query plan = %q", plan)
	}
}
