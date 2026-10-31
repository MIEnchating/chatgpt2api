package service

import (
	"errors"

	"chatgpt2api/internal/storage"
)

// IsConcurrentRowUpdate reports whether err is an optimistic-lock conflict, so
// transport code can classify it without importing the storage package.
func IsConcurrentRowUpdate(err error) bool {
	return errors.Is(err, storage.ErrConcurrentRowUpdate)
}

// IsStorageObjectNotFound reports whether err means the storage object is missing.
func IsStorageObjectNotFound(err error) bool {
	return errors.Is(err, storage.ErrStorageObjectNotFound)
}
