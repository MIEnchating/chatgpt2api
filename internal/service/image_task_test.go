package service

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestImageTaskServiceIdempotencyOwnerIsolationAndCompletion(t *testing.T) {
	handlerCalls := make(chan map[string]any, 4)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })

	alice := Identity{ID: "alice", Name: "Alice", Role: "user"}
	bob := Identity{ID: "bob", Name: "Bob", Role: "user"}

	first, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil)
	if err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	second, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "different", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil)
	if err != nil {
		t.Fatalf("second SubmitGeneration() error = %v", err)
	}
	if first["id"] != second["id"] {
		t.Fatalf("idempotent task id mismatch: %#v %#v", first, second)
	}
	waitForTaskStatus(t, svc, alice, "task-1", TaskStatusSuccess)
	select {
	case <-handlerCalls:
	default:
		t.Fatal("handler was not called")
	}
	if len(handlerCalls) != 0 {
		t.Fatalf("handler calls after duplicate = %d extra, want 0", len(handlerCalls))
	}
	if got := svc.ListTasks(bob, []string{"task-1"}); len(got["items"].([]map[string]any)) != 0 {
		t.Fatalf("bob can see alice task: %#v", got)
	}
	if got := svc.ListTasks(bob, []string{"task-1"}); len(got["missing_ids"].([]string)) != 1 {
		t.Fatalf("bob missing ids = %#v", got)
	}
}

func TestImageTaskServiceUsesOwnerIDAroundCredentialRotation(t *testing.T) {
	handlerCalls := make(chan map[string]any, 4)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	ownerID := "linuxdo:123"
	oldKey := Identity{ID: ownerID, OwnerID: ownerID, CredentialID: "key-old", Name: "Alice", Role: "user"}
	newKey := Identity{ID: ownerID, OwnerID: ownerID, CredentialID: "key-new", Name: "Alice", Role: "user"}
	otherOwner := Identity{ID: "linuxdo:456", OwnerID: "linuxdo:456", CredentialID: "key-other", Name: "Bob", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), oldKey, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, newKey, "task-1", TaskStatusSuccess)
	if got := svc.ListTasks(newKey, []string{"task-1"}); len(got["items"].([]map[string]any)) != 1 {
		t.Fatalf("rotated credential cannot see owner task: %#v", got)
	}
	if got := svc.ListTasks(otherOwner, []string{"task-1"}); len(got["items"].([]map[string]any)) != 0 || len(got["missing_ids"].([]string)) != 1 {
		t.Fatalf("other owner should not see task: %#v", got)
	}
	if _, err := svc.SubmitGeneration(context.Background(), newKey, "task-1", "different", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("second SubmitGeneration() error = %v", err)
	}
	if len(handlerCalls) != 1 {
		t.Fatalf("credential rotation should not create a duplicate task, handler calls = %d", len(handlerCalls))
	}
}

func TestImageTaskServiceListTasksReturnsEmptyArrays(t *testing.T) {
	svc := newTestImageTaskService(t, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	for name, got := range map[string]map[string]any{
		"empty list":   svc.ListTasks(identity, nil),
		"missing task": svc.ListTasks(identity, []string{"missing"}),
	} {
		items, ok := got["items"].([]map[string]any)
		if !ok {
			t.Fatalf("%s items type = %T", name, got["items"])
		}
		if items == nil {
			t.Fatalf("%s items is nil", name)
		}
		missing, ok := got["missing_ids"].([]string)
		if !ok {
			t.Fatalf("%s missing_ids type = %T", name, got["missing_ids"])
		}
		if missing == nil {
			t.Fatalf("%s missing_ids is nil", name)
		}

		data, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("%s Marshal() error = %v", name, err)
		}
		text := string(data)
		if strings.Contains(text, `"items":null`) || strings.Contains(text, `"missing_ids":null`) {
			t.Fatalf("%s encoded nil arrays: %s", name, text)
		}
	}
}

func TestImageTaskServiceRejectsBlankPromptBeforeQueueing(t *testing.T) {
	svc := newTestImageTaskService(t, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	for name, submit := range map[string]func() (map[string]any, error){
		"generation": func() (map[string]any, error) {
			return svc.SubmitGeneration(context.Background(), identity, "task-1", "  ", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil)
		},
		"edit": func() (map[string]any, error) {
			return svc.SubmitEdit(context.Background(), identity, "task-2", "\t", "gpt-image-2", "1024x1024", "high", "https://base.test", []any{"image"}, 1, nil)
		},
		"chat": func() (map[string]any, error) {
			return svc.SubmitChat(context.Background(), identity, "task-3", " ", "auto", []map[string]any{{"role": "user", "content": "hello"}}, false)
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := submit(); err == nil || err.Error() != "prompt is required" {
				t.Fatalf("Submit() error = %v, want prompt is required", err)
			}
		})
	}

	got := svc.ListTasks(identity, nil)
	if len(got["items"].([]map[string]any)) != 0 {
		t.Fatalf("blank prompt should not queue tasks: %#v", got)
	}
}

