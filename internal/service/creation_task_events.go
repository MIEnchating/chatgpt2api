package service

import (
	"encoding/json"
	"sort"
	"strconv"
	"sync"

	"chatgpt2api/internal/util"
)

// CreationTaskSubscription coalesces notifications; each read returns the latest
// revisions, so a slow browser cannot block workers or lose terminal results.
type CreationTaskSubscription struct {
	service  *ImageTaskService
	identity Identity
	changed  chan struct{}
	seen     map[string]string
	initial  bool
	close    sync.Once
}

type CreationTaskEvent struct {
	Type       string            `json:"type"`
	Items      []json.RawMessage `json:"items"`
	DeletedIDs []string          `json:"deleted_ids"`
}

func (s *ImageTaskService) SubscribeTasks(identity Identity) (*CreationTaskSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.closed {
		return nil, ErrImageTaskServiceClosed
	}
	if err := s.ensureLoadedLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	recovered := s.recoverUnfinishedLocked()
	if s.cleanupLocked() || recovered {
		_ = s.saveWithRetryLocked()
	}
	subscription := &CreationTaskSubscription{service: s, identity: identity, changed: make(chan struct{}, 1), seen: map[string]string{}, initial: true}
	s.taskSubscribers[subscription.changed] = struct{}{}
	s.startRemoteMonitorLocked()
	return subscription, nil
}

func (s *CreationTaskSubscription) Changed() <-chan struct{} { return s.changed }

func (s *CreationTaskSubscription) Close() {
	s.close.Do(func() {
		s.service.mu.Lock()
		delete(s.service.taskSubscribers, s.changed)
		s.service.mu.Unlock()
	})
}

// Read serializes public data while locked, avoiding mutable maps escaping to
// the HTTP writer. Reconnection starts a fresh, authoritative snapshot.
func (s *CreationTaskSubscription) Read() (CreationTaskEvent, error) {
	s.service.mu.RLock()
	defer s.service.mu.RUnlock()
	event := CreationTaskEvent{Type: "tasks", Items: []json.RawMessage{}, DeletedIDs: []string{}}
	if s.service.stopping || s.service.closed {
		return event, ErrImageTaskServiceClosed
	}
	if s.initial {
		event.Type = "snapshot"
	}
	owner := ownerID(s.identity)
	current := make(map[string]string)
	for _, task := range s.service.tasks {
		if task["owner_id"] != owner {
			continue
		}
		id := util.Clean(task["id"])
		revision := strconv.Itoa(util.ToInt(task["revision"], 0)) + ":" + util.Clean(task["updated_at"]) + ":" + util.Clean(task["status"])
		current[id] = revision
		if !s.initial && s.seen[id] == revision {
			continue
		}
		encoded, err := json.Marshal(publicTask(task, s.identity))
		if err != nil {
			return event, err
		}
		event.Items = append(event.Items, encoded)
	}
	for id := range s.seen {
		if _, exists := current[id]; !exists {
			event.DeletedIDs = append(event.DeletedIDs, id)
		}
	}
	sort.Strings(event.DeletedIDs)
	s.seen, s.initial = current, false
	return event, nil
}

func (s *ImageTaskService) notifyTaskSubscribersLocked() {
	for changed := range s.taskSubscribers {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
}
