package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"testing"
)

func TestLogsEndpointFiltersBusinessOutcomeAndRawHTTPStatus(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, entry := range []struct {
		summary string
		detail  map[string]any
	}{
		{summary: "业务成功", detail: map[string]any{"status": 201, "outcome": "success"}},
		{summary: "业务失败", detail: map[string]any{"status": 502, "outcome": "failed"}},
		{summary: "业务排队", detail: map[string]any{"status": "queued", "outcome": "success"}},
		{summary: "GET /api/status-test", detail: map[string]any{"method": "GET", "path": "/api/status-test", "status": 403}},
	} {
		if err := app.logs.Add(entry.summary, entry.detail); err != nil {
			t.Fatalf("Add(%q) error = %v", entry.summary, err)
		}
	}

	tests := []struct {
		name   string
		query  string
		wanted []string
	}{
		{name: "success", query: "status=success&view=business", wanted: []string{"业务成功", "业务排队"}},
		{name: "failed", query: "status=failed&view=business", wanted: []string{"业务失败"}},
		{name: "numeric HTTP status", query: "status=403&view=all", wanted: []string{"GET /api/status-test"}},
		{name: "other raw status", query: "status=queued&view=all", wanted: []string{"业务排队"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/logs?"+test.query, nil)
			setRequestAuthCookie(req, adminSessionToken(t, app))
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusOK {
				t.Fatalf("GET /api/logs status = %d body = %s", res.Code, res.Body.String())
			}
			var payload struct {
				Items []map[string]any `json:"items"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode logs response: %v", err)
			}
			got := make([]string, 0, len(payload.Items))
			for _, item := range payload.Items {
				if summary, _ := item["summary"].(string); summary != "" {
					got = append(got, summary)
				}
			}
			sort.Strings(got)
			sort.Strings(test.wanted)
			if !reflect.DeepEqual(got, test.wanted) {
				t.Fatalf("GET /api/logs?%s summaries = %#v, want %#v", test.query, got, test.wanted)
			}
		})
	}
}
