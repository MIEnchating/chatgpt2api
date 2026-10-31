package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAnnouncementServiceReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	announcements := &AnnouncementService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := announcements.ListAll(); err == nil {
		t.Fatal("ListAll() should fail when the database hangs")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ListAll() error = %v, want deadline exceeded", err)
	}
	if _, err := announcements.ListVisible(); err == nil {
		t.Fatal("ListVisible() should fail when the database hangs")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("announcement reads took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
