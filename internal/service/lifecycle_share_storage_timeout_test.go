package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFileLifecycleReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	lifecycle := &FileLifecycleService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := lifecycle.loadLocked(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("loadLocked() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("loadLocked() took %v, the timeout was not applied", elapsed)
	}
}

func TestCanvasShareReadReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	canvas := &CanvasDocumentService{store: hangingContextStore{}}
	token := strings.Repeat("a", 64)

	started := time.Now()
	if _, _, err := canvas.SharedCanvas(token); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SharedCanvas() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("SharedCanvas() took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
