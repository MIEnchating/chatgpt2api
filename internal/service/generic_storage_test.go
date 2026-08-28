package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
)

type genericStorageTestSettings struct {
	setting model.StorageSetting
}

func (s *genericStorageTestSettings) StorageSettings() model.StorageSetting { return s.setting }
func (s *genericStorageTestSettings) UpdateStorageProvider(index int, provider model.StorageProvider) error {
	s.setting.Providers[index] = provider
	return nil
}

func newGenericStorageTestService(t *testing.T, setting model.StorageSetting) *GenericStorageService {
	t.Helper()
	root := t.TempDir()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(root, "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	service, err := NewGenericStorageService(backend, &genericStorageTestSettings{setting: setting}, filepath.Join(root, "media"))
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestGenericStorageServicePersistsUserProvidersAndDirectObjects(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{AllowUserProvider: true})
	enabled := true
	providers, err := service.SaveUserProviders("user-1", UserStorageProviders{WebDAV: &StorageObjectProviderInput{
		Enabled: &enabled, Name: "DAV", Type: "webdav", Endpoint: "https://dav.example.test/root",
		PathPrefix: "canvas", Username: "user", Password: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if providers.WebDAV == nil || providers.WebDAV.Password != "secret" {
		t.Fatalf("SaveUserProviders() = %#v", providers)
	}
	loaded, err := service.UserProviders("user-1")
	if err != nil || loaded.WebDAV == nil || loaded.WebDAV.Endpoint != "https://dav.example.test/root" {
		t.Fatalf("UserProviders() = (%#v, %v)", loaded, err)
	}
	registered, err := service.RegisterDirect("user-1", DirectStorageObjectInput{
		Provider: *providers.WebDAV, ObjectKey: "canvas/user-1/2026/08/26/video.mp4", MIMEType: "video/mp4", Bytes: 99,
	})
	if err != nil {
		t.Fatal(err)
	}
	object, err := service.InfoForIdentity("user-1", false, registered.ID)
	if err != nil || !object.Direct || object.CreatedBy != "user-1" || object.ObjectKey != "canvas/user-1/2026/08/26/video.mp4" {
		t.Fatalf("InfoForIdentity() = (%#v, %v)", object, err)
	}
	if _, err := service.InfoForIdentity("user-2", false, registered.ID); err == nil {
		t.Fatal("InfoForIdentity() allowed another user")
	}
	if _, err := service.InfoForIdentity("admin", true, registered.ID); err != nil {
		t.Fatalf("InfoForIdentity() denied admin: %v", err)
	}
	if err := service.DeleteDirectRecord("user-2", registered.ID); err == nil {
		t.Fatal("DeleteDirectRecord() allowed another user")
	}
	if err := service.DeleteDirectRecord("user-1", registered.ID); err != nil {
		t.Fatal(err)
	}
}

func TestGenericStorageServiceRejectsMixedEnabledUserProviderTypes(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{AllowUserProvider: true})
	enabled := true
	_, err := service.SaveUserProviders("user-1", UserStorageProviders{
		S3: &StorageObjectProviderInput{
			Enabled: &enabled, Type: "s3", Endpoint: "https://s3.example.test", Region: "auto",
			Bucket: "media", AccessKeyID: "key", SecretAccessKey: "secret",
		},
		WebDAV: &StorageObjectProviderInput{
			Enabled: &enabled, Type: "webdav", Endpoint: "https://dav.example.test",
			PathPrefix: "canvas", Username: "user", Password: "secret",
		},
	})
	if err == nil {
		t.Fatal("SaveUserProviders() accepted S3/R2 and WebDAV at the same time")
	}
}

func TestStorageObjectPublicURLRejectsInvalidOverrides(t *testing.T) {
	provider := model.StorageProvider{PublicBaseURL: "https://cdn.example.test/root"}
	if got := storageObjectPublicURL(provider, "assets/user/image 1.png"); got != "https://cdn.example.test/root/assets/user/image%201.png" {
		t.Fatalf("storageObjectPublicURL() = %q", got)
	}
	for _, invalid := range []string{"cdn.example.test", "ftp://cdn.example.test", "https://user:pass@cdn.example.test", "https://cdn.example.test?token=value"} {
		provider.PublicBaseURL = invalid
		if got := storageObjectPublicURL(provider, "assets/image.png"); got != "" {
			t.Fatalf("storageObjectPublicURL(%q) = %q, want proxy fallback", invalid, got)
		}
	}
}

func TestCleanStorageObjectPathMatchesReferenceRules(t *testing.T) {
	if got, err := cleanStorageObjectPath("/canvas/user/file.png/"); err != nil || got != "canvas/user/file.png" {
		t.Fatalf("cleanStorageObjectPath() = %q, %v", got, err)
	}
	for _, value := range []string{"", ".", "..", "a//b", "a/../b", "a/./b", "a\x00b"} {
		if _, err := cleanStorageObjectPath(value); err == nil {
			t.Fatalf("cleanStorageObjectPath(%q) should fail", value)
		}
	}
}

func TestGenericStorageServiceRejectsDirectObjectOutsideUserPrefix(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{AllowUserProvider: true})
	enabled := true
	_, err := service.RegisterDirect("user-1", DirectStorageObjectInput{
		Provider:  StorageObjectProviderInput{Enabled: &enabled, Type: "webdav", Endpoint: "https://dav.example.test", PathPrefix: "canvas", Username: "user", Password: "secret"},
		ObjectKey: "canvas/user-2/video.mp4", MIMEType: "video/mp4", Bytes: 99,
	})
	if err == nil {
		t.Fatal("RegisterDirect() accepted another user's path")
	}
}

func TestParseStorageByteRangeMatchesReferenceRules(t *testing.T) {
	tests := []struct {
		value  string
		size   int64
		offset int64
		length int64
		ok     bool
	}{
		{value: "bytes=10-19", size: 100, offset: 10, length: 10, ok: true},
		{value: "bytes=90-", size: 100, offset: 90, length: 10, ok: true},
		{value: "bytes=-12", size: 100, offset: 88, length: 12, ok: true},
		{value: "bytes=100-101", size: 100},
		{value: "bytes=0-1,4-5", size: 100},
	}
	for _, test := range tests {
		got, ok := parseStorageByteRange(test.value, test.size)
		if ok != test.ok || got.offset != test.offset || got.length != test.length {
			t.Fatalf("parseStorageByteRange(%q, %d) = (%#v, %v)", test.value, test.size, got, ok)
		}
	}
}

func TestGenericStorageServicePublicConfig(t *testing.T) {
	settings := &genericStorageTestSettings{setting: model.StorageSetting{
		AllowUserProvider: true, AllowUserGlobalProvider: true,
		Providers: []model.StorageProvider{{
			ID: "s3", Type: "s3", Endpoint: "https://s3.example.test", Bucket: "bucket",
			AccessKeyID: "key", SecretAccessKey: "secret", Enabled: true, Weight: 1,
		}},
	}}
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	service, err := NewGenericStorageService(backend, settings, filepath.Join(t.TempDir(), "media"))
	if err != nil {
		t.Fatal(err)
	}
	config := service.PublicConfig()
	if config.Mode != "server_external" || !config.LocalStorageEnabled || !config.AllowUserProvider || !config.AllowUserGlobalProvider {
		t.Fatalf("PublicConfig() = %#v", config)
	}
}

func TestGenericStorageServiceUsesServerLocalMediaStorageByDefault(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{})
	uploaded, err := service.Upload(context.Background(), "user-1", false, "sample.txt", "text/plain", []byte("0123456789"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if uploaded.StorageKey != "server:"+uploaded.ID || uploaded.URL == "" {
		t.Fatalf("Upload() = %#v", uploaded)
	}
	object, err := service.InfoForIdentity("user-1", false, uploaded.ID)
	if err != nil || object.ProviderID != "server-local" || object.Bytes != 10 {
		t.Fatalf("InfoForIdentity() = (%#v, %v)", object, err)
	}
	download, err := service.DownloadForIdentity(context.Background(), "user-1", false, uploaded.ID, "bytes=2-5")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(download.Stream)
	_ = download.Stream.Close()
	if readErr != nil || string(data) != "2345" || download.StatusCode != http.StatusPartialContent {
		t.Fatalf("DownloadForIdentity() = %q status=%d err=%v", data, download.StatusCode, readErr)
	}
	capacity, err := service.MeasureAdmin(context.Background(), -1, nil)
	if err != nil || capacity.Bytes != 10 {
		t.Fatalf("MeasureAdmin(local) = (%#v, %v)", capacity, err)
	}
	if err := service.Delete(context.Background(), "user-1", false, uploaded.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.InfoForIdentity("user-1", false, uploaded.ID); !errors.Is(err, storage.ErrStorageObjectNotFound) {
		t.Fatalf("deleted object error = %v", err)
	}
}

func TestGenericStorageServiceEnforcesServerLocalCapacityLimit(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{LocalCapacityLimitBytes: 12})
	if _, err := service.Upload(context.Background(), "user-1", false, "first.bin", "application/octet-stream", []byte("0123456789"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Upload(context.Background(), "user-1", false, "second.bin", "application/octet-stream", []byte("abc"), nil); !errors.Is(err, ErrLocalStorageCapacityExceeded) {
		t.Fatalf("Upload(over limit) error = %v, want ErrLocalStorageCapacityExceeded", err)
	}
	capacity, err := service.MeasureAdmin(context.Background(), -1, nil)
	if err != nil || capacity.Bytes != 10 || capacity.LimitBytes != 12 || capacity.OverLimit {
		t.Fatalf("MeasureAdmin(local) = (%#v, %v)", capacity, err)
	}
}

func TestGenericStorageServiceReportsLocalMediaUsageByType(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{LocalCapacityLimitBytes: 1024})
	for _, upload := range []struct {
		name     string
		mimeType string
		data     string
	}{
		{name: "image.png", mimeType: "image/png", data: "image"},
		{name: "video.mp4", mimeType: "video/mp4", data: "video-data"},
		{name: "audio.mp3", mimeType: "audio/mpeg", data: "audio-data"},
		{name: "prompt.txt", mimeType: "text/plain; charset=utf-8", data: "prompt"},
	} {
		if _, err := service.Upload(context.Background(), "user-1", false, upload.name, upload.mimeType, []byte(upload.data), nil); err != nil {
			t.Fatal(err)
		}
	}
	governance, err := service.LocalMediaGovernance()
	if err != nil {
		t.Fatal(err)
	}
	if governance.TotalCount != 4 || governance.TextCount != 1 || governance.ImageCount != 1 || governance.VideoCount != 1 || governance.AudioCount != 1 {
		t.Fatalf("LocalMediaGovernance() = %#v", governance)
	}
	if governance.TotalBytes != int64(len("image")+len("video-data")+len("audio-data")+len("prompt")) || governance.TextBytes != int64(len("prompt")) || governance.UntrackedBytes != 0 || governance.LimitBytes != 1024 {
		t.Fatalf("LocalMediaGovernance() bytes = %#v", governance)
	}
}

func TestGenericStorageServiceDownloadsPublicURLWithoutSavedProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=1-3" {
			http.Error(w, "missing range", http.StatusBadRequest)
			return
		}
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Range", "bytes 1-3/5")
		w.Header().Set("Content-Length", "3")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("bcd"))
	}))
	defer server.Close()

	service := newGenericStorageTestService(t, model.StorageSetting{})
	if err := service.objects.SaveStorageObject(model.StorageObject{
		ID: "public-object", ProviderID: "removed-provider", ObjectKey: "media/file.bin",
		PublicURL: server.URL + "/media/file.bin", MIMEType: "application/octet-stream", Bytes: 5, CreatedBy: "user-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.DownloadForIdentity(context.Background(), "user-2", false, "public-object", "bytes=1-3"); err == nil {
		t.Fatal("DownloadForIdentity() allowed another user")
	}
	download, err := service.DownloadForIdentity(context.Background(), "user-1", false, "public-object", "bytes=1-3")
	if err != nil {
		t.Fatal(err)
	}
	defer download.Stream.Close()
	data, err := io.ReadAll(download.Stream)
	if err != nil || string(data) != "bcd" || download.StatusCode != http.StatusPartialContent || download.ContentRange != "bytes 1-3/5" {
		t.Fatalf("DownloadForIdentity() = data %q, status %d, range %q, err %v", data, download.StatusCode, download.ContentRange, err)
	}
}
