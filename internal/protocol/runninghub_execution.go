package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"chatgpt2api/internal/model"
)

func workflowMediaSource(input model.WorkflowRunInput, id string) (string, error) {
	if id == "mask" && input.Mask != "" {
		return input.Mask, nil
	}
	parts := strings.Split(id, ":")
	if len(parts) != 2 {
		return "", errors.New("媒体引用格式无效")
	}
	index, err := strconv.Atoi(parts[1])
	if err != nil || index < 0 {
		return "", errors.New("媒体索引无效")
	}
	var items []string
	switch parts[0] {
	case "image":
		items = input.ReferenceImages
	case "video":
		items = input.ReferenceVideos
	case "audio":
		items = input.ReferenceAudios
	default:
		return "", errors.New("媒体类型无效")
	}
	if index >= len(items) {
		return "", errors.New("媒体索引超出素材数量")
	}
	return items[index], nil
}

func ComfyWorkflowPayload(entry model.WorkflowEntry, input model.WorkflowRunInput, overrides []model.WorkflowOverride) map[string]any {
	media := func(prefix string, values []string) []map[string]any {
		items := make([]map[string]any, 0, len(values))
		for index, value := range values {
			item := map[string]any{"id": fmt.Sprintf("%s:%d", prefix, index)}
			if strings.HasPrefix(value, "data:") {
				item["dataUrl"] = value
			} else {
				item["url"] = value
			}
			items = append(items, item)
		}
		return items
	}
	payload := map[string]any{
		"mode": entry.Capability, "workflowId": entry.WorkflowID, "workflowJson": entry.WorkflowJSON, "workflowFields": entry.Fields, "workflowOverrides": overrides,
		"referenceImages": media("image", input.ReferenceImages), "referenceVideos": media("video", input.ReferenceVideos), "referenceAudios": media("audio", input.ReferenceAudios),
	}
	if input.Mask != "" {
		mask := media("mask", []string{input.Mask})[0]
		mask["id"] = "mask"
		payload["mask"] = mask
	}
	return payload
}

func WorkflowResultURLs(raw string) ([]string, error) {
	var result struct {
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		Video struct {
			URL string `json:"url"`
		} `json:"video"`
		Audio struct {
			URL string `json:"url"`
		} `json:"audio"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, errors.New("Bridge 产物格式无效")
	}
	urls := make([]string, 0, len(result.Images)+2)
	for _, image := range result.Images {
		if image.URL != "" {
			urls = append(urls, image.URL)
		}
	}
	if result.Video.URL != "" {
		urls = append(urls, result.Video.URL)
	}
	if result.Audio.URL != "" {
		urls = append(urls, result.Audio.URL)
	}
	if len(urls) == 0 {
		return nil, errors.New("Bridge 没有返回可用产物")
	}
	return urls, nil
}