func TestImageTaskServicePassesMessagesToHandler(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	messages := []any{
		map[string]any{"role": "user", "content": "你好，你是什么模型？"},
		map[string]any{"role": "assistant", "content": "我是 GPT-5 Mini。"},
		map[string]any{"role": "user", "content": "我之前说了什么？"},
	}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "我之前说了什么？", "auto", "", "high", "https://base.test", 1, messages); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}

	var payload map[string]any
	select {
	case payload = <-handlerCalls:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	if got := payload["messages"]; got == nil {
		t.Fatalf("payload messages missing: %#v", payload)
	}
	if got := payload["prompt"]; got != "我之前说了什么？" {
		t.Fatalf("payload prompt = %#v, want current prompt", got)
	}
	if got := payload["quality"]; got != "high" {
		t.Fatalf("payload quality = %#v, want high", got)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServicePassesImageRequestMetadataToHandler(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGenerationWithMetadata(context.Background(), identity, "task-1", "draw", "gpt-image-2", "2048x2048", "high", "https://base.test", 1, nil, map[string]any{"image_resolution": "2k", "requested_size": "2048x2048", "token_group": "draw", "token_name": "image"}); err != nil {
		t.Fatalf("SubmitGenerationWithMetadata() error = %v", err)
	}

	select {
	case payload := <-handlerCalls:
		if _, ok := payload["response_format"]; ok {
			t.Fatalf("payload should not include response_format: %#v", payload)
		}
		if got := payload["image_resolution"]; got != "2k" {
			t.Fatalf("payload image_resolution = %#v, want 2k in %#v", got, payload)
		}
		if got := payload["requested_size"]; got != "2048x2048" {
			t.Fatalf("payload requested_size = %#v, want 2048x2048 in %#v", got, payload)
		}
		if got := payload["token_group"]; got != "draw" {
			t.Fatalf("payload token_group = %#v, want draw in %#v", got, payload)
		}
		if got := payload["token_name"]; got != "image" {
			t.Fatalf("payload token_name = %#v, want image in %#v", got, payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServicePassesImageToolOptionsToHandler(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGenerationWithOptions(context.Background(), identity, "task-1", "draw", "gpt-image-2", "16:9", "high", "https://base.test", 1, nil, nil, ImageOutputOptions{Format: "webp"}, ImageToolOptions{Moderation: "auto", Stream: true, PartialImages: 2}); err != nil {
		t.Fatalf("SubmitGenerationWithOptions() error = %v", err)
	}

	select {
	case payload := <-handlerCalls:
		if _, ok := payload["response_format"]; ok {
			t.Fatalf("payload should not include response_format: %#v", payload)
		}
		for key, want := range map[string]any{"moderation": "auto", "output_format": "webp", "stream": true, "partial_images": 2} {
			if got := payload[key]; got != want {
				t.Fatalf("payload[%s] = %#v, want %#v in %#v", key, got, want, payload)
			}
		}
		if _, ok := payload["background"]; ok {
			t.Fatalf("payload should not include background: %#v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServiceSubmitsChatTasks(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	imageHandler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	chatHandler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "chat response"}}}, nil
	}
	svc := newTestImageTaskService(t, imageHandler, imageHandler, chatHandler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	messages := []map[string]any{{"role": "user", "content": "hello"}}

	if _, err := svc.SubmitChatWithMetadata(context.Background(), identity, "chat-1", "hello", "auto", messages, false, map[string]any{"token_group": "draw", "token_name": "codex"}); err != nil {
		t.Fatalf("SubmitChatWithMetadata() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "chat-1", TaskStatusSuccess)
	got := svc.ListTasks(identity, []string{"chat-1"})
	item := got["items"].([]map[string]any)[0]
	if item["mode"] != "chat" {
		t.Fatalf("mode = %#v, want chat in %#v", item["mode"], item)
	}
	if item["output_type"] != "text" {
		t.Fatalf("output_type = %#v, want text in %#v", item["output_type"], item)
	}
	data := item["data"].([]map[string]any)
	if len(data) != 1 || data[0]["text_response"] != "chat response" {
		t.Fatalf("text response data = %#v", data)
	}
	select {
	case payload := <-handlerCalls:
		if got := payload["messages"]; got == nil {
			t.Fatalf("chat payload messages missing: %#v", payload)
		}
		if got := payload["token_group"]; got != "draw" {
			t.Fatalf("chat payload token_group = %#v, want draw in %#v", got, payload)
		}
		if got := payload["token_name"]; got != "codex" {
			t.Fatalf("chat payload token_name = %#v, want codex in %#v", got, payload)
		}
	default:
		t.Fatal("chat handler was not called")
	}
}

func TestImageTaskServicePublishesPartialChatTextWhileRunning(t *testing.T) {
	partialPublished := make(chan struct{})
	release := make(chan struct{})
	imageHandler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	chatHandler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		callback, ok := payload[TextOutputCallbackPayloadKey].(func(string))
		if !ok {
			return nil, errors.New("text output callback missing")
		}
		callback("partial response")
		close(partialPublished)
		<-release
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "final response"}}}, nil
	}
	svc := newTestImageTaskService(t, imageHandler, imageHandler, chatHandler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}
	messages := []map[string]any{{"role": "user", "content": "hello"}}

	if _, err := svc.SubmitChat(context.Background(), identity, "chat-stream", "hello", "gpt-5.5", messages, false); err != nil {
		t.Fatalf("SubmitChat() error = %v", err)
	}
	select {
	case <-partialPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for partial chat text")
	}
	waitForTaskStatus(t, svc, identity, "chat-stream", TaskStatusRunning)
	waitForTaskData(t, svc, identity, "chat-stream", func(data []map[string]any) bool {
		return len(data) == 1 && data[0]["text_response"] == "partial response"
	})
	close(release)
	waitForTaskStatus(t, svc, identity, "chat-stream", TaskStatusSuccess)
	waitForTaskData(t, svc, identity, "chat-stream", func(data []map[string]any) bool {
		return len(data) == 1 && data[0]["text_response"] == "final response"
	})
}

func TestImageTaskServiceDoesNotLimitGlobalImageSlots(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		started <- payload["prompt"].(string)
		<-release
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "first", "gpt-image-2", "1024x1024", "high", "https://base.test", 4, nil); err != nil {
		t.Fatalf("SubmitGeneration(first) error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "first" {
		t.Fatalf("started task = %q, want first", got)
	}
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-2", "second", "gpt-image-2", "1024x1024", "high", "https://base.test", 4, nil); err != nil {
		t.Fatalf("SubmitGeneration(second) error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "second" {
		t.Fatalf("second task should not wait for global image slots, started = %q", got)
	}
	close(release)
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
	waitForTaskStatus(t, svc, identity, "task-2", TaskStatusSuccess)
}

func TestImageTaskServicePublishesPartialImageDataWhileRunning(t *testing.T) {
	partialPublished := make(chan struct{})
	release := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		callback, ok := payload[imageOutputCallbackPayloadKey].(func([]map[string]any))
		if !ok {
			return nil, errors.New("image output callback missing")
		}
		callback([]map[string]any{
			{},
			{"url": "https://example.test/second.png"},
		})
		close(partialPublished)
		<-release
		return map[string]any{"data": []map[string]any{
			{"url": "https://example.test/first.png"},
			{"url": "https://example.test/second.png"},
		}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-partialPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for partial task data")
	}
	waitForTaskData(t, svc, identity, "task-1", func(data []map[string]any) bool {
		return len(data) == 2 && len(data[0]) == 0 && data[1]["url"] == "https://example.test/second.png"
	})
	close(release)
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServiceKeepsPreviewRunningAndProtectsCompletedOutput(t *testing.T) {
	previewPublished := make(chan struct{})
	publishFinal := make(chan struct{})
	finalPublished := make(chan struct{})
	finish := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		callback, ok := payload[imageOutputCallbackPayloadKey].(func([]map[string]any))
		if !ok {
			return nil, errors.New("image output callback missing")
		}
		callback([]map[string]any{{"b64_json": "preview", "preview": true}})
		close(previewPublished)
		select {
		case <-publishFinal:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		callback([]map[string]any{{"b64_json": "final"}})
		callback([]map[string]any{{"b64_json": "late-preview", "preview": true}})
		close(finalPublished)
		select {
		case <-finish:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{{"b64_json": "final"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "preview-state", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-preview", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-previewPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for preview")
	}
	previewTask := svc.ListTasks(identity, []string{"task-preview"})["items"].([]map[string]any)[0]
	previewData := util.AsMapSlice(previewTask["data"])
	if previewTask["status"] != TaskStatusRunning || !reflect.DeepEqual(util.AsStringSlice(previewTask["output_statuses"]), []string{TaskStatusRunning}) {
		t.Fatalf("preview completed task slot: %#v", previewTask)
	}
	if len(previewData) != 1 || !util.ToBool(previewData[0]["preview"]) || util.Clean(previewData[0]["b64_json"]) != "preview" {
		t.Fatalf("preview data = %#v", previewData)
	}

	close(publishFinal)
	select {
	case <-finalPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for final progress")
	}
	finalTask := svc.ListTasks(identity, []string{"task-preview"})["items"].([]map[string]any)[0]
	finalData := util.AsMapSlice(finalTask["data"])
	if finalTask["status"] != TaskStatusRunning || !reflect.DeepEqual(util.AsStringSlice(finalTask["output_statuses"]), []string{TaskStatusSuccess}) {
		t.Fatalf("final progress slot status = %#v", finalTask)
	}
	if len(finalData) != 1 || util.Clean(finalData[0]["b64_json"]) != "final" || util.ToBool(finalData[0]["preview"]) {
		t.Fatalf("late preview overwrote completed data: %#v", finalData)
	}

	close(finish)
	waitForTaskStatus(t, svc, identity, "task-preview", TaskStatusSuccess)
}

func TestImageTaskServiceMergesPartialSlotsAndDefersPartialPersistence(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	store := &countingImageTaskDocumentStore{JSONDocumentBackend: documentStore}
	partialsPublished := make(chan struct{})
	finish := make(chan struct{})
	var finishOnce sync.Once
	defer finishOnce.Do(func() { close(finish) })
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		callback, ok := payload[imageOutputCallbackPayloadKey].(func([]map[string]any))
		if !ok {
			return nil, errors.New("image output callback missing")
		}
		callback([]map[string]any{
			{},
			{"url": "https://example.test/second.png", "revised_prompt": "second"},
		})
		callback([]map[string]any{{"url": "https://example.test/first.png"}})
		callback([]map[string]any{{"url": "   "}})
		callback([]map[string]any{})
		close(partialsPublished)
		select {
		case <-finish:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{
			{"url": "https://example.test/first.png"},
			{"url": "https://example.test/second.png", "revised_prompt": "second"},
		}}, nil
	}
	svc := newImageTaskService(store, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}

	submitted, err := svc.SubmitGeneration(context.Background(), identity, "task-union", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2, nil)
	if err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	if revision := util.ToInt(submitted["revision"], 0); revision != 1 {
		t.Fatalf("submitted revision = %d, want 1: %#v", revision, submitted)
	}
	if _, err := time.Parse(time.RFC3339Nano, util.Clean(submitted["updated_at"])); err != nil {
		t.Fatalf("submitted updated_at is not RFC3339Nano: %#v", submitted["updated_at"])
	}

	select {
	case <-partialsPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for partial task data")
	}
	got := svc.ListTasks(identity, []string{"task-union"})
	item := got["items"].([]map[string]any)[0]
	data := util.AsMapSlice(item["data"])
	if len(data) != 2 || data[0]["url"] != "https://example.test/first.png" || data[1]["url"] != "https://example.test/second.png" || data[1]["revised_prompt"] != "second" {
		t.Fatalf("partial slot union = %#v", data)
	}
	partialRevision := util.ToInt(item["revision"], 0)
	if partialRevision <= util.ToInt(submitted["revision"], 0) {
		t.Fatalf("partial revision did not advance: submitted=%#v partial=%#v", submitted, item)
	}
	if store.SaveCount() != 2 {
		t.Fatalf("save count after partial updates = %d, want queued + running only", store.SaveCount())
	}
	persisted, err := store.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	persistedTasks := util.AsMapSlice(util.StringMap(persisted)["tasks"])
	if len(persistedTasks) != 1 || persistedTasks[0]["status"] != TaskStatusRunning || persistedTasks[0]["data"] != nil {
		t.Fatalf("partial state should stay in memory until a durable transition: %#v", persistedTasks)
	}
	persistedRunningRevision := util.ToInt(persistedTasks[0]["revision"], 0)
	if persistedRunningRevision <= util.ToInt(submitted["revision"], 0) || persistedRunningRevision >= partialRevision {
		t.Fatalf("persisted running revision = %d, submitted=%#v partial=%#v", persistedRunningRevision, submitted, item)
	}
	persistedStatuses := util.AsStringSlice(persistedTasks[0]["output_statuses"])
	if len(persistedStatuses) != 2 {
		t.Fatalf("persisted output statuses = %#v, want two running slots", persistedStatuses)
	}
	for _, status := range persistedStatuses {
		if status != TaskStatusRunning {
			t.Fatalf("persisted running task contains non-running output status: %#v", persistedTasks[0])
		}
	}
	recoveredService := newImageTaskService(documentStore, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	recoveredTask := recoveredService.ListTasks(identity, []string{"task-union"})["items"].([]map[string]any)[0]
	if recoveredTask["status"] != TaskStatusError || util.ToInt(recoveredTask["revision"], 0) <= partialRevision {
		t.Fatalf("restart recovery revision regressed behind observed partial: partial=%d recovered=%#v", partialRevision, recoveredTask)
	}

	finishOnce.Do(func() { close(finish) })
	waitForTaskStatus(t, svc, identity, "task-union", TaskStatusSuccess)
	final := svc.ListTasks(identity, []string{"task-union"})["items"].([]map[string]any)[0]
	finalRevision := util.ToInt(final["revision"], 0)
	if finalRevision <= partialRevision {
		t.Fatalf("final revision = %d, want greater than partial %d: %#v", finalRevision, partialRevision, final)
	}
	if store.SaveCount() != 3 {
		t.Fatalf("final save count = %d, want queued + running + terminal", store.SaveCount())
	}
	persisted, err = store.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument(final) error = %v", err)
	}
	persistedTasks = util.AsMapSlice(util.StringMap(persisted)["tasks"])
	if len(persistedTasks) != 1 || persistedTasks[0]["status"] != TaskStatusSuccess || util.ToInt(persistedTasks[0]["revision"], 0) != finalRevision || len(util.AsMapSlice(persistedTasks[0]["data"])) != 2 {
		t.Fatalf("terminal task was not durably persisted: %#v", persistedTasks)
	}
}

func TestImageTaskServiceLimitsGlobalConcurrentCreationUnitsForAdmins(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
	t.Cleanup(svc.Close)
	admin := Identity{ID: "admin", Name: "Admin", Role: AuthRoleAdmin}
	releases := make([]func(), 0, defaultGlobalImageTaskConcurrentUnits)
	for index := 0; index < defaultGlobalImageTaskConcurrentUnits; index++ {
		release, err := svc.AcquireCreationUnit(context.Background(), admin)
		if err != nil {
			t.Fatalf("AcquireCreationUnit(%d) error = %v", index, err)
		}
		releases = append(releases, release)
	}
	type acquireResult struct {
		release func()
		err     error
	}
	result := make(chan acquireResult, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		release, err := svc.AcquireCreationUnit(ctx, Identity{ID: "admin-2", Name: "Admin 2", Role: AuthRoleAdmin})
		result <- acquireResult{release: release, err: err}
	}()
	select {
	case acquired := <-result:
		if acquired.release != nil {
			acquired.release()
		}
		t.Fatalf("extra admin unit bypassed the global limit: %v", acquired.err)
	case <-time.After(120 * time.Millisecond):
	}
	releases[0]()
	select {
	case acquired := <-result:
		if acquired.err != nil {
			t.Fatalf("waiting admin acquire error = %v", acquired.err)
		}
		acquired.release()
	case <-time.After(2 * time.Second):
		t.Fatal("waiting admin unit did not start after a global slot was released")
	}
	for _, release := range releases[1:] {
		release()
	}
	if _, err := svc.AcquireCreationUnits(context.Background(), admin, defaultGlobalImageTaskConcurrentUnits+1); err == nil {
		t.Fatal("oversized request exceeded the global unit limit without an error")
	}
}

func TestImageTaskServiceCloseRejectsAndWakesCreationUnitAcquirers(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
	admin := Identity{ID: "admin", Name: "Admin", Role: AuthRoleAdmin}
	releases := make([]func(), 0, defaultGlobalImageTaskConcurrentUnits)
	for index := 0; index < defaultGlobalImageTaskConcurrentUnits; index++ {
		release, err := svc.AcquireCreationUnit(context.Background(), admin)
		if err != nil {
			t.Fatalf("AcquireCreationUnit(%d) error = %v", index, err)
		}
		releases = append(releases, release)
	}

	result := make(chan error, 1)
	go func() {
		release, err := svc.AcquireCreationUnit(context.Background(), admin)
		if release != nil {
			release()
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("blocked acquisition returned before Close(): %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	svc.Close()
	select {
	case err := <-result:
		if !errors.Is(err, ErrImageTaskServiceClosed) {
			t.Fatalf("blocked acquisition error = %v, want closed service", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not wake the blocked creation-unit acquisition")
	}
	if release, err := svc.AcquireCreationUnit(context.Background(), admin); !errors.Is(err, ErrImageTaskServiceClosed) {
		if release != nil {
			release()
		}
		t.Fatalf("acquisition after Close() error = %v, want closed service", err)
	}
	for _, release := range releases {
		release()
	}
}

func TestImageTaskServiceLimitsUserDefaultConcurrentCreationUnits(t *testing.T) {
	startedImages := make(chan int, 3)
	release := make(chan struct{})
	var mu sync.Mutex
	activeImages := 0
	maxActiveImages := 0
	imageHandler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload["image_output_slot_acquirer"].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		count := imageTaskCount(payload)
		errCh := make(chan error, count)
		var wg sync.WaitGroup
		for index := 1; index <= count; index++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				releaseSlot, err := acquire(ctx, index)
				if err != nil {
					errCh <- err
					return
				}
				defer releaseSlot()
				mu.Lock()
				activeImages++
				if activeImages > maxActiveImages {
					maxActiveImages = activeImages
				}
				mu.Unlock()
				startedImages <- index
				select {
				case <-release:
				case <-ctx.Done():
					errCh <- ctx.Err()
				}
				mu.Lock()
				activeImages--
				mu.Unlock()
			}(index)
		}
		wg.Wait()
		close(errCh)
		for err := range errCh {
			if err != nil {
				return nil, err
			}
		}
		data := make([]map[string]any, 0, count)
		for index := 1; index <= count; index++ {
			data = append(data, map[string]any{"url": "https://example.test/image.png"})
		}
		return map[string]any{"data": data}, nil
	}
	chatHandler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "chat response"}}}, nil
	}
	svc := newTestImageTaskService(t, imageHandler, imageHandler, chatHandler, func() int { return 30 }, func() int { return 2 })
	alice := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	seen := map[int]bool{}
	seen[waitForStartedImageIndex(t, startedImages)] = true
	seen[waitForStartedImageIndex(t, startedImages)] = true
	if len(seen) != 2 {
		t.Fatalf("started image indexes = %#v, want two distinct images", seen)
	}
	select {
	case index := <-startedImages:
		t.Fatalf("third image output started before a user slot was released: %d", index)
	case <-time.After(120 * time.Millisecond):
	}
	mu.Lock()
	gotMaxActive := maxActiveImages
	mu.Unlock()
	if gotMaxActive != 2 {
		t.Fatalf("max active image outputs = %d, want 2", gotMaxActive)
	}
	waitForTaskStatus(t, svc, alice, "task-1", TaskStatusRunning)
	waitForTaskOutputStatusCounts(t, svc, alice, "task-1", map[string]int{"running": 2, "queued": 1})
	close(release)
	seen[waitForStartedImageIndex(t, startedImages)] = true
	waitForTaskStatus(t, svc, alice, "task-1", TaskStatusSuccess)
	if len(seen) != 3 {
		t.Fatalf("started image indexes after release = %#v, want three images", seen)
	}
	started := make(chan string, 3)
	releaseImage := make(chan struct{})
	releaseChat := make(chan struct{})
	imageHandler = func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload["image_output_slot_acquirer"].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		count := imageTaskCount(payload)
		errCh := make(chan error, count)
		var wg sync.WaitGroup
		for index := 1; index <= count; index++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				releaseSlot, err := acquire(ctx, index)
				if err != nil {
					errCh <- err
					return
				}
				defer releaseSlot()
				started <- "image"
				select {
				case <-releaseImage:
				case <-ctx.Done():
					errCh <- ctx.Err()
				}
			}(index)
		}
		wg.Wait()
		close(errCh)
		for err := range errCh {
			if err != nil {
				return nil, err
			}
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/first.png"}, {"url": "https://example.test/second.png"}}}, nil
	}
	chatHandler = func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		started <- "chat"
		select {
		case <-releaseChat:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "chat response"}}}, nil
	}
	svc = newTestImageTaskService(t, imageHandler, imageHandler, chatHandler, func() int { return 30 }, func() int { return 2 })
	messages := []map[string]any{{"role": "user", "content": "hello"}}

	if _, err := svc.SubmitEdit(context.Background(), alice, "edit-1", "edit", "gpt-image-2", "1024x1024", "high", "https://base.test", []any{"image"}, 2, nil); err != nil {
		t.Fatalf("SubmitEdit(edit-1) error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "image" {
		t.Fatalf("started task = %q, want image", got)
	}
	if got := waitForStartedTask(t, started); got != "image" {
		t.Fatalf("started task = %q, want image", got)
	}
	if _, err := svc.SubmitChat(context.Background(), alice, "chat-1", "hello", "auto", messages, false); err != nil {
		t.Fatalf("SubmitChat(chat-1) error = %v", err)
	}
	waitForTaskStatus(t, svc, alice, "chat-1", TaskStatusQueued)
	select {
	case item := <-started:
		t.Fatalf("chat task started before an image slot was released: %s", item)
	case <-time.After(120 * time.Millisecond):
	}
	close(releaseImage)
	if got := waitForStartedTask(t, started); got != "chat" {
		t.Fatalf("started task = %q, want chat", got)
	}
	waitForTaskStatus(t, svc, alice, "chat-1", TaskStatusRunning)
	close(releaseChat)
	waitForTaskStatus(t, svc, alice, "edit-1", TaskStatusSuccess)
	waitForTaskStatus(t, svc, alice, "chat-1", TaskStatusSuccess)
}

func TestImageTaskServiceLimitsUserDefaultRPM(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 }, nil, func() int { return 1 })
	user := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}
	admin := Identity{ID: "admin", Name: "Admin", Role: AuthRoleAdmin}

	if _, err := svc.SubmitGeneration(context.Background(), user, "task-1", "first", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration(first) error = %v", err)
	}
	waitForTaskStatus(t, svc, user, "task-1", TaskStatusSuccess)
	if _, err := svc.SubmitGeneration(context.Background(), user, "task-2", "second", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err == nil {
		t.Fatal("SubmitGeneration(second) error = nil, want RPM limit")
	} else {
		var limitErr ImageTaskLimitError
		if !errors.As(err, &limitErr) {
			t.Fatalf("SubmitGeneration(second) error = %T %v, want ImageTaskLimitError", err, err)
		}
	}
	if _, err := svc.SubmitGeneration(context.Background(), admin, "task-1", "admin first", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("admin should bypass user RPM limit: %v", err)
	}
	if _, err := svc.SubmitGeneration(context.Background(), admin, "task-2", "admin second", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("admin should bypass user RPM limit on second request: %v", err)
	}
	waitForTaskStatus(t, svc, admin, "task-1", TaskStatusSuccess)
	waitForTaskStatus(t, svc, admin, "task-2", TaskStatusSuccess)
}

func TestImageTaskServiceRequestWideSlotCountsEveryRequestedImage(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		close(started)
		select {
		case <-finish:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{{"url": "a"}, {"url": "b"}, {"url": "c"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 }, func() int { return 4 })
	identity := Identity{ID: "request-wide", Role: AuthRoleUser}
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-wide", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for request-wide slot")
	}
	svc.mu.Lock()
	units := svc.ownerRunningUnits[ownerID(identity)]
	svc.mu.Unlock()
	if units != 3 {
		t.Fatalf("request-wide running units = %d, want 3", units)
	}
	close(finish)
	waitForTaskStatus(t, svc, identity, "task-wide", TaskStatusSuccess)
}

