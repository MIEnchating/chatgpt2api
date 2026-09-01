package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"

	"golang.org/x/net/webdav"
)

type genericStorageTestSettings struct {
	setting model.StorageSetting
}

type genericStorageFailingSaveBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.StorageObjectBackend
	cancel context.CancelFunc
	err    error
}

func (b *genericStorageFailingSaveBackend) SaveStorageObject(model.StorageObject) error {
	b.cancel()
	return b.err
}

func (s *genericStorageTestSettings) StorageSettings() model.StorageSetting { return s.setting }
func (s *genericStorageTestSettings) UpdateStorageProviderCapacity(expected model.StorageProvider, expectedLimitBytes, capacityBytes int64, checkedAt string, exceeded bool) (bool, error) {
	if s.setting.CapacityLimitBytes <= 0 {
		s.setting.CapacityLimitBytes = defaultStorageCapacityLimitBytes
	}
	if s.setting.CapacityLimitBytes != expectedLimitBytes {
		return false, nil
	}
	for index := range s.setting.Providers {
		if s.setting.Providers[index].ID != expected.ID {
			continue
		}
		s.setting.Providers[index].CapacityBytes = capacityBytes
		s.setting.Providers[index].CapacityCheckedAt = checkedAt
		s.setting.Providers[index].CapacityExceeded = exceeded
		if exceeded {
			s.setting.Providers[index].Enabled = false
		}
		return true, nil
	}
	return false, nil
}

func newGenericStorageTestService(t *testing.T, setting model.StorageSetting) *GenericStorageService {
	t.Helper()
	root := t.TempDir()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(root, "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	service, err := NewGenericStorageService(backend, &genericStorageTestSettings{setting: setting}, filepath.Join(root, "media"), nil)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestRemoveEmptyLocalStorageDirectoriesStopsAtConfiguredRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "storage")
	nested := filepath.Join(root, "owner", "images")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	removeEmptyLocalStorageDirectories(nested, root)

	if _, err := os.Stat(root); err != nil {
		t.Fatalf("configured root was removed: %v", err)
	}
	if _, err := os.Stat(nested); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty nested directory still exists: %v", err)
	}
	if _, err := os.Stat(parent); err != nil {
		t.Fatalf("parent directory was removed: %v", err)
	}
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

func TestGenericStorageServiceMeasureUserHonorsProviderSetting(t *testing.T) {
	fileSystem := webdav.NewMemFS()
	if err := fileSystem.Mkdir(context.Background(), "/assets", 0o755); err != nil {
		t.Fatal(err)
	}
	requests := 0
	webDAVHandler := &webdav.Handler{FileSystem: fileSystem, LockSystem: webdav.NewMemLS()}
	webDAV := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		webDAVHandler.ServeHTTP(w, r)
	}))
	defer webDAV.Close()
	input := StorageObjectProviderInput{
		Name: "Private DAV", Type: model.StorageProviderTypeWebDAV, Endpoint: webDAV.URL,
		PathPrefix: "assets", Username: "user", Password: "secret",
	}

	disabled := newGenericStorageTestService(t, model.StorageSetting{})
	if _, err := disabled.MeasureUser(context.Background(), "user-1", input); err == nil || err.Error() != "user storage providers are disabled" {
		t.Fatalf("MeasureUser() error = %v, want disabled error", err)
	}
	if requests != 0 {
		t.Fatalf("disabled MeasureUser() made %d WebDAV requests", requests)
	}

	enabled := newGenericStorageTestService(t, model.StorageSetting{AllowUserProvider: true})
	result, err := enabled.MeasureUser(context.Background(), "user-1", input)
	if err != nil {
		t.Fatalf("MeasureUser(private WebDAV) error = %v", err)
	}
	if result.ProviderName != "Private DAV" || result.Bytes != 0 || requests == 0 {
		t.Fatalf("MeasureUser(private WebDAV) = %#v, requests = %d", result, requests)
	}
}

func TestGenericStorageServiceWebDAVMeasureHonorsContextCancellation(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	var startOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		startOnce.Do(func() { close(requestStarted) })
		select {
		case <-request.Context().Done():
		case <-releaseRequest:
		}
	}))
	defer server.Close()
	defer close(releaseRequest)

	service := newGenericStorageTestService(t, model.StorageSetting{AllowUserProvider: true})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := service.MeasureUser(ctx, "user-1", StorageObjectProviderInput{
			Name: "Blocking DAV", Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL,
			PathPrefix: "assets", Username: "user", Password: "secret",
		})
		done <- err
	}()

	select {
	case <-requestStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("WebDAV capacity request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("MeasureUser() error = %v, want context canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("WebDAV capacity request ignored context cancellation")
	}
}

