package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestImageTaskServiceStorageCallsTimeOutWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	svc := newImageTaskService(hangingContextStore{}, nil, nil, nil, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })

	started := time.Now()
	svc.mu.Lock()
	refreshErr := svc.refreshTasksLocked()
	saveErr := svc.saveLocked()
	svc.mu.Unlock()

	if !errors.Is(refreshErr, context.DeadlineExceeded) {
		t.Fatalf("refresh error = %v, want deadline exceeded", refreshErr)
	}
	if !errors.Is(saveErr, context.DeadlineExceeded) {
		t.Fatalf("save error = %v, want deadline exceeded", saveErr)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("task storage calls took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
