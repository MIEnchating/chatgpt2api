package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

// Inputs are owner-scoped canvas nodes; never pass remote URLs to FFmpeg.
func (a *App) mergeCanvasVideos(ctx context.Context, identity service.Identity, nodes []service.CanvasNode, options service.CanvasVideoMergeOptions) (service.CanvasMergedVideo, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	// Share the existing storage work limit instead of allowing unbounded encoders.
	if a.storageUploadSlots != nil {
		select {
		case a.storageUploadSlots <- struct{}{}:
			defer func() { <-a.storageUploadSlots }()
		case <-ctx.Done():
			return service.CanvasMergedVideo{}, ctx.Err()
		}
	}
	dir, err := os.MkdirTemp("", "canvas-video-merge-*")
	if err != nil {
		return service.CanvasMergedVideo{}, err
	}
	defer os.RemoveAll(dir)
	paths := make([]string, 0, len(nodes))
	var total int64
	sourceInfo := make([]service.CanvasMediaMetadata, 0, len(nodes))
	for index, node := range nodes {
		reader, err := a.canvasMergeVideoReader(ctx, identity, node)
		if err != nil {
			return service.CanvasMergedVideo{}, fmt.Errorf("读取镜头 %d 失败: %w", index+1, err)
		}
		name := fmt.Sprintf("source-%03d.mp4", index)
		size, err := service.StoreMediaFile(reader, service.MediaFileWrite{Directory: dir, Name: name, MaxBytes: 100 << 20})
		_ = reader.Close()
		if err != nil {
			return service.CanvasMergedVideo{}, fmt.Errorf("读取镜头 %d 失败（单段最大 100 MiB）: %w", index+1, err)
		}
		total += size
		if total > 1<<30 {
			return service.CanvasMergedVideo{}, fmt.Errorf("待合并的视频总大小不能超过 1 GiB")
		}
		path := filepath.Join(dir, name)
		info, err := service.ProbeCanvasVideo(ctx, path)
		if err != nil {
			return service.CanvasMergedVideo{}, err
		}
		sourceInfo = append(sourceInfo, info)
		paths = append(paths, path)
	}
	path := filepath.Join(dir, "movie.mp4")
	info, err := service.MergeVideoFiles(ctx, paths, path, options.ShotSeconds)
	if err != nil {
		return service.CanvasMergedVideo{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return service.CanvasMergedVideo{}, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return service.CanvasMergedVideo{}, err
	}
	if stat.Size() > 1<<30 {
		return service.CanvasMergedVideo{}, fmt.Errorf("合并成片不能超过 1 GiB")
	}
	object, err := a.storageFiles.UploadReader(ctx, identityScope(identity), false, "merged-storyboard.mp4", "video/mp4", file, stat.Size(), nil)
	if err != nil {
		return service.CanvasMergedVideo{}, err
	}
	return service.CanvasMergedVideo{URL: object.URL, StorageKey: object.StorageKey, Bytes: object.Bytes, MergedVideoInfo: info, Sources: sourceInfo}, nil
}

func (a *App) canvasMergeVideoReader(ctx context.Context, identity service.Identity, node service.CanvasNode) (io.ReadCloser, error) {
	raw := node.URL
	if strings.HasPrefix(node.StorageKey, "server:") {
		raw = "/api/files/" + strings.TrimPrefix(node.StorageKey, "server:") + "/content"
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("无效视频地址")
	}
	if strings.HasPrefix(parsed.Path, "/api/files/") {
		parts := strings.Split(strings.TrimPrefix(parsed.Path, "/api/files/"), "/")
		if len(parts) != 2 || parts[1] != "content" {
			return nil, fmt.Errorf("无效存储视频地址")
		}
		object, err := a.storageFiles.DownloadForIdentity(ctx, identityScope(identity), false, parts[0], "")
		if err != nil {
			return nil, err
		}
		return object.Stream, nil
	}
	if strings.HasPrefix(parsed.Path, "/videos/") {
		name := strings.TrimPrefix(parsed.Path, "/videos/")
		if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
			return nil, fmt.Errorf("无效视频文件名")
		}
		allowed, err := a.tasks.CanAccessMediaResult(identity, parsed.Path)
		if err != nil || !allowed {
			return nil, fmt.Errorf("无权读取该视频")
		}
		return service.OpenMediaFile(filepath.Join(a.videoDir, name))
	}
	if strings.HasPrefix(referenceCapabilityPath(parsed.Path), "/video-references/") {
		if !a.validReferenceSignature(parsed) {
			return nil, fmt.Errorf("视频引用签名无效或已过期")
		}
		file, found, err := a.localVideoReferenceFile(raw)
		if err != nil || !found {
			return nil, fmt.Errorf("视频引用不可用")
		}
		return io.NopCloser(bytes.NewReader(file.Data)), nil
	}
	if !isPublicReferenceURL(raw) {
		return nil, fmt.Errorf("视频必须是当前用户素材或公开 HTTP(S) 地址")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	response, err := service.SafeMediaProxyHTTPClient().Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("视频下载失败: %d", response.StatusCode)
	}
	return response.Body, nil
}

// Probe completed media independently from generation success; never resubmit it.
func (a *App) waitCanvasAgentMedia(ctx context.Context, identity service.Identity, node service.CanvasNode, onProgress func(int) error) (map[string]any, error) {
	task, err := service.WaitCanvasAgentTask(ctx, a.tasks, identity, node.TaskID, nil, onProgress)
	if err != nil || node.Type != "video" {
		return task, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp("", "canvas-video-probe-*")
	if err != nil {
		return task, nil
	}
	defer os.RemoveAll(dir)
	for index, item := range util.AsMapSlice(task["data"]) {
		item["media_probe_error"] = "媒体属性检测未完成，成片交付时会重新检测"
		source := service.CanvasNode{URL: util.Clean(item["video_url"]), StorageKey: util.Clean(item["storageKey"])}
		if source.URL == "" {
			source.URL = util.Clean(item["url"])
		}
		if source.StorageKey == "" {
			source.StorageKey = util.Clean(item["storage_key"])
		}
		reader, err := a.canvasMergeVideoReader(probeCtx, identity, source)
		if err != nil {
			continue
		}
		name := fmt.Sprintf("probe-%03d.mp4", index)
		_, err = service.StoreMediaFile(reader, service.MediaFileWrite{Directory: dir, Name: name, MaxBytes: 100 << 20})
		_ = reader.Close()
		if err != nil {
			continue
		}
		info, err := service.ProbeCanvasVideo(probeCtx, filepath.Join(dir, name))
		if err != nil {
			continue
		}
		item["media_metadata"] = info
		item["width"], item["height"] = info.Width, info.Height
		delete(item, "media_probe_error")
	}
	return task, nil
}
