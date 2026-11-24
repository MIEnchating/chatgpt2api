package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"

	"golang.org/x/image/draw"
)

// Keep durable URLs in agent memory. Protected images are encoded only at the
// authenticated model transport boundary; public images retain their URLs.
func (a *App) canvasAgentModelImages(ctx context.Context, identity service.Identity, messages []map[string]any) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages))
	type variant struct {
		url      string
		longEdge int
	}
	resolved := map[variant]string{}
	protectedImages := 0
	for _, message := range messages {
		for _, part := range util.AsMapSlice(message["content"]) {
			if part["type"] == "image_url" && !canvasAgentPublicImage(util.Clean(util.StringMap(part["image_url"])["url"])) {
				protectedImages++
			}
		}
	}
	const requestImageBytes = 16 << 20
	imageBudget := requestImageBytes / max(1, protectedImages)
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
				if canvasAgentPublicImage(raw) {
					content = append(content, part)
					continue
				}
				longEdge := 1536
				switch image["detail"] {
				case "low":
					longEdge = 768
				case "high":
					longEdge = 2048
				}
				key := variant{url: raw, longEdge: longEdge}
				transportURL, ok := resolved[key]
				if !ok {
					loaded, err := a.canvasAgentImage(ctx, identity, raw)
					if err != nil {
						return nil, err
					}
					budget := min(imageBudget, longEdge*1024)
					data, contentType, err := canvasAgentImageVariant(ctx, loaded, longEdge, budget)
					if err != nil {
						return nil, err
					}
					transportURL = "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data)
					resolved[key] = transportURL
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

func canvasAgentPublicImage(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && isPublicReferenceURL(raw) &&
		!strings.HasPrefix(parsed.Path, "/api/files/") &&
		!strings.HasPrefix(parsed.Path, "/images/") &&
		!strings.HasPrefix(parsed.Path, service.ImageConversationAssetURLPrefix)
}

func canvasAgentImageVariant(ctx context.Context, source protocol.UploadedImage, longEdge, maxBytes int) ([]byte, string, error) {
	info, err := util.InspectRasterImage(source.Data)
	if err != nil {
		return nil, "", err
	}
	if max(info.Width, info.Height) <= longEdge && len(source.Data) <= maxBytes {
		return source.Data, info.ContentType, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	decoded, _, err := image.Decode(bytes.NewReader(source.Data))
	if err != nil {
		return nil, "", err
	}
	originalEdge := max(info.Width, info.Height)
	for edge := min(longEdge, originalEdge); ; edge = max(1, edge*3/4) {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		size := image.Rect(0, 0, max(1, info.Width*edge/originalEdge), max(1, info.Height*edge/originalEdge))
		scaled := image.NewRGBA(size)
		draw.CatmullRom.Scale(scaled, size, decoded, decoded.Bounds(), draw.Src, nil)
		var encoded bytes.Buffer
		contentType := "image/jpeg"
		if !scaled.Opaque() {
			contentType = "image/png"
			err = png.Encode(&encoded, scaled)
		} else {
			err = jpeg.Encode(&encoded, scaled, &jpeg.Options{Quality: 90})
		}
		if err != nil {
			return nil, "", err
		}
		if encoded.Len() <= maxBytes {
			return encoded.Bytes(), contentType, nil
		}
		if edge == 1 {
			return nil, "", fmt.Errorf("参考图超过当前模型请求的图片体积预算")
		}
	}
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
	case strings.HasPrefix(parsed.Path, service.ImageConversationAssetURLPrefix):
		ref, e := a.conversationAssets.Access(parsed.Path, identityScope(identity), false)
		if e != nil {
			return protocol.UploadedImage{}, e
		}
		reader, err = service.OpenMediaFile(ref.Path)
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

func (a *App) canvasAgentVideoReference(ctx context.Context, identity service.Identity, raw, kind string, contract protocol.VideoModelContract) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if contract.Transport.LocalMaterial == "url" && isPublicReferenceURL(raw) && !strings.HasPrefix(parsed.Path, "/api/files/") && !strings.HasPrefix(parsed.Path, "/images/") && !strings.HasPrefix(parsed.Path, service.ImageConversationAssetURLPrefix) && !strings.HasPrefix(parsed.Path, "/videos/") && !strings.HasPrefix(parsed.Path, "/audios/") {
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
		} else if !strings.HasPrefix(parsed.Path, "/videos/") && !strings.HasPrefix(parsed.Path, "/audios/") && isPublicReferenceURL(raw) {
			req, e := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
			if e != nil {
				return "", e
			}
			response, e := service.SafeOutboundHTTPClient(30 * time.Second).Do(req)
			if e != nil {
				return "", e
			}
			if response.StatusCode != http.StatusOK {
				response.Body.Close()
				return "", fmt.Errorf("媒体引用读取失败: %d", response.StatusCode)
			}
			reader = response.Body
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
	if contract.Transport.LocalMaterial == "url" && contract.Transport.MaterialUpload == nil && !isPublicReferenceURL(a.resolveImageBaseURL(ctx)) {
		return "", fmt.Errorf("当前视频模型只接受公网素材 URL，当前站点地址无法用于公网素材访问；请通过公网网站访问，或用 IMAGE_BASE_URL 指定上游可访问的素材地址")
	}
	result, err := a.storeReferenceUpload(ctx, referenceUpload{data: data, filename: "agent-reference" + ext}, ext, contentType, kind, pathPrefix)
	if err != nil {
		return "", err
	}
	reference := util.Clean(result["url"])
	if contract.Transport.LocalMaterial == "multipart" || contract.Transport.LocalMaterial == "base64" || contract.Transport.MaterialUpload != nil {
		stored, parseErr := url.Parse(reference)
		if parseErr != nil {
			return "", parseErr
		}
		stored.Path, stored.RawPath = referenceCapabilityPath(stored.Path), ""
		return stored.RequestURI(), nil
	}
	return reference, nil
}
