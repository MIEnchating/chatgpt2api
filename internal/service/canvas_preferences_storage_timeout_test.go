package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCanvasDocumentServiceReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	canvas := &CanvasDocumentService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := canvas.Workspace("owner"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Workspace() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("Workspace() took %v while holding the lock, the timeout was not applied", elapsed)
	}
}

func TestImageGenerationPreferenceServiceReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	preferences := &ImageGenerationPreferenceService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := preferences.Preferences("owner"); err == nil {
		t.Fatal("Preferences() should fail when the database hangs")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("Preferences() took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
