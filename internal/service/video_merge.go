package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type MergedVideoInfo struct {
	Width, Height int
	Duration      float64
	HasAudio      bool
	SilentClips   int
}

type videoMergeProbe struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Duration  string `json:"duration"`
		SideData  []struct {
			Rotation float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func probeMergeVideo(ctx context.Context, path string) (MergedVideoInfo, bool, error) {
	data, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm", "-show_streams", "-show_format", "-of", "json", path).Output()
	if err != nil {
		return MergedVideoInfo{}, false, fmt.Errorf("无法读取分镜视频，请检查文件是否完整: %w", err)
	}
	var probe videoMergeProbe
	if err := json.Unmarshal(data, &probe); err != nil {
		return MergedVideoInfo{}, false, err
	}
	info := MergedVideoInfo{}
	audio := false
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" {
			audio = true
		}
		if stream.CodecType != "video" || info.Width != 0 {
			continue
		}
		info.Width, info.Height = stream.Width, stream.Height
		info.Duration, _ = strconv.ParseFloat(stream.Duration, 64)
		for _, side := range stream.SideData {
			if math.Mod(math.Abs(side.Rotation), 180) == 90 {
				info.Width, info.Height = info.Height, info.Width
			}
		}
	}
	duration, _ := strconv.ParseFloat(probe.Format.Duration, 64)
	info.Duration = math.Max(info.Duration, duration)
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" {
			duration, _ := strconv.ParseFloat(stream.Duration, 64)
			info.Duration = math.Max(info.Duration, duration)
		}
	}
	if info.Width <= 0 || info.Height <= 0 || !finiteCanvasNumber(info.Duration) || info.Duration <= 0 || info.Duration > 1800 {
		return MergedVideoInfo{}, false, fmt.Errorf("分镜视频必须包含有效画面和不超过 30 分钟的时长")
	}
	info.HasAudio = audio
	return info, audio, nil
}

func ProbeCanvasVideo(ctx context.Context, path string) (CanvasMediaMetadata, error) {
	info, audio, err := probeMergeVideo(ctx, path)
	if err != nil {
		return CanvasMediaMetadata{}, err
	}
	return CanvasMediaMetadata{Width: info.Width, Height: info.Height, DurationMS: int64(math.Round(info.Duration * 1000)), HasAudio: &audio}, nil
}

// Normalize each clip before concatenating; retain audio and fill missing tracks with silence.
func MergeVideoFiles(ctx context.Context, sources []string, destination string, seconds []float64) (MergedVideoInfo, error) {
	if len(sources) < 1 || len(sources) > 200 || len(seconds) != len(sources) {
		return MergedVideoInfo{}, fmt.Errorf("交付需要 1 至 200 段视频及对应目标时长")
	}
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			return MergedVideoInfo{}, fmt.Errorf("视频合并需要服务端安装 FFmpeg（ffmpeg 和 ffprobe）")
		}
	}
	dir, err := os.MkdirTemp(filepath.Dir(destination), ".video-merge-*")
	if err != nil {
		return MergedVideoInfo{}, err
	}
	defer os.RemoveAll(dir)
	success := false
	defer func() {
		if !success {
			_ = os.Remove(destination)
		}
	}()
	var width, height int
	var totalDuration float64
	silentClips := 0
	var totalBytes int64
	var playlist strings.Builder
	for index, source := range sources {
		info, audio, err := probeMergeVideo(ctx, source)
		if err != nil {
			return MergedVideoInfo{}, fmt.Errorf("镜头 %d: %w", index+1, err)
		}
		target := seconds[index]
		if !finiteCanvasNumber(target) || target <= 0 || target > 1800 {
			return MergedVideoInfo{}, fmt.Errorf("镜头 %d 的目标时长无效", index+1)
		}
		ratio := info.Duration / target
		if math.Abs(ratio-1) > 0.1 {
			return MergedVideoInfo{}, fmt.Errorf("镜头 %d 实际 %.3f 秒，与目标 %.3f 秒差异超过 10%%；请调整镜头时长或重新制作，避免截断对白", index+1, info.Duration, target)
		}
		totalDuration += target
		if !audio {
			silentClips++
		}
		if totalDuration > 1800 {
			return MergedVideoInfo{}, fmt.Errorf("成片总时长不能超过 30 分钟")
		}
		if index == 0 {
			scale := math.Min(1, 1920/float64(max(info.Width, info.Height)))
			width = max(2, int(float64(info.Width)*scale)/2*2)
			height = max(2, int(float64(info.Height)*scale)/2*2)
		}
		name := fmt.Sprintf("clip-%03d.mkv", index)
		args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm", "-i", source}
		if !audio {
			args = append(args, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo")
		}
		audioMap := "0:a:0"
		if !audio {
			audioMap = "1:a:0"
		}
		args = append(args, "-map", "0:v:0", "-map", audioMap, "-t", strconv.FormatFloat(target, 'f', 6, 64),
			"-vf", fmt.Sprintf("setpts=(PTS-STARTPTS)/%.9f,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30", ratio, width, height, width, height),
			"-af", fmt.Sprintf("aresample=48000,asetpts=PTS-STARTPTS,atempo=%.9f,apad,atrim=duration=%.9f", ratio, target), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-map_metadata", "-1", filepath.Join(dir, name))
		if output, err := exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput(); err != nil {
			if ctx.Err() != nil {
				return MergedVideoInfo{}, ctx.Err()
			}
			return MergedVideoInfo{}, fmt.Errorf("镜头 %d 转码失败: %s", index+1, strings.TrimSpace(string(output)))
		}
		stat, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			return MergedVideoInfo{}, err
		}
		totalBytes += stat.Size()
		if totalBytes > 1<<30 {
			return MergedVideoInfo{}, fmt.Errorf("成片不能超过 1 GiB")
		}
		fmt.Fprintf(&playlist, "file '%s'\nduration %.9f\n", name, target)
	}
	listPath := filepath.Join(dir, "clips.txt")
	if err := os.WriteFile(listPath, []byte(playlist.String()), 0o600); err != nil {
		return MergedVideoInfo{}, err
	}
	if output, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", listPath, "-map", "0:v:0", "-map", "0:a:0", "-t", strconv.FormatFloat(totalDuration, 'f', 6, 64), "-c:v", "copy", "-c:a", "aac", "-af", "asetpts=PTS-STARTPTS", "-movflags", "+faststart", destination).CombinedOutput(); err != nil {
		if ctx.Err() != nil {
			return MergedVideoInfo{}, ctx.Err()
		}
		return MergedVideoInfo{}, fmt.Errorf("视频合并失败: %s", strings.TrimSpace(string(output)))
	}
	info, _, err := probeMergeVideo(ctx, destination)
	if err != nil {
		return MergedVideoInfo{}, err
	}
	if math.Abs(info.Duration-totalDuration) > 0.04 {
		return MergedVideoInfo{}, fmt.Errorf("成片时长验收未通过：实际 %.3f 秒，目标 %.3f 秒", info.Duration, totalDuration)
	}
	info.SilentClips = silentClips
	success = true
	return info, nil
}
