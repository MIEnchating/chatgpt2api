package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	err        error
	queryCalls int
}

type failingLogCleanupSummaryBackend struct {
	err         error
	deleteCalls int
}

func (b *failingLogQueryBackend) AppendLog(map[string]any) error { return nil }

func (b *failingLogQueryBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	b.queryCalls++
	return nil, b.err
}

func (b *failingLogQueryBackend) QueryLogPage(string, string, *storage.LogCursor, int) (storage.LogPage, error) {
	return storage.LogPage{}, b.err
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
	page, err := logs.SearchPage(query)
	if err != nil {
		t.Fatalf("SearchPage() error = %v", err)
	}
	return page.Items
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
	backend := &countingLogPageBackend{page: storage.LogPage{SnapshotID: 3, Records: []storage.LogRecord{
		{Item: map[string]any{"time": "2026-08-30 10:00:00", "summary": "newest", "detail": map[string]any{}}, Cursor: storage.LogCursor{SnapshotID: 3, Day: "2026-08-30", ID: 3}},
		{Item: map[string]any{"time": "2026-08-30 09:00:00", "summary": "second", "detail": map[string]any{}}, Cursor: storage.LogCursor{SnapshotID: 3, Day: "2026-08-30", ID: 2}},
		{Item: map[string]any{"time": "2026-08-30 08:00:00", "summary": "third", "detail": map[string]any{}}, Cursor: storage.LogCursor{SnapshotID: 3, Day: "2026-08-30", ID: 1}},
	}}}
	service := &LogService{store: backend}
	page, err := service.SearchPage(LogQuery{Limit: 2})
	if err != nil || len(page.Items) != 2 || !page.HasMore || backend.pageCalls != 1 || backend.fullScanCalls != 0 {
		t.Fatalf("SearchPage() = (%#v, %v), page calls = %d, full scans = %d", page, err, backend.pageCalls, backend.fullScanCalls)
	}
}

func TestLogServiceSearchReturnsPageQueryErrorWithoutFullScanFallback(t *testing.T) {
	queryErr := errors.New("page query failed")
	backend := &countingLogPageBackend{pageErr: queryErr}
	logs := &LogService{store: backend}

	page, err := logs.SearchPage(LogQuery{Limit: 10})
	if !errors.Is(err, queryErr) || page.Items != nil {
		t.Fatalf("SearchPage() = (%#v, %v), want wrapped page query error", page, err)
	}
	if backend.pageCalls != 1 || backend.fullScanCalls != 0 {
		t.Fatalf("page calls = %d, full scans = %d, want 1 and 0", backend.pageCalls, backend.fullScanCalls)
	}
}

func TestLogServiceSearchPagePaginatesSparseMatchesWithoutLoss(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	for index := 0; index < 520; index++ {
		summary := fmt.Sprintf("noise-%03d", index)
		if index == 10 || index == 260 || index == 510 {
			summary = fmt.Sprintf("needle-%03d", index)
		}
		if err := logs.store.AppendLog(map[string]any{
			"time":    "2026-08-30 10:00:00",
			"summary": summary,
			"detail":  map[string]any{},
		}); err != nil {
			t.Fatalf("AppendLog(%d) error = %v", index, err)
		}
	}

	query := LogQuery{Summary: "needle", View: LogViewAll, Limit: 2}
	first, err := logs.SearchPage(query)
	if err != nil {
		t.Fatalf("SearchPage(first) error = %v", err)
	}
	if got := logSummaries(first.Items); !reflect.DeepEqual(got, []string{"needle-510", "needle-260"}) || !first.HasMore || first.SnapshotCursor == "" || first.NextCursor == "" {
		t.Fatalf("SearchPage(first) = %#v", first)
	}
	if err := logs.store.AppendLog(map[string]any{
		"time":    "2020-01-01 00:00:00",
		"summary": "needle-backfilled-later",
		"detail":  map[string]any{},
	}); err != nil {
		t.Fatalf("AppendLog(backfill) error = %v", err)
	}

	query.Summary = " NEEDLE "
	query.Cursor = first.NextCursor
	second, err := logs.SearchPage(query)
	if err != nil {
		t.Fatalf("SearchPage(second) error = %v", err)
	}
	if got := logSummaries(second.Items); !reflect.DeepEqual(got, []string{"needle-010"}) || second.HasMore || second.NextCursor != "" {
		t.Fatalf("SearchPage(second) = %#v", second)
	}
}