func TestGenericWebDAVObjectLifecycleKeepsNormalRequestsWorking(t *testing.T) {
	fileSystem := webdav.NewMemFS()
	server := httptest.NewServer(&webdav.Handler{FileSystem: fileSystem, LockSystem: webdav.NewMemLS()})
	defer server.Close()
	provider := model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL, PathPrefix: "assets",
		Username: "user", Password: "secret",
	}
	ctx := context.Background()
	objectKey := "assets/user-1/sample.txt"
	if err := putGenericWebDAVObject(ctx, provider, objectKey, []byte("content")); err != nil {
		t.Fatalf("putGenericWebDAVObject() error = %v", err)
	}
	download, err := downloadGenericWebDAVObject(ctx, provider, model.StorageObject{ObjectKey: objectKey, Bytes: 7}, "")
	if err != nil {
		t.Fatalf("downloadGenericWebDAVObject() error = %v", err)
	}
	data, readErr := io.ReadAll(download.Stream)
	_ = download.Stream.Close()
	if readErr != nil || string(data) != "content" {
		t.Fatalf("downloaded WebDAV object = %q, %v", data, readErr)
	}
	if err := deleteGenericWebDAVObject(ctx, provider, objectKey); err != nil {
		t.Fatalf("deleteGenericWebDAVObject() error = %v", err)
	}
	if _, err := fileSystem.Stat(ctx, "/"+objectKey); err == nil {
		t.Fatal("deleted WebDAV object still exists")
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
	service, err := NewGenericStorageService(backend, settings, filepath.Join(t.TempDir(), "media"), nil)
	if err != nil {
		t.Fatal(err)
	}
	config := service.PublicConfig()
	if config.Mode != "server_external" || !config.LocalStorageEnabled || !config.AllowUserProvider || !config.AllowUserGlobalProvider {
		t.Fatalf("PublicConfig() = %#v", config)
	}
}

func TestGenericStorageServiceReportsScheduledCapacityErrors(t *testing.T) {
	settings := &genericStorageTestSettings{setting: model.StorageSetting{
		Providers: []model.StorageProvider{{
			ID: "broken", Name: "Broken DAV", Type: "webdav", Endpoint: "://invalid", Enabled: true,
		}},
	}}
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	var reported error
	service, err := NewGenericStorageService(backend, settings, filepath.Join(t.TempDir(), "media"), func(err error) {
		reported = err
	})
	if err != nil {
		t.Fatal(err)
	}
	service.runScheduledCapacityCheck(context.Background())
	if reported == nil || !strings.Contains(reported.Error(), `measure provider "Broken DAV"`) {
		t.Fatalf("scheduled capacity error = %v", reported)
	}
}

