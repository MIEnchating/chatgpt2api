package service

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestCustomRelayConfigServiceStoresMultipleMaskedStatusesAndPreservesKey(t *testing.T) {
	service := NewCustomRelayConfigService(newTestStorageBackend(t))
	first, err := service.Create("owner-a", "image", "主线路", "https://api.example.test/v1/", "sk-secret")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	second, err := service.Create("owner-a", "image", "备用线路", "https://backup.example.test/v1", "sk-backup")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	if first.ID == second.ID || first.TokenName == second.TokenName || !first.Configured || !first.HasKey || first.BaseURL != "https://api.example.test/v1" {
		t.Fatalf("created statuses = %#v, %#v", first, second)
	}

	updated, err := service.Update("owner-a", first.ID, "主线路更新", "https://api.example.test/v2", "")
	if err != nil {
		t.Fatalf("Update() preserving key error = %v", err)
	}
	config, err := service.Config("owner-a", first.ID)
	if err != nil {
		t.Fatalf("Config() error = %v", err)
	}
	if config.BaseURL != "https://api.example.test/v2" || config.APIKey != "sk-secret" || config.Name != "主线路更新" || !updated.Configured {
		t.Fatalf("Config() = %#v, status = %#v", config, updated)
	}
	if _, err := service.Update("owner-a", first.ID, "切换线路", "https://next.example.test", ""); err == nil || !strings.Contains(err.Error(), "必须重新填写 API Key") {
		t.Fatalf("Update(changed origin without key) error = %v", err)
	}
	statuses, err := service.Statuses("owner-a")
	if err != nil || len(statuses) != 2 {
		t.Fatalf("Statuses() = %#v, %v", statuses, err)
	}
}

func TestCustomRelayConfigServiceValidatesAndDeletesConfig(t *testing.T) {
	service := NewCustomRelayConfigService(newTestStorageBackend(t))
	for _, baseURL := range []string{"", "ftp://api.example.test", "https://user:pass@api.example.test", "https://api.example.test?key=value", "http://127.0.0.1:8080", "http://[::1]:8080"} {
		if _, err := service.Create("owner-a", "text", "测试", baseURL, "sk-secret"); err == nil {
			t.Fatalf("Create(%q) error = nil", baseURL)
		}
	}
	if _, err := service.Create("owner-a", "unknown", "测试", "https://api.example.test", "sk-secret"); err == nil {
		t.Fatal("Create(unknown kind) error = nil")
	}
	if _, err := service.Create("owner-a", "text", "测试", "https://api.example.test", ""); err == nil {
		t.Fatal("Create(empty key) error = nil")
	}
	created, err := service.Create("owner-a", "text", "测试", "https://api.example.test", "sk-secret")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := service.Delete("owner-a", created.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	config, err := service.Config("owner-a", created.ID)
	if !errors.Is(err, ErrCustomRelayConfigNotFound) || config != (CustomRelayConfig{}) {
		t.Fatalf("Config() after Delete = %#v, %v, want ErrCustomRelayConfigNotFound", config, err)
	}
}

func TestCustomRelayTokenNameRoundTrip(t *testing.T) {
	id := "config-id"
	name := CustomRelayTokenName(id)
	if got := CustomRelayConfigIDFromTokenName(name); got != id {
		t.Fatalf("CustomRelayConfigIDFromTokenName(%q) = %q, want %q", name, got, id)
	}
	if got := CustomRelayConfigIDFromTokenName("ordinary-token"); got != "" {
		t.Fatalf("ordinary token parsed as %q", got)
	}
}

func TestCustomRelayConfigServiceMergesConcurrentCreates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-custom-relay.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendA.Close()
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer backendB.Close()

	barrier := newTestDocumentSaveBarrier(2)
	serviceA := NewCustomRelayConfigService(newFirstSaveBarrierBackend(t, backendA, barrier))
	serviceB := NewCustomRelayConfigService(newFirstSaveBarrierBackend(t, backendB, barrier))
	type createResult struct {
		status CustomRelayConfigStatus
		err    error
	}
	results := make(chan createResult, 2)
	go func() {
		status, createErr := serviceA.Create("owner", "image", "线路 A", "https://a.example.test", "sk-a")
		results <- createResult{status: status, err: createErr}
	}()
	go func() {
		status, createErr := serviceB.Create("owner", "video", "线路 B", "https://b.example.test", "sk-b")
		results <- createResult{status: status, err: createErr}
	}()
	createdIDs := map[string]bool{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent Create() error = %v", result.err)
		}
		createdIDs[result.status.ID] = true
	}
	statuses, err := serviceA.Statuses("owner")
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 2 || len(createdIDs) != 2 || !createdIDs[statuses[0].ID] || !createdIDs[statuses[1].ID] {
		t.Fatalf("concurrent statuses = %#v, created IDs = %#v", statuses, createdIDs)
	}
}

func TestCustomRelayConfigServiceClassifiesStorageAndNotFoundErrors(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "closed.db")))
	if err != nil {
		t.Fatal(err)
	}
	service := NewCustomRelayConfigService(backend)
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Statuses("owner"); err == nil {
		t.Fatal("Statuses() error = nil")
	} else {
		var storageErr *CustomRelayConfigStorageError
		if !errors.As(err, &storageErr) {
			t.Fatalf("Statuses() error = %T %v, want storage error", err, err)
		}
	}

	service = NewCustomRelayConfigService(newTestStorageBackend(t))
	if _, err := service.Update("owner", "missing", "名称", "https://api.example.test", "sk-key"); !errors.Is(err, ErrCustomRelayConfigNotFound) {
		t.Fatalf("Update(missing) error = %v, want ErrCustomRelayConfigNotFound", err)
	}
}
