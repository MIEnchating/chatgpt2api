package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestProfileImageConversationRowsPaginationDetailActiveAndGeneration(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token := createPasswordUserSession(t, app, "history-row-http", "Password123", "History Rows")

	request := func(method, path string, body any) *httptest.ResponseRecorder {
		text := ""
		if body != nil {
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal request body: %v", err)
			}
			text = string(data)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(text))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	updatedAt := "2026-07-19T12:00:00Z"
	items := []map[string]any{
		imageConversationHTTPTestItem("row-http-a", 1, updatedAt, "success", "success"),
		imageConversationHTTPTestItem("row-http-b", 1, updatedAt, "loading", "queued"),
		imageConversationHTTPTestItem("row-http-c", 1, updatedAt, "success", "success"),
	}
	summaryReferencePayload := "http-summary-must-not-leak-" + strings.Repeat("x", 32*1024)
	activeReferencePayload := "http-active-must-remain-full-" + strings.Repeat("y", 1024)
	items[1]["turns"].([]any)[0].(map[string]any)["referenceImages"] = []any{map[string]any{
		"name": "active.png", "type": "image/png", "dataUrl": activeReferencePayload,
	}}
	items[2]["turns"].([]any)[0].(map[string]any)["referenceImages"] = []any{map[string]any{
		"name": "large.png", "type": "image/png", "dataUrl": summaryReferencePayload,
	}}
	res := request(http.MethodPost, "/api/profile/image-conversations?response=minimal", map[string]any{"items": items})
	if res.Code != http.StatusOK {
		t.Fatalf("initial merge status=%d body=%s", res.Code, res.Body.String())
	}
	initial := decodeImageConversationHTTPPayload(t, res)
	generation := int64(initial["generation"].(float64))

	res = request(http.MethodGet, "/api/profile/image-conversations?limit=2", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("first page status=%d body=%s", res.Code, res.Body.String())
	}
	firstBody := res.Body.String()
	first := decodeImageConversationHTTPPayload(t, res)
	firstItems := first["items"].([]any)
	nextCursor, _ := first["next_cursor"].(string)
	if len(firstItems) != 2 || first["has_more"] != true || nextCursor == "" || int64(first["generation"].(float64)) != generation {
		t.Fatalf("first page=%#v", first)
	}
	res = request(http.MethodGet, "/api/profile/image-conversations?limit=2&cursor="+nextCursor, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("second page status=%d body=%s", res.Code, res.Body.String())
	}
	secondBody := res.Body.String()
	second := decodeImageConversationHTTPPayload(t, res)
	secondItems := second["items"].([]any)
	if len(secondItems) != 1 || second["has_more"] != false {
		t.Fatalf("second page=%#v", second)
	}
	if strings.Contains(firstBody+secondBody, "dataUrl") || strings.Contains(firstBody+secondBody, summaryReferencePayload) || strings.Contains(firstBody+secondBody, activeReferencePayload) {
		t.Fatalf("paginated summary leaked reference image data")
	}
	for _, raw := range append(firstItems, second["items"].([]any)...) {
		item := raw.(map[string]any)
		if _, exists := item["turns"]; exists || item["historySummaryOnly"] != true {
			t.Fatalf("paginated item is not a summary: %#v", item)
		}
		summary := item["historySummary"].(map[string]any)
		if summary["turnCount"] != float64(1) {
			t.Fatalf("paginated history summary=%#v", summary)
		}
	}

	res = request(http.MethodGet, "/api/profile/image-conversations/active?limit=10", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("active status=%d body=%s", res.Code, res.Body.String())
	}
	active := decodeImageConversationHTTPPayload(t, res)
	activeItems := active["items"].([]any)
	if len(activeItems) != 1 || activeItems[0].(map[string]any)["id"] != "row-http-b" {
		t.Fatalf("active response=%#v", active)
	}
	if !strings.Contains(res.Body.String(), activeReferencePayload) || len(activeItems[0].(map[string]any)["turns"].([]any)) != 1 {
		t.Fatalf("active response was not full: body bytes=%d", res.Body.Len())
	}

	res = request(http.MethodGet, "/api/profile/image-conversations/row-http-c", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", res.Code, res.Body.String())
	}
	detail := decodeImageConversationHTTPPayload(t, res)
	if detail["item"].(map[string]any)["id"] != "row-http-c" || int64(detail["generation"].(float64)) != generation {
		t.Fatalf("detail response=%#v", detail)
	}
	if !strings.Contains(res.Body.String(), summaryReferencePayload) || len(detail["item"].(map[string]any)["turns"].([]any)) != 1 {
		t.Fatalf("detail response was not full: body bytes=%d", res.Body.Len())
	}

	// Move the item behind the first-page cursor to the top. The old cursor
	// must be rejected instead of silently skipping the reordered row.
	reorderedID := secondItems[0].(map[string]any)["id"].(string)
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", map[string]any{
		"generation": generation,
		"item":       imageConversationHTTPTestItem(reorderedID, 2, "2026-07-19T13:00:00Z", "success", "success"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("reorder save status=%d body=%s", res.Code, res.Body.String())
	}
	reorderedResponse := decodeImageConversationHTTPPayload(t, res)
	reorderedGeneration := int64(reorderedResponse["generation"].(float64))
	if reorderedGeneration <= generation {
		t.Fatalf("reorder generation=%d initial=%d", reorderedGeneration, generation)
	}
	res = request(http.MethodGet, "/api/profile/image-conversations?limit=2&cursor="+nextCursor, nil)
	if res.Code != http.StatusConflict {
		t.Fatalf("save-invalidated cursor status=%d body=%s", res.Code, res.Body.String())
	}
	saveInvalidated := decodeImageConversationHTTPPayload(t, res)
	if saveInvalidated["code"] != "history_reset" || int64(saveInvalidated["generation"].(float64)) != reorderedGeneration {
		t.Fatalf("save-invalidated cursor response=%#v", saveInvalidated)
	}
	generation = reorderedGeneration

	res = request(http.MethodDelete, "/api/profile/image-conversations/missing?response=minimal", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("delete missing status=%d body=%s", res.Code, res.Body.String())
	}
	deleted := decodeImageConversationHTTPPayload(t, res)
	if deleted["ok"] != true || deleted["removed"] != false {
		t.Fatalf("idempotent delete response=%#v", deleted)
	}
	deleteGeneration := int64(deleted["generation"].(float64))
	if deleteGeneration <= generation {
		t.Fatalf("delete generation=%d initial=%d", deleteGeneration, generation)
	}
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", map[string]any{
		"generation": generation,
		"item":       imageConversationHTTPTestItem("row-http-after-delete", 1, updatedAt, "success", "success"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("unrelated stale-generation save status=%d body=%s", res.Code, res.Body.String())
	}
	afterDelete := decodeImageConversationHTTPPayload(t, res)
	afterDeleteGeneration := int64(afterDelete["generation"].(float64))
	if afterDelete["accepted"] != true || afterDeleteGeneration <= deleteGeneration {
		t.Fatalf("unrelated stale-generation response=%#v", afterDelete)
	}
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", map[string]any{
		"generation": generation,
		"item":       imageConversationHTTPTestItem("missing", 1, updatedAt, "success", "success"),
	})
	if res.Code != http.StatusGone {
		t.Fatalf("deleted stale-generation save status=%d body=%s", res.Code, res.Body.String())
	}
	deletedWrite := decodeImageConversationHTTPPayload(t, res)
	if int64(deletedWrite["generation"].(float64)) != afterDeleteGeneration {
		t.Fatalf("deleted stale-generation response=%#v", deletedWrite)
	}

	res = request(http.MethodGet, "/api/profile/image-conversations?limit=2&cursor="+nextCursor, nil)
	if res.Code != http.StatusConflict {
		t.Fatalf("invalidated cursor status=%d body=%s", res.Code, res.Body.String())
	}
	invalidated := decodeImageConversationHTTPPayload(t, res)
	if invalidated["code"] != "history_reset" || int64(invalidated["generation"].(float64)) != afterDeleteGeneration {
		t.Fatalf("invalidated cursor response=%#v", invalidated)
	}

	res = request(http.MethodDelete, "/api/profile/image-conversations?response=minimal", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("minimal clear status=%d body=%s", res.Code, res.Body.String())
	}
	cleared := decodeImageConversationHTTPPayload(t, res)
	clearGeneration := int64(cleared["generation"].(float64))
	if cleared["ok"] != true || clearGeneration <= afterDeleteGeneration {
		t.Fatalf("minimal clear response=%#v", cleared)
	}
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", map[string]any{
		"generation": deleteGeneration,
		"item":       imageConversationHTTPTestItem("row-http-before-clear", 1, "2026-07-19T08:00:00Z", "success", "success"),
	})
	if res.Code != http.StatusGone {
		t.Fatalf("pre-clear stale-generation save status=%d body=%s", res.Code, res.Body.String())
	}
	preClear := decodeImageConversationHTTPPayload(t, res)
	if int64(preClear["generation"].(float64)) != clearGeneration {
		t.Fatalf("pre-clear stale-generation response=%#v", preClear)
	}
}

