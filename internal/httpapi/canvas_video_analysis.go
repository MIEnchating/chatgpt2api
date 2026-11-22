package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"chatgpt2api/internal/service"
)

func (a *App) analyzeCanvasVideo(ctx context.Context, identity service.Identity, node service.CanvasNode, options service.CanvasVideoAnalysisOptions) (service.CanvasVideoAnalysis, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if a.storageUploadSlots != nil {
		select {
		case a.storageUploadSlots <- struct{}{}:
			defer func() { <-a.storageUploadSlots }()
		case <-ctx.Done():
			return service.CanvasVideoAnalysis{}, ctx.Err()
		}
	}
	dir, err := os.MkdirTemp("", "canvas-video-analysis-*")
	if err != nil {
		return service.CanvasVideoAnalysis{}, err
	}
	defer os.RemoveAll(dir)
	reader, err := a.canvasMergeVideoReader(ctx, identity, node)
	if err != nil {
		return service.CanvasVideoAnalysis{}, err
	}
	_, err = service.StoreMediaFile(reader, service.MediaFileWrite{Directory: dir, Name: "source.media", MaxBytes: 100 << 20})
	_ = reader.Close()
	if err != nil {
		return service.CanvasVideoAnalysis{}, err
	}
	result, err := service.ExtractCanvasVideoFrames(ctx, filepath.Join(dir, "source.media"), options)
	if err != nil {
		return service.CanvasVideoAnalysis{}, err
	}
	for i := range result.Frames {
		frame := &result.Frames[i]
		if len(frame.JPEG) == 0 {
			continue
		}
		object, err := a.storageFiles.UploadReader(ctx, identityScope(identity), false, fmt.Sprintf("video-frame-%d.jpg", frame.TimestampMS), "image/jpeg", bytes.NewReader(frame.JPEG), int64(len(frame.JPEG)), nil)
		if err != nil {
			return service.CanvasVideoAnalysis{}, err
		}
		frame.URL = object.URL
		frame.JPEG = nil
	}
	return result, nil
}