func TestImageTaskServiceCancelsRunningTask(t *testing.T) {
	started := make(chan struct{})
	handlerDone := make(chan error, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		close(started)
		<-ctx.Done()
		handlerDone <- ctx.Err()
		return nil, ctx.Err()
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	submitted, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil)
	if err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for task handler to start")
	}

	cancelled, err := svc.CancelTask(identity, "task-1")
	if err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	if cancelled["status"] != TaskStatusCancelled {
		t.Fatalf("cancelled task status = %#v", cancelled)
	}
	for _, status := range util.AsStringSlice(cancelled["output_statuses"]) {
		if status != TaskStatusCancelled {
			t.Fatalf("cancelled task retained active output status: %#v", cancelled)
		}
	}
	if util.ToInt(cancelled["revision"], 0) <= util.ToInt(submitted["revision"], 0) {
		t.Fatalf("cancel revision did not advance: submitted=%#v cancelled=%#v", submitted, cancelled)
	}
	if _, err := time.Parse(time.RFC3339Nano, util.Clean(cancelled["updated_at"])); err != nil {
		t.Fatalf("cancelled updated_at is not RFC3339Nano: %#v", cancelled["updated_at"])
	}
	select {
	case err := <-handlerDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("handler ctx err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("task handler did not observe cancellation")
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusCancelled)
}

