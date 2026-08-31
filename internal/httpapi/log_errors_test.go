package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

type failingLogReadBackend struct {
	storage.Backend
	logStore storage.LogBackend
	err      error
}

type postCleanupSummaryFailureBackend struct {
	storage.Backend
	logStore     storage.LogBackend
	err          error
	summaryCalls int
	deleteCalls  int
}

func (b *failingLogReadBackend) AppendLog(item map[string]any) error {
	return b.logStore.AppendLog(item)
}

func (b *failingLogReadBackend) QueryLogs(string, string, int) ([]map[string]any, error) {
	return nil, b.err
}

func (b *failingLogReadBackend) QueryLogPage(string, string, *storage.LogCursor, int) (storage.LogPage, error) {
	return storage.LogPage{}, b.err
}

func (b *failingLogReadBackend) LogSummary() (int, string, string, error) {
	return 0, "", "", b.err
}

func (b *postCleanupSummaryFailureBackend) AppendLog(item map[string]any) error {
	return b.logStore.AppendLog(item)
}

func (b *postCleanupSummaryFailureBackend) QueryLogs(startDate, endDate string, limit int) ([]map[string]any, error) {
	return b.logStore.QueryLogs(startDate, endDate, limit)
}

func (b *postCleanupSummaryFailureBackend) LogSummary() (int, string, string, error) {
	b.summaryCalls++
	if b.summaryCalls == 1 {
		return 2, "2026-01-01 00:00:00", "2026-08-31 00:00:00", nil
	}
	return 0, "", "", b.err
}

func (b *postCleanupSummaryFailureBackend) DeleteLogsBefore(string) (int, error) {
	b.deleteCalls++
	return 1, nil
}

func TestLogReadEndpointsReturnServiceUnavailableOnDatabaseFailure(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	logStore, ok := backend.(storage.LogBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement LogBackend", backend)
	}
	const privateError = "private database query failure"
	app.logs = service.NewLogService(&failingLogReadBackend{
		Backend:  backend,
		logStore: logStore,
		err:      errors.New(privateError),
	})

	for _, path := range []string{"/api/logs", "/api/logs/governance"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			setRequestAuthCookie(req, token)
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)

			if res.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body = %s", res.Code, http.StatusServiceUnavailable, res.Body.String())
			}
			if strings.Contains(res.Body.String(), privateError) {
				t.Fatalf("response leaked storage error: %s", res.Body.String())
			}
		})
	}
}

func TestLogCleanupReportsSuccessWhenPostCleanupSummaryFails(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	logStore, ok := backend.(storage.LogBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement LogBackend", backend)
	}
	const privateError = "post-cleanup summary failure"
	failingBackend := &postCleanupSummaryFailureBackend{
		Backend:  backend,
		logStore: logStore,
		err:      errors.New(privateError),
	}
	app.logs = service.NewLogService(failingBackend)

	req := httptest.NewRequest(http.MethodPost, "/api/logs/governance", strings.NewReader(`{"retention_days":1}`))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	if failingBackend.deleteCalls != 1 {
		t.Fatalf("DeleteLogsBefore() calls = %d, want 1", failingBackend.deleteCalls)
	}
	if strings.Contains(res.Body.String(), privateError) {
		t.Fatalf("response leaked storage error: %s", res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"deleted":1`) || !strings.Contains(res.Body.String(), `"remaining":1`) || !strings.Contains(res.Body.String(), `"total":1`) {
		t.Fatalf("cleanup response did not preserve successful deletion: %s", res.Body.String())
	}
}
