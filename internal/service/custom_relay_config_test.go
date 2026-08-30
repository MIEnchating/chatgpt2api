package service

import "testing"

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

	updated, err := service.Update("owner-a", first.ID, "主线路更新", "https://next.example.test", "")
	if err != nil {
		t.Fatalf("Update() preserving key error = %v", err)
	}
	config, err := service.Config("owner-a", first.ID)
	if err != nil {
		t.Fatalf("Config() error = %v", err)
	}
	if config.BaseURL != "https://next.example.test" || config.APIKey != "sk-secret" || config.Name != "主线路更新" || !updated.Configured {
		t.Fatalf("Config() = %#v, status = %#v", config, updated)
	}
	statuses, err := service.Statuses("owner-a")
	if err != nil || len(statuses) != 2 {
		t.Fatalf("Statuses() = %#v, %v", statuses, err)
	}
}

func TestCustomRelayConfigServiceValidatesAndDeletesConfig(t *testing.T) {
	service := NewCustomRelayConfigService(newTestStorageBackend(t))
	for _, baseURL := range []string{"", "ftp://api.example.test", "https://user:pass@api.example.test", "https://api.example.test?key=value"} {
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
	if err != nil || config != (CustomRelayConfig{}) {
		t.Fatalf("Config() after Delete = %#v, %v", config, err)
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
