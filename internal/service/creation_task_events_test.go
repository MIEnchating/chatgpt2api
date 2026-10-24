package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func TestCreationTaskSubscriptionStreamsOwnedTextCancellationAndDeletion(t *testing.T) {
	started := make(chan struct{}, 2)
	handler := func(ctx context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		payload[TextOutputCallbackPayloadKey].(func(string))("你好")
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	svc := newTestImageTaskService(t, nil, nil, handler, func() int { return 30 })
	defer svc.Close()
	owner := Identity{ID: "owner", Role: AuthRoleUser}
	other := Identity{ID: "other", Role: AuthRoleUser}
	sub, err := svc.SubscribeTasks(owner)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	initial, err := sub.Read()
	if err != nil || initial.Type != "snapshot" || len(initial.Items) != 0 {
		t.Fatalf("initial: %#v, %v", initial, err)
	}
	for _, identity := range []Identity{owner, other} {
		if _, err := svc.SubmitChat(context.Background(), identity, "same-id", "private prompt", "text-model", []map[string]any{{"role": "user", "content": "private prompt"}}); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("worker did not start")
		}
	}
	event, err := sub.Read()
	if err != nil || len(event.Items) != 1 || !strings.Contains(string(event.Items[0]), "你好") {
		t.Fatalf("partial text: %#v, %v", event, err)
	}
	if strings.Contains(string(event.Items[0]), "owner_id") || strings.Contains(string(event.Items[0]), "private prompt") {
		t.Fatal("private task fields leaked")
	}
	empty, _ := sub.Read()
	if len(empty.Items) != 0 {
		t.Fatal("unchanged task was emitted again")
	}
	for range 100 {
		svc.updateTextTaskPartialData(taskKey(ownerID(owner), "same-id"), "最新文本")
	}
	if len(sub.changed) != 1 {
		t.Fatal("updates were not coalesced")
	}
	partial, _ := sub.Read()
	if len(partial.Items) != 1 || !strings.Contains(string(partial.Items[0]), "最新文本") {
		t.Fatalf("coalesced text: %#v", partial)
	}
	if _, err := svc.CancelTask(owner, "same-id"); err != nil {
		t.Fatal(err)
	}
	terminal, _ := sub.Read()
	var task map[string]any
	if len(terminal.Items) != 1 {
		t.Fatalf("terminal event: %#v", terminal)
	}
	if err := json.Unmarshal(terminal.Items[0], &task); err != nil {
		t.Fatal(err)
	}
	if task["status"] != TaskStatusCancelled {
		t.Fatalf("terminal: %#v", task)
	}
	if svc.updateTextTaskPartialData(taskKey(ownerID(owner), "same-id"), "late text") {
		t.Fatal("late text changed a cancelled task")
	}
	if _, err := svc.DeleteTasks(owner, []string{"same-id"}); err != nil {
		t.Fatal(err)
	}
	deleted, _ := sub.Read()
	if len(deleted.DeletedIDs) != 1 || deleted.DeletedIDs[0] != "same-id" {
		t.Fatalf("deletion: %#v", deleted)
	}
	sub.Close()
	sub.Close()
	svc.mu.RLock()
	remaining := len(svc.taskSubscribers)
	svc.mu.RUnlock()
	if remaining != 0 {
		t.Fatal("subscription was not released")
	}
}

func TestCreationTaskSubscriptionObservesSharedStorageUpdatesAndServiceClose(t *testing.T) {
	backend := newTestStorageBackend(t)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "done"}}}, nil
	}
	worker := NewStoredImageTaskService(backend, nil, nil, handler, func() int { return 30 })
	defer worker.Close()
	observer := NewStoredImageTaskService(backend, nil, nil, nil, func() int { return 30 })
	defer observer.Close()
	identity := Identity{ID: "owner", Role: AuthRoleUser}
	sub, err := observer.SubscribeTasks(identity)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	if _, err := sub.Read(); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.SubmitChat(context.Background(), identity, "remote", "prompt", "model", []map[string]any{{"role": "user", "content": "prompt"}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Second)
	for {
		select {
		case <-sub.Changed():
			event, err := sub.Read()
			if err != nil {
				t.Fatal(err)
			}
			for _, data := range event.Items {
				var task map[string]any
				if err := json.Unmarshal(data, &task); err != nil {
					t.Fatal(err)
				}
				if util.Clean(task["status"]) == TaskStatusSuccess {
					if err := observer.Close(); err != nil {
						t.Fatal(err)
					}
					if _, err := sub.Read(); err != ErrImageTaskServiceClosed {
						t.Fatalf("closed service: %v", err)
					}
					return
				}
			}
		case <-deadline:
			t.Fatal("remote task did not reach the subscriber")
		}
	}
}
