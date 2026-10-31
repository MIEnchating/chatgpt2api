package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRelayOnboardingLockIsPerUserAndCancellable(t *testing.T) {
	set := &relayOnboardingLockSet{entries: map[int64]*relayOnboardingLockEntry{}}
	release, err := set.acquire(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	other, err := set.acquire(context.Background(), 2)
	if err != nil {
		t.Fatalf("a different user must not block: %v", err)
	}
	other()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := set.acquire(ctx, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked acquire error = %v, want deadline exceeded", err)
	}
	release()
	again, err := set.acquire(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	again()
	if len(set.entries) != 0 {
		t.Fatalf("lock entries leaked: %d", len(set.entries))
	}
}
