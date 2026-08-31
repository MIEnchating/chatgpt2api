package service

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func (s *ImageTaskService) SubmitGeneration(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, n int, visibilityValues ...string) (map[string]any, error) {
	return s.SubmitGenerationWithOptions(ctx, identity, clientTaskID, prompt, model, size, quality, baseURL, n, nil, ImageOutputOptions{}, ImageToolOptions{}, visibilityValues...)
}

func (s *ImageTaskService) SubmitGenerationWithMetadata(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, n int, metadata map[string]any, visibilityValues ...string) (map[string]any, error) {
	return s.SubmitGenerationWithOptions(ctx, identity, clientTaskID, prompt, model, size, quality, baseURL, n, metadata, ImageOutputOptions{}, ImageToolOptions{}, visibilityValues...)
}

func (s *ImageTaskService) SubmitEdit(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, images any, n int, visibilityValues ...string) (map[string]any, error) {
	return s.SubmitEditWithOptions(ctx, identity, clientTaskID, prompt, model, size, quality, baseURL, images, n, nil, ImageOutputOptions{}, ImageToolOptions{}, visibilityValues...)
}

func (s *ImageTaskService) SubmitChat(ctx context.Context, identity Identity, clientTaskID, prompt, model string, messages any, nValues ...int) (map[string]any, error) {
	return s.SubmitChatWithMetadata(ctx, identity, clientTaskID, prompt, model, messages, nil, nValues...)
}

func (s *ImageTaskService) ListTasks(identity Identity, taskIDs []string) map[string]any {
	result, _ := s.ListTasksWithError(identity, taskIDs)
	if result == nil {
		return map[string]any{"items": []map[string]any{}, "missing_ids": []string{}}
	}
	return result
}

func (s *ImageTaskService) markImageOutputStatus(key string, index int, status string) bool {
	if index < 1 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.tasks[key]
	if task == nil || !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	count := storedImageOutputCount(task)
	if index > count {
		return false
	}
	statuses := normalizedImageOutputStatuses(util.Clean(task["mode"]), count, task["output_statuses"])
	if len(statuses) == 0 || !isActiveTaskStatus(statuses[index-1]) || statuses[index-1] == status {
		return true
	}
	statuses[index-1] = status
	task["output_statuses"] = statuses
	bumpImageTaskRevision(task)
	return true
}

func (s *ImageTaskService) markAllImageOutputStatuses(key string, status string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.tasks[key]
	if task == nil || !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	count := storedImageOutputCount(task)
	statuses := normalizedImageOutputStatuses(util.Clean(task["mode"]), count, task["output_statuses"])
	changed := false
	for index := range statuses {
		if isActiveTaskStatus(statuses[index]) && statuses[index] != status {
			statuses[index] = status
			changed = true
		}
	}
	if changed {
		task["output_statuses"] = statuses
		bumpImageTaskRevision(task)
	}
	return true
}

func TestImageTaskServiceRequiresVideoPromptForEveryModel(t *testing.T) {
	handlerCalls := make(chan map[string]any, 8)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/video.mp4"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	for _, testCase := range []struct {
		model  string
		images any
		videos any
		audios any
	}{
		{model: "sora-2"},
		{model: "topaz/video-upscale", videos: []string{"https://cdn.example.com/source.mp4"}},
		{model: "infinitalk/from-audio", images: []string{"https://cdn.example.com/avatar.png"}, audios: []string{"https://cdn.example.com/voice.mp3"}},
		{model: "kling-3-0-turbo", images: []string{"https://cdn.example.com/reference.png"}},
		{model: "i2v-01", images: []string{"https://cdn.example.com/reference.png"}},
	} {
		if _, err := svc.SubmitVideo(context.Background(), identity, testCase.model+"-task", "", testCase.model, "", 5, "", false, false, "reference", testCase.images, testCase.videos, testCase.audios, nil); err == nil || err.Error() != "prompt is required" {
			t.Fatalf("%s error = %v, want prompt is required", testCase.model, err)
		}
	}
	select {
	case payload := <-handlerCalls:
		t.Fatalf("promptless video reached handler: %#v", payload)
	default:
	}
}