func TestGenericStorageServiceRefreshesCapacitySchedulerAtomically(t *testing.T) {
	settings := &genericStorageTestSettings{setting: model.StorageSetting{
		CapacityCheck: model.StorageCapacityCheckSetting{Enabled: true, Cron: "0 0 1 1 *"},
	}}
	root := t.TempDir()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(root, "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	service, err := NewGenericStorageService(backend, settings, filepath.Join(root, "media"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	if err := service.RefreshCapacityScheduler(context.Background()); err != nil {
		t.Fatalf("initial RefreshCapacityScheduler() error = %v", err)
	}
	entries := service.cron.Entries()
	if len(entries) != 1 {
		t.Fatalf("initial scheduler entries = %#v", entries)
	}
	initialEntryID := entries[0].ID

	settings.setting.CapacityCheck.Cron = "definitely-not-cron"
	if err := service.RefreshCapacityScheduler(context.Background()); err == nil {
		t.Fatal("RefreshCapacityScheduler(invalid cron) error = nil")
	}
	entries = service.cron.Entries()
	if len(entries) != 1 || entries[0].ID != initialEntryID {
		t.Fatalf("invalid refresh replaced existing entry: %#v", entries)
	}

	settings.setting.CapacityCheck.Cron = "0 0 2 1 *"
	if err := service.RefreshCapacityScheduler(context.Background()); err != nil {
		t.Fatalf("replacement RefreshCapacityScheduler() error = %v", err)
	}
	entries = service.cron.Entries()
	if len(entries) != 1 || entries[0].ID == initialEntryID {
		t.Fatalf("valid refresh did not replace existing entry: %#v", entries)
	}

	settings.setting.CapacityCheck.Enabled = false
	if err := service.RefreshCapacityScheduler(context.Background()); err != nil {
		t.Fatalf("disable RefreshCapacityScheduler() error = %v", err)
	}
	if entries = service.cron.Entries(); len(entries) != 0 {
		t.Fatalf("disabled scheduler entries = %#v", entries)
	}

	settings.setting.CapacityCheck.Enabled = true
	if err := service.RefreshCapacityScheduler(context.Background()); err != nil {
		t.Fatalf("re-enable RefreshCapacityScheduler() error = %v", err)
	}
	if entries = service.cron.Entries(); len(entries) != 1 {
		t.Fatalf("re-enabled scheduler entries = %#v", entries)
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

func TestGenericStorageServiceRollsBackUploadedDataAfterCanceledMetadataFailure(t *testing.T) {
	fileSystem := webdav.NewMemFS()
	handler := &webdav.Handler{FileSystem: fileSystem, LockSystem: webdav.NewMemLS()}
	var requestMu sync.Mutex
	uploadedPath := ""
	deleteRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestMu.Lock()
		if r.Method == http.MethodPut {
			uploadedPath = r.URL.Path
		}
		if r.Method == http.MethodDelete {
			deleteRequests++
		}
		requestMu.Unlock()
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()

	root := t.TempDir()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(root, "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	ctx, cancel := context.WithCancel(context.Background())
	metadataErr := errors.New("metadata save failed")
	failingBackend := &genericStorageFailingSaveBackend{
		Backend: backend, JSONDocumentBackend: backend, StorageObjectBackend: backend,
		cancel: cancel, err: metadataErr,
	}
	settings := &genericStorageTestSettings{setting: model.StorageSetting{Providers: []model.StorageProvider{{
		ID: "webdav", Name: "WebDAV", Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL,
		PathPrefix: "assets", Username: "user", Password: "secret", Enabled: true, Weight: 1,
	}}}}
	service, err := NewGenericStorageService(failingBackend, settings, filepath.Join(root, "media"), nil)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Upload(ctx, "user-1", true, "sample.txt", "text/plain", []byte("content"), nil)
	if !errors.Is(err, metadataErr) {
		t.Fatalf("Upload() error = %v, want metadata error", err)
	}
	if ctx.Err() == nil {
		t.Fatal("metadata failure did not cancel the request context")
	}
	requestMu.Lock()
	path := uploadedPath
	deletes := deleteRequests
	requestMu.Unlock()
	if path == "" || deletes == 0 {
		t.Fatalf("rollback requests: uploaded path = %q, DELETE count = %d", path, deletes)
	}
	if _, statErr := fileSystem.Stat(context.Background(), path); statErr == nil {
		t.Fatalf("uploaded WebDAV object %q still exists after metadata rollback", path)
	}
}

func TestGenericStorageServiceReportsMetadataAndRollbackFailures(t *testing.T) {
	fileSystem := webdav.NewMemFS()
	handler := &webdav.Handler{FileSystem: fileSystem, LockSystem: webdav.NewMemLS()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			http.Error(w, "injected delete failure", http.StatusInternalServerError)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()

	root := t.TempDir()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(root, "storage.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	ctx, cancel := context.WithCancel(context.Background())
	metadataErr := errors.New("metadata save failed")
	failingBackend := &genericStorageFailingSaveBackend{
		Backend: backend, JSONDocumentBackend: backend, StorageObjectBackend: backend,
		cancel: cancel, err: metadataErr,
	}
	settings := &genericStorageTestSettings{setting: model.StorageSetting{Providers: []model.StorageProvider{{
		ID: "webdav", Name: "WebDAV", Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL,
		PathPrefix: "assets", Username: "user", Password: "secret", Enabled: true, Weight: 1,
	}}}}
	service, err := NewGenericStorageService(failingBackend, settings, filepath.Join(root, "media"), nil)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Upload(ctx, "user-1", true, "sample.txt", "text/plain", []byte("content"), nil)
	if !errors.Is(err, metadataErr) {
		t.Fatalf("Upload() error = %v, want metadata error", err)
	}
	if !strings.Contains(err.Error(), "rollback uploaded storage object") || !strings.Contains(err.Error(), "500") {
		t.Fatalf("Upload() error omitted rollback failure: %v", err)
	}
}

func TestRollbackStorageObjectDataHasBoundedLifetime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	provider := model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL, PathPrefix: "assets",
		Username: "user", Password: "secret",
	}

	started := time.Now()
	err := rollbackStorageObjectData(context.Background(), provider, "assets/sample.txt", 25*time.Millisecond)
	if err == nil {
		t.Fatal("rollbackStorageObjectData() error = nil")
	}
	if elapsed := time.Since(started); elapsed < 20*time.Millisecond {
		t.Fatalf("rollbackStorageObjectData() returned before its deadline: %s", elapsed)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("rollbackStorageObjectData() took %s", elapsed)
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
