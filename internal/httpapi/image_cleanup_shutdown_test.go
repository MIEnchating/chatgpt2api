package httpapi

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type imageCleanupShutdownCloser struct {
	once   sync.Once
	closed chan struct{}
}

func (c *imageCleanupShutdownCloser) Close() error {
	c.once.Do(func() { close(c.closed) })
	return nil
}

func TestImageCleanupWorkerCloseCancelsAndBoundsUnresponsiveRun(t *testing.T) {
	worker := imageCleanupWorker{closeWait: 20 * time.Millisecond}
	started := make(chan struct{})
	canceled := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	worker.scheduleContext(func(ctx context.Context) {
		defer close(finished)
		close(started)
		<-ctx.Done()
		close(canceled)
		<-release
	})
	waitForImageCleanupShutdownSignal(t, started, "cleanup start")

	closed := make(chan bool, 1)
	go func() {
		closed <- worker.close()
	}()
	waitForImageCleanupShutdownSignal(t, canceled, "cleanup cancellation")
	if drained := waitForImageCleanupShutdownValue(t, closed, "bounded worker close"); drained {
		t.Fatal("unresponsive cleanup reported a drained worker")
	}
	select {
	case <-finished:
		t.Fatal("unresponsive cleanup returned before it was released")
	default:
	}
	close(release)
	waitForImageCleanupShutdownSignal(t, finished, "cleanup exit")
}

func TestImageCleanupWorkerCloseWaitIsNotExecutionTimeout(t *testing.T) {
	worker := imageCleanupWorker{closeWait: 10 * time.Millisecond}
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	worker.scheduleContext(func(ctx context.Context) {
		defer close(finished)
		close(started)
		select {
		case <-ctx.Done():
			t.Error("scheduled cleanup was canceled before shutdown")
		case <-release:
		}
	})
	waitForImageCleanupShutdownSignal(t, started, "cleanup start")
	time.Sleep(4 * worker.closeWait)
	select {
	case <-finished:
		t.Fatal("scheduled cleanup was time-limited during normal operation")
	default:
	}
	close(release)
	waitForImageCleanupShutdownSignal(t, finished, "cleanup completion")
	worker.close()
}

func TestAppCloseBoundsUnresponsiveImageCleanup(t *testing.T) {
	backend := &imageCleanupShutdownCloser{closed: make(chan struct{})}
	app := &App{storageBackendCloser: backend}
	app.imageCleanup.closeWait = 20 * time.Millisecond
	started := make(chan struct{})
	canceled := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	var postCloseRuns atomic.Int32
	app.imageCleanup.scheduleContext(func(ctx context.Context) {
		defer close(finished)
		close(started)
		<-ctx.Done()
		close(canceled)
		<-release
	})
	waitForImageCleanupShutdownSignal(t, started, "app cleanup start")

	closed := make(chan struct{})
	go func() {
		app.Close()
		close(closed)
	}()
	waitForImageCleanupShutdownSignal(t, canceled, "app cleanup cancellation")
	waitForImageCleanupShutdownSignal(t, closed, "bounded app close")
	select {
	case <-backend.closed:
		t.Fatal("storage backend closed while cleanup was still active")
	default:
	}
	app.imageCleanup.schedule(func() { postCloseRuns.Add(1) })
	if got := postCloseRuns.Load(); got != 0 {
		t.Fatalf("cleanup runs scheduled after App.Close = %d, want 0", got)
	}
	close(release)
	waitForImageCleanupShutdownSignal(t, finished, "app cleanup exit")
	waitForImageCleanupShutdownSignal(t, backend.closed, "deferred storage backend close")
}

func waitForImageCleanupShutdownSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func waitForImageCleanupShutdownValue[T any](t *testing.T, values <-chan T, name string) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
		var zero T
		return zero
	}
}
