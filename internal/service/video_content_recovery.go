package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const VideoTaskRecoveryPayloadKey = "_video_task_recovery"

// VideoTaskRecovery stores original query/download coordinates without credentials.
type VideoTaskRecovery struct {
	TaskID       string
	URL          string
	BaseURL      string
	AllowedHosts []string
	TokenName    string
	TokenGroup   string
	Model        string
	QueryPath    string
	Contract     json.RawMessage
}

func (r VideoTaskRecovery) document() map[string]any {
	return map[string]any{"task_id": r.TaskID, "url": r.URL, "base_url": r.BaseURL, "allowed_hosts": r.AllowedHosts, "token_name": r.TokenName, "token_group": r.TokenGroup, "model": r.Model, "query_path": r.QueryPath, "contract": r.Contract}
}

func videoTaskRecovery(task map[string]any) *VideoTaskRecovery {
	data := util.StringMap(task["video_recovery"])
	r := VideoTaskRecovery{TaskID: util.Clean(data["task_id"]), URL: util.Clean(data["url"]), BaseURL: util.Clean(data["base_url"]), AllowedHosts: util.AsStringSlice(data["allowed_hosts"]), TokenName: util.Clean(data["token_name"]), TokenGroup: util.Clean(data["token_group"]), Model: util.Clean(data["model"]), QueryPath: util.Clean(data["query_path"])}
	if data["contract"] != nil {
		encoded, err := json.Marshal(data["contract"])
		if err != nil {
			return nil
		}
		r.Contract = encoded
	}
	if r.TaskID == "" || r.BaseURL == "" {
		return nil
	}
	if r.URL == "" && (r.QueryPath == "" || r.Model == "" || len(r.Contract) == 0 || string(r.Contract) == "null") {
		return nil
	}
	return &r
}

func (s *ImageTaskService) SetVideoRecoveryHandler(handler ImageTaskHandler) {
	s.videoRecovery = handler
}

// RecoverVideoTask claims one observation worker; it never invokes generation.
func (s *ImageTaskService) RecoverVideoTask(identity Identity, taskID string) (map[string]any, error) {
	key := taskKey(ownerID(identity), strings.TrimSpace(taskID))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.closed {
		return nil, ErrImageTaskServiceClosed
	}
	if err := s.ensureLoadedLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	task := s.tasks[key]
	if task == nil || util.Clean(task["mode"]) != "video" {
		return nil, fmt.Errorf("视频任务不存在")
	}
	if task["status"] == TaskStatusSuccess || isActiveTaskStatus(util.Clean(task["status"])) {
		return publicTask(task, identity), nil
	}
	recovery := videoTaskRecovery(task)
	if recovery == nil {
		return nil, fmt.Errorf("此任务没有可恢复的原视频任务")
	}
	if s.videoRecovery == nil {
		return nil, fmt.Errorf("视频恢复处理器未配置")
	}
	originalRevision := util.ToInt(task["revision"], 0)
	original := util.CopyMap(task)
	claimed := false
	for attempt := 0; attempt < imageTaskInsertMaxAttempts; attempt++ {
		candidate := util.CopyMap(task)
		candidate["status"], candidate["error"] = TaskStatusQueued, ""
		delete(candidate, "progress")
		candidate["video_recovery_attempt"] = util.ToInt(task["video_recovery_attempt"], 0) + 1
		bumpImageTaskRevision(candidate)
		s.tasks[key] = candidate
		err := s.persistLocked()
		if err == nil {
			task = candidate
			claimed = true
			break
		}
		s.tasks[key] = original
		if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
			return nil, ImageTaskPersistenceError{Err: err}
		}
		remote, err := s.loadLocked()
		if err != nil {
			return nil, ImageTaskLoadError{Err: err}
		}
		local := make(map[string]map[string]any, len(s.tasks))
		for k, v := range s.tasks {
			if k != key {
				local[k] = v
			}
		}
		s.tasks = s.mergeTaskMapsLocked(remote, local)
		task = s.tasks[key]
		if task == nil {
			return nil, fmt.Errorf("视频任务已被删除")
		}
		if util.ToInt(task["revision"], 0) != originalRevision {
			return publicTask(task, identity), nil
		}
	}
	if !claimed {
		return nil, ImageTaskPersistenceError{Err: storage.ErrConcurrentRowUpdate}
	}
	// A newer observation attempt fences late callbacks from a previous worker.
	ctx, cancel := context.WithCancel(context.Background())
	s.cancels[key] = cancel
	payload := map[string]any{"client_task_id": taskID, "owner_id": ownerID(identity), "model": task["model"], VideoTaskRecoveryPayloadKey: recovery, "video_recovery_attempt": task["video_recovery_attempt"], VideoTaskTimeoutSecondsPayloadKey: task["timeout_seconds"]}
	s.taskWorkers.Add(1)
	s.startRemoteMonitorLocked()
	s.notifyTaskSubscribersLocked()
	result := publicTask(task, identity)
	go func() {
		defer s.taskWorkers.Done()
		defer s.recoverTaskPanic(key, util.ToInt(payload["video_recovery_attempt"], 0))
		s.runTask(ctx, key, "video", identity, payload)
	}()
	return result, nil
}
