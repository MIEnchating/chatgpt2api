package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	assertImageConversationHistoryCount(t, res, 1, "Alice image")

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
	if res.Code != http.StatusOK {
		t.Fatalf("stale merge status = %d body = %s", res.Code, res.Body.String())
	}
	assertImageConversationHistoryCount(t, res, 1, "Alice image")

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/image-conversations/conversation-1", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("bob delete status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/image-conversations/conversation-1", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("alice delete status = %d body = %s", res.Code, res.Body.String())
	}
	assertImageConversationHistoryCount(t, res, 0, "")
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
