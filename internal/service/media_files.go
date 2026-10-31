package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	// ErrMediaFileEmpty reports that the source produced no bytes.
	ErrMediaFileEmpty = errors.New("media file is empty")
	// ErrMediaFileTooLarge reports that the source produced more than MaxBytes.
	ErrMediaFileTooLarge = errors.New("media file exceeds the size limit")
)

// MediaFileWrite describes one atomic write into a local media directory.
type MediaFileWrite struct {
	Directory   string
	Name        string
	TempPattern string
	MaxBytes    int64
	// Perm is applied before the rename; zero keeps the temporary file mode.
	Perm       os.FileMode
	AllowEmpty bool
}

// StoreMediaFile copies source into Directory/Name through a temporary file in the
// same directory, so readers never observe a partially written file.
func StoreMediaFile(source io.Reader, spec MediaFileWrite) (int64, error) {
	if spec.MaxBytes <= 0 {
		return 0, errors.New("media file size limit is invalid")
	}
	if spec.Name == "" || spec.Name == "." || spec.Name == ".." || filepath.Base(spec.Name) != spec.Name {
		return 0, errors.New("media file name is invalid")
	}
	pattern := spec.TempPattern
	if pattern == "" {
		pattern = ".media-*"
	}
	temporary, err := os.CreateTemp(spec.Directory, pattern)
	if err != nil {
		return 0, err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	written, copyErr := io.Copy(temporary, io.LimitReader(source, spec.MaxBytes+1))
	if copyErr != nil {
		_ = temporary.Close()
		return 0, copyErr
	}
	if written == 0 && !spec.AllowEmpty {
		_ = temporary.Close()
		return 0, ErrMediaFileEmpty
	}
	if written > spec.MaxBytes {
		_ = temporary.Close()
		return 0, ErrMediaFileTooLarge
	}
	if spec.Perm != 0 {
		if err := temporary.Chmod(spec.Perm); err != nil {
			_ = temporary.Close()
			return 0, err
		}
	}
	if err := temporary.Close(); err != nil {
		return 0, err
	}
	if err := os.Rename(temporaryName, filepath.Join(spec.Directory, spec.Name)); err != nil {
		return 0, err
	}
	return written, nil
}

var (
	// ErrMediaFileNotFound reports that the media file does not exist.
	ErrMediaFileNotFound = errors.New("media file not found")
	// ErrMediaFileSizeInvalid reports a zero-length file or one above the limit.
	ErrMediaFileSizeInvalid = errors.New("media file size is invalid")
)

// ReadMediaFile reads Directory/Name fully after checking that its size is within (0, maxBytes].
func ReadMediaFile(directory, name string, maxBytes int64) ([]byte, error) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return nil, errors.New("media file name is invalid")
	}
	path := filepath.Join(directory, name)
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrMediaFileNotFound
		}
		return nil, err
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return nil, ErrMediaFileSizeInvalid
	}
	return os.ReadFile(path)
}

// RemoveMediaFile deletes path and treats a missing file as success.
func RemoveMediaFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// IsRegularMediaFile reports whether path is a regular file. Symbolic links are not followed.
func IsRegularMediaFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// CleanupMediaDirectory removes regular files in root older than cutoff.
// Subdirectories and dot-prefixed in-progress temporary files are skipped.
func CleanupMediaDirectory(root string, cutoff time.Time) (int, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, fmt.Errorf("read generated media directory %q: %w", root, err)
	}
	deleted := 0
	var cleanupErrors []error
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("inspect generated media %q: %w", entry.Name(), err))
			continue
		}
		if !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(root, entry.Name())); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("remove generated media %q: %w", entry.Name(), err))
			continue
		}
		deleted++
	}
	return deleted, errors.Join(cleanupErrors...)
}

// OpenMediaFile opens an existing media file for reading.
func OpenMediaFile(path string) (*os.File, error) {
	return os.Open(path)
}

// IsMediaFile reports whether path exists and is not a directory. Symbolic links are followed.
func IsMediaFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// EnsureMediaDirectory creates directory and any missing parents with perm.
func EnsureMediaDirectory(directory string, perm os.FileMode) error {
	return os.MkdirAll(directory, perm)
}