func TestImageTaskServicePreservesDeclaredVideoGenerationMode(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/video.mp4"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	snapshot := map[string]any{"name": "MiniMax H3 v1.8"}
	if _, err := svc.SubmitVideo(context.Background(), identity, "video-generation-mode", "animate", "minimax-h3-768p", "16:9", 5, "768p", true, false, "reference", []string{"https://cdn.example.com/ref.png"}, nil, nil, map[string]any{
		"generation_mode":         "reference-to-video",
		"video_contract_snapshot": snapshot,
	}); err != nil {
		t.Fatalf("SubmitVideo() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "video-generation-mode", TaskStatusSuccess)
	payload := <-handlerCalls
	if payload["generation_mode"] != "reference-to-video" {
		t.Fatalf("video handler generation_mode = %#v", payload["generation_mode"])
	}
	if !reflect.DeepEqual(payload["video_contract_snapshot"], snapshot) {
		t.Fatalf("video handler contract snapshot = %#v", payload["video_contract_snapshot"])
	}
}

func TestImageTaskServiceTracksVideoQueueAndUpstreamProgress(t *testing.T) {
	queued := make(chan struct{})
	continueRunning := make(chan struct{})
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		callback := payload[VideoTaskProgressCallbackPayloadKey].(func(VideoTaskProgressUpdate))
		callback(VideoTaskProgressUpdate{Status: TaskStatusQueued, UpstreamStatus: "queued", Progress: 0, HasProgress: true})
		close(queued)
		<-continueRunning
		callback(VideoTaskProgressUpdate{Status: TaskStatusRunning, UpstreamStatus: "in_progress", Progress: 42, HasProgress: true})
		return map[string]any{"output_type": "video", "data": []map[string]any{{"video_url": "https://example.test/video.mp4"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	if _, err := svc.SubmitVideo(context.Background(), identity, "video-progress", "animate", "video-model", "16:9", 5, "1080p", false, false, "text", nil, nil, nil, nil); err != nil {
		t.Fatalf("SubmitVideo() error = %v", err)
	}
	<-queued
	items := svc.ListTasks(identity, []string{"video-progress"})["items"].([]map[string]any)
	if len(items) != 1 || items[0]["status"] != TaskStatusQueued || items[0]["upstream_status"] != "queued" || util.ToInt(items[0]["progress"], -1) != 0 {
		t.Fatalf("queued video task = %#v", items)
	}
	close(continueRunning)
	waitForTaskStatus(t, svc, identity, "video-progress", TaskStatusSuccess)
	items = svc.ListTasks(identity, []string{"video-progress"})["items"].([]map[string]any)
	if items[0]["upstream_status"] != "in_progress" || util.ToInt(items[0]["progress"], -1) != 42 {
		t.Fatalf("completed video progress = %#v", items[0])
	}
}

func TestImageTaskServiceDoesNotApplyLegacyVideoDurationLimit(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/video.mp4"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	if _, err := svc.SubmitVideo(context.Background(), identity, "video-long-duration", "animate", "future-video", "16:9", 61, "1080p", false, false, "first-frame", nil, nil, nil, nil); err != nil {
		t.Fatalf("SubmitVideo(61 seconds) error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "video-long-duration", TaskStatusSuccess)
	if payload := <-handlerCalls; payload["seconds"] != 61 {
		t.Fatalf("video handler seconds = %#v", payload["seconds"])
	}
	if _, err := svc.SubmitVideo(context.Background(), identity, "video-too-long", "animate", "future-video", "16:9", 3601, "1080p", false, false, "first-frame", nil, nil, nil, nil); err == nil {
		t.Fatal("SubmitVideo(3601 seconds) was accepted")
	}
}

func TestImageTaskServiceSubmitsSingleAudioOutput(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(_ context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"output_type": "audio", "data": []map[string]any{{"url": "/audios/result.mp3"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetAudioHandler(handler)
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	task, err := svc.SubmitAudio(context.Background(), identity, "audio-1", map[string]any{
		"input": "read this", "model": "gpt-4o-mini-tts", "voice": "verse", "response_format": "mp3", "speed": 1.25, "instructions": "calm",
	}, nil)
	if err != nil {
		t.Fatalf("SubmitAudio() error = %v", err)
	}
	if task["mode"] != "audio" || task["count"] != 1 {
		t.Fatalf("submitted audio task = %#v", task)
	}
	waitForTaskStatus(t, svc, identity, "audio-1", TaskStatusSuccess)
	payload := <-handlerCalls
	if payload["n"] != 1 || payload["voice"] != "verse" || payload["response_format"] != "mp3" || payload["speed"] != 1.25 || payload["instructions"] != "calm" {
		t.Fatalf("audio handler payload = %#v", payload)
	}
}

func TestImageTaskServiceIdempotencyOwnerIsolationAndCompletion(t *testing.T) {
	handlerCalls := make(chan map[string]any, 4)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })

	alice := Identity{ID: "alice", Name: "Alice", Role: "user"}
	bob := Identity{ID: "bob", Name: "Bob", Role: "user"}

	first, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
	if err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	second, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "different", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
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

	if _, err := svc.SubmitGeneration(context.Background(), oldKey, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, newKey, "task-1", TaskStatusSuccess)
	if got := svc.ListTasks(newKey, []string{"task-1"}); len(got["items"].([]map[string]any)) != 1 {
		t.Fatalf("rotated credential cannot see owner task: %#v", got)
	}
	if got := svc.ListTasks(otherOwner, []string{"task-1"}); len(got["items"].([]map[string]any)) != 0 || len(got["missing_ids"].([]string)) != 1 {
		t.Fatalf("other owner should not see task: %#v", got)
	}
	if _, err := svc.SubmitGeneration(context.Background(), newKey, "task-1", "different", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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
			return svc.SubmitGeneration(context.Background(), identity, "task-1", "  ", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
		},
		"edit": func() (map[string]any, error) {
			return svc.SubmitEdit(context.Background(), identity, "task-2", "\t", "gpt-image-2", "1024x1024", "high", "https://base.test", []any{"image"}, 1)
		},
		"chat": func() (map[string]any, error) {
			return svc.SubmitChat(context.Background(), identity, "task-3", " ", "auto", []map[string]any{{"role": "user", "content": "hello"}})
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

func TestImageTaskServiceUsesOnlyCurrentPromptForImageRequests(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "我之前说了什么？", "auto", "", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}

	var payload map[string]any
	select {
	case payload = <-handlerCalls:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	if _, ok := payload["messages"]; ok {
		t.Fatalf("payload retained image history: %#v", payload)
	}
	if got := payload["prompt"]; got != "我之前说了什么？" {
		t.Fatalf("payload prompt = %#v, want current prompt", got)
	}
	if got := payload["quality"]; got != "high" {
		t.Fatalf("payload quality = %#v, want high", got)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusSuccess)
}

func TestImageTaskServicePersistsWorkflowContext(t *testing.T) {
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/workflow.png"}}}, nil
	}
	backend := newTestStorageBackend(t)
	svc := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	workflowContext := map[string]any{
		"workflow_id":   "workflow-1",
		"workflow_name": "商品海报",
		"prompt":        "生成商品海报",
		"inputs":        map[string]any{"product": "背包"},
		"references":    []map[string]any{{"id": "reference-1", "name": "参考图", "url": "/images/reference.png", "temporary": true}},
		"config":        map[string]any{"image_model": "gpt-image-1.5", "size": "1024x1024", "quality": "high", "count": "1", "api_mode": "responses"},
		"count":         1,
		"series_title":  "封面",
		"series_index":  1,
		"batch_task_id": "workflow-batch-1",
		"batch_index":   1,
		"batch_count":   2,
	}
	if _, err := svc.SubmitGenerationWithMetadata(context.Background(), identity, "workflow-task-1", "生成商品海报", "auto", "", "high", "https://base.test", 1, map[string]any{"workflow_context": workflowContext}); err != nil {
		t.Fatalf("SubmitGenerationWithMetadata() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "workflow-task-1", TaskStatusSuccess)
	reloaded := NewStoredImageTaskService(backend, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	item := reloaded.ListTasks(identity, []string{"workflow-task-1"})["items"].([]map[string]any)[0]
	stored := util.StringMap(item["workflow_context"])
	if stored["workflow_id"] != "workflow-1" || stored["workflow_name"] != "商品海报" || stored["batch_task_id"] != "workflow-batch-1" || util.ToInt(stored["batch_count"], 0) != 2 || util.ToInt(stored["series_index"], 0) != 1 {
		t.Fatalf("workflow context = %#v", stored)
	}
	if references := util.AsMapSlice(stored["references"]); len(references) != 1 || util.Clean(references[0]["url"]) != "/images/reference.png" || !util.ToBool(references[0]["temporary"]) {
		t.Fatalf("workflow references = %#v", stored["references"])
	}
	if config := util.StringMap(stored["config"]); config["image_model"] != "gpt-image-1.5" || config["api_mode"] != "responses" {
		t.Fatalf("workflow config = %#v", stored["config"])
	}
}

func TestImageTaskServicePassesImageRequestMetadataToHandler(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGenerationWithMetadata(context.Background(), identity, "task-1", "draw", "gemini-3.1-flash-image", "1:1", "", "https://base.test", 1, map[string]any{"image_resolution": "512", "requested_size": "1:1", "token_group": "draw", "token_name": "image", "provider": "apimart", "image_provider": "apimart", "channel_protocol": "apimart", "provider_base_url": "https://api.apimart.ai"}); err != nil {
		t.Fatalf("SubmitGenerationWithMetadata() error = %v", err)
	}

	select {
	case payload := <-handlerCalls:
		if _, ok := payload["response_format"]; ok {
			t.Fatalf("payload should not include response_format: %#v", payload)
		}
		if got := payload["image_resolution"]; got != "512" {
			t.Fatalf("payload image_resolution = %#v, want 512 in %#v", got, payload)
		}
		if got := payload["requested_size"]; got != "1:1" {
			t.Fatalf("payload requested_size = %#v, want 1:1 in %#v", got, payload)
		}
		if got := payload["token_group"]; got != "draw" {
			t.Fatalf("payload token_group = %#v, want draw in %#v", got, payload)
		}
		if got := payload["token_name"]; got != "image" {
			t.Fatalf("payload token_name = %#v, want image in %#v", got, payload)
		}
		for _, key := range []string{"provider", "image_provider", "channel_protocol"} {
			if got := payload[key]; got != "apimart" {
				t.Fatalf("payload %s = %#v, want apimart in %#v", key, got, payload)
			}
		}
		if got := payload["provider_base_url"]; got != "https://api.apimart.ai" {
			t.Fatalf("payload provider_base_url = %#v in %#v", got, payload)
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

	if _, err := svc.SubmitGenerationWithOptions(context.Background(), identity, "task-1", "draw", "gpt-image-2", "16:9", "high", "https://base.test", 1, nil, ImageOutputOptions{Format: "webp"}, ImageToolOptions{Moderation: "auto", Stream: true, PartialImages: 2}); err != nil {
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

func TestImageTaskServicePreservesExplicitZeroPartialImages(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGenerationWithOptions(context.Background(), identity, "task-zero-partials", "draw", "gpt-image-2", "1:1", "auto", "https://base.test", 1, nil, ImageOutputOptions{}, ImageToolOptions{Stream: true, PartialImages: 0, PartialImagesSet: true}); err != nil {
		t.Fatalf("SubmitGenerationWithOptions() error = %v", err)
	}

	select {
	case payload := <-handlerCalls:
		if got, ok := payload["partial_images"]; !ok || got != 0 {
			t.Fatalf("payload partial_images = %#v, present = %v; want explicit 0 in %#v", got, ok, payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	waitForTaskStatus(t, svc, identity, "task-zero-partials", TaskStatusSuccess)
}

func TestImageTaskServiceDoesNotPersistRawMaskData(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}
	mask := "data:image/png;base64,bWFzaw=="

	task, err := svc.SubmitEditWithOptions(context.Background(), identity, "task-mask", "edit", "gpt-image-2", "1024x1024", "high", "https://base.test", []string{"source"}, 1, nil, ImageOutputOptions{}, ImageToolOptions{InputImageMask: mask}, ImageVisibilityPrivate)
	if err != nil {
		t.Fatalf("SubmitEditWithOptions() error = %v", err)
	}
	if _, ok := task["input_image_mask"]; ok {
		t.Fatalf("public task contains raw mask data: %#v", task)
	}

	select {
	case payload := <-handlerCalls:
		if payload["input_image_mask"] != mask {
			t.Fatalf("handler mask = %#v, want transient mask", payload["input_image_mask"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}
	waitForTaskStatus(t, svc, identity, "task-mask", TaskStatusSuccess)
	listed, err := svc.ListTasksWithError(identity, []string{"task-mask"})
	if err != nil {
		t.Fatalf("ListTasksWithError() error = %v", err)
	}
	items := anyList(listed["items"])
	if len(items) != 1 {
		t.Fatalf("listed tasks = %#v", listed)
	}
	if _, ok := items[0].(map[string]any)["input_image_mask"]; ok {
		t.Fatalf("stored task contains raw mask data: %#v", items[0])
	}
}

func TestImageTaskServiceMergesConcurrentDatabaseDocumentUpdates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-tasks.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	serviceA := newImageTaskService(backendA, nil, nil, nil, func() int { return 30 })
	serviceB := newImageTaskService(backendB, nil, nil, nil, func() int { return 30 })
	newTask := func(id string) map[string]any {
		now := util.NowISO()
		return map[string]any{
			"id": id, "owner_id": "owner", "status": TaskStatusSuccess,
			"mode": "generate", "model": "gpt-image-2", "count": 1,
			"revision": 1, "created_at": now, "updated_at": now,
		}
	}

	serviceA.mu.Lock()
	serviceA.tasks[taskKey("owner", "task-a")] = newTask("task-a")
	err = serviceA.saveLocked()
	serviceA.mu.Unlock()
	if err != nil {
		t.Fatalf("service A saveLocked() error = %v", err)
	}

	serviceB.mu.Lock()
	serviceB.tasks[taskKey("owner", "task-b")] = newTask("task-b")
	err = serviceB.saveLocked()
	serviceB.mu.Unlock()
	if err != nil {
		t.Fatalf("service B saveLocked() error = %v", err)
	}

	raw, err := backendB.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	ids := map[string]bool{}
	for _, task := range util.AsMapSlice(util.StringMap(raw)["tasks"]) {
		ids[util.Clean(task["id"])] = true
	}
	if !ids["task-a"] || !ids["task-b"] || len(ids) != 2 {
		t.Fatalf("concurrent task document lost an update: %#v", raw)
	}
}

func TestImageTaskServiceClaimsDuplicateTaskAcrossDatabaseInstances(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-idempotency.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	started := make(chan string, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseHandler()
	handler := func(ctx context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		started <- util.Clean(payload["prompt"])
		select {
		case <-release:
			return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	serviceA := newImageTaskService(backendA, handler, handler, handler, func() int { return 30 })
	serviceB := newImageTaskService(backendB, handler, handler, handler, func() int { return 30 })
	t.Cleanup(func() { _ = serviceA.Close() })
	t.Cleanup(func() { _ = serviceB.Close() })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}

	first, err := serviceA.SubmitGeneration(context.Background(), identity, "shared-task", "first", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
	if err != nil {
		t.Fatalf("service A SubmitGeneration() error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "first" {
		t.Fatalf("service A started prompt = %q, want first", got)
	}
	second, err := serviceB.SubmitGeneration(context.Background(), identity, "shared-task", "second", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
	if err != nil {
		t.Fatalf("service B duplicate SubmitGeneration() error = %v", err)
	}
	if first["id"] != second["id"] {
		t.Fatalf("duplicate task IDs differ: first=%#v second=%#v", first, second)
	}
	select {
	case prompt := <-started:
		t.Fatalf("duplicate task started a second upstream request with prompt %q", prompt)
	case <-time.After(150 * time.Millisecond):
	}

	releaseHandler()
	waitForTaskStatus(t, serviceA, identity, "shared-task", TaskStatusSuccess)
}

func TestImageTaskServicePropagatesCancellationAcrossDatabaseInstances(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-cancellation.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	started := make(chan struct{})
	stopped := make(chan struct{})
	var startedOnce sync.Once
	var stoppedOnce sync.Once
	handler := func(ctx context.Context, _ Identity, _ map[string]any) (map[string]any, error) {
		startedOnce.Do(func() { close(started) })
		<-ctx.Done()
		stoppedOnce.Do(func() { close(stopped) })
		return nil, ctx.Err()
	}
	serviceA := newImageTaskService(backendA, handler, handler, handler, func() int { return 30 })
	serviceB := newImageTaskService(backendB, handler, handler, handler, func() int { return 30 })
	t.Cleanup(func() { _ = serviceA.Close() })
	t.Cleanup(func() { _ = serviceB.Close() })
	identity := Identity{ID: "alice", Name: "Alice", Role: AuthRoleUser}
	if _, err := serviceA.SubmitGeneration(context.Background(), identity, "cancel-across-instances", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for task handler")
	}
	if _, err := serviceB.CancelTask(identity, "cancel-across-instances"); err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("remote cancellation did not stop the owning handler")
	}
	waitForTaskStatus(t, serviceA, identity, "cancel-across-instances", TaskStatusCancelled)
}

func TestImageTaskServicePreservesUnspecifiedOutputFormat(t *testing.T) {
	handlerCalls := make(chan map[string]any, 1)
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		handlerCalls <- payload
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.jpg", "output_format": "jpeg"}}}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	submitted, err := svc.SubmitGenerationWithOptions(context.Background(), identity, "task-no-format", "draw", "grok-imagine-image", "", "", "https://base.test", 1, nil, ImageOutputOptions{}, ImageToolOptions{})
	if err != nil {
		t.Fatalf("SubmitGenerationWithOptions() error = %v", err)
	}
	if _, ok := submitted["output_format"]; ok {
		t.Fatalf("submitted task invented output_format: %#v", submitted)
	}

	select {
	case payload := <-handlerCalls:
		if _, ok := payload["output_format"]; ok {
			t.Fatalf("handler payload invented output_format: %#v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler payload")
	}

	waitForTaskStatus(t, svc, identity, "task-no-format", TaskStatusSuccess)
	completed := svc.ListTasks(identity, []string{"task-no-format"})["items"].([]map[string]any)[0]
	if _, ok := completed["output_format"]; ok {
		t.Fatalf("completed task invented task-level output_format: %#v", completed)
	}
	data := util.AsMapSlice(completed["data"])
	if len(data) != 1 || data[0]["output_format"] != "jpeg" {
		t.Fatalf("completed task lost actual item format: %#v", completed)
	}
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
	tools := []map[string]any{{"type": "function", "function": map[string]any{"name": "get_canvas_summary"}}}

	if _, err := svc.SubmitChatWithMetadata(context.Background(), identity, "chat-1", "hello", "auto", messages, map[string]any{"token_group": "draw", "token_name": "codex", "tools": tools, "tool_choice": "auto"}); err != nil {
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
		if got := util.AsMapSlice(payload["tools"]); len(got) != 1 || util.Clean(util.StringMap(got[0]["function"])["name"]) != "get_canvas_summary" {
			t.Fatalf("chat payload tools = %#v", payload["tools"])
		}
		if got := payload["tool_choice"]; got != "auto" {
			t.Fatalf("chat payload tool_choice = %#v, want auto in %#v", got, payload)
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

	if _, err := svc.SubmitChat(context.Background(), identity, "chat-stream", "hello", "gpt-5.5", messages); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "first", "gpt-image-2", "1024x1024", "high", "https://base.test", 4); err != nil {
		t.Fatalf("SubmitGeneration(first) error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "first" {
		t.Fatalf("started task = %q, want first", got)
	}
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-2", "second", "gpt-image-2", "1024x1024", "high", "https://base.test", 4); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-preview", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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

	submitted, err := svc.SubmitGeneration(context.Background(), identity, "task-union", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2)
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
	observerService := newImageTaskService(documentStore, failingImageTaskHandler, failingImageTaskHandler, failingImageTaskHandler, func() int { return 30 })
	observedTask := observerService.ListTasks(identity, []string{"task-union"})["items"].([]map[string]any)[0]
	if observedTask["status"] != TaskStatusRunning {
		t.Fatalf("a second service interrupted an active task: %#v", observedTask)
	}

	finishOnce.Do(func() { close(finish) })
	waitForTaskStatus(t, svc, identity, "task-union", TaskStatusSuccess)
	waitForTaskStatus(t, observerService, identity, "task-union", TaskStatusSuccess)
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
	t.Cleanup(func() { _ = svc.Close() })
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

func TestImageTaskCountUsesSelectedModelLimit(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    int
	}{
		{name: "GPT permits fifteen outputs", payload: map[string]any{"model": "gpt-image-2", "n": 15}, want: 15},
		{name: "GPT clamps oversized count", payload: map[string]any{"model": "gpt-image-2", "n": 16}, want: 15},
		{name: "Gemini uses the shared canvas limit", payload: map[string]any{"model": "gemini-3.1-flash-image", "n": 15}, want: 15},
		{name: "stored count uses task model", payload: map[string]any{"model": "gpt-image-2", "count": 15}, want: 15},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := imageTaskCount(test.payload); got != test.want {
				t.Fatalf("imageTaskCount(%#v) = %d, want %d", test.payload, got, test.want)
			}
		})
	}
}

func TestImageTaskServiceAcceptsMaximumGPTOutputUnits(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })
	admin := Identity{ID: "admin", Name: "Admin", Role: AuthRoleAdmin}

	release, err := svc.AcquireCreationUnits(context.Background(), admin, util.MaxImageOutputCount("gpt-image-2"))
	if err != nil {
		t.Fatalf("AcquireCreationUnits() rejected a valid GPT image request: %v", err)
	}
	release()
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

	if _, err := svc.SubmitGeneration(context.Background(), alice, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3); err != nil {
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

	if _, err := svc.SubmitEdit(context.Background(), alice, "edit-1", "edit", "gpt-image-2", "1024x1024", "high", "https://base.test", []any{"image"}, 2); err != nil {
		t.Fatalf("SubmitEdit(edit-1) error = %v", err)
	}
	if got := waitForStartedTask(t, started); got != "image" {
		t.Fatalf("started task = %q, want image", got)
	}
	if got := waitForStartedTask(t, started); got != "image" {
		t.Fatalf("started task = %q, want image", got)
	}
	if _, err := svc.SubmitChat(context.Background(), alice, "chat-1", "hello", "auto", messages); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), user, "task-1", "first", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration(first) error = %v", err)
	}
	waitForTaskStatus(t, svc, user, "task-1", TaskStatusSuccess)
	if _, err := svc.SubmitGeneration(context.Background(), user, "task-2", "second", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err == nil {
		t.Fatal("SubmitGeneration(second) error = nil, want RPM limit")
	} else {
		var limitErr ImageTaskLimitError
		if !errors.As(err, &limitErr) {
			t.Fatalf("SubmitGeneration(second) error = %T %v, want ImageTaskLimitError", err, err)
		}
	}
	if _, err := svc.SubmitGeneration(context.Background(), admin, "task-1", "admin first", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("admin should bypass user RPM limit: %v", err)
	}
	if _, err := svc.SubmitGeneration(context.Background(), admin, "task-2", "admin second", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-wide", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3); err != nil {
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

	submitted, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-partial-cancel", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 2); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "task-1", TaskStatusError)
	got := svc.ListTasks(identity, []string{"task-1"})
	item := got["items"].([]map[string]any)[0]
	if item["error"] != "图片生成超时，请稍后重试或降低分辨率" {
		t.Fatalf("timeout error = %#v", item)
	}
}

func TestImageTaskServiceHonorsVideoContractTimeout(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		timer := time.NewTimer(50 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return map[string]any{"output_type": "video", "data": []map[string]any{{"url": "https://example.test/video.mp4"}}}, nil
		}
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	svc.SetVideoHandler(handler)
	svc.SetTaskTimeoutGetter(func() time.Duration { return 20 * time.Millisecond })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	task, err := svc.SubmitVideo(context.Background(), identity, "video-contract-timeout", "animate", "future-video", "16:9", 5, "1080p", false, false, "text", nil, nil, nil, map[string]any{
		VideoTaskTimeoutSecondsPayloadKey: 1,
	})
	if err != nil {
		t.Fatalf("SubmitVideo() error = %v", err)
	}
	if task[VideoTaskTimeoutSecondsPayloadKey] != nil {
		t.Fatalf("private timeout leaked into public task: %#v", task)
	}
	waitForTaskStatus(t, svc, identity, "video-contract-timeout", TaskStatusSuccess)
}

func TestImageTaskServicePreservesTextOutputType(t *testing.T) {
	handler := func(ctx context.Context, identity Identity, payload map[string]any) (map[string]any, error) {
		return map[string]any{"message": "text response", "output_type": "text"}, nil
	}
	svc := newTestImageTaskService(t, handler, handler, handler, func() int { return 30 })
	identity := Identity{ID: "alice", Name: "Alice", Role: "user"}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "who are you", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "who are you", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-atomic-running", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 4); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-1", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 3); err != nil {
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

	result, err := svc.SubmitGeneration(context.Background(), identity, "task-save-failure", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
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

func TestImageTaskServiceRetriesInitialLoadWithoutOverwritingStoredTasks(t *testing.T) {
	backend := newTestStorageBackend(t)
	documentStore, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement JSONDocumentBackend", backend)
	}
	identity := Identity{ID: "load-retry-owner", Name: "Alice", Role: AuthRoleUser}
	stored := map[string]any{
		"tasks": []map[string]any{{
			"id":         "stored-task",
			"owner_id":   ownerID(identity),
			"status":     TaskStatusSuccess,
			"mode":       "generate",
			"model":      "gpt-image-2",
			"count":      1,
			"revision":   1,
			"created_at": util.NowISO(),
			"updated_at": util.NowISO(),
			"data":       []map[string]any{{"url": "https://example.test/stored.png"}},
		}},
	}
	if err := documentStore.SaveJSONDocument("image_tasks.json", stored); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}
	store := &flakyImageTaskLoadStore{JSONDocumentBackend: documentStore, failNext: 2}
	handlerCalls := make(chan struct{}, 1)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		handlerCalls <- struct{}{}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/new.png"}}}, nil
	}
	svc := newImageTaskService(store, handler, handler, handler, func() int { return 30 })

	result, err := svc.SubmitGeneration(context.Background(), identity, "new-task", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1)
	var loadErr ImageTaskLoadError
	if result != nil || !errors.As(err, &loadErr) {
		t.Fatalf("SubmitGeneration() result = %#v, error = %v; want ImageTaskLoadError", result, err)
	}
	select {
	case <-handlerCalls:
		t.Fatal("handler ran before stored tasks were loaded")
	case <-time.After(100 * time.Millisecond):
	}
	persisted, err := documentStore.LoadJSONDocument("image_tasks.json")
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	items := util.AsMapSlice(util.StringMap(persisted)["tasks"])
	if len(items) != 1 || util.Clean(items[0]["id"]) != "stored-task" {
		t.Fatalf("stored tasks changed after load failure: %#v", items)
	}

	if _, err := svc.SubmitGeneration(context.Background(), identity, "new-task", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() after recovery error = %v", err)
	}
	waitForTaskStatus(t, svc, identity, "new-task", TaskStatusSuccess)
	loaded, err := svc.ListTasksWithError(identity, []string{"stored-task", "new-task"})
	if err != nil {
		t.Fatalf("ListTasksWithError() error = %v", err)
	}
	if got := loaded["items"].([]map[string]any); len(got) != 2 {
		t.Fatalf("ListTasksWithError() items = %#v", got)
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-terminal-retry", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
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

	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-close", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err != nil {
		t.Fatalf("SubmitGeneration() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for active task")
	}

	closed := make(chan struct{})
	var closeErr error
	go func() {
		closeErr = svc.Close()
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
	if closeErr != nil {
		t.Fatalf("Close() error = %v", closeErr)
	}

	items := svc.ListTasks(identity, []string{"task-close"})["items"].([]map[string]any)
	if len(items) != 1 || items[0]["status"] != TaskStatusCancelled {
		t.Fatalf("closed task = %#v, want cancelled", items)
	}
	waitForPersistedImageTaskStatus(t, documentStore, "task-close", TaskStatusCancelled)
	if _, err := svc.SubmitGeneration(context.Background(), identity, "task-after-close", "draw", "gpt-image-2", "1024x1024", "high", "https://base.test", 1); err == nil || !strings.Contains(err.Error(), "service is closed") {
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
	var closeErr error
	go func() {
		closeErr = svc.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() blocked on permanent persistence failure")
	}
	if closeErr == nil || !strings.Contains(closeErr.Error(), "injected permanent image task persistence failure") {
		t.Fatalf("Close() error = %v, want persistence failure", closeErr)
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
	if secondErr := svc.Close(); secondErr != closeErr {
		t.Fatalf("second Close() error = %v, want same error %v", secondErr, closeErr)
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

func TestImageTaskServiceDeleteTasksPersistsOwnerScopedTerminalDeletion(t *testing.T) {
	backend := newTestStorageBackend(t)
	handler := func(context.Context, Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}, nil
	}
	svc := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })
	alice := Identity{ID: "alice"}
	bob := Identity{ID: "bob"}

	for _, item := range []struct {
		identity Identity
		id       string
	}{{alice, "alice-done"}, {bob, "bob-done"}} {
		if _, err := svc.SubmitGenerationWithOptions(context.Background(), item.identity, item.id, "draw", "gpt-image-2", "1024x1024", "high", "", 1, nil, ImageOutputOptions{}, ImageToolOptions{}); err != nil {
			t.Fatalf("SubmitGenerationWithOptions(%s) error = %v", item.id, err)
		}
		waitForTaskStatus(t, svc, item.identity, item.id, TaskStatusSuccess)
	}
	svc.mu.Lock()
	now := util.NowISO()
	svc.tasks[taskKey("alice", "alice-running")] = map[string]any{
		"id": "alice-running", "owner_id": "alice", "status": TaskStatusRunning,
		"mode": "generate", "model": "gpt-image-2", "count": 1,
		"revision": 1, "created_at": now, "updated_at": now,
	}
	svc.mu.Unlock()

	result, err := svc.DeleteTasks(alice, []string{"alice-done", "alice-running", "bob-done", "missing"})
	if err != nil {
		t.Fatalf("DeleteTasks() error = %v", err)
	}
	if got := util.AsStringSlice(result["deleted_ids"]); !reflect.DeepEqual(got, []string{"alice-done"}) {
		t.Fatalf("deleted_ids = %#v", got)
	}
	if got := util.AsStringSlice(result["missing_ids"]); !reflect.DeepEqual(got, []string{"bob-done", "missing"}) {
		t.Fatalf("missing_ids = %#v", got)
	}
	if got := util.AsStringSlice(result["active_ids"]); !reflect.DeepEqual(got, []string{"alice-running"}) {
		t.Fatalf("active_ids = %#v", got)
	}

	reloaded := NewStoredImageTaskService(backend, handler, handler, handler, func() int { return 30 })
	t.Cleanup(func() { _ = reloaded.Close() })
	if got := reloaded.ListTasks(alice, []string{"alice-done"}); len(got["items"].([]map[string]any)) != 0 {
		t.Fatalf("deleted task returned after reload: %#v", got)
	}
	if got := reloaded.ListTasks(bob, []string{"bob-done"}); len(got["items"].([]map[string]any)) != 1 {
		t.Fatalf("other owner's task was deleted: %#v", got)
	}
	if got := reloaded.ListTasks(alice, []string{"alice-running"}); len(got["items"].([]map[string]any)) != 1 {
		t.Fatalf("active task was deleted: %#v", got)
	}
}

func TestImageTaskServiceDeletionTombstonePreventsConcurrentResurrection(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "deleted-tasks.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	serviceA := newImageTaskService(backendA, nil, nil, nil, func() int { return 30 })
	now := util.NowISO()
	serviceA.mu.Lock()
	serviceA.tasks[taskKey("owner", "task-a")] = map[string]any{
		"id": "task-a", "owner_id": "owner", "status": TaskStatusSuccess,
		"mode": "generate", "model": "gpt-image-2", "count": 1,
		"revision": 1, "created_at": now, "updated_at": now,
	}
	err = serviceA.saveLocked()
	serviceA.mu.Unlock()
	if err != nil {
		t.Fatalf("seed task save error = %v", err)
	}
	serviceB := newImageTaskService(backendB, nil, nil, nil, func() int { return 30 })

	if _, err := serviceA.DeleteTasks(Identity{ID: "owner"}, []string{"task-a"}); err != nil {
		t.Fatalf("DeleteTasks() error = %v", err)
	}
	serviceB.mu.Lock()
	serviceB.tasks[taskKey("owner", "task-b")] = map[string]any{
		"id": "task-b", "owner_id": "owner", "status": TaskStatusSuccess,
		"mode": "generate", "model": "gpt-image-2", "count": 1,
		"revision": 1, "created_at": now, "updated_at": now,
	}
	err = serviceB.saveLocked()
	serviceB.mu.Unlock()
	if err != nil {
		t.Fatalf("concurrent save error = %v", err)
	}

	observer := newImageTaskService(backendA, nil, nil, nil, func() int { return 30 })
	got := observer.ListTasks(Identity{ID: "owner"}, []string{"task-a", "task-b"})
	items := got["items"].([]map[string]any)
	if len(items) != 1 || util.Clean(items[0]["id"]) != "task-b" {
		t.Fatalf("deleted task was resurrected: %#v", got)
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

type flakyImageTaskLoadStore struct {
	storage.JSONDocumentBackend
	mu       sync.Mutex
	failNext int
}

func (s *flakyImageTaskLoadStore) LoadJSONDocument(name string) (any, error) {
	s.mu.Lock()
	if s.failNext > 0 {
		s.failNext--
		s.mu.Unlock()
		return nil, errors.New("injected image task load failure")
	}
	s.mu.Unlock()
	return s.JSONDocumentBackend.LoadJSONDocument(name)
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
