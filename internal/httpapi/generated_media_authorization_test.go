package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestGeneratedMediaFileAuthorization(t *testing.T) {
	testCases := []struct {
		name       string
		resultURL  string
		fileBody   []byte
		mediaDir   func(*App) string
		submitTask func(*App, service.Identity, string, string) error
	}{
		{
			name:      "video",
			resultURL: "/videos/private.mp4",
			fileBody:  []byte("private video content"),
			mediaDir:  func(app *App) string { return app.videoDir },
			submitTask: func(app *App, identity service.Identity, taskID, resultURL string) error {
				app.tasks.SetVideoHandler(func(context.Context, service.Identity, map[string]any) (map[string]any, error) {
					return map[string]any{"data": []map[string]any{{"url": resultURL}}}, nil
				})
				_, err := app.tasks.SubmitVideo(context.Background(), identity, taskID, "animate", "video-model", "16:9", 5, "720p", false, false, "text", nil, nil, nil, nil)
				return err
			},
		},
		{
			name:      "audio",
			resultURL: "/audios/private.mp3",
			fileBody:  []byte("private audio content"),
			mediaDir:  func(app *App) string { return app.audioDir },
			submitTask: func(app *App, identity service.Identity, taskID, resultURL string) error {
				app.tasks.SetAudioHandler(func(context.Context, service.Identity, map[string]any) (map[string]any, error) {
					return map[string]any{"data": []map[string]any{{"url": resultURL}}}, nil
				})
				_, err := app.tasks.SubmitAudio(context.Background(), identity, taskID, map[string]any{"input": "read this", "model": "audio-model"}, nil)
				return err
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()

			owner, ownerToken := createPasswordUserSession(t, app, testCase.name+"-owner", "Password123!", "Media Owner")
			_, otherToken := createPasswordUserSession(t, app, testCase.name+"-other", "Password123!", "Other User")
			adminToken := adminSessionToken(t, app)

			filePath := filepath.Join(testCase.mediaDir(app), filepath.Base(testCase.resultURL))
			if err := os.WriteFile(filePath, testCase.fileBody, 0o600); err != nil {
				t.Fatalf("write generated %s file: %v", testCase.name, err)
			}
			taskID := testCase.name + "-private-media"
			if err := testCase.submitTask(app, *owner, taskID, testCase.resultURL); err != nil {
				t.Fatalf("submit %s task: %v", testCase.name, err)
			}
			waitForHTTPMediaTaskSuccess(t, app, *owner, taskID)

			for _, accessCase := range []struct {
				name       string
				token      string
				wantStatus int
				wantBody   bool
			}{
				{name: "owner", token: ownerToken, wantStatus: http.StatusOK, wantBody: true},
				{name: "other user", token: otherToken, wantStatus: http.StatusNotFound},
				{name: "admin", token: adminToken, wantStatus: http.StatusOK, wantBody: true},
			} {
				t.Run(accessCase.name, func(t *testing.T) {
					request := httptest.NewRequest(http.MethodGet, testCase.resultURL, nil)
					setRequestAuthCookie(request, accessCase.token)
					response := httptest.NewRecorder()
					app.Handler().ServeHTTP(response, request)

					if response.Code != accessCase.wantStatus {
						t.Fatalf("GET %s status = %d body = %q, want %d", testCase.resultURL, response.Code, response.Body.String(), accessCase.wantStatus)
					}
					if accessCase.wantBody && response.Body.String() != string(testCase.fileBody) {
						t.Fatalf("GET %s body = %q, want %q", testCase.resultURL, response.Body.String(), testCase.fileBody)
					}
				})
			}
		})
	}
}

func waitForHTTPMediaTaskSuccess(t *testing.T, app *App, identity service.Identity, taskID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var lastResult map[string]any
	var lastErr error
	for time.Now().Before(deadline) {
		lastResult, lastErr = app.tasks.ListTasksWithError(identity, []string{taskID})
		if lastErr == nil {
			items := util.AsMapSlice(lastResult["items"])
			if len(items) == 1 && util.Clean(items[0]["status"]) == service.TaskStatusSuccess {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %q did not reach status %q: result=%#v err=%v", taskID, service.TaskStatusSuccess, lastResult, lastErr)
}
