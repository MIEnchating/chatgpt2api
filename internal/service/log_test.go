package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type countingLogPageBackend struct {
	pageCalls     int
	fullScanCalls int
	summaryCalls  int
	page          storage.LogPage
	pageErr       error
	summaryErr    error
}

type failingLogQueryBackend struct {
	err error
}

type failingLogCleanupSummaryBackend struct {
	err         error
	deleteCalls int
}

func (b *failingLogQueryBackend) AppendLog(map[string]any) error { return nil }

func (b *failingLogQueryBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	return nil, b.err
}

func (b *failingLogCleanupSummaryBackend) AppendLog(map[string]any) error { return nil }

func (b *failingLogCleanupSummaryBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	return nil, b.err
}

func (b *failingLogCleanupSummaryBackend) LogSummary() (int, string, string, error) {
	return 0, "", "", b.err
}

func (b *failingLogCleanupSummaryBackend) DeleteLogsBefore(string) (int, error) {
	b.deleteCalls++
	return 1, nil
}

func (b *countingLogPageBackend) AppendLog(map[string]any) error { return nil }

func (b *countingLogPageBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	b.fullScanCalls++
	return nil, nil
}

func (b *countingLogPageBackend) QueryLogPage(string, string, *storage.LogCursor, int) (storage.LogPage, error) {
	b.pageCalls++
	return b.page, b.pageErr
}

func (b *countingLogPageBackend) LogSummary() (int, string, string, error) {
	b.summaryCalls++
	return 0, "", "", b.summaryErr
}

func mustSearchLogs(t *testing.T, logs *LogService, query LogQuery) []map[string]any {
	t.Helper()
	items, err := logs.Search(query)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	return items
}

func TestLogServiceStoresLogsInDatabase(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))

	if err := logs.Add("新增账号", map[string]any{"module": "accounts", "operation_type": "新增", "added": 1}); err != nil {
		t.Fatalf("Add() error = %v", err)
	}

	items := mustSearchLogs(t, logs, LogQuery{Limit: 10})
	if len(items) != 1 {
		t.Fatalf("List() length = %d, want 1", len(items))
	}
	if items[0]["summary"] != "新增账号" {
		t.Fatalf("List()[0] = %#v", items[0])
	}
	if _, ok := items[0]["type"]; ok {
		t.Fatalf("List()[0] should not expose log type: %#v", items[0])
	}
}

func TestLogServiceSearchStopsAfterFirstMatchingPage(t *testing.T) {
	backend := &countingLogPageBackend{page: storage.LogPage{Items: []map[string]any{
		{"time": "2026-08-30 10:00:00", "summary": "newest", "detail": map[string]any{}},
		{"time": "2026-08-30 09:00:00", "summary": "second", "detail": map[string]any{}},
	}, NextCursor: &storage.LogCursor{Day: "2026-08-30", ID: 1}}}
	service := &LogService{store: backend}
	items := mustSearchLogs(t, service, LogQuery{Limit: 2})
	if len(items) != 2 || backend.pageCalls != 1 || backend.fullScanCalls != 0 {
		t.Fatalf("Search() = %#v, page calls = %d, full scans = %d", items, backend.pageCalls, backend.fullScanCalls)
	}
}

func TestLogServiceSearchReturnsPageQueryErrorWithoutFullScanFallback(t *testing.T) {
	queryErr := errors.New("page query failed")
	backend := &countingLogPageBackend{pageErr: queryErr}
	logs := &LogService{store: backend}

	items, err := logs.Search(LogQuery{Limit: 10})
	if !errors.Is(err, queryErr) || items != nil {
		t.Fatalf("Search() = (%#v, %v), want wrapped page query error", items, err)
	}
	if backend.pageCalls != 1 || backend.fullScanCalls != 0 {
		t.Fatalf("page calls = %d, full scans = %d, want 1 and 0", backend.pageCalls, backend.fullScanCalls)
	}
}

func TestLogServiceGovernanceSummaryReturnsDatabaseError(t *testing.T) {
	queryErr := errors.New("summary query failed")
	backend := &countingLogPageBackend{summaryErr: queryErr}
	logs := &LogService{store: backend}

	summary, err := logs.GovernanceSummary()
	if !errors.Is(err, queryErr) || summary != (LogGovernanceSummary{}) {
		t.Fatalf("GovernanceSummary() = (%#v, %v), want wrapped summary query error", summary, err)
	}
	if backend.summaryCalls != 1 || backend.fullScanCalls != 0 {
		t.Fatalf("summary calls = %d, full scans = %d, want 1 and 0", backend.summaryCalls, backend.fullScanCalls)
	}
}

