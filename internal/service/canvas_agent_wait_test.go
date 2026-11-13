package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWaitCanvasAgentTaskPublishesRealProgressWithoutCompletingOrResubmitting(t *testing.T) {
	for _, testCase := range []struct {
		status   string
		progress int
	}{{TaskStatusQueued, 0}, {TaskStatusRunning, 37}} {
		t.Run(testCase.status, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			release := make(chan struct{})
			releaseTask := sync.OnceFunc(func() { close(release) })
			defer releaseTask()
			started := make(chan struct{})
			handler := func(ctx context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
				payload[VideoTaskProgressCallbackPayloadKey].(func(VideoTaskProgressUpdate))(VideoTaskProgressUpdate{Status: testCase.status, Progress: testCase.progress, HasProgress: true})
				close(started)
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-release:
				}
				return map[string]any{"data": []map[string]any{{"video_url": "/video.mp4"}}}, nil
			}
			svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
			svc.SetVideoHandler(handler)
			identity := Identity{ID: "alice", Role: AuthRoleUser}
			if _, err := svc.SubmitVideo(ctx, identity, "progress", "animate", "video-model", "9:16", 15, "768p", true, false, "text", nil, nil, nil, nil); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			observationFailed := errors.New("progress persistence failed")
			_, err := WaitCanvasAgentTask(ctx, svc, identity, "progress", nil, func(progress int) error {
				if progress != testCase.progress {
					t.Errorf("progress = %d, want actual %d", progress, testCase.progress)
				}
				return observationFailed
			})
			if !errors.Is(err, observationFailed) {
				t.Fatalf("observer error not returned: %v", err)
			}
			items := svc.ListTasks(identity, []string{"progress"})["items"].([]map[string]any)
			if len(items) != 1 || items[0]["status"] != testCase.status {
				t.Fatal("observer failure cancelled or replaced the paid task")
			}
			releaseTask()
			if _, err := WaitCanvasAgentTask(ctx, svc, identity, "progress", nil, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWaitCanvasAgentTaskReportsMissingTask(t *testing.T) {
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) { return nil, nil }
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := WaitCanvasAgentTask(ctx, svc, Identity{ID: "alice", Role: AuthRoleUser}, "absent", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "absent") {
		t.Fatalf("WaitCanvasAgentTask() error = %v, want missing task error", err)
	}
}
