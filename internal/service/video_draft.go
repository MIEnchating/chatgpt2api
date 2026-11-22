package service

import (
	"fmt"

	"chatgpt2api/internal/util"
)

// The local task ID is resolved under the caller's ownership, never trusted as an upstream ID.
func (s *ImageTaskService) VideoDraftSource(identity Identity, id string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.prepareTaskReadLocked(); err != nil {
		return nil, err
	}
	task := s.tasks[taskKey(ownerID(identity), id)]
	if task == nil || task["mode"] != "video" || task["status"] != TaskStatusSuccess || task["draft"] != true {
		return nil, fmt.Errorf("样片任务不存在、未完成或不属于当前账号")
	}
	origin := util.StringMap(task["video_draft_origin"])
	taskID := util.Clean(task["upstream_task_id"])
	if taskID == "" || util.Clean(origin["base_url"]) == "" {
		return nil, fmt.Errorf("样片缺少原始渠道和任务信息，无法生成正片")
	}
	return map[string]any{"model": task["model"], "seconds": task["seconds"], "size": task["size"], "generate_audio": task["generate_audio"], "watermark": task["watermark"], "draft_task_id": taskID, "token_name": util.Clean(origin["token_name"]), "token_group": util.Clean(origin["token_group"]), "base_url": util.Clean(origin["base_url"])}, nil
}
