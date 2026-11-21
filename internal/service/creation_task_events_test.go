package service

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
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
	sub, err := svc.SubscribeTasks(owner, CreationTaskEventScope{TaskIDs: []string{"same-id"}})
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
	sub, err := observer.SubscribeTasks(identity, CreationTaskEventScope{TaskIDs: []string{"remote"}})
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

func TestCreationTaskSubscriptionLimitsSnapshotAndFollowsWorkflowBatch(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, nil)
	t.Cleanup(func() { _ = svc.Close() })
	identity := Identity{ID: "owner"}
	// Seed both completed and active work to ensure scope is independent of status.
	newTask := func(id, owner, status, batch string) map[string]any {
		task := map[string]any{"id": id, "owner_id": owner, "status": status, "mode": "generate", "created_at": util.NowISO(), "updated_at": util.NowISO()}
		if batch != "" {
			task["workflow_context"] = map[string]any{"workflow_id": "workflow", "batch_task_id": batch}
		}
		return task
	}
	svc.mu.Lock()
	for _, task := range []map[string]any{
		newTask("child-one", "owner", TaskStatusSuccess, "batch"),
		newTask("direct", "owner", TaskStatusSuccess, ""),
		newTask("old", "owner", TaskStatusSuccess, "old-batch"),
		newTask("unrelated", "owner", TaskStatusRunning, ""),
		newTask("foreign", "other", TaskStatusRunning, "batch"),
	} {
		svc.tasks[taskKey(task["owner_id"].(string), task["id"].(string))] = task
	}
	svc.deletedTasks[taskKey("other", "foreign-deleted")] = util.NowISO()
	svc.deletedTasks[taskKey("owner", "owned-deleted")] = util.NowISO()
	svc.mu.Unlock()
	sub, err := svc.SubscribeTasks(identity, CreationTaskEventScope{
		TaskIDs: []string{"direct", "child-one", "foreign", "foreign-deleted", "owned-deleted", "quick-deletion"}, WorkflowBatchIDs: []string{"batch"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	readIDs := func(wantType string, wantIDs, wantDeleted string) {
		t.Helper()
		event, err := sub.Read()
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0, len(event.Items))
		for _, data := range event.Items {
			var task struct{ ID string }
			if err := json.Unmarshal(data, &task); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, task.ID)
		}
		sort.Strings(ids)
		if event.Type != wantType || strings.Join(ids, ",") != wantIDs || strings.Join(event.DeletedIDs, ",") != wantDeleted {
			t.Fatalf("event %s, tasks %v, deleted %v", event.Type, ids, event.DeletedIDs)
		}
	}
	readIDs("snapshot", "child-one,direct", "owned-deleted")
	svc.mu.Lock()
	svc.tasks[taskKey("owner", "child-two")] = newTask("child-two", "owner", TaskStatusRunning, "batch")
	delete(svc.tasks, taskKey("owner", "child-one"))
	svc.deletedTasks[taskKey("owner", "quick-deletion")] = util.NowISO()
	svc.mu.Unlock()
	readIDs("tasks", "child-two", "child-one,quick-deletion")
	readIDs("tasks", "", "")
}

func TestCreationTaskSubscriptionReceivesRemoteDeletionWithoutPriorTask(t *testing.T) {
	backend := newTestStorageBackend(t)
	svc := NewStoredImageTaskService(backend, nil, nil, nil, nil)
	t.Cleanup(func() { _ = svc.Close() })
	sub, err := svc.SubscribeTasks(Identity{ID: "owner"}, CreationTaskEventScope{TaskIDs: []string{"deleted-remotely"}})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	if event, err := sub.Read(); err != nil || len(event.Items) != 0 || len(event.DeletedIDs) != 0 {
		t.Fatalf("initial: %#v, %v", event, err)
	}
	writer, err := storage.NewDatabaseBackend(backend.Info()["database_url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err := writer.SaveJSONDocument(svc.docName, map[string]any{
		"tasks": []any{}, "deleted_tasks": []map[string]string{{"id": "deleted-remotely", "owner_id": "owner", "deleted_at": util.NowISO()}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sub.Changed():
		event, err := sub.Read()
		if err != nil || strings.Join(event.DeletedIDs, ",") != "deleted-remotely" {
			t.Fatalf("remote deletion: %#v, %v", event, err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("deletion did not wake the subscriber")
	}
}
