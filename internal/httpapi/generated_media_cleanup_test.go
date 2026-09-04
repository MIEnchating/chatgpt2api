package httpapi

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupGeneratedMediaUsesMediaAndReferenceRetention(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	app.cancel()
	app.backgroundWorkers.Wait()
	now := time.Now()

	files := []struct {
		path    string
		age     time.Duration
		deleted bool
	}{
		{path: filepath.Join(app.videoDir, "expired.mp4"), age: 31 * 24 * time.Hour, deleted: true},
		{path: filepath.Join(app.audioDir, "expired.mp3"), age: 31 * 24 * time.Hour, deleted: true},
		{path: filepath.Join(app.videoReferenceDir, "reference-11111111111111111111111111111111.mp4"), age: 25 * time.Hour, deleted: true},
		{path: filepath.Join(app.videoDir, "current.mp4"), age: time.Hour},
		{path: filepath.Join(app.videoReferenceDir, "reference-22222222222222222222222222222222.mp4"), age: time.Hour},
		{path: filepath.Join(app.videoDir, ".video-in-progress"), age: 31 * 24 * time.Hour},
	}
	for _, file := range files {
		if err := os.WriteFile(file.path, []byte("media"), 0o600); err != nil {
			t.Fatal(err)
		}
		modified := now.Add(-file.age)
		if err := os.Chtimes(file.path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}

	deleted, err := app.cleanupGeneratedMedia(now)
	if err != nil || deleted != 3 {
		t.Fatalf("cleanupGeneratedMedia() = (%d, %v), want 3", deleted, err)
	}
	for _, file := range files {
		_, err := os.Stat(file.path)
		if file.deleted && !os.IsNotExist(err) {
			t.Fatalf("expired file %q remains: %v", file.path, err)
		}
		if !file.deleted && err != nil {
			t.Fatalf("preserved file %q missing: %v", file.path, err)
		}
	}
}
