package httpapi

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

func TestCanvasVideoMergeSourceOwnership(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	alice, _ := createPasswordUserSession(t, app, "merge-owner", "", "Alice")
	bob, _ := createPasswordUserSession(t, app, "merge-other", "", "Bob")
	ctx := context.Background()
	content := []byte("owner video")
	object, err := app.storageFiles.Upload(ctx, identityScope(*alice), false, "clip.mp4", "video/mp4", content, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range []service.CanvasNode{
		{URL: object.URL, StorageKey: object.StorageKey},
		{URL: object.URL},
		{URL: "https://untrusted.example/api/files/" + object.ID + "/content"},
	} {
		reader, err := app.canvasMergeVideoReader(ctx, *alice, node)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !bytes.Equal(data, content) {
			t.Fatal("owner could not read source video", err)
		}
		reader, err = app.canvasMergeVideoReader(ctx, *bob, node)
		if err == nil {
			reader.Close()
			t.Fatal("cross-owner source read succeeded")
		}
	}
	for _, raw := range []string{"/videos/../private.mp4", "/videos/unowned.mp4", "file:///etc/passwd", "http://127.0.0.1/private.mp4", "http://169.254.169.254/latest/meta-data", "/video-references/unsigned.mp4"} {
		reader, err := app.canvasMergeVideoReader(ctx, *alice, service.CanvasNode{URL: raw})
		if err == nil {
			reader.Close()
			t.Fatalf("unsafe or unowned source accepted: %s", raw)
		}
	}
}

func TestCanvasVideoMergeStoresOwnedMovie(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip("FFmpeg is required for media integration tests")
		}
	}
	app := newTestApp(t)
	defer app.Close()
	alice, _ := createPasswordUserSession(t, app, "movie-owner", "", "Alice")
	bob, _ := createPasswordUserSession(t, app, "movie-other", "", "Bob")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	source := filepath.Join(t.TempDir(), "clip.mp4")
	output, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x120:d=0.3", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", source).CombinedOutput()
	if err != nil {
		t.Fatalf("create fixture: %v %s", err, output)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	object, err := app.storageFiles.Upload(ctx, identityScope(*alice), false, "clip.mp4", "video/mp4", data, nil)
	if err != nil {
		t.Fatal(err)
	}
	node := service.CanvasNode{URL: object.URL, StorageKey: object.StorageKey}
	movie, err := app.mergeCanvasVideos(ctx, *alice, []service.CanvasNode{node, node}, service.CanvasVideoMergeOptions{ShotSeconds: []float64{0.32, 0.32}})
	if err != nil {
		t.Fatal(err)
	}
	if movie.URL == "" || movie.StorageKey == "" || movie.Bytes <= 0 || movie.Duration < .5 || movie.Width != 160 || movie.Height != 120 {
		t.Fatalf("invalid merged movie: %+v", movie)
	}
	merged := service.CanvasNode{URL: movie.URL, StorageKey: movie.StorageKey}
	reader, err := app.canvasMergeVideoReader(ctx, *alice, merged)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || int64(len(stored)) != movie.Bytes || !bytes.Contains(stored[:min(len(stored), 32)], []byte("ftyp")) {
		t.Fatal("merged MP4 was not stored completely", err)
	}
	if reader, err := app.canvasMergeVideoReader(ctx, *bob, merged); err == nil {
		reader.Close()
		t.Fatal("another user read merged movie")
	}
}
