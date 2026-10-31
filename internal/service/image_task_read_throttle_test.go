package service

import (
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

// loadCountingStore counts document reads so tests can see how often the task document is reloaded.
type loadCountingStore struct {
	storage.JSONDocumentBackend
	mu    sync.Mutex
	loads int
}

func (s *loadCountingStore) LoadJSONDocument(name string) (any, error) {
	s.mu.Lock()
	s.loads++
	s.mu.Unlock()
	return s.JSONDocumentBackend.LoadJSONDocument(name)
}

func (s *loadCountingStore) LoadCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loads
}

func TestImageTaskListReadsAreThrottledButStillRefreshAfterTheInterval(t *testing.T) {
	original := imageTaskReadRefreshInterval
	imageTaskReadRefreshInterval = 300 * time.Millisecond
	t.Cleanup(func() { imageTaskReadRefreshInterval = original })

	documentStore := jsonDocumentStoreFromBackend(newTestStorageBackend(t))
	store := &loadCountingStore{JSONDocumentBackend: documentStore}
	svc := newImageTaskService(store, nil, nil, nil, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })
	identity := Identity{ID: "reader", Role: AuthRoleAdmin}

	if _, err := svc.ListTasksWithError(identity, nil); err != nil {
		t.Fatal(err)
	}
	afterFirst := store.LoadCount()
	for range 5 {
		if _, err := svc.ListTasksWithError(identity, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := store.LoadCount(); got != afterFirst {
		t.Fatalf("listing within the refresh interval reloaded the document: loads %d -> %d", afterFirst, got)
	}

	time.Sleep(400 * time.Millisecond)
	if _, err := svc.ListTasksWithError(identity, nil); err != nil {
		t.Fatal(err)
	}
	if got := store.LoadCount(); got <= afterFirst {
		t.Fatalf("listing after the refresh interval did not reload the document: loads stayed at %d", got)
	}
}