func TestLogServiceSearchPageRejectsInvalidAndMismatchedCursors(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	for index := 0; index < 2; index++ {
		if err := logs.store.AppendLog(map[string]any{
			"time":    "2026-08-30 10:00:00",
			"summary": "cursor test",
			"detail":  map[string]any{},
		}); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}
	first, err := logs.SearchPage(LogQuery{Summary: "cursor", View: LogViewAll, Limit: 1})
	if err != nil || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("SearchPage(first) = (%#v, %v)", first, err)
	}
	forgedPayload, err := json.Marshal(logOpaqueCursor{
		Version:    logCursorVersion,
		SnapshotID: 2,
		Day:        "2026-08-30",
		ID:         -1,
		QueryHash:  logQueryCursorHash(LogQuery{Summary: "cursor", View: LogViewAll}),
	})
	if err != nil {
		t.Fatalf("Marshal(forged cursor) error = %v", err)
	}
	forgedCursor := base64.RawURLEncoding.EncodeToString(forgedPayload)

	for name, query := range map[string]LogQuery{
		"malformed":       {Summary: "cursor", View: LogViewAll, Limit: 1, Cursor: "not-a-cursor"},
		"oversized":       {Summary: "cursor", View: LogViewAll, Limit: 1, Cursor: strings.Repeat("a", maxLogCursorLength+1)},
		"negative id":     {Summary: "cursor", View: LogViewAll, Limit: 1, Cursor: forgedCursor},
		"filter mismatch": {Summary: "different", View: LogViewAll, Limit: 1, Cursor: first.NextCursor},
		"view mismatch":   {Summary: "cursor", View: LogViewBusiness, Limit: 1, Cursor: first.NextCursor},
	} {
		t.Run(name, func(t *testing.T) {
			page, err := logs.SearchPage(query)
			if !errors.Is(err, ErrInvalidLogCursor) || page.Items != nil || page.SnapshotCursor != "" || page.NextCursor != "" || page.HasMore {
				t.Fatalf("SearchPage() = (%#v, %v), want invalid cursor", page, err)
			}
		})
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

	page, err := logs.SearchPage(LogQuery{Limit: 10})
	if !errors.Is(err, queryErr) || page.Items != nil {
		t.Fatalf("SearchPage() = (%#v, %v), want wrapped database error", page, err)
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

	usageByUser, err := logs.UserUsageStatsForUsers(1, []string{"alice-key"})
	if err != nil {
		t.Fatalf("UserUsageStatsForUsers() error = %v", err)
	}
	usage := usageByUser["alice-key"]
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
	for _, key := range []string{"session_json", "accessToken", "sessionToken"} {
		if item[key] != redactedLogValue {
			t.Fatalf("SanitizeLogValue()[%q] = %#v, want %q", key, item[key], redactedLogValue)
		}
	}
}

func TestSanitizeLogValueRedactsSensitiveFieldsRegardlessOfValueShape(t *testing.T) {
	sanitized := SanitizeLogValue(map[string]any{
		"password":      "short",
		"authorization": "Bearer credential-with-a-visible-prefix",
		"api_key":       []any{"first-key", "second-key"},
		"secret":        123456,
		"token":         nil,
		"nested": map[string]any{
			"refresh_token": true,
			"label":         "visible",
		},
		"b64_json": strings.Repeat("a", 40),
		"url":      "https://example.test/resource",
	})

	item, ok := sanitized.(map[string]any)
	if !ok {
		t.Fatalf("SanitizeLogValue() = %#v", sanitized)
	}
	for _, key := range []string{"password", "authorization", "api_key", "secret", "token"} {
		if item[key] != redactedLogValue {
			t.Fatalf("SanitizeLogValue()[%q] = %#v, want %q", key, item[key], redactedLogValue)
		}
	}
	nested, ok := item["nested"].(map[string]any)
	if !ok || nested["refresh_token"] != redactedLogValue || nested["label"] != "visible" {
		t.Fatalf("SanitizeLogValue()[nested] = %#v", item["nested"])
	}
	if item["b64_json"] != strings.Repeat("a", 24)+"..." {
		t.Fatalf("SanitizeLogValue()[b64_json] = %#v", item["b64_json"])
	}
	if item["url"] != "https://example.test/resource" {
		t.Fatalf("SanitizeLogValue()[url] = %#v", item["url"])
	}
}

func TestSanitizeLogValueRemovesURLCapabilities(t *testing.T) {
	sanitized := SanitizeLogValue(map[string]any{
		"url": "https://cdn.example.test/file.png?token=secret&expires=1#preview",
		"urls": []any{
			"/video-references/reference.mp4?signature=secret&expires=1",
			"data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	}).(map[string]any)
	if sanitized["url"] != "https://cdn.example.test/file.png" {
		t.Fatalf("sanitized url = %#v", sanitized["url"])
	}
	urls := sanitized["urls"].([]any)
	if urls[0] != "/video-references/reference.mp4" || urls[1] != "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAA..." {
		t.Fatalf("sanitized urls = %#v", urls)
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

	usage, err := logs.UserUsageStatsForUsers(1, []string{"alice-key"})
	if err != nil {
		t.Fatalf("UserUsageStatsForUsers() error = %v", err)
	}
	if usage["alice-key"] == nil {
		t.Fatalf("missing requested user usage: %#v", usage)
	}
	if usage["bob-key"] != nil {
		t.Fatalf("returned unrequested user usage: %#v", usage)
	}
}

func TestLogServiceUserUsageStatsForUsersReturnsQueryErrorWithoutCachingFailure(t *testing.T) {
	queryErr := errors.New("usage query failed")
	backend := &failingLogQueryBackend{err: queryErr}
	logs := &LogService{store: backend}

	for attempt := 1; attempt <= 2; attempt++ {
		stats, err := logs.UserUsageStatsForUsers(14, []string{"alice-key"})
		if !errors.Is(err, queryErr) || stats != nil {
			t.Fatalf("attempt %d UserUsageStatsForUsers() = (%#v, %v), want query error", attempt, stats, err)
		}
	}
	if backend.queryCalls != 2 {
		t.Fatalf("QueryLogs() calls = %d, want 2 so a transient failure is not cached", backend.queryCalls)
	}
}

func TestLogServiceUserUsageStatsForUsersRequiresStorage(t *testing.T) {
	stats, err := NewLogService().UserUsageStatsForUsers(14, []string{"alice-key"})
	if err == nil || stats != nil {
		t.Fatalf("UserUsageStatsForUsers() = (%#v, %v), want missing storage error", stats, err)
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
		page, err := logs.SearchPage(LogQuery{Limit: 10})
		if err == nil && len(page.Items) == 1 && page.Items[0]["summary"] == "新日志" {
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

func TestLogServiceRetentionCleanerClosesDoneAfterCancel(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	ctx, cancel := context.WithCancel(context.Background())
	done := logs.StartRetentionCleaner(ctx, func() LogRetentionSchedule {
		return LogRetentionSchedule{Enabled: false}
	}, time.Hour, nil)

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retention cleaner did not stop after context cancellation")
	}
}