func TestLogServiceBasicQueriesReturnDatabaseError(t *testing.T) {
	queryErr := errors.New("log query failed")
	logs := &LogService{store: &failingLogQueryBackend{err: queryErr}}

	items, err := logs.Search(LogQuery{Limit: 10})
	if !errors.Is(err, queryErr) || items != nil {
		t.Fatalf("Search() = (%#v, %v), want wrapped database error", items, err)
	}
	summary, err := logs.GovernanceSummary()
	if !errors.Is(err, queryErr) || summary != (LogGovernanceSummary{}) {
		t.Fatalf("GovernanceSummary() = (%#v, %v), want wrapped database error", summary, err)
	}
}

func TestLogServiceCleanupChecksSummaryBeforeDeleting(t *testing.T) {
	queryErr := errors.New("summary query failed")
	backend := &failingLogCleanupSummaryBackend{err: queryErr}
	logs := &LogService{store: backend}

	result, err := logs.CleanupOlderThan(1)
	if !errors.Is(err, queryErr) || result != (LogCleanupResult{}) {
		t.Fatalf("CleanupOlderThan() = (%#v, %v), want summary error", result, err)
	}
	if backend.deleteCalls != 0 {
		t.Fatalf("DeleteLogsBefore() calls = %d, want 0", backend.deleteCalls)
	}
}

func TestLogServiceSearchFiltersUnifiedLogs(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))

	if err := logs.Add("新增账号", map[string]any{"module": "accounts", "operation_type": "新增", "added": 1}); err != nil {
		t.Fatalf("Add(account event) error = %v", err)
	}
	if err := logs.Add("文生图调用完成", map[string]any{
		"key_name":    "alice",
		"key_id":      "alice-key",
		"method":      "POST",
		"path":        "/v1/images/generations",
		"module":      "images",
		"endpoint":    "/v1/images/generations",
		"duration_ms": 120,
		"status":      200,
		"outcome":     "success",
		"log_level":   "info",
	}); err != nil {
		t.Fatalf("Add(call event) error = %v", err)
	}
	if err := logs.Add("GET /api/settings", map[string]any{
		"username":       "admin",
		"module":         "settings",
		"method":         "GET",
		"path":           "/api/settings",
		"status":         403,
		"ip_address":     "127.0.0.1",
		"operation_type": "查询",
		"log_level":      "warning",
	}); err != nil {
		t.Fatalf("Add(audit event) error = %v", err)
	}
	if err := logs.Add("GET /api/profile", map[string]any{
		"username":       "admin",
		"module":         "profile",
		"method":         "GET",
		"path":           "/api/profile",
		"status":         200,
		"operation_type": "查询",
		"log_level":      "info",
	}); err != nil {
		t.Fatalf("Add(noisy get audit event) error = %v", err)
	}
	if err := logs.Add("POST /api/settings", map[string]any{
		"username":       "admin",
		"module":         "settings",
		"method":         "POST",
		"path":           "/api/settings",
		"status":         200,
		"operation_type": "提交",
		"log_level":      "info",
	}); err != nil {
		t.Fatalf("Add(write audit event) error = %v", err)
	}

	all := mustSearchLogs(t, logs, LogQuery{Limit: 10})
	if len(all) != 5 {
		t.Fatalf("Search(all) length = %d, want 5: %#v", len(all), all)
	}
	for _, item := range all {
		if _, ok := item["type"]; ok {
			t.Fatalf("Search(all) should not expose log type: %#v", all)
		}
	}

	filtered := mustSearchLogs(t, logs, LogQuery{
		Username:      "admin",
		Module:        "settings",
		Method:        "GET",
		Summary:       "/api/settings",
		Status:        "403",
		IPAddress:     "127.0.0.1",
		OperationType: "查询",
		LogLevel:      "warning",
		Limit:         10,
	})
	if len(filtered) != 1 || filtered[0]["summary"] != "GET /api/settings" {
		t.Fatalf("Search(filtered) = %#v", filtered)
	}

	callLogs := mustSearchLogs(t, logs, LogQuery{Username: "alice", Module: "images", Method: "POST", Status: "200", LogLevel: "info", Limit: 10})
	if len(callLogs) != 1 || callLogs[0]["summary"] != "文生图调用完成" {
		t.Fatalf("Search(call) = %#v", callLogs)
	}
	if _, ok := callLogs[0]["type"]; ok {
		t.Fatalf("Search(call) should not expose log type: %#v", callLogs)
	}

	meaningful := mustSearchLogs(t, logs, LogQuery{View: LogViewMeaningful, Limit: 10})
	if summaries := logSummaries(meaningful); !reflect.DeepEqual(summaries, []string{"POST /api/settings", "GET /api/settings", "文生图调用完成", "新增账号"}) {
		t.Fatalf("Search(meaningful) summaries = %#v", summaries)
	}
	business := mustSearchLogs(t, logs, LogQuery{View: LogViewBusiness, Limit: 10})
	if summaries := logSummaries(business); !reflect.DeepEqual(summaries, []string{"文生图调用完成", "新增账号"}) {
		t.Fatalf("Search(business) summaries = %#v", summaries)
	}

	usage := logs.UserUsageStatsForUsers(1, []string{"alice-key"})["alice-key"]
	if usage == nil || usage["call_count"] != 1 || usage["success_count"] != 1 || usage["quota_used"] != 1 {
		t.Fatalf("UserUsageStats(new call log shape) = %#v", usage)
	}
}

