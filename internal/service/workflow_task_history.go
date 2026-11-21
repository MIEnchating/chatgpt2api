package service

import (
	"errors"
	"maps"
	"sort"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type WorkflowTaskHistoryQuery struct {
	Page     int
	PageSize int
	Status   string
	Active   bool
}

type WorkflowTaskHistoryCounts struct {
	All     int `json:"all"`
	Running int `json:"running"`
	Success int `json:"success"`
	Failed  int `json:"failed"`
}

type WorkflowTaskHistoryPage struct {
	Items       []map[string]any          `json:"items"`
	Counts      WorkflowTaskHistoryCounts `json:"counts"`
	Total       int                       `json:"total"`
	Page        int                       `json:"page"`
	LatestRunAt map[string]int64          `json:"latest_run_at,omitempty"`
}

type WorkflowTaskCleanupReference struct {
	URL        string `json:"url"`
	StorageKey string `json:"storageKey"`
	Temporary  bool   `json:"temporary"`
}

type WorkflowTaskCleanupResult struct {
	DeletedBatchIDs []string                       `json:"deleted_batch_ids"`
	References      []WorkflowTaskCleanupReference `json:"references,omitempty"`
	ResultURLs      []string                       `json:"result_urls,omitempty"`
}

func (s *ImageTaskService) ClearWorkflowTaskHistory(identity Identity, excludedIDs []string, includeAssets bool) (WorkflowTaskCleanupResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.closed {
		return WorkflowTaskCleanupResult{}, ErrImageTaskServiceClosed
	}
	if err := s.ensureLoadedLocked(); err != nil {
		return WorkflowTaskCleanupResult{}, ImageTaskLoadError{Err: err}
	}
	excluded := make(map[string]bool, len(excludedIDs))
	for _, id := range excludedIDs {
		excluded[id] = true
	}
	// Keep the monitor from replacing the storage revision between read and write.
	s.taskDocumentMu.Lock()
	defer s.taskDocumentMu.Unlock()
	owner := ownerID(identity)
	var candidates map[string]bool
	for range 3 {
		if err := s.refreshTasksLocked(); err != nil {
			return WorkflowTaskCleanupResult{}, ImageTaskLoadError{Err: err}
		}
		now := time.Now()
		batches := collectWorkflowTaskBatches(s.tasks, owner, now)
		if candidates == nil {
			candidates = make(map[string]bool, len(batches))
			for id, batch := range batches {
				if !excluded[id] && batch.status(now) != "running" {
					candidates[id] = true
				}
			}
		}
		result := WorkflowTaskCleanupResult{DeletedBatchIDs: []string{}}
		removed := make(map[string]map[string]any)
		for id := range candidates {
			batch := batches[id]
			if batch == nil || batch.status(now) == "running" {
				continue
			}
			result.DeletedBatchIDs = append(result.DeletedBatchIDs, id)
			for _, task := range batch.items {
				removed[taskKey(owner, util.Clean(task["id"]))] = task
			}
		}
		if len(removed) == 0 {
			return result, nil
		}
		result.References, result.ResultURLs = workflowCleanupMedia(s.tasks, removed, owner, includeAssets)
		previousTombstones := maps.Clone(s.deletedTasks)
		deletedAt := now.UTC().Format(time.RFC3339Nano)
		for key := range removed {
			delete(s.tasks, key)
			s.deletedTasks[key] = deletedAt
		}
		// Compare and write once. On conflict, restore the local tasks and recheck
		// the whole batch against the next snapshot before applying deletion again.
		err := s.persistLocked()
		if err == nil {
			s.persistenceDirty = false
			s.notifyTaskSubscribersLocked()
			sort.Strings(result.DeletedBatchIDs)
			return result, nil
		}
		maps.Copy(s.tasks, removed)
		s.deletedTasks = previousTombstones
		if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
			return WorkflowTaskCleanupResult{}, ImageTaskPersistenceError{Err: err, TaskStarted: true}
		}
	}
	return WorkflowTaskCleanupResult{}, ImageTaskPersistenceError{Err: storage.ErrConcurrentRowUpdate, TaskStarted: true}
}

