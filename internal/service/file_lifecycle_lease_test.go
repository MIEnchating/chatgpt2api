package service

import (
	"testing"
	"time"
)

func TestFileLifecycleExpiredLeasesAreDropped(t *testing.T) {
	f := newFileLifecycleFixture(t)
	if _, err := f.lifecycle.ProtectStorageReferences(map[string]any{"key": "server:ghost"}); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(fileReferenceLeaseDuration + time.Second)
	state, err := f.lifecycle.loadLocked()
	if err != nil || len(state.Leases) != 0 {
		t.Fatalf("expired leases = (%d, %v), want none", len(state.Leases), err)
	}
}
