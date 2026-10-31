package service

import (
	"testing"
	"time"
)

func TestImageTaskRecoveryUsesTimeoutRecordedWithTheTask(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })
	// The configured timeout is lowered after the tasks started.
	svc.SetTaskTimeoutGetter(func() time.Duration { return 10 * time.Second })

	stale := time.Now().UTC().Add(-60 * time.Second).Format("2006-01-02T15:04:05")
	svc.mu.Lock()
	svc.tasks = map[string]map[string]any{
		"recorded": {"id": "recorded", "status": TaskStatusRunning, "mode": "chat", "timeout_seconds": 300, "revision": 1, "updated_at": stale},
		"legacy":   {"id": "legacy", "status": TaskStatusRunning, "mode": "chat", "revision": 1, "updated_at": stale},
	}
	changed := svc.recoverUnfinishedLocked()
	recorded, legacy := svc.tasks["recorded"], svc.tasks["legacy"]
	svc.mu.Unlock()

	if !changed {
		t.Fatal("the task without a recorded timeout should have been recovered")
	}
	if recorded["status"] != TaskStatusRunning {
		t.Fatalf("a task with a recorded 300s timeout was marked lost after only 60s: %v", recorded["status"])
	}
	if legacy["status"] != TaskStatusError {
		t.Fatalf("a task without a recorded timeout should use the current 10s setting: %v", legacy["status"])
	}
}
