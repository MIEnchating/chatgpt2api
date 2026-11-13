package service

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

func videoMergeFixture(t *testing.T, color string, width, height int, audio bool) string {
	t.Helper()
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip("FFmpeg is required for media integration tests")
		}
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=" + color + ":s=" + strconv.Itoa(width) + "x" + strconv.Itoa(height) + ":r=24:d=0.6"}
	if audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.6", "-c:a", "aac")
	}
	args = append(args, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-t", "0.6", path)
	if output, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("create clip: %v %s", err, output)
	}
	return path
}

func TestMergeVideoFilesPreservesOrderAudioAndSilentClips(t *testing.T) {
	red := videoMergeFixture(t, "red", 320, 240, true)
	blue := videoMergeFixture(t, "blue", 240, 320, false)
	destination := filepath.Join(t.TempDir(), "movie.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	info, err := MergeVideoFiles(ctx, []string{red, blue, red}, destination, []float64{0.6, 0.6, 0.6})
	if err != nil {
		t.Fatal(err)
	}
	if info.Width != 320 || info.Height != 240 || math.Abs(info.Duration-1.8) > 0.2 {
		t.Fatalf("unexpected merged video: %+v", info)
	}
	for _, frame := range []struct {
		time string
		red  bool
	}{{"0.2", true}, {"0.9", false}, {"1.5", true}} {
		pixels, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-ss", frame.time, "-i", destination, "-frames:v", "1", "-vf", "crop=2:2:160:120", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) < 3 {
			t.Fatalf("decode frame: %v", err)
		}
		if frame.red && (pixels[0] < 200 || pixels[2] > 20) || !frame.red && (pixels[2] < 200 || pixels[0] > 20) {
			t.Fatalf("clip order changed at %s: %v", frame.time, pixels[:3])
		}
		pcm, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-ss", frame.time, "-i", destination, "-t", "0.1", "-vn", "-ac", "1", "-f", "s16le", "pipe:1").Output()
		if err != nil || len(pcm) < 2 {
			t.Fatalf("decode audio: %v", err)
		}
		energy := 0.0
		for offset := 0; offset+1 < len(pcm); offset += 2 {
			sample := float64(int16(binary.LittleEndian.Uint16(pcm[offset:]))) / 32768
			energy += sample * sample
		}
		rms := math.Sqrt(energy / float64(len(pcm)/2))
		if frame.red && rms < 0.02 || !frame.red && rms > 0.002 {
			t.Fatalf("original sound or silent interval changed at %s: rms=%f", frame.time, rms)
		}
	}
}

func TestMergeVideoFilesCancellationAndInvalidInputs(t *testing.T) {
	clip := videoMergeFixture(t, "green", 64, 64, false)
	destination := filepath.Join(t.TempDir(), "movie.mp4")
	if _, err := MergeVideoFiles(context.Background(), []string{}, destination, []float64{}); err == nil {
		t.Fatal("empty inputs accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := MergeVideoFiles(ctx, []string{clip, clip}, destination, []float64{0.6, 0.6}); err == nil {
		t.Fatal("cancelled merge completed")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("cancelled merge left a partial output")
	}
	invalid := filepath.Join(t.TempDir(), "invalid.mp4")
	if err := os.WriteFile(invalid, []byte("not a video"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := MergeVideoFiles(context.Background(), []string{clip, invalid}, destination, []float64{0.6, 0.6}); err == nil {
		t.Fatal("corrupt video accepted")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("failed merge left a partial output")
	}
}

func TestMergeVideoFilesSingleClipUsesExactTargetAndPreservesSource(t *testing.T) {
	source := videoMergeFixture(t, "red", 160, 120, true)
	original, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "single.mp4")
	info, err := MergeVideoFiles(context.Background(), []string{source}, destination, []float64{0.6})
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(info.Duration-0.6) > 0.04 || !info.HasAudio || info.SilentClips != 0 {
		t.Fatalf("delivery metadata: %+v", info)
	}
	unchanged, err := os.ReadFile(source)
	if err != nil || !slices.Equal(original, unchanged) {
		t.Fatal("source clip changed", err)
	}
	metadata, err := ProbeCanvasVideo(context.Background(), destination)
	if err != nil || metadata.HasAudio == nil || !*metadata.HasAudio || metadata.DurationMS < 580 || metadata.DurationMS > 640 {
		t.Fatalf("probe metadata: %+v %v", metadata, err)
	}
	if _, err := MergeVideoFiles(context.Background(), []string{source}, destination, []float64{0.2}); err == nil {
		t.Fatal("large duration mismatch silently cut source")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("failed delivery retained output")
	}
}
