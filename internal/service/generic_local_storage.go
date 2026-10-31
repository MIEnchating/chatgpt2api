package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"chatgpt2api/internal/model"
)

func ensureLocalStorageDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("initialize local media storage: %w", err)
	}
	return nil
}

func localStorageObjectPath(provider model.StorageProvider, objectKey string) (string, error) {
	cleaned, err := cleanStorageObjectPath(objectKey)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(provider.Endpoint)
	if err != nil {
		return "", err
	}
	segments := strings.Split(cleaned, "/")
	for index, segment := range segments {
		segments[index] = encodeLocalStorageSegment(segment)
	}
	target := filepath.Join(append([]string{root}, segments...)...)
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("local storage object path is invalid")
	}
	return target, nil
}

func putLocalStorageObject(provider model.StorageProvider, objectKey string, source io.Reader, size int64) error {
	target, err := localStorageObjectPath(provider, objectKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".upload-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	written, copyErr := io.Copy(temporary, io.LimitReader(source, size+1))
	if copyErr != nil {
		err = copyErr
	} else if written != size {
		err = fmt.Errorf("uploaded media size mismatch: got %d, want %d", written, size)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return fmt.Errorf("save local media object: %w", err)
	}
	return nil
}

func deleteLocalStorageObject(provider model.StorageProvider, objectKey string) error {
	target, err := localStorageObjectPath(provider, objectKey)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	removeEmptyLocalStorageDirectories(filepath.Dir(target), provider.Endpoint)
	return nil
}

func removeEmptyLocalStorageDirectories(directory, root string) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return
	}
	root = absoluteRoot
	for {
		absolute, err := filepath.Abs(directory)
		if err != nil || absolute == root || !strings.HasPrefix(absolute, root+string(filepath.Separator)) {
			return
		}
		if err := os.Remove(absolute); err != nil {
			return
		}
		directory = filepath.Dir(absolute)
	}
}

func downloadLocalStorageObject(provider model.StorageProvider, object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	target, err := localStorageObjectPath(provider, object.ObjectKey)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	file, err := os.Open(target)
	if errors.Is(err, os.ErrNotExist) {
		return DownloadedStorageObject{}, errors.New("local media object does not exist")
	}
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return DownloadedStorageObject{}, err
	}
	size := stat.Size()
	if strings.TrimSpace(rangeHeader) == "" {
		return DownloadedStorageObject{Object: object, Stream: file, StatusCode: 200, ContentLength: size, AcceptRanges: true}, nil
	}
	byteRange, ok := parseStorageByteRange(rangeHeader, size)
	if !ok {
		_ = file.Close()
		return DownloadedStorageObject{}, ErrInvalidStorageRange
	}
	section := io.NewSectionReader(file, byteRange.offset, byteRange.length)
	return DownloadedStorageObject{
		Object: object, Stream: &localSectionReadCloser{SectionReader: section, file: file}, StatusCode: 206,
		ContentLength: byteRange.length, ContentRange: fmt.Sprintf("bytes %d-%d/%d", byteRange.offset, byteRange.offset+byteRange.length-1, size), AcceptRanges: true,
	}, nil
}

type localSectionReadCloser struct {
	*io.SectionReader
	file *os.File
}

func (r *localSectionReadCloser) Close() error { return r.file.Close() }

func measureLocalStorageProvider(provider model.StorageProvider) (int64, error) {
	var total int64
	err := filepath.WalkDir(provider.Endpoint, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	return total, err
}

// encodeLocalStorageSegment percent-encodes ASCII characters that are invalid or
// ambiguous in file names on common platforms (for example the colon in
// owner IDs such as newapi:1001). The encoding is injective because the percent
// sign itself is escaped.
func encodeLocalStorageSegment(segment string) string {
	var builder strings.Builder
	for index := 0; index < len(segment); index++ {
		char := segment[index]
		safe := char >= 0x80 || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' || char == '~' || char == '.'
		// Windows strips trailing dots, so the final one must be escaped.
		if char == '.' && index == len(segment)-1 {
			safe = false
		}
		if safe {
			builder.WriteByte(char)
			continue
		}
		fmt.Fprintf(&builder, "%%%02X", char)
	}
	return builder.String()
}

// migrateLocalStorageNames renames existing entries to their encoded names once.
// Names that already contain a percent sign are treated as encoded, which keeps
// the migration idempotent.
func migrateLocalStorageNames(directory string) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			if err := migrateLocalStorageNames(path); err != nil {
				return err
			}
		}
		name := entry.Name()
		encoded := encodeLocalStorageSegment(name)
		if encoded == name || strings.Contains(name, "%") {
			continue
		}
		target := filepath.Join(directory, encoded)
		if _, statErr := os.Lstat(target); statErr == nil {
			return fmt.Errorf("migrate local media name %q: target %q already exists", name, encoded)
		}
		if err := os.Rename(path, target); err != nil {
			return fmt.Errorf("migrate local media name %q: %w", name, err)
		}
	}
	return nil
}
