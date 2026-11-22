package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"mime/multipart"
	"os/exec"
	"regexp"
	"strconv"

	"chatgpt2api/internal/util"
)

const MaxCanvasVideoFrames = 90

type CanvasVideoAnalysisOptions struct {
	StartMS  int64 `json:"startMs"`
	EndMS    int64 `json:"endMs,omitempty"`
	Detailed bool  `json:"detailed,omitempty"`
	Original bool  `json:"original,omitempty"`
}

type CanvasVideoFrame struct {
	TimestampMS int64  `json:"timestampMs"`
	URL         string `json:"url"`
	SameAsMS    *int64 `json:"sameAsMs,omitempty"`
	JPEG        []byte `json:"-"`
}

type CanvasVideoAnalysis struct {
	DurationMS  int64              `json:"durationMs"`
	NextStartMS *int64             `json:"nextStartMs"`
	Frames      []CanvasVideoFrame `json:"frames"`
}

// FFmpeg only receives a local file. Network reads and ownership checks belong to the caller.
func ExtractCanvasVideoFrames(ctx context.Context, input string, options CanvasVideoAnalysisOptions) (CanvasVideoAnalysis, error) {
	info, err := ProbeCanvasVideo(ctx, input)
	if err != nil {
		return CanvasVideoAnalysis{}, err
	}
	end := options.EndMS
	if end == 0 {
		end = info.DurationMS
	}
	if options.StartMS < 0 || end <= options.StartMS || end > info.DurationMS {
		return CanvasVideoAnalysis{}, fmt.Errorf("视频分析起止时间超出有效范围")
	}
	original := options.Original || options.EndMS > 0 && end-options.StartMS <= 250
	if original && end-options.StartMS > 250 {
		return CanvasVideoAnalysis{}, fmt.Errorf("原始帧读取每次最多 250 毫秒，请缩短区间")
	}
	gap := int64(1000)
	if options.Detailed {
		gap = 500
	}
	// Bin samples by their actual presentation timestamps, including variable-rate videos.
	selectFilter := fmt.Sprintf(",select='if(isnan(prev_selected_pts),1,gt(floor((pts-%d)/%d),floor((prev_selected_pts-%d)/%d)))'", options.StartMS*1000, gap*1000, options.StartMS*1000, gap*1000)
	if original {
		selectFilter = ""
	}
	filter := fmt.Sprintf("settb=AVTB,trim=start=%dms:end=%dms%s,trim=end_frame=%d,scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p,showinfo=checksum=0", options.StartMS, end, selectFilter, MaxCanvasVideoFrames+1)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-xerror", "-copyts", "-start_at_zero", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm", "-threads", "2", "-ss", fmt.Sprintf("%dms", options.StartMS), "-i", input, "-map", "0:V:0", "-an", "-sn", "-dn", "-filter_threads", "1", "-vf", filter, "-fps_mode", "passthrough", "-c:v", "mjpeg", "-threads", "2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "canvas_frame", "pipe:1")
	logs := &canvasFrameLogs{}
	cmd.Stderr = logs
	output, err := cmd.StdoutPipe()
	if err != nil {
		return CanvasVideoAnalysis{}, err
	}
	if err = cmd.Start(); err != nil {
		return CanvasVideoAnalysis{}, fmt.Errorf("视频分析需要服务端安装 FFmpeg: %w", err)
	}
	waited := false
	defer func() {
		if !waited {
			cancel()
			output.Close()
			_ = cmd.Wait()
		}
	}()
	reader := multipart.NewReader(output, "canvas_frame")
	frames := []CanvasVideoFrame{}
	totalBytes := 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return CanvasVideoAnalysis{}, fmt.Errorf("视频取帧输出无效: %w", err)
		}
		jpeg, err := io.ReadAll(io.LimitReader(part, (512<<10)+1))
		totalBytes += len(jpeg)
		if err != nil || len(jpeg) < 4 || len(jpeg) > 512<<10 || totalBytes > 12<<20 || len(frames) > MaxCanvasVideoFrames {
			return CanvasVideoAnalysis{}, fmt.Errorf("视频取帧超过单批限制")
		}
		frames = append(frames, CanvasVideoFrame{JPEG: jpeg})
	}
	err = cmd.Wait()
	waited = true
	if ctx.Err() != nil {
		return CanvasVideoAnalysis{}, ctx.Err()
	}
	if err != nil {
		return CanvasVideoAnalysis{}, fmt.Errorf("视频取帧失败: %w", err)
	}
	stamps := canvasVideoFramePTS.FindAllStringSubmatch(logs.String(), -1)
	if len(stamps) != len(frames) || len(frames) == 0 {
		return CanvasVideoAnalysis{}, fmt.Errorf("视频帧与时间戳不匹配，或所选区间没有画面")
	}
	result := CanvasVideoAnalysis{DurationMS: info.DurationMS, Frames: frames}
	seen := map[[32]byte]int64{}
	for i, stamp := range stamps {
		pts, err := strconv.ParseInt(stamp[1], 10, 64)
		if err != nil || pts < options.StartMS*1000 || pts >= end*1000 {
			return CanvasVideoAnalysis{}, fmt.Errorf("视频帧时间戳无效")
		}
		frames[i].TimestampMS = pts / 1000
		if i == MaxCanvasVideoFrames {
			if original {
				return CanvasVideoAnalysis{}, fmt.Errorf("原始帧超过 90 帧，请缩短区间")
			}
			next := options.StartMS + ((pts-options.StartMS*1000)/(gap*1000))*gap
			result.NextStartMS = &next
			result.Frames = frames[:MaxCanvasVideoFrames]
			break
		}
		digest := sha256.Sum256(frames[i].JPEG)
		if previous, ok := seen[digest]; ok {
			frames[i].SameAsMS = &previous
			frames[i].JPEG = nil
		} else {
			seen[digest] = frames[i].TimestampMS
		}
	}
	return result, nil
}

