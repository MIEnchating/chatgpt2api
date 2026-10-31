package service

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoverVideoContentCoalescesConcurrentCalls(t *testing.T) {
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) { return nil, nil }
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Role: AuthRoleUser}
	key := taskKey(ownerID(identity), "video-1")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	svc.mu.Lock()
	svc.tasks[key] = map[string]any{"id": "video-1", "owner_id": ownerID(identity), "status": TaskStatusError, "mode": "video", "model": "m", "count": 1, "revision": 1, "created_at": now, "updated_at": now, "video_recovery": map[string]any{"task_id": "up-1", "url": "https://x.test/v", "base_url": "https://x.test"}}
	err := svc.saveLocked()
	svc.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	release := make(chan struct{})
	download := func(context.Context, VideoContentRecovery) (string, error) {
		calls.Add(1)
		<-release
		return "/videos/out.mp4", nil
	}
	var group sync.WaitGroup
	errs := make(chan error, 3)
	for range 3 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := svc.RecoverVideoContent(context.Background(), identity, "video-1", download)
			errs <- err
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("RecoverVideoContent() error = %v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("download calls = %d, want 1", calls.Load())
	}
}