func workflowCleanupMedia(tasks, removed map[string]map[string]any, owner string, includeAssets bool) ([]WorkflowTaskCleanupReference, []string) {
	retainedKeys := make(map[string]bool)
	retainedURLs := make(map[string]bool)
	for key, task := range tasks {
		if task["owner_id"] != owner || removed[key] != nil {
			continue
		}
		for _, ref := range util.AsMapSlice(util.StringMap(task["workflow_context"])["references"]) {
			retainedKeys[util.Clean(ref["storageKey"])] = true
			retainedURLs[util.Clean(ref["url"])] = true
		}
	}
	var references []WorkflowTaskCleanupReference
	var urls []string
	seenRefs := make(map[string]bool)
	seenURLs := make(map[string]bool)
	for _, task := range removed {
		for _, ref := range util.AsMapSlice(util.StringMap(task["workflow_context"])["references"]) {
			key := util.Clean(ref["storageKey"])
			url := util.Clean(ref["url"])
			if ref["temporary"] == true && key != "" && !retainedKeys[key] && (url == "" || !retainedURLs[url]) && !seenRefs[key] {
				references = append(references, WorkflowTaskCleanupReference{URL: url, StorageKey: key, Temporary: true})
				seenRefs[key] = true
			}
		}
		if includeAssets {
			for _, item := range util.AsMapSlice(task["data"]) {
				url := firstNonEmpty(util.Clean(item["url"]), util.Clean(item["video_url"]))
				if url != "" && !strings.HasPrefix(url, "data:") && !seenURLs[url] {
					urls = append(urls, url)
					seenURLs[url] = true
				}
			}
		}
	}
	return references, urls
}

type workflowTaskBatch struct {
	id         string
	workflowID string
	items      []map[string]any
	started    time.Time
	updated    time.Time
	expected   int
	timeout    int
	firstIndex int
	firstID    string
	units      map[int]bool
	unindexed  int
	active     bool
	failed     bool
}

func workflowTaskID(context map[string]any) string {
	id, _ := context["workflow_id"].(string)
	return id
}

func (s *ImageTaskService) WorkflowTaskHistory(identity Identity, query WorkflowTaskHistoryQuery) (WorkflowTaskHistoryPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.prepareTaskReadLocked(); err != nil {
		return WorkflowTaskHistoryPage{}, err
	}
	now := time.Now()
	batches := collectWorkflowTaskBatches(s.tasks, ownerID(identity), now)
	result := WorkflowTaskHistoryPage{Items: []map[string]any{}, Page: 1}
	if query.Active {
		result.LatestRunAt = make(map[string]int64)
	}
	matching := make([]*workflowTaskBatch, 0, len(batches))
	for _, batch := range batches {
		status := batch.status(now)
		result.Counts.All++
		switch status {
		case "running":
			result.Counts.Running++
		case "success":
			result.Counts.Success++
			if query.Active {
				result.LatestRunAt[batch.workflowID] = max(result.LatestRunAt[batch.workflowID], batch.updated.UnixMilli())
			}
		case "failed":
			result.Counts.Failed++
		}
		if query.Active && status == "running" || !query.Active && (query.Status == "all" || query.Status == status) {
			matching = append(matching, batch)
		}
	}
	result.Total = len(matching)
	sort.Slice(matching, func(i, j int) bool {
		a, b := matching[i], matching[j]
		if !a.started.Equal(b.started) {
			return a.started.After(b.started)
		}
		return a.id < b.id
	})
	if !query.Active {
		size := min(48, max(1, query.PageSize))
		lastPage := max(1, (len(matching)+size-1)/size)
		result.Page = min(lastPage, max(1, query.Page))
		start := (result.Page - 1) * size
		matching = matching[start:min(start+size, len(matching))]
	}
	for _, batch := range matching {
		for _, task := range batch.items {
			result.Items = append(result.Items, publicTask(task, identity))
		}
	}
	return result, nil
}