func TestImageTaskServiceCancellationPreservesCompletedOutputsAfterReload(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	partialPublished := make(chan struct{})
	handlerDone := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		callback, ok := payload[imageOutputCallbackPayloadKey].(func([]map[string]any))
		if !ok {
			return nil, errors.New("image output callback missing")
		}
		callback([]map[string]any{
			{"url": "https://example.test/completed.png"},
			{"b64_json": "unfinished-preview", "preview": true},
		})
		close(partialPublished)
		<-ctx.Done()
		close(handlerDone)
		return nil, ctx.Err()
	}
	svc := newImageTaskService(documentStore, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "partial-cancel", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-partial-cancel", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-partialPublished:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for partial output")
	}

	cancelled, err := svc.CancelTask(identity, "task-partial-cancel")
	if err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	if got, want := util.AsStringSlice(cancelled["output_statuses"]), []string{TaskStatusSuccess, TaskStatusCancelled}; !reflect.DeepEqual(got, want) {
		t.Fatalf("cancelled output statuses = %#v, want %#v", got, want)
	}
	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("task handler did not stop after cancellation")
	}

	reloaded := newImageTaskService(documentStore, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	items := reloaded.ListTasks(identity, []string{"task-partial-cancel"})["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("reloaded cancelled task missing: %#v", items)
	}
	item := items[0]
	if item["status"] != TaskStatusCancelled {
		t.Fatalf("reloaded status = %#v, want cancelled", item)
	}
	if got, want := util.AsStringSlice(item["output_statuses"]), []string{TaskStatusSuccess, TaskStatusCancelled}; !reflect.DeepEqual(got, want) {
		t.Fatalf("reloaded output statuses = %#v, want %#v", got, want)
	}
	data := util.AsMapSlice(item["data"])
	if len(data) != 2 || util.Clean(data[0]["url"]) != "https://example.test/completed.png" {
		t.Fatalf("reloaded completed output missing: %#v", data)
	}
	if util.Clean(data[1]["b64_json"]) != "" || util.ToBool(data[1]["preview"]) {
		t.Fatalf("reloaded task retained preview payload: %#v", data)
	}
}