func TestProfileImageConversationRowsReturnsServiceUnavailableOnSaveFailure(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, token := createPasswordUserSession(t, app, "history-row-save-failure", "Password123", "History Failure")
	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	failing := &failingImageConversationRowSaveBackend{
		Backend:                  backend,
		JSONDocumentBackend:      backend.(storage.JSONDocumentBackend),
		ImageConversationBackend: backend.(storage.ImageConversationBackend),
	}
	app.history = service.NewImageConversationHistoryService(failing)
	body := map[string]any{"item": imageConversationHTTPTestItem("row-save-failure", 1, "2026-07-19T12:00:00Z", "success", "success")}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", strings.NewReader(string(data)))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable || strings.Contains(res.Body.String(), "row database unavailable") {
		t.Fatalf("save failure status=%d body=%s", res.Code, res.Body.String())
	}
}

func imageConversationHTTPTestItem(id string, revision int64, updatedAt, imageStatus, taskStatus string) map[string]any {
	turnStatus := imageStatus
	if imageStatus == "loading" {
		turnStatus = "queued"
	}
	return map[string]any{
		"id": id, "revision": revision, "title": id, "createdAt": updatedAt, "updatedAt": updatedAt,
		"turns": []any{map[string]any{
			"id": "turn-" + id, "status": turnStatus,
			"images": []any{map[string]any{
				"id": "image-" + id, "taskId": "task-" + id, "status": imageStatus, "taskStatus": taskStatus,
			}},
		}},
	}
}

func decodeImageConversationHTTPPayload(t *testing.T, res *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	payload := map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response body %q: %v", res.Body.String(), err)
	}
	return payload
}

type failingImageConversationRowSaveBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	storage.ImageConversationBackend
}

func (b *failingImageConversationRowSaveBackend) SaveCAS(context.Context, string, int64, int64, storage.ImageConversationRecord) (storage.ImageConversationRecord, error) {
	return storage.ImageConversationRecord{}, errors.New("row database unavailable")
}

func (b *failingImageConversationRowSaveBackend) BatchSaveCAS(context.Context, string, int64, []storage.ImageConversationCASRequest) (storage.ImageConversationBatchCASResult, error) {
	return storage.ImageConversationBatchCASResult{}, errors.New("row database unavailable")
}

var _ storage.Backend = (*failingImageConversationRowSaveBackend)(nil)
var _ storage.ImageConversationBackend = (*failingImageConversationRowSaveBackend)(nil)
