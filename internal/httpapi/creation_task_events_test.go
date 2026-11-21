package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestCreationTaskEventsRequireAuthentication(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/creation-tasks/events", strings.NewReader(`{"task_ids":["sse-video"]}`)))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status: %d", response.Code)
	}
}

func TestCreationTaskEventsRejectInvalidScopesBeforeStreaming(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, body := range []string{`{}`, `{"owner_id":"other","task_ids":["task"]}`, `{"task_ids":[1]}`, `{"workflow_batch_ids":[" "]}`, `{"task_ids":["\u0000"]}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/events", strings.NewReader(body))
		setRequestAuthCookie(req, token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("scope %s returned HTTP %d", body, response.Code)
		}
	}
}

func TestCreationTaskEventsFlushSnapshotAndUpdatesOverHTTP(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var records []map[string]any
	for i := range 250 {
		records = append(records, map[string]any{
			"id": fmt.Sprintf("history-%d", i), "owner_id": "admin", "mode": "chat", "status": service.TaskStatusSuccess,
			"created_at": now, "updated_at": now, "data": []map[string]string{{"text_response": strings.Repeat("x", 4096)}},
		})
	}
	records = append(records, map[string]any{
		"id": "already-complete", "owner_id": "admin", "mode": "chat", "status": service.TaskStatusSuccess,
		"created_at": now, "updated_at": now, "data": []map[string]string{{"text_response": "ready"}},
	})
	backend := app.storageBackendCloser.(storage.JSONDocumentBackend)
	if err := backend.SaveJSONDocument("image_tasks.json", map[string]any{"tasks": records}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/creation-tasks/events", strings.NewReader(`{"task_ids":["already-complete","sse-video"]}`))
	if err != nil {
		t.Fatal(err)
	}
	setRequestAuthCookie(req, adminSessionToken(t, app))
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE headers: %d, %v", response.StatusCode, response.Header)
	}
	scanner := bufio.NewScanner(response.Body)
	read := func() service.CreationTaskEvent {
		t.Helper()
		for scanner.Scan() {
			if !strings.HasPrefix(scanner.Text(), "data: ") {
				continue
			}
			var event service.CreationTaskEvent
			if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &event); err != nil {
				t.Fatal(err)
			}
			return event
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return service.CreationTaskEvent{}
	}
	if snapshot := read(); snapshot.Type != "snapshot" || len(snapshot.Items) != 1 || !strings.Contains(string(snapshot.Items[0]), `"id":"already-complete"`) {
		t.Fatalf("snapshot: %#v", snapshot)
	} else {
		all, err := app.tasks.ListTasksWithError(service.Identity{ID: "admin"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		full, err := json.Marshal(map[string]any{"type": "snapshot", "items": all["items"], "deleted_ids": []string{}})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("first SSE frame: %d bytes scoped, %d bytes with all 251 tasks (including framing)", len(scanner.Bytes())+2, len(full)+8)
	}
	app.tasks.SetVideoHandler(func(context.Context, service.Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"output_type": "video", "data": []map[string]any{{"video_url": "https://example.test/video.mp4"}}}, nil
	})
	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin}
	if _, err := app.tasks.SubmitVideo(ctx, identity, "sse-video", "prompt", "model", "16:9", 5, "720p", false, false, "text", nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	for {
		event := read()
		for _, item := range event.Items {
			var task map[string]any
			if err := json.Unmarshal(item, &task); err != nil {
				t.Fatal(err)
			}
			if task["id"] == "sse-video" && task["status"] == service.TaskStatusSuccess {
				return
			}
		}
	}
}

func TestCreationTaskEventsEndAfterSessionRevocation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	token := adminSessionToken(t, app)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/creation-tasks/events", strings.NewReader(`{"task_ids":["sse-video"]}`))
	if err != nil {
		t.Fatal(err)
	}
	setRequestAuthCookie(req, token)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"snapshot"`) {
		t.Fatalf("missing initial snapshot: %s, %v", scanner.Text(), scanner.Err())
	}
	if _, err := app.auth.RevokeSessions(token); err != nil {
		t.Fatal(err)
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			t.Fatalf("revoked session remains connected: %s", line)
		}
		var event struct {
			Type   string `json:"type"`
			Status int    `json:"status"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "error" || event.Status != http.StatusUnauthorized {
			t.Fatalf("revoked session received event: %#v", event)
		}
		return
	}
	t.Fatalf("missing revocation event: %v", scanner.Err())
}
