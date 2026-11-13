package service

import (
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoverVideoTaskCoalescesConcurrentCalls(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
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
	svc.SetVideoRecoveryHandler(func(ctx context.Context, _ Identity, _ map[string]any) (map[string]any, error) {
		calls.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{{"url": "/videos/out.mp4"}}}, nil
	})
	var group sync.WaitGroup
	errs := make(chan error, 3)
	for range 3 {
		group.Add(1)
		go func() { defer group.Done(); _, err := svc.RecoverVideoTask(identity, "video-1"); errs <- err }()
	}
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	close(release)
	waitForTaskStatus(t, svc, identity, "video-1", TaskStatusSuccess)
	if calls.Load() != 1 {
		t.Fatalf("recovery workers=%d", calls.Load())
	}
}

func TestRecoverVideoTaskRejectsLateWorkerUpdatesAndMonitorSnapshot(t *testing.T) {
	store := &pausedImageTaskSnapshotStore{JSONDocumentBackend: jsonDocumentStoreFromBackend(newTestStorageBackend(t)), captured: make(chan struct{}), resume: make(chan struct{}), nextRead: make(chan struct{})}
	svc := newImageTaskService(store, nil, nil, nil, func() int { return 30 })
	defer svc.Close()
	identity := Identity{ID: "recovery-owner", Role: AuthRoleUser}
	key := taskKey(ownerID(identity), "same-task")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	svc.mu.Lock()
	svc.tasks[key] = map[string]any{"id": "same-task", "owner_id": ownerID(identity), "mode": "video", "model": "m", "count": 1, "status": TaskStatusError, "error": "query expired", "revision": 2, "created_at": now, "updated_at": now, "video_recovery": map[string]any{"task_id": "original", "url": "https://x.test/video", "base_url": "https://x.test"}}
	oldCtx, oldCancel := context.WithCancel(context.Background())
	defer oldCancel()
	svc.cancels[key] = oldCancel
	err := svc.saveLocked()
	svc.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	subscription, err := svc.SubscribeTasks(identity)
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()
	store.mu.Lock()
	store.pause = true
	store.mu.Unlock()
	var once sync.Once
	resume := func() { once.Do(func() { close(store.resume) }) }
	defer resume()
	select {
	case <-store.captured:
	case <-time.After(3 * time.Second):
		t.Fatal("monitor did not capture old failure")
	}
	started, finish := make(chan context.Context, 1), make(chan struct{})
	svc.SetVideoRecoveryHandler(func(ctx context.Context, _ Identity, _ map[string]any) (map[string]any, error) {
		started <- ctx
		select {
		case <-finish:
			return map[string]any{"data": []map[string]any{{"url": "/videos/recovered.mp4"}}}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	claimed, err := svc.RecoverVideoTask(identity, "same-task")
	if err != nil {
		t.Fatal(err)
	}
	if claimed["status"] != TaskStatusQueued {
		t.Fatalf("claim=%#v", claimed)
	}
	var recoveredCtx context.Context
	select {
	case recoveredCtx = <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("recovery did not start")
	}
	_ = oldCtx
	// Simulate callbacks and cleanup from the original worker after the new claim.
	if err := svc.updateActiveTask(key, map[string]any{"status": TaskStatusError, "error": "late original failure"}, 0); err != nil {
		t.Fatal(err)
	}
	svc.updateVideoTaskProgress(key, VideoTaskProgressUpdate{ClearRecovery: true, Progress: 99, HasProgress: true}, 0)
	svc.removeTaskCancel(key, 0)
	store.mu.Lock()
	store.follow = true
	store.mu.Unlock()
	resume()
	select {
	case <-recoveredCtx.Done():
		t.Fatal("old monitor cancelled new recovery")
	case <-store.nextRead:
	case <-time.After(3 * time.Second):
		t.Fatal("monitor did not advance")
	}
	svc.mu.Lock()
	task := svc.tasks[key]
	if task["status"] != TaskStatusQueued || videoTaskRecovery(task) == nil || svc.cancels[key] == nil {
		t.Errorf("late worker changed recovery: %#v", task)
	}
	svc.mu.Unlock()
	close(finish)
	waitForTaskStatus(t, svc, identity, "same-task", TaskStatusSuccess)
}

func TestRecoverVideoTaskDatabaseClaimAndReload(t *testing.T) {
	cases := []struct{ name, url string }{{"sqlite", "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "video-recovery.db"))}, {"mysql", os.Getenv("TEST_MYSQL_DATABASE_URL")}, {"postgres", os.Getenv("TEST_POSTGRES_DATABASE_URL")}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.url == "" {
				t.Skip("isolated database URL is not configured")
			}
			backendA, err := storage.NewDatabaseBackend(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer backendA.Close()
			backendB, err := storage.NewDatabaseBackend(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer backendB.Close()
			identity := Identity{ID: "video-recovery-" + util.NewUUID(), Role: AuthRoleUser}
			seed := NewStoredImageTaskService(backendA, nil, nil, nil, func() int { return 30 })
			seed.SetVideoHandler(func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
				payload[VideoTaskProgressCallbackPayloadKey].(func(VideoTaskProgressUpdate))(VideoTaskProgressUpdate{Status: TaskStatusRunning, Recovery: &VideoTaskRecovery{TaskID: "original-upstream", BaseURL: "https://relay.example", Model: "m", QueryPath: "/original/{task_id}", Contract: []byte(`{"id":"original-contract"}`)}})
				return nil, errors.New("query authentication interrupted")
			})
			if _, err := seed.SubmitVideo(context.Background(), identity, "original-local", "animate", "m", "16:9", 5, "720p", false, false, "text", nil, nil, nil, nil); err != nil {
				t.Fatal(err)
			}
			waitForTaskStatus(t, seed, identity, "original-local", TaskStatusError)
			if err := seed.Close(); err != nil {
				t.Fatal(err)
			}
			a := NewStoredImageTaskService(backendA, nil, nil, nil, func() int { return 30 })
			defer a.Close()
			b := NewStoredImageTaskService(backendB, nil, nil, nil, func() int { return 30 })
			defer b.Close()
			var workers atomic.Int32
			release := make(chan struct{})
			var once sync.Once
			finish := func() { once.Do(func() { close(release) }) }
			defer finish()
			handler := func(ctx context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
				workers.Add(1)
				r := payload[VideoTaskRecoveryPayloadKey].(*VideoTaskRecovery)
				if r.TaskID != "original-upstream" || r.QueryPath != "/original/{task_id}" || string(r.Contract) != `{"id":"original-contract"}` {
					t.Errorf("query snapshot changed: %#v", r)
				}
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				return map[string]any{"data": []map[string]any{{"url": "/videos/restored.mp4"}}}, nil
			}
			a.SetVideoRecoveryHandler(handler)
			b.SetVideoRecoveryHandler(handler)
			var wg sync.WaitGroup
			errs := make(chan error, 2)
			for _, svc := range []*ImageTaskService{a, b} {
				wg.Add(1)
				go func(svc *ImageTaskService) {
					defer wg.Done()
					_, err := svc.RecoverVideoTask(identity, "original-local")
					errs <- err
				}(svc)
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatal(err)
				}
			}
			finish()
			waitForTaskStatus(t, a, identity, "original-local", TaskStatusSuccess)
			waitForTaskStatus(t, b, identity, "original-local", TaskStatusSuccess)
			if workers.Load() != 1 {
				t.Fatalf("duplicate recovery workers: %d", workers.Load())
			}
		})
	}
}

func TestRecoverVideoTaskDoesNotStartWorkerWhenClaimCannotPersist(t *testing.T) {
	backend := newTestStorageBackend(t)
	seed := NewStoredImageTaskService(backend, nil, nil, nil, func() int { return 30 })
	identity := Identity{ID: "claim-owner", Role: AuthRoleUser}
	key := taskKey(ownerID(identity), "claim-failure")
	now := util.NowISO()
	seed.mu.Lock()
	seed.tasks[key] = map[string]any{"id": "claim-failure", "owner_id": ownerID(identity), "mode": "video", "model": "m", "count": 1, "status": TaskStatusError, "error": "query interrupted", "revision": 3, "created_at": now, "updated_at": now, "video_recovery": map[string]any{"task_id": "original", "url": "https://relay.example/video", "base_url": "https://relay.example"}}
	err := seed.saveLocked()
	seed.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	store := &failingImageTaskDocumentStore{JSONDocumentBackend: jsonDocumentStoreFromBackend(backend)}
	svc := newImageTaskService(store, nil, nil, nil, func() int { return 30 })
	defer svc.Close()
	var calls atomic.Int32
	svc.SetVideoRecoveryHandler(func(context.Context, Identity, map[string]any) (map[string]any, error) { calls.Add(1); return nil, nil })
	if _, err := svc.RecoverVideoTask(identity, "claim-failure"); err == nil {
		t.Fatal("claim acknowledged despite failed durable save")
	}
	if calls.Load() != 0 {
		t.Fatal("worker started before durable claim")
	}
	waitForTaskStatus(t, svc, identity, "claim-failure", TaskStatusError)
	task := util.AsMapSlice(svc.ListTasks(identity, []string{"claim-failure"})["items"])[0]
	if !util.ToBool(task["can_recover_video"]) {
		t.Fatal("failed claim destroyed original recovery")
	}
}
