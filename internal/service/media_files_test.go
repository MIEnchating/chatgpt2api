package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStoreMediaFileWritesContentAtomically(t *testing.T) {
	dir := t.TempDir()
	written, err := StoreMediaFile(strings.NewReader("hello"), MediaFileWrite{Directory: dir, Name: "a.mp4", MaxBytes: 16, Perm: 0o644})
	if err != nil || written != 5 {
		t.Fatalf("written = %d, err = %v", written, err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "a.mp4"))
	if err != nil || string(data) != "hello" {
		t.Fatalf("data = %q, err = %v", data, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %d entries", len(entries))
	}
}

func TestStoreMediaFileRejectsOversizedSourceWithoutLeavingFiles(t *testing.T) {
	dir := t.TempDir()
	_, err := StoreMediaFile(strings.NewReader("0123456789"), MediaFileWrite{Directory: dir, Name: "big.mp4", MaxBytes: 4})
	if !errors.Is(err, ErrMediaFileTooLarge) {
		t.Fatalf("err = %v, want ErrMediaFileTooLarge", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("files left behind: %d entries", len(entries))
	}
}

func TestStoreMediaFileEmptySourceHonorsAllowEmpty(t *testing.T) {
	dir := t.TempDir()
	if _, err := StoreMediaFile(strings.NewReader(""), MediaFileWrite{Directory: dir, Name: "e.bin", MaxBytes: 4}); !errors.Is(err, ErrMediaFileEmpty) {
		t.Fatalf("err = %v, want ErrMediaFileEmpty", err)
	}
	if _, err := StoreMediaFile(strings.NewReader(""), MediaFileWrite{Directory: dir, Name: "e.bin", MaxBytes: 4, AllowEmpty: true}); err != nil {
		t.Fatalf("AllowEmpty write failed: %v", err)
	}
}

func TestStoreMediaFileRejectsInvalidNameAndLimit(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"", ".", "..", "../x", "a/b"} {
		if _, err := StoreMediaFile(strings.NewReader("x"), MediaFileWrite{Directory: dir, Name: name, MaxBytes: 4}); err == nil {
			t.Fatalf("name %q must be rejected", name)
		}
	}
	if _, err := StoreMediaFile(strings.NewReader("x"), MediaFileWrite{Directory: dir, Name: "a", MaxBytes: 0}); err == nil {
		t.Fatal("a non-positive size limit must be rejected")
	}
}

func TestReadMediaFileMapsMissingAndInvalidSize(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadMediaFile(dir, "none.mp4", 8); !errors.Is(err, ErrMediaFileNotFound) {
		t.Fatalf("err = %v, want ErrMediaFileNotFound", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "big.mp4"), []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadMediaFile(dir, "big.mp4", 4); !errors.Is(err, ErrMediaFileSizeInvalid) {
		t.Fatalf("err = %v, want ErrMediaFileSizeInvalid", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "empty.mp4"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadMediaFile(dir, "empty.mp4", 4); !errors.Is(err, ErrMediaFileSizeInvalid) {
		t.Fatalf("err = %v, want ErrMediaFileSizeInvalid", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ok.mp4"), []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := ReadMediaFile(dir, "ok.mp4", 4)
	if err != nil || string(data) != "abc" {
		t.Fatalf("data = %q, err = %v", data, err)
	}
	if _, err := ReadMediaFile(dir, "../x", 4); err == nil {
		t.Fatal("a path-like name must be rejected")
	}
}

func TestRemoveMediaFileIgnoresMissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.png")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMediaFile(path); err != nil {
		t.Fatalf("remove existing: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file still exists: %v", err)
	}
	if err := RemoveMediaFile(path); err != nil {
		t.Fatalf("remove missing: %v", err)
	}
}

func TestIsRegularMediaFileRejectsDirectoriesAndMissingPaths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.png")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !IsRegularMediaFile(path) {
		t.Fatal("a regular file must be accepted")
	}
	if IsRegularMediaFile(dir) {
		t.Fatal("a directory must be rejected")
	}
	if IsRegularMediaFile(filepath.Join(dir, "missing.png")) {
		t.Fatal("a missing path must be rejected")
	}
}

func TestCleanupMediaDirectorySkipsDotFilesDirectoriesAndFreshFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	for name, age := range map[string]time.Duration{"old.mp4": 48 * time.Hour, "fresh.mp4": time.Hour, ".tmp-old": 48 * time.Hour} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		modified := now.Add(-age)
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	deleted, err := CleanupMediaDirectory(dir, now.Add(-24*time.Hour))
	if err != nil || deleted != 1 {
		t.Fatalf("CleanupMediaDirectory() = (%d, %v), want 1", deleted, err)
	}
	for _, name := range []string{"fresh.mp4", ".tmp-old", "sub"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s must be preserved: %v", name, err)
		}
	}
	if _, err := CleanupMediaDirectory(filepath.Join(dir, "missing"), now); err == nil {
		t.Fatal("a missing directory must report an error")
	}
}

func TestOpenMediaFileIsMediaFileAndEnsureMediaDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "b")
	if err := EnsureMediaDirectory(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "x.png")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := OpenMediaFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if _, err := OpenMediaFile(filepath.Join(dir, "none")); err == nil {
		t.Fatal("opening a missing file must fail")
	}
	if !IsMediaFile(path) || IsMediaFile(dir) || IsMediaFile(filepath.Join(dir, "none")) {
		t.Fatal("IsMediaFile must accept files only")
	}
}