func TestImageTaskServicePreservesPartialDataOnFailure(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/first.png"}}}, errors.New("second image failed")
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusError)
	got := svc.ListTasks(identity, []string{"task-1"})
	item := got["items"].([]map[string]any)[0]
	data := item["data"].([]map[string]any)
	if len(data) != 1 || data[0]["url"] != "https://example.test/first.png" {
		t.Fatalf("partial data was not preserved: %#v", item)
	}
	if item["error"] != "second image failed" {
		t.Fatalf("partial failure error = %#v", item)
	}
	statuses := util.AsStringSlice(item["output_statuses"])
	if len(statuses) != 2 || statuses[0] != "success" || statuses[1] != "error" {
		t.Fatalf("output_statuses = %#v, want partial success and failed remainder", statuses)
	}
}

func TestImageTaskServiceMarksTimedOutTaskAsError(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetTaskTimeoutGetter(func() time.Duration { return 20 * time.Millisecond })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusError)
	got := svc.ListTasks(identity, []string{"task-1"})
	item := got["items"].([]map[string]any)[0]
	if item["error"] != "图片生成超时，请稍后重试或降低分辨率" {
		t.Fatalf("timeout error = %#v", item)
	}
}

func TestImageTaskServicePreservesTextOutputType(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"message": "text response", "output_type": "text"}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "who are you", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
	got := svc.ListTasks(identity, []string{"task-1"})
	item := got["items"].([]map[string]any)[0]
	if item["output_type"] != "text" {
		t.Fatalf("output_type = %#v, want text in %#v", item["output_type"], item)
	}
	data := item["data"].([]map[string]any)
	if len(data) != 1 || data[0]["text_response"] != "text response" {
		t.Fatalf("text response data = %#v", data)
	}
}

