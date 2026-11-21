package service

import (
	"encoding/json"
	"sort"
	"sync"

	"chatgpt2api/internal/util"
)

// CreationTaskSubscription coalesces notifications; each read returns the latest
// revisions, so a slow browser cannot block workers or lose terminal results.
type CreationTaskSubscription struct {
	service  *ImageTaskService
	identity Identity
	owner    string
	scope    CreationTaskEventScope
	batches  map[string]struct{}
	changed  chan struct{}
	seen     map[string]creationTaskEventRevision
	initial  bool
	close    sync.Once
}

type CreationTaskEventScope struct {
	TaskIDs          []string `json:"task_ids"`
	WorkflowBatchIDs []string `json:"workflow_batch_ids"`
}

type creationTaskEventRevision struct {
	revision int
	updated  string
	status   string
	deleted  bool
}

type CreationTaskEvent struct {
	Type       string            `json:"type"`
	Items      []json.RawMessage `json:"items"`
	DeletedIDs []string          `json:"deleted_ids"`
}

func (s *ImageTaskService) SubscribeTasks(identity Identity, scope CreationTaskEventScope) (*CreationTaskSubscription, error) {
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
	batches := make(map[string]struct{}, len(scope.WorkflowBatchIDs))
	for _, id := range scope.WorkflowBatchIDs {
		batches[id] = struct{}{}
	}
	subscription := &CreationTaskSubscription{
		service: s, identity: identity, owner: ownerID(identity), scope: scope, batches: batches,
		changed: make(chan struct{}, 1), initial: true,
	}
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
	current := make(map[string]creationTaskEventRevision, len(s.seen))
	appendTask := func(id string, task map[string]any) error {
		if _, exists := current[id]; exists {
			return nil
		}
		revision := creationTaskEventRevision{
			revision: util.ToInt(task["revision"], 0), updated: util.Clean(task["updated_at"]), status: util.Clean(task["status"]),
		}
		current[id] = revision
		if previous, exists := s.seen[id]; exists && previous == revision {
			return nil
		}
		encoded, err := json.Marshal(publicTask(task, s.identity))
		if err != nil {
			return err
		}
		event.Items = append(event.Items, encoded)
		return nil
	}
	deleted := make(map[string]struct{})
	for _, id := range s.scope.TaskIDs {
		key := taskKey(s.owner, id)
		if task := s.service.tasks[key]; task != nil && task["owner_id"] == s.owner {
			if err := appendTask(id, task); err != nil {
				return event, err
			}
		} else if _, known := s.service.deletedTasks[key]; known {
			current[id] = creationTaskEventRevision{deleted: true}
			if !s.seen[id].deleted {
				deleted[id] = struct{}{}
			}
		}
	}
	if len(s.batches) > 0 {
		for _, task := range s.service.tasks {
			if task["owner_id"] != s.owner {
				continue
			}
			context, ok := task["workflow_context"].(map[string]any)
			if !ok || workflowTaskID(context) == "" {
				continue
			}
			id := util.Clean(task["id"])
			if _, selected := s.batches[workflowTaskBatchID(context, id)]; selected {
				if err := appendTask(id, task); err != nil {
					return event, err
				}
			}
		}
	}
	for id, previous := range s.seen {
		if _, exists := current[id]; !exists && !previous.deleted {
			deleted[id] = struct{}{}
		}
	}
	for id := range deleted {
		event.DeletedIDs = append(event.DeletedIDs, id)
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
