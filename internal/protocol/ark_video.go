package protocol

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

type ArkVideoReferences struct {
	FirstFrame string
	LastFrame  string
	Images     []string
	Videos     []string
	Audio      []string
}

// Ark uses typed content and explicit roles for all reference media.
func ArkVideoContent(prompt string, refs ArkVideoReferences) ([]map[string]any, error) {
	if strings.TrimSpace(prompt) == "" {
		return nil, errors.New("方舟视频提示词不能为空")
	}
	if refs.LastFrame != "" && refs.FirstFrame == "" {
		return nil, errors.New("方舟尾帧需要首帧")
	}
	if refs.FirstFrame != "" && len(refs.Images)+len(refs.Videos)+len(refs.Audio) > 0 {
		return nil, errors.New("方舟首尾帧不能和参考素材混用")
	}
	content := []map[string]any{{"type": "text", "text": prompt}}
	appendMedia := func(kind, role, value string) error {
		if err := publicMediaURL(value); err != nil {
			return err
		}
		content = append(content, map[string]any{"type": kind + "_url", kind + "_url": map[string]any{"url": value}, "role": role})
		return nil
	}
	for _, frame := range []struct{ role, value string }{{"first_frame", refs.FirstFrame}, {"last_frame", refs.LastFrame}} {
		if frame.value != "" {
			if err := appendMedia("image", frame.role, frame.value); err != nil {
				return nil, err
			}
		}
	}
	for _, group := range []struct {
		kind, role string
		urls       []string
	}{{"image", "reference_image", refs.Images}, {"video", "reference_video", refs.Videos}, {"audio", "reference_audio", refs.Audio}} {
		for _, value := range group.urls {
			if err := appendMedia(group.kind, group.role, value); err != nil {
				return nil, err
			}
		}
	}
	return content, nil
}

func publicMediaURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("参考素材需要可公开访问的 HTTP(S) 地址")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("参考素材不能使用本地地址")
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast()) {
		return errors.New("参考素材不能使用本地地址")
	}
	return nil
}
