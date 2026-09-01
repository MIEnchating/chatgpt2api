package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"chatgpt2api/internal/model"

	"github.com/studio-b12/gowebdav"
)

func newGenericWebDAVClient(ctx context.Context, provider model.StorageProvider) (*gowebdav.Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(provider.Endpoint))
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("WebDAV endpoint is invalid")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("WebDAV endpoint must not contain credentials or a fragment")
	}
	client := gowebdav.NewClient(strings.TrimRight(parsed.String(), "/"), provider.Username, provider.Password)
	client.SetTimeout(5 * time.Minute)
	client.SetInterceptor(func(_ string, request *http.Request) {
		*request = *request.WithContext(ctx)
	})
	return client, nil
}

func cleanStorageObjectPath(value string) (string, error) {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsRune(part, '\x00') {
			return "", errors.New("storage object path is invalid")
		}
	}
	return strings.Join(parts, "/"), nil
}

func putGenericWebDAVObject(ctx context.Context, provider model.StorageProvider, objectKey string, data []byte) error {
	client, err := newGenericWebDAVClient(ctx, provider)
	if err != nil {
		return err
	}
	objectKey, err = cleanStorageObjectPath(objectKey)
	if err != nil {
		return err
	}
	if directory := path.Dir(objectKey); directory != "." {
		if err := client.MkdirAll(directory, 0o755); err != nil {
			return fmt.Errorf("create WebDAV directory: %w", err)
		}
	}
	if err := client.Write(objectKey, data, 0o644); err != nil {
		return fmt.Errorf("upload WebDAV object: %w", err)
	}
	return nil
}

func deleteGenericWebDAVObject(ctx context.Context, provider model.StorageProvider, objectKey string) error {
	client, err := newGenericWebDAVClient(ctx, provider)
	if err != nil {
		return err
	}
	objectKey, err = cleanStorageObjectPath(objectKey)
	if err != nil {
		return err
	}
	if err := client.Remove(objectKey); err != nil && !gowebdav.IsErrNotFound(err) {
		return fmt.Errorf("delete WebDAV object: %w", err)
	}
	root, err := cleanStorageObjectPath(provider.PathPrefix)
	if err != nil {
		return err
	}
	for directory := path.Dir(objectKey); directory != root && strings.HasPrefix(directory, root+"/"); directory = path.Dir(directory) {
		items, readErr := client.ReadDir(directory)
		if readErr != nil || len(items) != 0 {
			break
		}
		if removeErr := client.Remove(directory); removeErr != nil {
			break
		}
	}
	return nil
}

func downloadGenericWebDAVObject(ctx context.Context, provider model.StorageProvider, object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	client, err := newGenericWebDAVClient(ctx, provider)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	objectKey, err := cleanStorageObjectPath(object.ObjectKey)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	if strings.TrimSpace(rangeHeader) != "" {
		byteRange, ok := parseStorageByteRange(rangeHeader, object.Bytes)
		if !ok {
			return DownloadedStorageObject{}, ErrInvalidStorageRange
		}
		stream, err := client.ReadStreamRange(objectKey, byteRange.offset, byteRange.length)
		if err != nil {
			return DownloadedStorageObject{}, fmt.Errorf("download WebDAV object range: %w", err)
		}
		return DownloadedStorageObject{
			Object: object, Stream: stream, StatusCode: 206, ContentLength: byteRange.length,
			ContentRange: fmt.Sprintf("bytes %d-%d/%d", byteRange.offset, byteRange.offset+byteRange.length-1, object.Bytes), AcceptRanges: true,
		}, nil
	}
	stream, err := client.ReadStream(objectKey)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	return DownloadedStorageObject{
		Object: object, Stream: stream, StatusCode: 200, ContentLength: object.Bytes, AcceptRanges: true,
	}, nil
}

func measureGenericWebDAVProvider(ctx context.Context, provider model.StorageProvider) (int64, error) {
	client, err := newGenericWebDAVClient(ctx, provider)
	if err != nil {
		return 0, err
	}
	root, err := cleanStorageObjectPath(provider.PathPrefix)
	if err != nil {
		return 0, err
	}
	bytesUsed, err := measureGenericWebDAVDirectory(client, root)
	if gowebdav.IsErrNotFound(err) {
		return 0, nil
	}
	return bytesUsed, err
}

func measureGenericWebDAVDirectory(client *gowebdav.Client, directory string) (int64, error) {
	entries, err := client.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, entry := range entries {
		entryPath := path.Join(directory, entry.Name())
		if entry.IsDir() {
			bytesUsed, err := measureGenericWebDAVDirectory(client, entryPath)
			if err != nil {
				return 0, err
			}
			total += bytesUsed
			continue
		}
		total += entry.Size()
	}
	return total, nil
}
