package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	"chatgpt2api/internal/service"
)

type logPageHTTPResponse struct {
	Items          []map[string]any `json:"items"`
	Total          json.RawMessage  `json:"total"`
	PageSize       int              `json:"page_size"`
	View           string           `json:"view"`
	HasMore        bool             `json:"has_more"`
	SnapshotCursor string           `json:"snapshot_cursor"`
	NextCursor     string           `json:"next_cursor"`
}

func TestLogsEndpointUsesSnapshotCursorPagination(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for index, summary := range []string{"page-log-1", "page-log-2", "page-log-3", "page-log-4", "page-log-5"} {
		if err := app.logs.Add(summary, map[string]any{"module": "pagination", "sequence": index + 1}); err != nil {
			t.Fatalf("Add(%q) error = %v", summary, err)
		}
	}
	token := adminSessionToken(t, app)

	first := requestLogPage(t, app, token, "/api/logs?view=all&summary=page-log&page_size=2")
	if got := logPayloadSummaries(first.Items); !reflect.DeepEqual(got, []string{"page-log-5", "page-log-4"}) || !first.HasMore || first.SnapshotCursor == "" || first.NextCursor == "" {
		t.Fatalf("first page = %#v", first)
	}
	if string(first.Total) != "null" || first.PageSize != 2 || first.View != service.LogViewAll {
		t.Fatalf("first metadata = %#v", first)
	}
	if err := app.logs.Add("page-log-backfilled", map[string]any{"module": "pagination"}); err != nil {
		t.Fatalf("Add(backfilled) error = %v", err)
	}
	replayPath := "/api/logs?view=all&summary=page-log&page_size=2&cursor=" + url.QueryEscape(first.SnapshotCursor)
	replayed := requestLogPage(t, app, token, replayPath)
	if got := logPayloadSummaries(replayed.Items); !reflect.DeepEqual(got, []string{"page-log-5", "page-log-4"}) || replayed.SnapshotCursor != first.SnapshotCursor {
		t.Fatalf("replayed first page = %#v", replayed)
	}

	secondPath := "/api/logs?view=all&summary=page-log&page_size=2&cursor=" + url.QueryEscape(first.NextCursor)
	second := requestLogPage(t, app, token, secondPath)
	if got := logPayloadSummaries(second.Items); !reflect.DeepEqual(got, []string{"page-log-3", "page-log-2"}) || !second.HasMore || second.NextCursor == "" {
		t.Fatalf("second page = %#v", second)
	}
	thirdPath := "/api/logs?view=all&summary=page-log&page_size=2&cursor=" + url.QueryEscape(second.NextCursor)
	third := requestLogPage(t, app, token, thirdPath)
	if got := logPayloadSummaries(third.Items); !reflect.DeepEqual(got, []string{"page-log-1"}) || third.HasMore || third.NextCursor != "" {
		t.Fatalf("third page = %#v", third)
	}
}

func TestLogsEndpointRejectsInvalidAndMismatchedCursors(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, summary := range []string{"cursor-log-1", "cursor-log-2"} {
		if err := app.logs.Add(summary, map[string]any{"module": "pagination"}); err != nil {
			t.Fatalf("Add(%q) error = %v", summary, err)
		}
	}
	token := adminSessionToken(t, app)
	first := requestLogPage(t, app, token, "/api/logs?view=all&summary=cursor-log&page_size=1")
	if first.NextCursor == "" {
		t.Fatalf("first page has no cursor: %#v", first)
	}
	decodedCursor, err := base64.RawURLEncoding.DecodeString(first.NextCursor)
	if err != nil {
		t.Fatalf("DecodeString(cursor) error = %v", err)
	}
	var forgedPayload map[string]any
	if err := json.Unmarshal(decodedCursor, &forgedPayload); err != nil {
		t.Fatalf("Unmarshal(cursor) error = %v", err)
	}
	forgedPayload["i"] = -1
	decodedCursor, err = json.Marshal(forgedPayload)
	if err != nil {
		t.Fatalf("Marshal(forged cursor) error = %v", err)
	}
	forgedCursor := base64.RawURLEncoding.EncodeToString(decodedCursor)

	for name, path := range map[string]string{
		"malformed":   "/api/logs?view=all&page_size=1&cursor=not-a-cursor",
		"mismatch":    "/api/logs?view=all&summary=different&page_size=1&cursor=" + url.QueryEscape(first.NextCursor),
		"negative id": "/api/logs?view=all&summary=cursor-log&page_size=1&cursor=" + url.QueryEscape(forgedCursor),
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			setRequestAuthCookie(req, token)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusBadRequest || !json.Valid(res.Body.Bytes()) {
				t.Fatalf("status = %d body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func requestLogPage(t *testing.T, app *App, token, path string) logPageHTTPResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d body = %s", path, res.Code, res.Body.String())
	}
	var payload logPageHTTPResponse
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET %s: %v", path, err)
	}
	return payload
}
