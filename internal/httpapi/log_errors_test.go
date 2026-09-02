package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
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

func TestAdminUsersReportsUnavailableUsageStatsWithoutInventingZeroes(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	user, err := app.auth.CreatePasswordUser("usage_unavailable", "Password123", "Usage Unavailable", service.DefaultManagedRoleID, true)
	if err != nil {
		t.Fatalf("CreatePasswordUser() error = %v", err)
	}
	token := adminSessionToken(t, app)
	const privateError = "private usage database failure"
	installFailingUsageLogService(t, app, errors.New(privateError))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?sort_by=created_at", nil)
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("default sort status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("default sort json: %v", err)
	}
	if payload["usage_stats_available"] != false {
		t.Fatalf("usage_stats_available = %#v, want false", payload["usage_stats_available"])
	}
	item := findManagedUser(logItems(payload), util.Clean(user["id"]))
	if item == nil {
		t.Fatalf("missing user in degraded response: %#v", payload)
	}
	for _, field := range []string{"call_count", "success_count", "failure_count", "quota_used", "usage_curve"} {
		if _, exists := item[field]; exists {
			t.Fatalf("degraded response invented %s: %#v", field, item)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?sort_by=call_count", nil)
	setRequestAuthCookie(req, token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("usage sort status = %d, want %d; body = %s", res.Code, http.StatusServiceUnavailable, res.Body.String())
	}
	if strings.Contains(res.Body.String(), privateError) || !strings.Contains(res.Body.String(), "用户使用统计暂时不可用") {
		t.Fatalf("usage sort response did not sanitize error: %s", res.Body.String())
	}
}

func TestAdminUserMutationsRemainSuccessfulWhenUsageStatsFail(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.auth.CreatePasswordUser("usage_survivor", "Password123", "Usage Survivor", service.DefaultManagedRoleID, true); err != nil {
		t.Fatalf("CreatePasswordUser(survivor) error = %v", err)
	}
	token := adminSessionToken(t, app)
	installFailingUsageLogService(t, app, errors.New("usage stats unavailable"))

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users?sort_by=call_count", strings.NewReader(`{"username":"usage_mutation","password":"Password123","name":"Before","role_id":"default-user","enabled":true}`))
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", res.Code, res.Body.String())
	}
	created := decodeManagedUserMutationResponse(t, res)
	createdItem := util.StringMap(created["item"])
	userID := util.Clean(createdItem["id"])
	if userID == "" || created["usage_stats_available"] != false || created["sort_by"] != "created_at" {
		t.Fatalf("create fallback response = %#v", created)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/users/"+userID+"?sort_by=call_count", strings.NewReader(`{"name":"After"}`))
	setRequestAuthCookie(req, token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", res.Code, res.Body.String())
	}
	updated := decodeManagedUserMutationResponse(t, res)
	if updated["usage_stats_available"] != false || util.Clean(util.StringMap(updated["item"])["name"]) != "After" {
		t.Fatalf("update fallback response = %#v", updated)
	}
	persisted := findManagedUser(app.auth.ListUsers(), userID)
	if persisted == nil || util.Clean(persisted["name"]) != "After" {
		t.Fatalf("updated user was not persisted: %#v", persisted)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/admin/users/"+userID+"?sort_by=call_count", nil)
	setRequestAuthCookie(req, token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("delete status = %d body = %s", res.Code, res.Body.String())
	}
	deleted := decodeManagedUserMutationResponse(t, res)
	if deleted["usage_stats_available"] != false || findManagedUser(app.auth.ListUsers(), userID) != nil {
		t.Fatalf("delete fallback response/users = %#v / %#v", deleted, app.auth.ListUsers())
	}
}

func installFailingUsageLogService(t *testing.T, app *App, queryErr error) {
	t.Helper()
	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	logStore, ok := backend.(storage.LogBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement LogBackend", backend)
	}
	app.logs = service.NewLogService(&failingLogReadBackend{
		Backend:  backend,
		logStore: logStore,
		err:      queryErr,
	})
}

func decodeManagedUserMutationResponse(t *testing.T, res *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("mutation response json: %v; body = %s", err, res.Body.String())
	}
	return payload
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