func collectWorkflowTaskBatches(tasks map[string]map[string]any, owner string, now time.Time) map[string]*workflowTaskBatch {
	batches := make(map[string]*workflowTaskBatch)
	for _, task := range tasks {
		if task["owner_id"] != owner {
			continue
		}
		context := util.StringMap(task["workflow_context"])
		if !restorableWorkflowContext(context) {
			continue
		}
		taskID := util.Clean(task["id"])
		id := workflowTaskBatchID(context, taskID)
		batch := batches[id]
		index, hasIndex := workflowTaskInteger(context["batch_index"])
		sortIndex := max(1, index)
		if batch == nil {
			batch = &workflowTaskBatch{id: id, started: now, units: make(map[int]bool)}
			batches[id] = batch
		}
		if batch.firstID == "" || sortIndex < batch.firstIndex || sortIndex == batch.firstIndex && taskID < batch.firstID {
			config := util.StringMap(context["config"])
			timeout, _ := strconv.Atoi(util.Clean(config["timeout"]))
			if timeout == 0 {
				timeout = 600
			}
			batch.workflowID = workflowTaskID(context)
			batch.firstIndex = sortIndex
			batch.firstID = taskID
			batch.timeout = max(1, timeout)
		}
		batch.items = append(batch.items, task)
		count, _ := workflowTaskInteger(context["batch_count"])
		batch.expected = max(batch.expected, count)
		if hasIndex && index > 0 {
			batch.units[index] = true
		} else if context["batch_index"] == nil || index == 0 && hasIndex {
			batch.unindexed++
		}
		if started := parseWorkflowHistoryTime(task["created_at"], now); started.Before(batch.started) || len(batch.items) == 1 {
			batch.started = started
		}
		if updated := parseWorkflowHistoryTime(task["updated_at"], now); updated.After(batch.updated) {
			batch.updated = updated
		}
		status := util.Clean(task["status"])
		batch.active = batch.active || status != TaskStatusSuccess && status != TaskStatusError && status != TaskStatusCancelled
		batch.failed = batch.failed || status == TaskStatusError || status == TaskStatusCancelled || status == TaskStatusSuccess && !workflowTaskHasImage(task)
	}
	return batches
}

func workflowTaskBatchID(context map[string]any, taskID string) string {
	batchID, _ := context["batch_task_id"].(string)
	return firstNonEmpty(strings.TrimSpace(batchID), taskID)
}

func (b *workflowTaskBatch) status(now time.Time) string {
	if b.active {
		return "running"
	}
	expected := max(b.expected, len(b.items))
	present := b.unindexed
	for unit := range b.units {
		if unit <= expected {
			present++
		}
	}
	if expected > present {
		budget := float64(expected) * (float64(b.timeout) + 60)
		if now.Sub(b.updated).Seconds() <= budget {
			return "running"
		}
		return "failed"
	}
	if b.failed {
		return "failed"
	}
	return "success"
}

func parseWorkflowHistoryTime(value any, fallback time.Time) time.Time {
	parsed := parseTaskTime(value)
	if parsed.Unix() == 0 {
		return fallback
	}
	return parsed
}

func workflowTaskHasImage(task map[string]any) bool {
	for _, item := range util.AsMapSlice(task["data"]) {
		if firstNonEmpty(util.Clean(item["url"]), util.Clean(item["video_url"]), util.Clean(item["b64_json"])) != "" {
			return true
		}
	}
	return false
}

func workflowTaskInteger(value any) (int, bool) {
	if _, isString := value.(string); isString {
		return 0, false
	}
	number, ok := util.StrictInt(value)
	const maxSafeInteger = 1<<53 - 1
	if !ok || int64(number) > maxSafeInteger || int64(number) < -maxSafeInteger {
		return 0, false
	}
	return number, true
}

func restorableWorkflowContext(context map[string]any) bool {
	name, _ := context["workflow_name"].(string)
	_, prompt := context["prompt"].(string)
	_, inputs := context["inputs"].(map[string]any)
	count, validCount := workflowTaskInteger(context["count"])
	if workflowTaskID(context) == "" || name == "" || !prompt || !inputs || !validCount || count < 1 {
		return false
	}
	config := util.StringMap(context["config"])
	for _, key := range []string{"model", "image_model", "quality", "size", "count", "timeout", "system_prompt", "prompt_template", "negative_prompt"} {
		if _, ok := config[key].(string); !ok {
			return false
		}
	}
	switch config["api_mode"] {
	case "images", "responses", "chat":
	default:
		return false
	}
	execution := util.StringMap(context["execution"])
	for _, key := range []string{"stream", "response_format_b64_json", "codex_cli_compatibility"} {
		if _, ok := execution[key].(bool); !ok {
			return false
		}
	}
	partial, ok := workflowTaskInteger(execution["partial_images"])
	if !ok || partial < 0 {
		return false
	}
	if token, exists := execution["token_name"]; exists {
		if _, ok := token.(string); !ok {
			return false
		}
	}
	refs := util.AsMapSlice(context["references"])
	switch raw := context["references"].(type) {
	case []any:
		if len(raw) != len(refs) {
			return false
		}
	case []map[string]any:
	default:
		return false
	}
	for _, ref := range refs {
		for _, key := range []string{"id", "name", "url"} {
			if _, ok := ref[key].(string); !ok {
				return false
			}
		}
		if role, _ := ref["role"].(string); role != "template" && role != "product" {
			return false
		}
	}
	return true
}
