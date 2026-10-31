package service

import (
	"testing"
	"time"
)

func TestWithThumbnailJobCleansUpAfterPanic(t *testing.T) {
	s := &ImageService{}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic to propagate")
			}
		}()
		s.withThumbnailJob("a", func() map[string]any { panic("boom") })
	}()
	calls := 0
	got := s.withThumbnailJob("a", func() map[string]any { calls++; return map[string]any{"ok": true} })
	if calls != 1 || got["ok"] != true {
		t.Fatalf("job was not cleaned up: calls=%d result=%v", calls, got)
	}
}

func TestWithThumbnailJobReleasesWaitersWhenRunPanics(t *testing.T) {
	s := &ImageService{}
	started := make(chan struct{})
	release := make(chan struct{})
	go func() {
		defer func() { _ = recover() }()
		s.withThumbnailJob("b", func() map[string]any {
			close(started)
			<-release
			panic("boom")
		})
	}()
	<-started
	done := make(chan map[string]any, 1)
	go func() { done <- s.withThumbnailJob("b", func() map[string]any { return nil }) }()
	time.Sleep(20 * time.Millisecond)
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter stayed blocked after the leader panicked")
	}
}
