package httpapi

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

// Keep durable URLs in agent memory. Protected images are encoded only at the
// authenticated model transport boundary; public images retain their URLs.
func (a *App) canvasAgentModelImages(ctx context.Context, identity service.Identity, messages []map[string]any) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages))
	resolved := map[string]string{}
	for _, message := range messages {
		next := make(map[string]any, len(message))
		for key, value := range message {
			next[key] = value
		}
		if parts := util.AsMapSlice(message["content"]); len(parts) > 0 {
			content := make([]map[string]any, 0, len(parts))
			for _, part := range parts {
				if part["type"] != "image_url" {
					content = append(content, part)
					continue
				}
				image, _ := part["image_url"].(map[string]any)
				raw := util.Clean(image["url"])
				parsed, err := url.Parse(raw)
				if err != nil {
					return nil, err
				}
				protected := strings.HasPrefix(parsed.Path, "/api/files/") || strings.HasPrefix(parsed.Path, "/images/")
				if !protected && isPublicReferenceURL(raw) {
					content = append(content, part)
					continue
				}
				transportURL, ok := resolved[raw]
				if !ok {
					loaded, err := a.canvasAgentImage(ctx, identity, raw)
					if err != nil {
						return nil, err
					}
					transportURL = "data:" + loaded.ContentType + ";base64," + base64.StdEncoding.EncodeToString(loaded.Data)
					resolved[raw] = transportURL
				}
				transportImage := map[string]any{"url": transportURL}
				if detail, ok := image["detail"]; ok {
					transportImage["detail"] = detail
				}
				content = append(content, map[string]any{"type": "image_url", "image_url": transportImage})
			}
			next["content"] = content
		}
		out = append(out, next)
	}
	return out, nil
}

// Resolve protected references through their owner-scoped storage APIs, never
// through unauthenticated loopback HTTP requests.
func (a *App) canvasAgentImage(ctx context.Context, identity service.Identity, raw string) (protocol.UploadedImage, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	var reader io.ReadCloser
	switch {
	case strings.HasPrefix(parsed.Path, "/api/files/"):
		parts := strings.Split(strings.TrimPrefix(parsed.Path, "/api/files/"), "/")
		if len(parts) != 2 || parts[1] != "content" {
			return protocol.UploadedImage{}, fmt.Errorf("无效素材地址")
		}
		object, e := a.storageFiles.DownloadForIdentity(ctx, identityScope(identity), false, parts[0], "")
		if e != nil {
			return protocol.UploadedImage{}, e
		}
		reader = object.Stream
	case strings.HasPrefix(parsed.Path, "/images/"):
		ref, e := a.images.ImageFileAccess(parsed.Path, service.ImageAccessScope{OwnerID: identityScope(identity), Visible: true})
		if e != nil {
			return protocol.UploadedImage{}, e
		}
		reader, err = service.OpenMediaFile(ref.Path)
	default:
		if !isPublicReferenceURL(raw) {
			return protocol.UploadedImage{}, fmt.Errorf("图片引用必须是当前用户素材或公开 HTTP(S) 地址")
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if e != nil {
			return protocol.UploadedImage{}, e
		}
		response, e := service.SafeOutboundHTTPClient(30 * time.Second).Do(req)
		if e != nil {
			return protocol.UploadedImage{}, e
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return protocol.UploadedImage{}, fmt.Errorf("图片引用读取失败: %d", response.StatusCode)
		}
		reader = response.Body
	}
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, 20<<20+1))
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	if len(data) > 20<<20 {
		return protocol.UploadedImage{}, fmt.Errorf("图片引用超过 20 MiB")
	}
	contentType, err := uploadedImageContentType(data)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	return protocol.UploadedImage{Data: data, Filename: "reference.png", ContentType: contentType}, nil
}

func (a *App) canvasAgentVideoReference(ctx context.Context, identity service.Identity, raw, kind string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if isPublicReferenceURL(raw) && !strings.HasPrefix(parsed.Path, "/api/files/") && !strings.HasPrefix(parsed.Path, "/images/") && !strings.HasPrefix(parsed.Path, "/videos/") && !strings.HasPrefix(parsed.Path, "/audios/") {
		return raw, nil
	}
	var data []byte
	if kind == "image" {
		image, e := a.canvasAgentImage(ctx, identity, raw)
		if e != nil {
			return "", e
		}
		data = image.Data
	} else {
		var reader io.ReadCloser
		if strings.HasPrefix(parsed.Path, "/api/files/") {
			parts := strings.Split(strings.TrimPrefix(parsed.Path, "/api/files/"), "/")
			if len(parts) != 2 || parts[1] != "content" {
				return "", fmt.Errorf("无效素材地址")
			}
			object, e := a.storageFiles.DownloadForIdentity(ctx, identityScope(identity), false, parts[0], "")
			if e != nil {
				return "", e
			}
			reader = object.Stream
		} else {
			prefix, dir := "/videos/", a.videoDir
			if kind == "audio" {
				prefix, dir = "/audios/", a.audioDir
			}
			name := strings.TrimPrefix(parsed.Path, prefix)
			if !strings.HasPrefix(parsed.Path, prefix) || name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
				return "", fmt.Errorf("无效媒体引用")
			}
			allowed, e := a.tasks.CanAccessMediaResult(identity, parsed.Path)
			if e != nil {
				return "", e
			}
			if !allowed {
				return "", fmt.Errorf("无权读取媒体引用")
			}
			reader, err = service.OpenMediaFile(filepath.Join(dir, name))
			if err != nil {
				return "", err
			}
		}
		defer reader.Close()
		data, err = io.ReadAll(io.LimitReader(reader, maxVideoReferenceFileBytes+1))
		if err != nil {
			return "", err
		}
		if int64(len(data)) > maxVideoReferenceFileBytes {
			return "", fmt.Errorf("媒体引用过大")
		}
	}
	ext, contentType, pathPrefix := ".png", "image/png", "/video-image-references/"
	if kind == "image" {
		info, e := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
		if e != nil {
			return "", e
		}
		contentType = info.ContentType
		if contentType == "image/jpeg" {
			ext = ".jpg"
		}
		if contentType == "image/webp" {
			ext = ".webp"
		}
	} else {
		var ok bool
		if kind == "video" {
			ext, contentType, ok = videoReferenceFileType(data, parsed.Path)
			pathPrefix = "/video-references/"
		} else {
			ext, contentType, ok = audioReferenceFileType(data, parsed.Path, http.DetectContentType(data))
			pathPrefix = "/audio-references/"
		}
		if !ok {
			return "", fmt.Errorf("无效媒体内容")
		}
	}
	result, err := a.storeReferenceUpload(ctx, referenceUpload{data: data, filename: "agent-reference" + ext}, ext, contentType, kind, pathPrefix)
	if err != nil {
		return "", err
	}
	return util.Clean(result["url"]), nil
}
