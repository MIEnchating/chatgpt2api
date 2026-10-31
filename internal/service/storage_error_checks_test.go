package service

import (
	"fmt"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestStorageErrorChecksUnwrapStorageSentinels(t *testing.T) {
	if !IsConcurrentRowUpdate(fmt.Errorf("save: %w", storage.ErrConcurrentRowUpdate)) || IsConcurrentRowUpdate(fmt.Errorf("other")) {
		t.Fatal("IsConcurrentRowUpdate classification is wrong")
	}
	if !IsStorageObjectNotFound(fmt.Errorf("read: %w", storage.ErrStorageObjectNotFound)) || IsStorageObjectNotFound(fmt.Errorf("other")) {
		t.Fatal("IsStorageObjectNotFound classification is wrong")
	}
}
