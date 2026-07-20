package httpapi

import (
	"context"
	"testing"
	"time"
)

func TestImageConversationHistoryWriteWeight(t *testing.T) {
	for _, test := range []struct {
		name          string
		contentLength int64
		want          int
	}{
		{name: "ordinary", contentLength: 1024, want: 1},
		{name: "threshold", contentLength: imageConversationHistoryLargeWriteBytes, want: 1},
		{name: "large", contentLength: imageConversationHistoryLargeWriteBytes + 1, want: 2},
		{name: "chunked", contentLength: -1, want: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := imageConversationHistoryWriteWeight(test.contentLength); got != test.want {
				t.Fatalf("weight = %d, want %d", got, test.want)
			}
		})
	}
}

func TestImageConversationHistoryWriteLimiterAllowsOrdinaryParallelism(t *testing.T) {
	limiter := newImageConversationHistoryWriteLimiter(2)
	releaseFirst, ok := limiter.acquire(context.Background(), 1)
	if !ok {
		t.Fatal("first ordinary request was not acquired")
	}
	defer releaseFirst()
	releaseSecond, ok := limiter.acquire(context.Background(), 1)
	if !ok {
		t.Fatal("second ordinary request was not acquired")
	}
	defer releaseSecond()

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if release, acquired := limiter.acquire(cancelled, 1); acquired || release != nil {
		t.Fatal("third ordinary request acquired full limiter capacity")
	}
}

func TestImageConversationHistoryWriteLimiterAcquiresLargeRequestAtomically(t *testing.T) {
	limiter := newImageConversationHistoryWriteLimiter(2)
	releaseFirst, _ := limiter.acquire(context.Background(), 1)
	releaseSecond, _ := limiter.acquire(context.Background(), 1)
	acquired := make(chan func(), 1)
	go func() {
		release, ok := limiter.acquire(context.Background(), 2)
		if ok {
			acquired <- release
		}
	}()

	waitForImageConversationHistoryExclusiveWaiter(t, limiter)
	releaseFirst()
	select {
	case release := <-acquired:
		release()
		t.Fatal("large request acquired only one free slot")
	default:
	}
	releaseSecond()

	select {
	case release := <-acquired:
		release()
	case <-time.After(time.Second):
		t.Fatal("large request did not acquire both released slots")
	}
}

func TestImageConversationHistoryWriteLimiterCancelsLargeWaiter(t *testing.T) {
	limiter := newImageConversationHistoryWriteLimiter(2)
	release, _ := limiter.acquire(context.Background(), 1)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan bool, 1)
	go func() {
		_, acquired := limiter.acquire(ctx, 2)
		result <- acquired
	}()
	waitForImageConversationHistoryExclusiveWaiter(t, limiter)
	cancel()
	select {
	case acquired := <-result:
		if acquired {
			t.Fatal("canceled large request acquired the limiter")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled large request remained blocked")
	}

	limiter.mu.Lock()
	waiters := limiter.exclusiveWaiters
	limiter.mu.Unlock()
	if waiters != 0 {
		t.Fatalf("exclusive waiters = %d, want 0", waiters)
	}
}

func TestImageConversationHistoryWriteLimiterPrioritizesWaitingLargeRequest(t *testing.T) {
	limiter := newImageConversationHistoryWriteLimiter(2)
	releaseCurrent, _ := limiter.acquire(context.Background(), 1)
	largeAcquired := make(chan func(), 1)
	go func() {
		release, ok := limiter.acquire(context.Background(), 2)
		if ok {
			largeAcquired <- release
		}
	}()
	waitForImageConversationHistoryExclusiveWaiter(t, limiter)

	ordinaryAcquired := make(chan func(), 1)
	go func() {
		release, ok := limiter.acquire(context.Background(), 1)
		if ok {
			ordinaryAcquired <- release
		}
	}()
	releaseCurrent()

	var releaseLarge func()
	select {
	case releaseLarge = <-largeAcquired:
	case <-time.After(time.Second):
		t.Fatal("waiting large request was not prioritized")
	}
	select {
	case release := <-ordinaryAcquired:
		release()
		releaseLarge()
		t.Fatal("ordinary request bypassed a waiting large request")
	default:
	}
	releaseLarge()

	select {
	case release := <-ordinaryAcquired:
		release()
	case <-time.After(time.Second):
		t.Fatal("ordinary request did not resume after the large request")
	}
}

func waitForImageConversationHistoryExclusiveWaiter(
	t *testing.T,
	limiter *imageConversationHistoryWriteLimiter,
) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		limiter.mu.Lock()
		if limiter.exclusiveWaiters > 0 {
			limiter.mu.Unlock()
			return
		}
		changed := limiter.changed
		limiter.mu.Unlock()
		select {
		case <-changed:
		case <-deadline:
			t.Fatal("large request did not enter the limiter wait queue")
		}
	}
}
