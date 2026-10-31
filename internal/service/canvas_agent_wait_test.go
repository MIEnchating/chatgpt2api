package service

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWaitCanvasAgentTaskReportsMissingTask(t *testing.T) {
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) { return nil, nil }
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := WaitCanvasAgentTask(ctx, svc, Identity{ID: "alice", Role: AuthRoleUser}, "absent", nil)
	if err == nil || !strings.Contains(err.Error(), "absent") {
		t.Fatalf("WaitCanvasAgentTask() error = %v, want missing task error", err)
	}
}
