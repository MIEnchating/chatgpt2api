package service

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type usagePageTestBackend struct {
	storage.LogBackend
	pageCalls atomic.Int32
	fullCalls atomic.Int32
	queryPage func(*storage.LogCursor, int) (storage.LogPage, error)
}

func (b *usagePageTestBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	b.fullCalls.Add(1)
	return nil, errors.New("unbounded log query is forbidden")
}

func (b *usagePageTestBackend) QueryLogPage(_, _ string, cursor *storage.LogCursor, limit int) (storage.LogPage, error) {
	b.pageCalls.Add(1)
	return b.queryPage(cursor, limit)
}

func usageTestLog(userID string, status int) map[string]any {
	return map[string]any{
		"time": util.NowLocal(),
		"detail": map[string]any{
			"key_id": userID, "endpoint": "/v1/images/generations", "status": status,
		},
	}
}

func TestUserUsageStatsPaginatesWithoutUnboundedLogReads(t *testing.T) {
	backend := newTestStorageBackend(t)
	logStore := backend.(storage.LogBackend)
	for index := 0; index < 1003; index++ {
		status := 200
		if index%2 == 0 {
			status = 500
		}
		if err := logStore.AppendLog(usageTestLog("alice", status)); err != nil {
			t.Fatal(err)
		}
	}
	pager := backend.(storage.LogPageBackend)
	spy := &usagePageTestBackend{LogBackend: logStore}
	spy.queryPage = func(cursor *storage.LogCursor, limit int) (storage.LogPage, error) {
		if limit < 1 || limit > 1000 {
			return storage.LogPage{}, fmt.Errorf("unbounded page size %d", limit)
		}
		page, err := pager.QueryLogPage("", "", cursor, limit)
		if cursor == nil && err == nil {
			// New rows must not enter an aggregation that already has a snapshot.
			if err := logStore.AppendLog(usageTestLog("alice", 200)); err != nil {
				return storage.LogPage{}, err
			}
		}
		return page, err
	}
	logs := &LogService{store: spy}
	stats, err := logs.UserUsageStatsForUsers(1, []string{"alice"})
	if err != nil {
		t.Fatal(err)
	}
	if got := stats["alice"]; got["call_count"] != 1003 || got["success_count"] != 501 || got["failure_count"] != 502 {
		t.Fatalf("paginated usage = %#v", got)
	}
	if spy.fullCalls.Load() != 0 || spy.pageCalls.Load() != 2 {
		t.Fatalf("query counts: full=%d pages=%d", spy.fullCalls.Load(), spy.pageCalls.Load())
	}
}

func TestUserUsageStatsDoesNotCachePartialPageResults(t *testing.T) {
	queryErr := errors.New("second usage page unavailable")
	fail := true
	spy := &usagePageTestBackend{}
	spy.queryPage = func(cursor *storage.LogCursor, _ int) (storage.LogPage, error) {
		if cursor == nil {
			return storage.LogPage{
				Records:    []storage.LogRecord{{Item: usageTestLog("alice", 200)}},
				NextCursor: &storage.LogCursor{SnapshotID: 2, ID: 2, Day: time.Now().Format("2006-01-02")},
			}, nil
		}
		if fail {
			return storage.LogPage{}, queryErr
		}
		return storage.LogPage{Records: []storage.LogRecord{{Item: usageTestLog("alice", 500)}}}, nil
	}
	logs := &LogService{store: spy}
	stats, err := logs.UserUsageStatsForUsers(1, []string{"alice"})
	if !errors.Is(err, queryErr) || stats != nil {
		t.Fatalf("partial aggregate = (%#v, %v), want query error", stats, err)
	}
	fail = false
	stats, err = logs.UserUsageStatsForUsers(1, []string{"alice"})
	if err != nil || stats["alice"]["call_count"] != 2 || spy.pageCalls.Load() != 4 {
		t.Fatalf("retry aggregate = (%#v, %v), page calls=%d", stats, err, spy.pageCalls.Load())
	}
}

func TestUserUsageStatsSharesConcurrentCacheFillWithoutBlockingLogWrites(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	spy := &usagePageTestBackend{LogBackend: newTestStorageBackend(t).(storage.LogBackend)}
	var startedOnce sync.Once
	spy.queryPage = func(*storage.LogCursor, int) (storage.LogPage, error) {
		startedOnce.Do(func() { close(started) })
		<-release
		return storage.LogPage{Records: []storage.LogRecord{{Item: usageTestLog("alice", 200)}}}, nil
	}
	logs := &LogService{store: spy}
	const readers = 16
	results := make(chan error, readers)
	var callers sync.WaitGroup
	callers.Add(readers)
	for range readers {
		go func() {
			callers.Done()
			stats, err := logs.UserUsageStatsForUsers(1, []string{"alice"})
			if err == nil && stats["alice"]["call_count"] != 1 {
				err = fmt.Errorf("unexpected usage: %#v", stats)
			}
			results <- err
		}()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("usage aggregation did not start")
	}
	callers.Wait()
	writeDone := make(chan error, 1)
	go func() { writeDone <- logs.Add("concurrent audit", nil) }()
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("usage aggregation blocked a log write")
	}
	releaseOnce.Do(func() { close(release) })
	for range readers {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if calls := spy.pageCalls.Load(); calls != 1 {
		t.Fatalf("concurrent usage page queries = %d, want one cache fill", calls)
	}
}

func TestUserUsageStatsEvictsExpiredDateRanges(t *testing.T) {
	spy := &usagePageTestBackend{queryPage: func(*storage.LogCursor, int) (storage.LogPage, error) {
		return storage.LogPage{}, nil
	}}
	logs := &LogService{
		store: spy,
		usageStatsCache: map[string]cachedUserUsageStats{
			"old-date-range": {expiresAt: time.Now().Add(-time.Second)},
			"valid-range":    {expiresAt: time.Now().Add(time.Minute)},
		},
	}
	if _, err := logs.UserUsageStatsForUsers(1, []string{"alice"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := logs.usageStatsCache["old-date-range"]; ok {
		t.Fatal("expired date range was retained")
	}
	if _, ok := logs.usageStatsCache["valid-range"]; !ok {
		t.Fatal("unexpired date range was evicted")
	}
	if len(logs.usageStatsCache) != 2 {
		t.Fatalf("cache contains %d date ranges, want 2", len(logs.usageStatsCache))
	}
}
