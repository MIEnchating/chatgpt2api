package service

import (
	"context"
	"testing"
)

func TestVideoDraftSourcePersistsAndChecksOwnership(t *testing.T) {
	handler := func(_ context.Context, _ Identity, p map[string]any) (map[string]any, error) {
		p[VideoTaskProgressCallbackPayloadKey].(func(VideoTaskProgressUpdate))(VideoTaskProgressUpdate{Status: TaskStatusRunning, UpstreamTaskID: "upstream-draft", Recovery: &VideoTaskRecovery{TaskID: "upstream-draft", BaseURL: "https://provider.example", URL: "https://provider.example/video", TokenName: "original-key", Model: "seedance-2.5"}})
		return map[string]any{"data": []map[string]any{{"url": "https://provider.example/video"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	owner := Identity{ID: "alice"}
	if _, err := svc.SubmitVideo(context.Background(), owner, "sample", "scene", "seedance-2.5", "16:9", 5, "480p", true, false, "first-frame", nil, nil, nil, map[string]any{"draft": true, "video_draft_origin": map[string]any{"base_url": "https://provider.example", "token_name": "original-key"}}); err != nil {
		t.Fatal(err)
	}
	waitForTaskStatus(t, svc, owner, "sample", TaskStatusSuccess)
	source, err := svc.VideoDraftSource(owner, "sample")
	if err != nil || source["draft_task_id"] != "upstream-draft" || source["token_name"] != "original-key" {
		t.Fatalf("draft source: %v %v", source, err)
	}
	reloaded := newImageTaskService(svc.store, nil, nil, nil, nil)
	t.Cleanup(func() { _ = reloaded.Close() })
	restored, err := reloaded.VideoDraftSource(owner, "sample")
	if err != nil || restored["draft_task_id"] != "upstream-draft" {
		t.Fatalf("sample source did not survive restart: %v %v", restored, err)
	}
	if _, err := svc.VideoDraftSource(Identity{ID: "bob"}, "sample"); err == nil {
		t.Fatal("cross-owner draft accepted")
	}
	svc.mu.Lock()
	task := svc.tasks[taskKey("alice", "sample")]
	task["draft"] = false
	svc.mu.Unlock()
	if _, err := svc.VideoDraftSource(owner, "sample"); err == nil {
		t.Fatal("ordinary video accepted as draft")
	}
}