func logSummaries(items []map[string]any) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, util.Clean(item["summary"]))
	}
	return out
}

func TestSanitizeLogValueMasksSessionCredentials(t *testing.T) {
	accessToken := "access-token-secret"
	sessionToken := "session-token-secret"
	sanitized := SanitizeLogValue(map[string]any{
		"session_json": `{"accessToken":"` + accessToken + `","sessionToken":"` + sessionToken + `"}`,
		"accessToken":  accessToken,
		"sessionToken": sessionToken,
	})

	item, ok := sanitized.(map[string]any)
	if !ok {
		t.Fatalf("SanitizeLogValue() = %#v", sanitized)
	}
	text := item["session_json"].(string) + item["accessToken"].(string) + item["sessionToken"].(string)
	if strings.Contains(text, accessToken) || strings.Contains(text, sessionToken) {
		t.Fatalf("sanitized log value leaked credentials: %#v", sanitized)
	}
}

func TestLogServiceUserUsageStatsForUsersFiltersResults(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))

	if err := logs.Add("Alice 调用", map[string]any{
		"key_id":   "alice-key",
		"endpoint": "/v1/images/generations",
		"status":   200,
	}); err != nil {
		t.Fatalf("Add(alice) error = %v", err)
	}
	if err := logs.Add("Bob 调用", map[string]any{
		"key_id":   "bob-key",
		"endpoint": "/v1/images/generations",
		"status":   200,
	}); err != nil {
		t.Fatalf("Add(bob) error = %v", err)
	}

	usage := logs.UserUsageStatsForUsers(1, []string{"alice-key"})
	if usage["alice-key"] == nil {
		t.Fatalf("missing requested user usage: %#v", usage)
	}
	if usage["bob-key"] != nil {
		t.Fatalf("returned unrequested user usage: %#v", usage)
	}
}

func TestLogServiceCleansOldLogs(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))

	for _, item := range []map[string]any{
		{"time": "2000-01-01 00:00:00", "type": "event", "summary": "旧调用", "detail": map[string]any{"status": "success"}},
		{"time": time.Now().Format("2006-01-02 15:04:05"), "type": "event", "summary": "新日志", "detail": map[string]any{"status": 200}},
	} {
		if err := logs.store.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	result, err := logs.CleanupOlderThan(1)
	if err != nil {
		t.Fatalf("CleanupOlderThan() error = %v", err)
	}
	if result.Deleted != 1 || result.Remaining != 1 {
		t.Fatalf("CleanupOlderThan() = %#v, want deleted 1 remaining 1", result)
	}
	items := mustSearchLogs(t, logs, LogQuery{Limit: 10})
	if len(items) != 1 || items[0]["summary"] != "新日志" {
		t.Fatalf("remaining logs = %#v", items)
	}
}

func TestLogServiceRetentionCleanerRunsAtConfiguredHour(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	for _, item := range []map[string]any{
		{"time": "2000-01-01 00:00:00", "type": "event", "summary": "旧调用", "detail": map[string]any{"status": "success"}},
		{"time": time.Now().Format("2006-01-02 15:04:05"), "type": "event", "summary": "新日志", "detail": map[string]any{"status": 200}},
	} {
		if err := logs.store.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logs.StartRetentionCleaner(ctx, func() LogRetentionSchedule {
		return LogRetentionSchedule{Enabled: true, RetentionDays: 1, Hour: time.Now().Hour()}
	}, time.Hour, nil)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		items, err := logs.Search(LogQuery{Limit: 10})
		if err == nil && len(items) == 1 && items[0]["summary"] == "新日志" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	items := mustSearchLogs(t, logs, LogQuery{Limit: 10})
	t.Fatalf("retention cleaner did not remove old logs, remaining = %#v", items)
}

func TestLogServiceRetentionCleanerHonorsDisabledSchedule(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	if err := logs.store.AppendLog(map[string]any{
		"time": "2000-01-01 00:00:00", "type": "event", "summary": "旧调用", "detail": map[string]any{"status": "success"},
	}); err != nil {
		t.Fatalf("AppendLog() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logs.StartRetentionCleaner(ctx, func() LogRetentionSchedule {
		return LogRetentionSchedule{Enabled: false, RetentionDays: 1, Hour: time.Now().Hour()}
	}, 10*time.Millisecond, nil)
	time.Sleep(30 * time.Millisecond)

	if items := mustSearchLogs(t, logs, LogQuery{Limit: 10}); len(items) != 1 {
		t.Fatalf("disabled retention cleaner removed logs, remaining = %#v", items)
	}
}
