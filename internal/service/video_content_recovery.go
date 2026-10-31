package service

import (
	"context"
	"fmt"
	"strings"

	"chatgpt2api/internal/util"
)

// VideoContentRecovery stores download coordinates, never channel credentials.
type VideoContentRecovery struct {
	TaskID       string
	URL          string
	BaseURL      string
	AllowedHosts []string
	TokenName    string
	TokenGroup   string
}

func (r VideoContentRecovery) document() map[string]any {
	return map[string]any{"task_id": r.TaskID, "url": r.URL, "base_url": r.BaseURL, "allowed_hosts": r.AllowedHosts, "token_name": r.TokenName, "token_group": r.TokenGroup}
}

func videoContentRecovery(task map[string]any) *VideoContentRecovery {
	data := util.StringMap(task["video_recovery"])
	r := VideoContentRecovery{
		TaskID: util.Clean(data["task_id"]), URL: util.Clean(data["url"]), BaseURL: util.Clean(data["base_url"]),
		AllowedHosts: util.AsStringSlice(data["allowed_hosts"]), TokenName: util.Clean(data["token_name"]), TokenGroup: util.Clean(data["token_group"]),
	}
	if r.TaskID == "" || r.URL == "" || r.BaseURL == "" {
		return nil
	}
	return &r
}

// RecoverVideoContent retries only artifact storage for an owned completed video.
type videoRecoveryCall struct {
	done   chan struct{}
	result map[string]any
	err    error
}

// RecoverVideoContent coalesces concurrent recoveries of one task so the artifact is stored once.
func (s *ImageTaskService) RecoverVideoContent(ctx context.Context, identity Identity, taskID string, download func(context.Context, VideoContentRecovery) (string, error)) (map[string]any, error) {
	key := taskKey(ownerID(identity), strings.TrimSpace(taskID))
	s.recoveryMu.Lock()
	if call := s.recoveryCalls[key]; call != nil {
		s.recoveryMu.Unlock()
		select {
		case <-call.done:
			if call.result != nil {
				return util.CopyMap(call.result), call.err
			}
			return nil, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &videoRecoveryCall{done: make(chan struct{}), err: fmt.Errorf("视频恢复被中断")}
	if s.recoveryCalls == nil {
		s.recoveryCalls = map[string]*videoRecoveryCall{}
	}
	s.recoveryCalls[key] = call
	s.recoveryMu.Unlock()
	// Cleanup is deferred so a panicking download cannot leave waiters blocked.
	defer func() {
		s.recoveryMu.Lock()
		delete(s.recoveryCalls, key)
		s.recoveryMu.Unlock()
		close(call.done)
	}()
	call.result, call.err = s.recoverVideoContentOnce(ctx, identity, taskID, download)
	return call.result, call.err
}

func (s *ImageTaskService) recoverVideoContentOnce(ctx context.Context, identity Identity, taskID string, download func(context.Context, VideoContentRecovery) (string, error)) (map[string]any, error) {
	key := taskKey(ownerID(identity), strings.TrimSpace(taskID))
	s.mu.Lock()
	if s.stopping || s.closed {
		s.mu.Unlock()
		return nil, ErrImageTaskServiceClosed
	}
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	task := s.tasks[key]
	if task == nil || util.Clean(task["mode"]) != "video" {
		s.mu.Unlock()
		return nil, fmt.Errorf("视频任务不存在")
	}
	if util.Clean(task["status"]) == TaskStatusSuccess {
		result := publicTask(task, identity)
		s.mu.Unlock()
		return result, nil
	}
	recovery := videoContentRecovery(task)
	if util.Clean(task["status"]) != TaskStatusError || recovery == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("此任务没有可恢复的已生成视频")
	}
	s.mu.Unlock()
	localURL, err := download(ctx, *recovery)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(localURL, "/videos/") {
		return nil, fmt.Errorf("视频保存未返回本地成品")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.closed {
		return nil, ErrImageTaskServiceClosed
	}
	if err := s.refreshTasksLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	task = s.tasks[key]
	current := videoContentRecovery(task)
	if task == nil || current == nil || current.TaskID != recovery.TaskID || current.URL != recovery.URL {
		return nil, fmt.Errorf("视频任务已被删除或更改")
	}
	if util.Clean(task["status"]) == TaskStatusSuccess {
		return publicTask(task, identity), nil
	}
	if util.Clean(task["status"]) != TaskStatusError {
		return nil, fmt.Errorf("视频任务状态已更改")
	}
	task["status"], task["error"], task["output_type"], task["progress"] = TaskStatusSuccess, "", "video", 100
	task["data"] = []map[string]any{{"url": localURL, "video_url": localURL, "type": "video", "mime_type": "video/mp4"}}
	bumpImageTaskRevision(task)
	if err := s.saveWithRetryLocked(); err != nil {
		return nil, ImageTaskPersistenceError{Err: err}
	}
	return publicTask(task, identity), nil
}
