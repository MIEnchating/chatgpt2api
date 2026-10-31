package service

import (
	"testing"
	"time"
)

func TestCustomRelayConfigServiceReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	configs := &CustomRelayConfigService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := configs.Config("owner", "config-id"); err == nil {
		t.Fatal("Config() should fail when the database hangs")
	}
	if _, err := configs.Statuses("owner"); err == nil {
		t.Fatal("Statuses() should fail when the database hangs")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("custom relay config reads took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
