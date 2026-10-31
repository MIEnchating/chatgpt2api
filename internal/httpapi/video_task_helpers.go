package httpapi

import (
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func videoFrameAliases(body map[string]any) []string {
	frames := make([]string, 0, 2)
	if value := videoFirstFrameAlias(body); value != "" {
		frames = append(frames, value)
	}
	if value := videoLastFrameAlias(body); value != "" {
		frames = append(frames, value)
	}
	return frames
}

func videoContractMaterialCounts(kind string, body map[string]any, imageURLs, videoURLs, audioURLs []string) protocol.VideoModelMaterialCounts {
	counts := protocol.VideoModelMaterialCounts{
		Video: len(videoURLs),
		Audio: len(audioURLs),
	}
	firstFrame := videoFirstFrameAlias(body)
	lastFrame := videoLastFrameAlias(body)
	switch kind {
	case "image":
		firstFrame, lastFrame, imageURLs = videoContractImageFrames(body, imageURLs)
		if firstFrame != "" {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		}
		counts.Image = len(imageURLs)
	case "reference":
		if firstFrame != "" {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		}
		counts.Image = len(imageURLs)
	default:
		if firstFrame != "" {
			counts.FirstFrame = 1
		}
		if lastFrame != "" {
			counts.LastFrame = 1
		}
		counts.Image = len(imageURLs)
	}
	return counts
}

func videoContractImageFrames(body map[string]any, imageURLs []string) (string, string, []string) {
	firstFrame := videoFirstFrameAlias(body)
	lastFrame := videoLastFrameAlias(body)
	remaining := append([]string(nil), imageURLs...)
	if firstFrame != "" || len(remaining) == 0 {
		return firstFrame, lastFrame, remaining
	}
	firstFrame = remaining[0]
	remaining = remaining[1:]
	if lastFrame == "" && len(remaining) > 0 {
		lastFrame = remaining[0]
		remaining = remaining[1:]
	}
	return firstFrame, lastFrame, remaining
}

func videoFirstFrameAlias(body map[string]any) string {
	for _, key := range []string{"first_frame_url", "first_frame_image"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			return value
		}
	}
	return ""
}

func videoLastFrameAlias(body map[string]any) string {
	for _, key := range []string{"last_frame_url", "last_frame_image", "end_image_url", "tail_image_url"} {
		if value := strings.TrimSpace(util.Clean(body[key])); value != "" {
			return value
		}
	}
	return ""
}

func removeVideoFrameAliases(refs, frames []string) []string {
	frameSet := make(map[string]struct{}, len(frames))
	for _, value := range frames {
		frameSet[strings.TrimSpace(value)] = struct{}{}
	}
	filtered := make([]string, 0, len(refs))
	for _, value := range refs {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, isFrame := frameSet[value]; !isFrame {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func normalizeVideoReferenceMode(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
