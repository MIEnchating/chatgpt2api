package httpapi

import (
	"context"
	"sync"
)

const (
	imageConversationHistoryWriteParallelism = 2
	imageConversationHistoryLargeWriteBytes  = 32 << 20
)

// imageConversationHistoryWriteLimiter lets ordinary snapshots proceed in
// parallel while making memory-heavy or chunked requests exclusive. Waiting
// exclusive requests block new ordinary work so they cannot starve.
type imageConversationHistoryWriteLimiter struct {
	mu               sync.Mutex
	capacity         int
	used             int
	exclusiveWaiters int
	changed          chan struct{}
}

func newImageConversationHistoryWriteLimiter(capacity int) *imageConversationHistoryWriteLimiter {
	if capacity < 1 {
		capacity = 1
	}
	return &imageConversationHistoryWriteLimiter{
		capacity: capacity,
		changed:  make(chan struct{}),
	}
}

func imageConversationHistoryWriteWeight(contentLength int64) int {
	if contentLength < 0 || contentLength > imageConversationHistoryLargeWriteBytes {
		return imageConversationHistoryWriteParallelism
	}
	return 1
}

func (l *imageConversationHistoryWriteLimiter) acquire(ctx context.Context, weight int) (func(), bool) {
	if l == nil {
		return func() {}, true
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if weight < 1 {
		weight = 1
	}
	if weight > l.capacity {
		weight = l.capacity
	}
	exclusive := weight == l.capacity
	registeredExclusive := false

	for {
		if ctx.Err() != nil {
			l.cancelExclusiveWaiter(registeredExclusive)
			return nil, false
		}

		l.mu.Lock()
		if exclusive && !registeredExclusive {
			l.exclusiveWaiters++
			registeredExclusive = true
			l.signalLocked()
		}
		canAcquire := l.used+weight <= l.capacity && (exclusive || l.exclusiveWaiters == 0)
		if canAcquire {
			if registeredExclusive {
				l.exclusiveWaiters--
				registeredExclusive = false
			}
			l.used += weight
			l.signalLocked()
			l.mu.Unlock()

			var once sync.Once
			return func() {
				once.Do(func() { l.release(weight) })
			}, true
		}
		changed := l.changed
		l.mu.Unlock()

		select {
		case <-ctx.Done():
			l.cancelExclusiveWaiter(registeredExclusive)
			return nil, false
		case <-changed:
		}
	}
}

func (l *imageConversationHistoryWriteLimiter) cancelExclusiveWaiter(registered bool) {
	if l == nil || !registered {
		return
	}
	l.mu.Lock()
	if l.exclusiveWaiters > 0 {
		l.exclusiveWaiters--
		l.signalLocked()
	}
	l.mu.Unlock()
}

func (l *imageConversationHistoryWriteLimiter) release(weight int) {
	l.mu.Lock()
	l.used -= weight
	if l.used < 0 {
		l.used = 0
	}
	l.signalLocked()
	l.mu.Unlock()
}

func (l *imageConversationHistoryWriteLimiter) signalLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}
