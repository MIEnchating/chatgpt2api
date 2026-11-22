package httpapi

import (
	"fmt"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) resolveVideoDraft(identity service.Identity, body map[string]any, contract protocol.VideoModelContract) error {
	delete(body, "draft_source_base_url")
	if _, present := body["draft_task_id"]; present {
		return fmt.Errorf("生成正片请传本站样片任务 ID：draft_source_task_id")
	}
	if draft, exists := body["draft"]; exists {
		if _, ok := draft.(bool); !ok {
			return fmt.Errorf("draft 必须是布尔值")
		}
	}
	sourceID := util.Clean(body["draft_source_task_id"])
	if body["draft"] != true && sourceID == "" {
		return nil
	}
	if !protocol.SupportsVideoDraft(util.Clean(body["model"]), contract) {
		return fmt.Errorf("当前模型和视频协议不支持样片转正片")
	}
	if sourceID == "" {
		body["resolution"] = "480p"
		return nil
	}
	if body["draft"] == true {
		return fmt.Errorf("不能同时创建样片和生成正片")
	}
	source, err := a.tasks.VideoDraftSource(identity, sourceID)
	if err != nil {
		return err
	}
	if source["model"] != body["model"] {
		return fmt.Errorf("正片必须沿用样片模型")
	}
	for _, key := range []string{"draft_task_id", "token_name", "token_group", "seconds", "size", "generate_audio", "watermark"} {
		body[key] = source[key]
	}
	body["draft_source_base_url"] = source["base_url"]
	body["resolution"] = "1080p"
	for _, key := range []string{"reference_image_urls", "reference_video_urls", "reference_audio_urls", "first_frame_url", "last_frame_url", "parameters"} {
		delete(body, key)
	}
	return nil
}
