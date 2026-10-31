package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMyAssetServiceReturnsWhenTheDatabaseHangs(t *testing.T) {
	shortenTaskStorageTimeout(t)
	assets := &MyAssetService{store: hangingContextStore{}}

	started := time.Now()
	if _, err := assets.List("owner"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("List() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("List() took %v while holding the lock, the timeout was not applied", elapsed)
	}
}
