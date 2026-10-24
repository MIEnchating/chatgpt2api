package service

import (
	"context"
	"fmt"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func TestVideoTaskPersistsAdditionalParametersAndOptionalPrompt(t *testing.T) {
	backend := newTestStorageBackend(t)
	received := make(chan map[string]any, 1)
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		received <- payload
		return nil, fmt.Errorf("fixture upstream failure")
	}
	svc := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	defer svc.Close()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Capability.Prompt = &protocol.VideoPromptConstraint{Required: false, MinLength: 1, MaxLength: 20000}
	contract.Capability.Seconds = nil
	contract.Capability.SecondsRange = &protocol.VideoDurationRange{Min: 1, Step: 1}
	parameters := map[string]any{"seed": 0, "prompt_enhance": false, "prompt_expansion_mode": "quality"}
	identity := Identity{ID: "parameter-creator", Role: AuthRoleAdmin}
	_, err := svc.SubmitVideo(context.Background(), identity, "parameter-task", "", "video-model", "16:9", 5000, "720p", false, false, "text", nil, nil, nil, map[string]any{
		protocol.VideoContractSnapshotPayloadKey: contract, "parameters": parameters, VideoTaskInputConstraintsKey: VideoTaskInputConstraints{PromptRequired: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForTaskStatus(t, svc, identity, "parameter-task", TaskStatusError)
	payload := <-received
	got := util.StringMap(payload["parameters"])
	if len(got) != 3 || util.ToInt(got["seed"], 99) != 0 || got["prompt_enhance"] != false || got["prompt_expansion_mode"] != "quality" || util.ToInt(payload["seconds"], 0) != 5000 {
		t.Fatalf("task parameters lost: %#v", payload)
	}
}

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
