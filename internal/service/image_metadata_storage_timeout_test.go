package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestImageServiceMetadataReadReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	images := &ImageService{config: fixedImageConfig{metadataDir: t.TempDir()}, store: hangingContextStore{}}

	started := time.Now()
	if _, err := images.loadImageMetadata("2026/10/30/a.png"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("loadImageMetadata() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("loadImageMetadata() took %v, the timeout was not applied", elapsed)
	}
}
