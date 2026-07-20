package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestProfileImageConversationsSyncAndIsolateUsers(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, aliceToken := createPasswordUserSession(t, app, "history-alice", "Password123", "Alice")
	_, bobToken := createPasswordUserSession(t, app, "history-bob", "Password123", "Bob")

	postBody := `{"items":[{"id":"conversation-1","title":"Alice image","createdAt":"2026-07-15T10:00:00Z","updatedAt":"2026-07-15T10:00:00Z","turns":[{"id":"turn-1","prompt":"draw a cat"}]}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations", strings.NewReader(postBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil || created["accepted"] != true {
		t.Fatalf("create response = %#v error = %v", created, err)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("bob list status = %d body = %s", res.Code, res.Body.String())
	}
	assertImageConversationHistoryCount(t, res, 0, "")

	olderBody := strings.Replace(postBody, "Alice image", "stale title", 1)
	olderBody = strings.Replace(olderBody, "2026-07-15T10:00:00Z\",\"turns", "2026-07-15T09:00:00Z\",\"turns", 1)
	req = httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations", strings.NewReader(olderBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale merge status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations?limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	assertImageConversationHistoryCount(t, res, 1, "Alice image")

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/image-conversations/conversation-1", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("bob delete status = %d body = %s", res.Code, res.Body.String())
	}
	var bobDelete map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &bobDelete); err != nil || bobDelete["removed"] != false {
		t.Fatalf("bob delete response = %#v error = %v", bobDelete, err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/image-conversations/conversation-1", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("alice delete status = %d body = %s", res.Code, res.Body.String())
	}
	var aliceDelete map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &aliceDelete); err != nil || aliceDelete["removed"] != true {
		t.Fatalf("alice delete response = %#v error = %v", aliceDelete, err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations?limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	assertImageConversationHistoryCount(t, res, 0, "")
}

func TestProfileImageConversationsMinimalResponse(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-minimal", "Password123", "Minimal")
	body := `{"items":[{"id":"conversation-minimal","title":"Minimal","updatedAt":"2026-07-15T10:00:00Z","turns":[]}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("minimal response status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode minimal response: %v", err)
	}
	if payload["ok"] != true || payload["accepted"] != true || payload["id"] != "conversation-minimal" || payload["revision"] != float64(0) {
		t.Fatalf("minimal response = %#v", payload)
	}
	if _, exists := payload["items"]; exists {
		t.Fatalf("minimal response unexpectedly contains full items: %#v", payload)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("minimal follow-up GET status = %d body = %s", res.Code, res.Body.String())
	}
	assertImageConversationHistoryCount(t, res, 1, "Minimal")
}

func TestProfileImageConversationsBaseRoutesStayBoundedAndMinimal(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-bounded", "Password123", "Bounded")
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		var reader io.Reader
		if body != nil {
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			reader = strings.NewReader(string(data))
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	items := make([]map[string]any, 35)
	for index := range items {
		id := fmt.Sprintf("bounded-%02d", index)
		items[index] = imageConversationHTTPTestItem(id, 1, fmt.Sprintf("2026-07-15T10:%02d:00Z", index), "success", "success")
	}
	res := request(http.MethodPost, "/api/profile/image-conversations", map[string]any{"items": items})
	if res.Code != http.StatusOK {
		t.Fatalf("base POST status=%d body=%s", res.Code, res.Body.String())
	}
	post := decodeImageConversationHTTPPayload(t, res)
	if _, exists := post["items"]; exists || len(post["acknowledgements"].([]any)) != len(items) {
		t.Fatalf("base POST was not minimal: %#v", post)
	}

	res = request(http.MethodGet, "/api/profile/image-conversations", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("base GET status=%d body=%s", res.Code, res.Body.String())
	}
	page := decodeImageConversationHTTPPayload(t, res)
	if len(page["items"].([]any)) != 30 || page["has_more"] != true || page["next_cursor"] == "" {
		t.Fatalf("base GET was not bounded: %#v", page)
	}

	res = request(http.MethodDelete, "/api/profile/image-conversations/bounded-00", nil)
	deleted := decodeImageConversationHTTPPayload(t, res)
	if res.Code != http.StatusOK || deleted["removed"] != true {
		t.Fatalf("base item DELETE status=%d response=%#v", res.Code, deleted)
	}
	if _, exists := deleted["items"]; exists {
		t.Fatalf("base item DELETE echoed full history: %#v", deleted)
	}

	res = request(http.MethodDelete, "/api/profile/image-conversations", nil)
	cleared := decodeImageConversationHTTPPayload(t, res)
	if res.Code != http.StatusOK || cleared["ok"] != true {
		t.Fatalf("base DELETE status=%d response=%#v", res.Code, cleared)
	}
	if _, exists := cleared["items"]; exists {
		t.Fatalf("base DELETE echoed full history: %#v", cleared)
	}
}

func TestProfileImageConversationsMinimalRejectsStaleAndGoneSnapshots(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-ack", "Password123", "History ACK")
	request := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	current := `{"items":[{"id":"conversation-ack","revision":7,"title":"Current","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2026-07-15T10:00:00Z","turns":[]}]}`
	res := request(http.MethodPost, "/api/profile/image-conversations?response=minimal", current)
	if res.Code != http.StatusOK {
		t.Fatalf("initial minimal status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode initial minimal response: %v", err)
	}
	if payload["accepted"] != true || payload["id"] != "conversation-ack" || payload["revision"] != float64(7) {
		t.Fatalf("initial minimal response = %#v", payload)
	}

	staleRevision := `{"items":[{"id":"conversation-ack","revision":6,"title":"Stale","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2099-01-01T00:00:00Z","turns":[]}]}`
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", staleRevision)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale revision status = %d body = %s", res.Code, res.Body.String())
	}

	staleTimestamp := `{"items":[{"id":"conversation-ack","revision":7,"title":"Stale","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2026-07-15T09:30:00Z","turns":[]}]}`
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", staleTimestamp)
	if res.Code != http.StatusConflict {
		t.Fatalf("stale timestamp status = %d body = %s", res.Code, res.Body.String())
	}

	res = request(http.MethodDelete, "/api/profile/image-conversations/conversation-ack", "")
	if res.Code != http.StatusOK {
		t.Fatalf("delete status = %d body = %s", res.Code, res.Body.String())
	}
	deleted := `{"items":[{"id":"conversation-ack","revision":8,"title":"Deleted","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2099-01-01T00:00:00Z","turns":[]}]}`
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", deleted)
	if res.Code != http.StatusGone {
		t.Fatalf("deleted snapshot status = %d body = %s", res.Code, res.Body.String())
	}

	res = request(http.MethodDelete, "/api/profile/image-conversations", "")
	if res.Code != http.StatusOK {
		t.Fatalf("clear status = %d body = %s", res.Code, res.Body.String())
	}
	cleared := `{"items":[{"id":"conversation-before-clear","revision":1,"title":"Cleared","createdAt":"2020-01-01T00:00:00Z","updatedAt":"2099-01-01T00:00:00Z","turns":[]}]}`
	res = request(http.MethodPost, "/api/profile/image-conversations?response=minimal", cleared)
	if res.Code != http.StatusGone {
		t.Fatalf("cleared snapshot status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileImageConversationsBulkMinimalReportsPartialStaleWithoutFailingRequest(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-bulk-ack", "Password123", "Bulk ACK")
	request := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	current := `{"item":{"id":"conversation-current","revision":7,"title":"Current","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2026-07-15T10:00:00Z","turns":[]}}`
	if res := request(current); res.Code != http.StatusOK {
		t.Fatalf("initial minimal status = %d body = %s", res.Code, res.Body.String())
	}

	batch := `{"items":[` +
		`{"id":"conversation-current","revision":6,"title":"Stale","createdAt":"2026-07-15T09:00:00Z","updatedAt":"2099-01-01T00:00:00Z","turns":[]},` +
		`{"id":"conversation-new","revision":1,"title":"New","createdAt":"2026-07-15T11:00:00Z","updatedAt":"2026-07-15T11:00:00Z","turns":[]}` +
		`]}`
	res := request(batch)
	if res.Code != http.StatusOK {
		t.Fatalf("bulk minimal status = %d body = %s", res.Code, res.Body.String())
	}
	var payload struct {
		OK               bool `json:"ok"`
		Acknowledgements []struct {
			ID       string `json:"id"`
			Accepted bool   `json:"accepted"`
			Gone     bool   `json:"gone"`
			Revision int64  `json:"revision"`
		} `json:"acknowledgements"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode bulk minimal response: %v", err)
	}
	if !payload.OK || len(payload.Acknowledgements) != 2 {
		t.Fatalf("bulk minimal response = %#v", payload)
	}
	if stale := payload.Acknowledgements[0]; stale.ID != "conversation-current" || stale.Accepted || stale.Gone || stale.Revision != 7 {
		t.Fatalf("stale acknowledgement = %#v", stale)
	}
	if accepted := payload.Acknowledgements[1]; accepted.ID != "conversation-new" || !accepted.Accepted || accepted.Gone || accepted.Revision != 1 {
		t.Fatalf("accepted acknowledgement = %#v", accepted)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/profile/image-conversations", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("bulk follow-up GET status = %d body = %s", res.Code, res.Body.String())
	}
	var history struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &history); err != nil {
		t.Fatalf("decode bulk follow-up GET: %v", err)
	}
	if len(history.Items) != 2 {
		t.Fatalf("history items = %#v, want current and new conversations", history.Items)
	}
	titles := map[string]string{}
	for _, item := range history.Items {
		titles[item["id"].(string)] = item["title"].(string)
	}
	if titles["conversation-current"] != "Current" || titles["conversation-new"] != "New" {
		t.Fatalf("history titles = %#v", titles)
	}
}

func TestProfileImageConversationsRejectsOversizedBody(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-large", "Password123", "Large")
	body := io.MultiReader(
		strings.NewReader(`{"items":[{"id":"conversation-large","updatedAt":"2026-07-15T10:00:00Z","turns":[],"payload":"`),
		io.LimitReader(repeatingByteReader('x'), maxImageConversationHistoryBodyBytes+1),
		strings.NewReader(`"}]}`),
	)
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations", body)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileImageConversationsReturnsServiceUnavailableOnDatabaseFailure(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-database-failure", "Password123", "Database Failure")
	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not support JSON documents", backend)
	}
	app.history = service.NewImageConversationHistoryService(&historySaveFailureBackend{
		Backend:   backend,
		documents: documents,
	})

	body := `{"items":[{"id":"conversation-database-failure","revision":1,"createdAt":"2026-07-19T10:00:00Z","updatedAt":"2026-07-19T10:00:00Z","turns":[]}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("database failure status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileImageConversationsReturnsBadRequestForInvalidItem(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "history-invalid-item", "Password123", "Invalid Item")
	body := `{"items":[{"revision":1,"updatedAt":"2026-07-19T10:00:00Z","turns":[]}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/profile/image-conversations?response=minimal", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid item status = %d body = %s", res.Code, res.Body.String())
	}
}

type historySaveFailureBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
}

func (b *historySaveFailureBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *historySaveFailureBackend) SaveJSONDocument(string, any) error {
	return errors.New("database unavailable")
}

func (b *historySaveFailureBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

type repeatingByteReader byte

func (r repeatingByteReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = byte(r)
	}
	return len(buffer), nil
}

func assertImageConversationHistoryCount(t *testing.T, res *httptest.ResponseRecorder, want int, title string) {
	t.Helper()
	payload := map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode history response: %v", err)
	}
	items := logItems(payload)
	if len(items) != want {
		t.Fatalf("history items = %#v, want %d", items, want)
	}
	if want > 0 && items[0]["title"] != title {
		t.Fatalf("history title = %#v, want %q", items[0]["title"], title)
	}
}
