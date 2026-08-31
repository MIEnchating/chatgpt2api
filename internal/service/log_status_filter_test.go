package service

import (
	"reflect"
	"sort"
	"testing"
)

func TestLogServiceStatusFilterSeparatesOutcomeFromRawStatus(t *testing.T) {
	logs := NewLogService(newTestStorageBackend(t))
	for _, entry := range []struct {
		summary string
		detail  map[string]any
	}{
		{summary: "业务成功", detail: map[string]any{"status": 201, "outcome": "success"}},
		{summary: "业务失败", detail: map[string]any{"status": 502, "outcome": "failed"}},
		{summary: "业务排队", detail: map[string]any{"status": "queued", "outcome": "success"}},
		{summary: "GET /api/status-test", detail: map[string]any{"method": "GET", "path": "/api/status-test", "status": 403}},
	} {
		if err := logs.Add(entry.summary, entry.detail); err != nil {
			t.Fatalf("Add(%q) error = %v", entry.summary, err)
		}
	}

	tests := []struct {
		name   string
		query  LogQuery
		wanted []string
	}{
		{name: "success uses business outcome", query: LogQuery{Status: "success", View: LogViewBusiness}, wanted: []string{"业务成功", "业务排队"}},
		{name: "failed uses business outcome", query: LogQuery{Status: "failed", View: LogViewBusiness}, wanted: []string{"业务失败"}},
		{name: "numeric status stays raw", query: LogQuery{Status: "403", View: LogViewAll}, wanted: []string{"GET /api/status-test"}},
		{name: "other status stays raw", query: LogQuery{Status: "queued", View: LogViewAll}, wanted: []string{"业务排队"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			items := mustSearchLogs(t, logs, test.query)
			got := logSummaries(items)
			sort.Strings(got)
			sort.Strings(test.wanted)
			if !reflect.DeepEqual(got, test.wanted) {
				t.Fatalf("Search(%#v) summaries = %#v, want %#v", test.query, got, test.wanted)
			}
		})
	}
}
