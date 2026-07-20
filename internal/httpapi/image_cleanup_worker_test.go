package httpapi

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestImageCleanupWorkerCoalescesTriggersAndCloseWaits(t *testing.T) {
	var worker imageCleanupWorker
	var runs atomic.Int32
	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	releaseSecond := make(chan struct{})

	run := func() {
		switch runs.Add(1) {
		case 1:
			close(firstStarted)
			<-releaseFirst
		case 2:
			close(secondStarted)
			<-releaseSecond
		}
	}

	worker.schedule(run)
	waitForImageCleanupSignal(t, firstStarted, "first cleanup")

	var schedules sync.WaitGroup
	for range 64 {
		schedules.Add(1)
		go func() {
			defer schedules.Done()
			worker.schedule(run)
		}()
	}
	schedules.Wait()
	if got := runs.Load(); got != 1 {
		t.Fatalf("cleanup runs while first pass is blocked = %d, want 1", got)
	}

	close(releaseFirst)
	waitForImageCleanupSignal(t, secondStarted, "coalesced cleanup")
	if got := runs.Load(); got != 2 {
		t.Fatalf("cleanup runs after coalescing = %d, want 2", got)
	}

	closeDone := make(chan struct{})
	go func() {
		worker.close()
		close(closeDone)
	}()
	waitForImageCleanupWorkerClosed(t, &worker)
	select {
	case <-closeDone:
		t.Fatal("worker close returned before the active cleanup finished")
	default:
	}

	close(releaseSecond)
	waitForImageCleanupSignal(t, closeDone, "worker close")
	worker.schedule(run)
	if got := runs.Load(); got != 2 {
		t.Fatalf("cleanup runs after close = %d, want 2", got)
	}
}

func TestImageCleanupWorkerConcurrentScheduleAndClose(t *testing.T) {
	for iteration := 0; iteration < 100; iteration++ {
		var worker imageCleanupWorker
		var schedules sync.WaitGroup
		start := make(chan struct{})
		for range 16 {
			schedules.Add(1)
			go func() {
				defer schedules.Done()
				<-start
				worker.schedule(func() {})
			}()
		}
		close(start)
		worker.close()
		schedules.Wait()
		worker.close()
	}
}

func TestImageConversationAssetCleanupWorkerDebouncesOwnerAndImmediateScheduleCancelsDelay(t *testing.T) {
	const delay = 40 * time.Millisecond
	var worker imageConversationAssetCleanupWorker
	var runs atomic.Int32
	started := make(chan struct{}, 2)
	run := func(context.Context, string) {
		runs.Add(1)
		started <- struct{}{}
	}
	for range 64 {
		worker.scheduleDebounced("owner", delay, run)
	}
	select {
	case <-started:
		t.Fatal("debounced cleanup ran before its delay")
	case <-time.After(delay / 2):
	}
	waitForImageCleanupSignal(t, started, "debounced conversation asset cleanup")
	time.Sleep(delay * 2)
	if got := runs.Load(); got != 1 {
		t.Fatalf("debounced cleanup runs = %d, want 1", got)
	}
	worker.close()

	var immediate imageConversationAssetCleanupWorker
	defer immediate.close()
	var immediateRuns atomic.Int32
	immediateStarted := make(chan struct{}, 2)
	immediateRun := func(context.Context, string) {
		immediateRuns.Add(1)
		immediateStarted <- struct{}{}
	}
	immediate.scheduleDebounced("owner", delay, immediateRun)
	immediate.schedule("owner", immediateRun)
	waitForImageCleanupSignal(t, immediateStarted, "immediate conversation asset cleanup")
	time.Sleep(delay * 2)
	if got := immediateRuns.Load(); got != 1 {
		t.Fatalf("immediate cleanup plus canceled debounce runs = %d, want 1", got)
	}
}

func TestImageConversationAssetCleanupWorkerTimeoutDoesNotBlockOtherOwners(t *testing.T) {
	worker := imageConversationAssetCleanupWorker{timeout: 30 * time.Millisecond}
	defer worker.close()
	firstStarted := make(chan struct{})
	firstCanceled := make(chan struct{})
	secondStarted := make(chan struct{})

	worker.schedule("first-owner", func(ctx context.Context, ownerID string) {
		if ownerID == "first-owner" {
			close(firstStarted)
			<-ctx.Done()
			close(firstCanceled)
			return
		}
		close(secondStarted)
	})
	waitForImageCleanupSignal(t, firstStarted, "blocked conversation asset cleanup")
	worker.schedule("second-owner", func(context.Context, string) {
	})
	waitForImageCleanupSignal(t, firstCanceled, "timed out cleanup cancellation")
	waitForImageCleanupSignal(t, secondStarted, "cleanup after timed out owner")
}

func TestImageConversationAssetCleanupWorkerBoundsUnresponsiveRuns(t *testing.T) {
	worker := imageConversationAssetCleanupWorker{timeout: 20 * time.Millisecond}
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	var runs atomic.Int32
	run := func(context.Context, string) {
		call := runs.Add(1)
		if call == 1 {
			close(started)
			defer close(finished)
		}
		<-release
	}
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
		worker.close()
	}()
	worker.schedule("first-owner", run)
	waitForImageCleanupSignal(t, started, "unresponsive conversation asset cleanup")
	for index := range 64 {
		worker.schedule(fmt.Sprintf("queued-owner-%d", index), run)
	}
	time.Sleep(4 * worker.timeout)
	if got := runs.Load(); got != 1 {
		t.Fatalf("unresponsive cleanup runs = %d, want one bounded in-flight run", got)
	}

	closed := make(chan struct{})
	go func() {
		worker.close()
		close(closed)
	}()
	waitForImageCleanupSignal(t, closed, "cleanup worker close with unresponsive run")
	close(release)
	waitForImageCleanupSignal(t, finished, "unresponsive cleanup exit")
	if got := runs.Load(); got != 1 {
		t.Fatalf("cleanup runs after close = %d, want 1", got)
	}
}

func TestImageConversationAssetCleanupWorkerCloseCancelsWithoutWaitingForRun(t *testing.T) {
	worker := imageConversationAssetCleanupWorker{timeout: time.Hour}
	started := make(chan struct{})
	ctxCanceled := make(chan struct{})
	release := make(chan struct{})
	runFinished := make(chan struct{})
	worker.schedule("owner", func(ctx context.Context, _ string) {
		defer close(runFinished)
		close(started)
		<-ctx.Done()
		close(ctxCanceled)
		<-release
	})
	waitForImageCleanupSignal(t, started, "conversation asset cleanup")

	closed := make(chan struct{})
	go func() {
		worker.close()
		close(closed)
	}()
	waitForImageCleanupSignal(t, ctxCanceled, "conversation asset cleanup cancellation")
	waitForImageCleanupSignal(t, closed, "conversation asset cleanup worker close")
	close(release)
	waitForImageCleanupSignal(t, runFinished, "canceled conversation asset cleanup exit")
}

func waitForImageCleanupSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func waitForImageCleanupWorkerClosed(t *testing.T, worker *imageCleanupWorker) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		worker.mu.Lock()
		closed := worker.closed
		worker.mu.Unlock()
		if closed {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for worker to enter closed state")
}