func TestImageTaskServiceStoresTextOutputFromHandlerError(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"message": "text response", "output_type": "text"}, errors.New("text response")
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "who are you", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
	got := svc.ListTasks(identity, []string{"task-1"})
	item := got["items"].([]map[string]any)[0]
	if util.Clean(item["error"]) != "" {
		t.Fatalf("error = %#v, want empty in %#v", item["error"], item)
	}
	if item["output_type"] != "text" {
		t.Fatalf("output_type = %#v, want text in %#v", item["output_type"], item)
	}
	data := item["data"].([]map[string]any)
	if len(data) != 1 || data[0]["text_response"] != "text response" {
		t.Fatalf("text response data = %#v", data)
	}
	statuses := item["output_statuses"].([]string)
	if len(statuses) != 1 || statuses[0] != "success" {
		t.Fatalf("output_statuses = %#v, want success", statuses)
	}
}

func TestImageTaskServiceRestoresUnfinishedTasksAsErrors(t *testing.T) {
	backend := newTestStorageBackend(t)
	raw := map[string]any{"tasks": []map[string]any{
		{"id": "queued", "owner_id": "alice", "status": TaskStatusQueued, "mode": "generate", "created_at": "2026-01-01 00:00:00", "updated_at": "2026-01-01 00:00:00"},
		{"id": "running", "owner_id": "alice", "status": TaskStatusRunning, "mode": "edit", "created_at": "2026-01-01 00:00:00", "updated_at": "2026-01-01 00:00:00"},
	}}
	store, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	if err := store.SaveJSONDocument("image_tasks.json", raw); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	svc := NewStoredImageTaskService(backend, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	got := svc.ListTasks(Identity{ID: "alice"}, []string{"queued", "running"})
	items := got["items"].([]map[string]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	for _, item := range items {
		if item["status"] != TaskStatusError {
			t.Fatalf("unfinished task was not restored as error: %#v", item)
		}
		if item["error"] == nil {
			t.Fatalf("restored task missing error text: %#v", item)
		}
		if util.ToInt(item["revision"], 0) <= 1 {
			t.Fatalf("legacy unfinished task revision did not advance after recovery: %#v", item)
		}
		if _, err := time.Parse(time.RFC3339Nano, util.Clean(item["updated_at"])); err != nil {
			t.Fatalf("recovered updated_at is not RFC3339Nano: %#v", item["updated_at"])
		}
	}
}

func TestImageTaskServiceRunningTransitionIsAtomicAndPreservesTerminalSlots(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	started := make(chan struct{})
	handlerDone := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		close(started)
		<-ctx.Done()
		close(handlerDone)
		return nil, ctx.Err()
	}
	svc := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "atomic-running", Name: "Alice", Role: AuthRoleUser}
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-atomic-running", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 4, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	defer func() { _, _ = svc.CancelTask(identity, "task-atomic-running") }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for task handler")
	}
	key := taskKey(ownerID(identity), "task-atomic-running")
	if !svc.markImageOutputStatus(key, 1, TaskStatusSuccess) || !svc.markImageOutputStatus(key, 2, TaskStatusError) || !svc.markImageOutputStatus(key, 3, TaskStatusCancelled) {
		t.Fatal("failed to seed terminal output statuses")
	}
	if !svc.activateImageTaskOutput(key, 0) {
		t.Fatal("queued task did not transition to running")
	}
	if !svc.markAllImageOutputStatuses(key, TaskStatusRunning) || !svc.markImageOutputStatus(key, 1, TaskStatusRunning) {
		t.Fatal("running status refresh unexpectedly failed")
	}

	item := svc.ListTasks(identity, []string{"task-atomic-running"})["items"].([]map[string]any)[0]
	wantStatuses := []string{TaskStatusSuccess, TaskStatusError, TaskStatusCancelled, TaskStatusRunning}
	if got := util.AsStringSlice(item["output_statuses"]); !reflect.DeepEqual(got, wantStatuses) {
		t.Fatalf("running output statuses = %#v, want %#v", got, wantStatuses)
	}
	if item["status"] != TaskStatusRunning || util.ToInt(item["revision"], 0) <= 1 {
		t.Fatalf("atomic running task did not advance revision: %#v", item)
	}
	if _, err := time.Parse(time.RFC3339Nano, util.Clean(item["updated_at"])); err != nil {
		t.Fatalf("running updated_at is not RFC3339Nano: %#v", item["updated_at"])
	}
	persisted, err := documentStore.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	persistedTasks := util.AsMapSlice(util.StringMap(persisted)["tasks"])
	if len(persistedTasks) != 1 || persistedTasks[0]["status"] != TaskStatusRunning || util.ToInt(persistedTasks[0]["revision"], 0) != util.ToInt(item["revision"], 0) || !reflect.DeepEqual(util.AsStringSlice(persistedTasks[0]["output_statuses"]), wantStatuses) {
		t.Fatalf("running transition was not atomically persisted: %#v", persistedTasks)
	}

	if _, err := svc.CancelTask(identity, "task-atomic-running"); err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("task handler did not stop after cancellation")
	}
}