var canvasVideoFramePTS = regexp.MustCompile(`\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:`)

// Bound decoder diagnostics while continuing to drain stderr.
type canvasFrameLogs struct{ bytes.Buffer }

func (b *canvasFrameLogs) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 1<<20 {
		_, _ = b.Buffer.Write(p[:min(n, (1<<20)-b.Len())])
	}
	return n, nil
}

func (s *CanvasAgentService) SetVideoAnalyzer(analyze func(context.Context, Identity, CanvasNode, CanvasVideoAnalysisOptions) (CanvasVideoAnalysis, error)) {
	s.videoAnalyzer = analyze
}

func (w *canvasAgentWorker) analyzeVideo(args map[string]any) (map[string]any, error) {
	node := w.node(util.Clean(args["nodeId"]))
	if node == nil || node.Type != "video" || node.URL == "" {
		return agentError("invalid_video", "请选择已有内容的视频节点"), nil
	}
	if w.service.videoAnalyzer == nil {
		return agentError("video_analysis_unavailable", "视频分析尚未启用"), nil
	}
	options := CanvasVideoAnalysisOptions{}
	if start, ok := args["startMs"]; ok {
		value, valid := util.StrictInt(start)
		if !valid || value < 0 || value > 1800000 {
			return agentError("invalid_range", "视频起始时间无效"), nil
		}
		options.StartMS = int64(value)
	}
	if end, ok := args["endMs"]; ok {
		value, valid := util.StrictInt(end)
		if !valid || value <= int(options.StartMS) || value > 1800000 {
			return agentError("invalid_range", "视频结束时间无效"), nil
		}
		options.EndMS = int64(value)
	}
	options.Detailed, _ = args["detailed"].(bool)
	options.Original, _ = args["original"].(bool)
	result, err := w.service.videoAnalyzer(w.ctx, w.identity, *node, options)
	if err != nil {
		return nil, err
	}
	if w.doc.AgentRun.Engine != "codex-tools" {
		for _, frame := range result.Frames {
			w.visuals = append(w.visuals, map[string]any{"type": "text", "text": fmt.Sprintf("视频 %s 时间 %d 毫秒；抽样画面仅用于视觉分析，不含音频。", node.Title, frame.TimestampMS)})
			if frame.URL != "" {
				w.visuals = append(w.visuals, map[string]any{"type": "image", "image": frame.URL, "detail": "auto"})
			}
		}
	}
	return map[string]any{"ok": true, "nodeId": node.ID, "question": args["question"], "durationMs": result.DurationMS, "nextStartMs": result.NextStartMS, "frames": result.Frames, "note": "按时间戳分析实际画面；抽帧不包含音频，不能据此确认对白或口型。nextStartMs 非空时可继续读取。"}, nil
}
