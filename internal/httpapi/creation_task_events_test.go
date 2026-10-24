package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestCreationTaskEventsRequireAuthentication(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/creation-tasks/events", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status: %d", response.Code)
	}
}

func TestCreationTaskEventsFlushSnapshotAndUpdatesOverHTTP(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/creation-tasks/events", nil)
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
	if snapshot := read(); snapshot.Type != "snapshot" {
		t.Fatalf("snapshot: %#v", snapshot)
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/creation-tasks/events", nil)
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