func TestImageTaskServiceCanMarkWholeImageRequestRunning(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload["image_output_slot_acquirer"].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		releaseSlot, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer releaseSlot()
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{
			{"url": "https://example.test/first.png"},
			{"url": "https://example.test/second.png"},
			{"url": "https://example.test/third.png"},
		}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler start")
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusRunning)
	waitForTaskOutputStatusCounts(t, svc, identity, "task-1", map[string]int{"running": 3})
	close(release)
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServiceDoesNotStartHandlerWhenInitialPersistenceFails(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	store := &flakyImageTaskDocumentStore{JSONDocumentBackend: documentStore}
	store.FailNextSaves(1)
	handlerCalls := make(chan struct{}, 1)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		handlerCalls <- struct{}{}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newImageTaskService(store, handler, handler, handler, func() int { return 30 }, func() int { return 0 }, func() int { return 1 })
	identity := Identity{ID: "initial-save-failure", Name: "Alice", Role: AuthRoleUser}

	result, err := svc.SubmitGeneration(context.Background(), identity, "task-save-failure", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil)
	if err == nil || !strings.Contains(err.Error(), "未启动上游请求") {
		t.Fatalf("SubmitGeneration() result = %#v, error = %v; want clear persistence error", result, err)
	}
	select {
	case <-handlerCalls:
		t.Fatal("handler ran after the initial queued task failed to persist")
	case <-time.After(100 * time.Millisecond):
	}

	svc.mu.Lock()
	taskCount := len(svc.tasks)
	cancelCount := len(svc.cancels)
	submitTimeCount := len(svc.ownerSubmitTimes[ownerID(identity)])
	svc.mu.Unlock()
	if taskCount != 0 || cancelCount != 0 || submitTimeCount != 0 {
		t.Fatalf("failed submission was not rolled back: tasks=%d cancels=%d submit_times=%d", taskCount, cancelCount, submitTimeCount)
	}
	waitForImageTaskSaveCalls(t, store, 2)
	persisted, loadErr := documentStore.LoadJSONDocument("image_tasks.json")
	if loadErr != nil {
		t.Fatalf("LoadJSONDocument() error = %v", loadErr)
	}
	if tasks := util.AsMapSlice(util.StringMap(persisted)["tasks"]); len(tasks) != 0 {
		t.Fatalf("rolled-back task remained in storage: %#v", tasks)
	}
}

func TestImageTaskServiceRetriesFailedTerminalPersistence(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	store := &flakyImageTaskDocumentStore{JSONDocumentBackend: documentStore}
	started := make(chan struct{})
	finish := make(chan struct{})
	completionReleased := make(chan string, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		close(started)
		select {
		case <-finish:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		payload[ImageOutputCompletionReleasePayloadKey] = func() {
			status := ""
			persisted, err := documentStore.LoadJSONDocument("image_tasks.json")
			if err == nil {
				for _, task := range util.AsMapSlice(util.StringMap(persisted)["tasks"]) {
					if util.Clean(task["id"]) == "task-terminal-retry" {
						status = util.Clean(task["status"])
						break
					}
				}
			}
			completionReleased <- status
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/final.png"}}}, nil
	}
	svc := newImageTaskService(store, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "terminal-save-retry", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-terminal-retry", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for running task")
	}
	store.FailNextSaves(1)
	close(finish)
	waitForTaskStatus(t, svc, identity, "task-terminal-retry", TaskStatusSuccess)
	select {
	case persistedStatus := <-completionReleased:
		if persistedStatus != TaskStatusSuccess {
			t.Fatalf("completion lease released before terminal persistence: status=%q", persistedStatus)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for completion lease release")
	}
	waitForPersistedImageTaskStatus(t, documentStore, "task-terminal-retry", TaskStatusSuccess)
	if failures := store.FailureCount(); failures != 1 {
		t.Fatalf("injected terminal save failures = %d, want 1", failures)
	}
	if calls := store.SaveCount(); calls < 4 {
		t.Fatalf("save calls = %d, want queued + running + failed terminal + retry", calls)
	}
}

func TestImageTaskServiceCloseCancelsAndWaitsForActiveTask(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	store := &countingImageTaskDocumentStore{JSONDocumentBackend: documentStore}
	started := make(chan struct{})
	stopped := make(chan struct{})
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		acquire, ok := payload[imageOutputSlotAcquirerPayloadKey].(func(context.Context, int) (func(), error))
		if !ok {
			return nil, errors.New("image output slot acquirer missing")
		}
		release, err := acquire(ctx, 0)
		if err != nil {
			return nil, err
		}
		defer release()
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	}
	svc := newImageTaskService(store, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "close-active", Name: "Alice", Role: AuthRoleUser}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-close", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for active task")
	}

	closed := make(chan struct{})
	go func() {
		svc.Close()
		close(closed)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not cancel the active task")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not wait for task shutdown")
	}

	items := svc.ListTasks(identity, []string{"task-close"})["items"].([]map[string]any)
	if len(items) != 1 || items[0]["status"] != TaskStatusCancelled {
		t.Fatalf("closed task = %#v, want cancelled", items)
	}
	waitForPersistedImageTaskStatus(t, documentStore, "task-close", TaskStatusCancelled)
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-after-close", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1, nil); err == nil || !strings.Contains(err.Error(), "service is closed") {
		t.Fatalf("submission after Close() error = %v, want closed service error", err)
	}

	secondClose := make(chan struct{})
	go func() {
		svc.Close()
		close(secondClose)
	}()
	select {
	case <-secondClose:
	case <-time.After(time.Second):
		t.Fatal("second Close() call blocked")
	}
}

