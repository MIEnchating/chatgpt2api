package service

import (
	"context"
	"fmt"
	"testing"

	"chatgpt2api/internal/util"
)

func TestVideoTaskContractPersistsAndIsVisibleOnlyToAdministrator(t *testing.T) {
	backend := newTestStorageBackend(t)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return nil, fmt.Errorf("upstream video failed")
	}
	svc := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	defer svc.Close()
	admin := Identity{ID: "creator", Role: AuthRoleAdmin}
	reference := map[string]any{"id": "video-contract", "name": "Video contract", "driver": "xai-videos", "revision": 3, "api_key": "must-not-be-exposed"}
	task, err := svc.SubmitVideo(context.Background(), admin, "contract-task", "animate", "video-model", "16:9", 5, "720p", false, false, "text", nil, nil, nil, map[string]any{"video_contract": reference})
	if err != nil {
		t.Fatal(err)
	}
	assertReference := func(task map[string]any) {
		t.Helper()
		got := util.StringMap(task["video_contract"])
		if got["id"] != "video-contract" || got["name"] != "Video contract" || got["driver"] != "xai-videos" || util.ToInt(got["revision"], 0) != 3 || len(got) != 4 {
			t.Fatalf("task contract = %#v", got)
		}
	}
	assertReference(task)
	waitForTaskStatus(t, svc, admin, "contract-task", TaskStatusError)
	reloaded := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	defer reloaded.Close()
	tasks := reloaded.ListTasks(admin, []string{"contract-task"})["items"].([]map[string]any)
	assertReference(tasks[0])
	user := admin
	user.Role = AuthRoleUser
	userTasks := reloaded.ListTasks(user, []string{"contract-task"})["items"].([]map[string]any)
	if _, exposed := userTasks[0]["video_contract"]; exposed {
		t.Fatal("contract metadata exposed to a non-admin")
	}
	if tasks := reloaded.ListTasks(Identity{ID: "other", Role: AuthRoleAdmin}, []string{"contract-task"})["items"].([]map[string]any); len(tasks) != 0 {
		t.Fatal("contract metadata crossed the task owner boundary")
	}
	// An idempotent resubmission must retain the original task's contract.
	reference["revision"] = 4
	task, err = svc.SubmitVideo(context.Background(), admin, "contract-task", "animate", "video-model", "16:9", 5, "720p", false, false, "text", nil, nil, nil, map[string]any{"video_contract": reference})
	if err != nil {
		t.Fatal(err)
	}
	assertReference(task)
}
