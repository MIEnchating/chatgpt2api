package service

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestEncodeLocalStorageSegmentIsSafeAndInjective(t *testing.T) {
	for input, want := range map[string]string{
		"newapi:1001":   "newapi%3A1001",
		"a%3Ab":         "a%253Ab",
		"name.":         "name%2E",
		"plain-1_2.png": "plain-1_2.png",
	} {
		if got := encodeLocalStorageSegment(input); got != want {
			t.Errorf("encode(%q) = %q, want %q", input, got, want)
		}
	}
	if encodeLocalStorageSegment("a:b") == encodeLocalStorageSegment("a%3Ab") {
		t.Fatal("encoding is not injective")
	}
}

func TestLocalStorageObjectKeyWithColonRoundTrips(t *testing.T) {
	provider := model.StorageProvider{Type: model.StorageProviderTypeLocal, Endpoint: t.TempDir()}
	key := "assets/newapi:1001/2026/10/30/object.png"
	target, err := localStorageObjectPath(provider, key)
	if err != nil {
		t.Fatal(err)
	}
	relative, _ := filepath.Rel(provider.Endpoint, target)
	if strings.Contains(relative, ":") {
		t.Fatalf("path still contains a colon: %s", relative)
	}
	if err := putLocalStorageObject(provider, key, strings.NewReader("data"), 4); err != nil {
		t.Fatal(err)
	}
	download, err := downloadLocalStorageObject(provider, model.StorageObject{ObjectKey: key}, "")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(download.Stream)
	_ = download.Stream.Close()
	if string(data) != "data" {
		t.Fatalf("downloaded %q", data)
	}
	if err := deleteLocalStorageObject(provider, key); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateLocalStorageNamesKeepsLegacyDataReadable(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "assets", "newapi:1001", "2026")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Skipf("platform cannot create legacy colon directories: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "object.png"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := migrateLocalStorageNames(root); err != nil {
			t.Fatal(err)
		}
	}
	provider := model.StorageProvider{Type: model.StorageProviderTypeLocal, Endpoint: root}
	download, err := downloadLocalStorageObject(provider, model.StorageObject{ObjectKey: "assets/newapi:1001/2026/object.png"}, "")
	if err != nil {
		t.Fatalf("legacy object unreadable after migration: %v", err)
	}
	data, _ := io.ReadAll(download.Stream)
	_ = download.Stream.Close()
	if string(data) != "old" {
		t.Fatalf("read %q", data)
	}
}
