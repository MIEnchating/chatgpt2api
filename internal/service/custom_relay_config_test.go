package service

import "testing"

func TestCustomRelayConfigServiceStoresMaskedStatusesAndPreservesKey(t *testing.T) {
	service := NewCustomRelayConfigService(newTestStorageBackend(t))
	status, err := service.Update("owner-a", "image", "https://api.example.test/v1/", "sk-secret")
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if !status.Configured || !status.HasKey || status.BaseURL != "https://api.example.test/v1" || status.TokenName != CustomRelayTokenName("image") {
		t.Fatalf("Update() status = %#v", status)
	}

	status, err = service.Update("owner-a", "image", "https://next.example.test", "")
	if err != nil {
		t.Fatalf("Update() preserving key error = %v", err)
	}
	config, err := service.Config("owner-a", "image")
	if err != nil {
		t.Fatalf("Config() error = %v", err)
	}
	if config.BaseURL != "https://next.example.test" || config.APIKey != "sk-secret" || !status.Configured {
		t.Fatalf("Config() = %#v, status = %#v", config, status)
	}

	statuses, err := service.Statuses("owner-b")
	if err != nil {
		t.Fatalf("Statuses() error = %v", err)
	}
	if len(statuses) != 4 || statuses["image"].Configured {
		t.Fatalf("Statuses() = %#v", statuses)
	}
}

func TestCustomRelayConfigServiceValidatesAndDeletesConfig(t *testing.T) {
	service := NewCustomRelayConfigService(newTestStorageBackend(t))
	for _, baseURL := range []string{"", "ftp://api.example.test", "https://user:pass@api.example.test", "https://api.example.test?key=value"} {
		if _, err := service.Update("owner-a", "text", baseURL, "sk-secret"); err == nil {
			t.Fatalf("Update(%q) error = nil", baseURL)
		}
	}
	if _, err := service.Update("owner-a", "unknown", "https://api.example.test", "sk-secret"); err == nil {
		t.Fatal("Update(unknown kind) error = nil")
	}
	if _, err := service.Update("owner-a", "text", "https://api.example.test", ""); err == nil {
		t.Fatal("Update(empty first key) error = nil")
	}
	if _, err := service.Update("owner-a", "text", "https://api.example.test", "sk-secret"); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if err := service.Delete("owner-a", "text"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	config, err := service.Config("owner-a", "text")
	if err != nil || config != (CustomRelayConfig{}) {
		t.Fatalf("Config() after Delete = %#v, %v", config, err)
	}
}

func TestCustomRelayTokenNameRoundTrip(t *testing.T) {
	for _, kind := range CustomRelayKinds() {
		name := CustomRelayTokenName(kind)
		if got := CustomRelayKindFromTokenName(name); got != kind {
			t.Fatalf("CustomRelayKindFromTokenName(%q) = %q, want %q", name, got, kind)
		}
	}
	if got := CustomRelayKindFromTokenName("ordinary-token"); got != "" {
		t.Fatalf("ordinary token parsed as %q", got)
	}
}
