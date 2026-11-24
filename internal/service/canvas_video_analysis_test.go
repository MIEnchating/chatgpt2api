package service

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCanvasVideoAnalysisSamplesActualFramesAndPaginates(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	input := filepath.Join(t.TempDir(), "source.mp4")
	if data, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=4", "-t", "95", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, data)
	}
	ctx := context.Background()
	first, err := ExtractCanvasVideoFrames(ctx, input, CanvasVideoAnalysisOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Frames) != 90 || first.NextStartMS == nil || *first.NextStartMS != 90000 {
		t.Fatalf("pagination: %d %v", len(first.Frames), first.NextStartMS)
	}
	for i, frame := range first.Frames {
		if frame.TimestampMS != int64(i)*1000 || len(frame.JPEG) == 0 {
			t.Fatalf("frame %d: timestamp=%d bytes=%d", i, frame.TimestampMS, len(frame.JPEG))
		}
	}
	next, err := ExtractCanvasVideoFrames(ctx, input, CanvasVideoAnalysisOptions{StartMS: *first.NextStartMS})
	if err != nil || len(next.Frames) != 5 || next.NextStartMS != nil || next.Frames[0].TimestampMS != 90000 {
		t.Fatalf("continuation: %+v %v", next, err)
	}
	detail, err := ExtractCanvasVideoFrames(ctx, input, CanvasVideoAnalysisOptions{StartMS: 1000, EndMS: 3000, Detailed: true})
	if err != nil || len(detail.Frames) != 4 || detail.Frames[1].TimestampMS != 1500 {
		t.Fatalf("detailed sampling: %+v %v", detail, err)
	}
	if _, err := ExtractCanvasVideoFrames(ctx, input, CanvasVideoAnalysisOptions{StartMS: 1000, EndMS: 3000, Original: true}); err == nil {
		t.Fatal("unbounded original-frame range accepted")
	}
	if _, err := ExtractCanvasVideoFrames(ctx, input, CanvasVideoAnalysisOptions{StartMS: 4000, EndMS: 3000}); err == nil {
		t.Fatal("invalid range accepted")
	}
}

func TestCanvasVideoAnalysisShortWindowRetainsEveryOriginalFrame(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	input := filepath.Join(t.TempDir(), "motion.mp4")
	if data, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=40", "-t", "2", "-c:v", "libx264", "-threads", "1", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, data)
	}
	for _, original := range []bool{true, false} {
		batch, err := ExtractCanvasVideoFrames(context.Background(), input, CanvasVideoAnalysisOptions{StartMS: 1000, EndMS: 1250, Original: original})
		if err != nil || len(batch.Frames) != 10 {
			t.Fatalf("short window lost source frames: count=%d err=%v", len(batch.Frames), err)
		}
		for i, frame := range batch.Frames {
			if frame.TimestampMS != 1000+int64(i)*25 {
				t.Fatalf("incorrect frame timestamp: %+v", frame)
			}
		}
	}
}

func TestCanvasVideoAnalysisDeduplicatesStaticFrames(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	input := filepath.Join(t.TempDir(), "static.mp4")
	if data, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:size=96x64:rate=2", "-t", "3", "-c:v", "libx264", "-threads", "1", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, data)
	}
	batch, err := ExtractCanvasVideoFrames(context.Background(), input, CanvasVideoAnalysisOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Frames) != 3 || batch.Frames[1].SameAsMS == nil || *batch.Frames[1].SameAsMS != 0 || batch.Frames[1].JPEG != nil {
		t.Fatalf("static frames not deduplicated: %d", len(batch.Frames))
	}
}

func TestCanvasAgentVideoAnalysisProvidesImagesToModel(t *testing.T) {
	w := parallelAgentWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "clip", Type: "video", URL: "/private.mp4", Title: "Clip"}}
	w.service.SetVideoAnalyzer(func(ctx context.Context, _ Identity, node CanvasNode, options CanvasVideoAnalysisOptions) (CanvasVideoAnalysis, error) {
		if node.ID != "clip" || options.StartMS != 1000 || !options.Detailed {
			t.Fatal("analysis lost node or window")
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > canvasAgentVideoAnalysisTimeout {
			t.Fatal("analysis did not receive its tool deadline")
		}
		return CanvasVideoAnalysis{Frames: []CanvasVideoFrame{{TimestampMS: 1000, URL: "/api/files/frame/content"}}}, nil
	})
	result, err := w.tool(map[string]any{"name": "analyze_video", "arguments": map[string]any{"nodeId": "clip", "question": "构图如何？", "startMs": 1000, "detailed": true}})
	if err != nil || result["ok"] != true || len(w.visuals) != 2 || w.visuals[1]["image"] != "/api/files/frame/content" {
		t.Fatalf("analysis did not provide actual model visuals: %v %v", result, err)
	}
}