func TestImageTaskServiceCloseStopsPermanentPersistenceRetry(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	store := &failingImageTaskDocumentStore{JSONDocumentBackend: documentStore}
	svc := newImageTaskService(store, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	svc.mu.Lock()
	svc.tasks["retry-close:task-retry-close"] = map[string]any{
		"id":         "task-retry-close",
		"owner_id":   "retry-close",
		"status":     TaskStatusSuccess,
		"mode":       "generate",
		"revision":   1,
		"created_at": util.NowISO(),
		"updated_at": util.NowISO(),
		"data":       []map[string]any{{"url": "https://example.test/final.png"}},
	}
	if err := svc.saveWithRetryLocked(); err == nil {
		svc.mu.Unlock()
		t.Fatal("saveWithRetryLocked() unexpectedly succeeded")
	}
	svc.mu.Unlock()
	waitForImageTaskSaveCalls(t, store, 2)

	closed := make(chan struct{})
	go func() {
		svc.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() blocked on permanent persistence failure")
	}

	svc.mu.RLock()
	retrying := svc.persistenceRetrying
	dirty := svc.persistenceDirty
	isClosed := svc.closed
	svc.mu.RUnlock()
	if retrying || !dirty || !isClosed {
		t.Fatalf("closed persistence state: retrying=%v dirty=%v closed=%v", retrying, dirty, isClosed)
	}
	callsAfterClose := store.SaveCount()
	time.Sleep(4 * imageTaskPersistenceRetryInitialDelay)
	if calls := store.SaveCount(); calls != callsAfterClose {
		t.Fatalf("persistence writes continued after Close(): before=%d after=%d", callsAfterClose, calls)
	}
	svc.mu.Lock()
	err := svc.saveWithRetryLocked()
	svc.mu.Unlock()
	if err == nil || !strings.Contains(err.Error(), "service is closed") {
		t.Fatalf("save after Close() error = %v, want closed service error", err)
	}
	if calls := store.SaveCount(); calls != callsAfterClose {
		t.Fatalf("save after Close() touched storage: before=%d after=%d", callsAfterClose, calls)
	}
}

func TestImageTaskServiceDoesNotPersistTerminalPreviewBase64(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	svc := newImageTaskService(documentStore, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	svc.mu.Lock()
	svc.tasks["preview-owner:preview-task"] = map[string]any{
		"id":         "preview-task",
		"owner_id":   "preview-owner",
		"status":     TaskStatusSuccess,
		"mode":       "generate",
		"created_at": util.NowISO(),
		"updated_at": util.NowISO(),
		"data": []map[string]any{
			{"b64_json": "preview-base64-must-not-persist", "preview": true},
			{"b64_json": "final-base64"},
		},
	}
	err := svc.saveLocked()
	svc.mu.Unlock()
	if err != nil {
		t.Fatalf("saveLocked() error = %v", err)
	}

	persisted, err := documentStore.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	encoded, err := json.Marshal(persisted)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if strings.Contains(string(encoded), "preview-base64-must-not-persist") || strings.Contains(string(encoded), `"preview"`) {
		t.Fatalf("preview payload was persisted: %s", encoded)
	}
	if !strings.Contains(string(encoded), "final-base64") {
		t.Fatalf("final payload was removed with preview data: %s", encoded)
	}
}

func newTestImageTaskService(t *testing.T, generation ImageTaskHandler, edit ImageTaskHandler, chat ImageTaskHandler, retentionGetter func() int, limitGetters ...func() int) *ImageTaskService {
	t.Helper()
	return NewStoredImageTaskService(newTestStorageBackend(t), generation, edit, chat, retentionGetter, limitGetters...)
}

type countingImageTaskDocumentStore struct {
	storage.JSONDocumentBackend
	mu        sync.Mutex
	saveCount int
}

func (s *countingImageTaskDocumentStore) SaveJSONDocument(name string, value any) error {
	s.mu.Lock()
	s.saveCount++
	s.mu.Unlock()
	return s.JSONDocumentBackend.SaveJSONDocument(name, value)
}

func (s *countingImageTaskDocumentStore) SaveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveCount
}

type flakyImageTaskDocumentStore struct {
	storage.JSONDocumentBackend
	mu           sync.Mutex
	failNext     int
	saveCount    int
	failureCount int
}

type failingImageTaskDocumentStore struct {
	storage.JSONDocumentBackend
	mu        sync.Mutex
	saveCount int
}

func (s *failingImageTaskDocumentStore) SaveJSONDocument(string, any) error {
	s.mu.Lock()
	s.saveCount++
	s.mu.Unlock()
	return errors.New("injected permanent image task persistence failure")
}

func (s *failingImageTaskDocumentStore) SaveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveCount
}

func (s *flakyImageTaskDocumentStore) FailNextSaves(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failNext = count
}

func (s *flakyImageTaskDocumentStore) SaveJSONDocument(name string, value any) error {
	s.mu.Lock()
	s.saveCount++
	if s.failNext > 0 {
		s.failNext--
		s.failureCount++
		s.mu.Unlock()
		return errors.New("injected image task persistence failure")
	}
	s.mu.Unlock()
	return s.JSONDocumentBackend.SaveJSONDocument(name, value)
}

func (s *flakyImageTaskDocumentStore) SaveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveCount
}

func (s *flakyImageTaskDocumentStore) FailureCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failureCount
}

func waitForImageTaskSaveCalls(t *testing.T, store interface{ SaveCount() int }, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if store.SaveCount() >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("save calls did not reach %d; got %d", want, store.SaveCount())
}

func waitForPersistedImageTaskStatus(t *testing.T, store storage.JSONDocumentBackend, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		persisted, err := store.LoadJSONDocument("image_tasks.json")
		if err == nil {
			for _, task := range util.AsMapSlice(util.StringMap(persisted)["tasks"]) {
				if util.Clean(task["id"]) == taskID && util.Clean(task["status"]) == want {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("persisted task %s did not reach status %s", taskID, want)
}

func waitForStartedTask(t *testing.T, started <-chan string) string {
	t.Helper()
	select {
	case prompt := <-started:
		return prompt
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for task handler to start")
	}
	return ""
}

func waitForStartedImageIndex(t *testing.T, started <-chan int) int {
	t.Helper()
	select {
	case index := <-started:
		return index
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for image output to start")
	}
	return 0
}

func failingImageTaskHandler(context.Context, Identity, map[string]any) (map[string]any, error) {
	return nil, errors.New("unexpected handler call")
}

func waitForTaskStatus(t *testing.T, svc *ImageTaskService, identity Identity, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got := svc.ListTasks(identity, []string{taskID})
		items := got["items"].([]map[string]any)
		if len(items) == 1 && items[0]["status"] == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s did not reach status %s", taskID, want)
}

func waitForTaskData(t *testing.T, svc *ImageTaskService, identity Identity, taskID string, ok func([]map[string]any) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got := svc.ListTasks(identity, []string{taskID})
		items := got["items"].([]map[string]any)
		if len(items) == 1 {
			if data, _ := items[0]["data"].([]map[string]any); ok(data) {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s did not publish expected data", taskID)
}

func waitForTaskOutputStatusCounts(t *testing.T, svc *ImageTaskService, identity Identity, taskID string, want map[string]int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got := svc.ListTasks(identity, []string{taskID})
		items := got["items"].([]map[string]any)
		if len(items) == 1 {
			counts := map[string]int{}
			for _, status := range util.AsStringSlice(items[0]["output_statuses"]) {
				counts[status]++
			}
			matches := true
			for status, count := range want {
				if counts[status] != count {
					matches = false
					break
				}
			}
			if matches {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s output status counts did not reach %#v", taskID, want)
}
