package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func mergeConversationHistory(history *ImageConversationHistoryService, ownerID string, incoming []map[string]any) ([]map[string]any, error) {
	if _, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, incoming, nil); err != nil {
		return nil, err
	}
	return listImageConversationHistoryForTest(history, ownerID)
}

func listImageConversationHistoryForTest(history *ImageConversationHistoryService, ownerID string) ([]map[string]any, error) {
	items := make([]map[string]any, 0)
	cursor := ""
	for {
		page, err := history.ListPage(context.Background(), ownerID, cursor, imageConversationMaximumLimit)
		if err != nil {
			return nil, err
		}
		for _, summary := range page.Items {
			item, found, _, err := history.GetItem(context.Background(), ownerID, util.Clean(summary["id"]))
			if err != nil {
				return nil, err
			}
			if found {
				items = append(items, item)
			}
		}
		if !page.HasMore {
			return items, nil
		}
		cursor = page.NextCursor
	}
}

func TestImageConversationHistoryServicePersistsAndIsolatesOwners(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)

	items, err := mergeConversationHistory(history, "user-a", []map[string]any{
		{
			"id":        "conversation-1",
			"title":     "first",
			"updatedAt": "2026-07-15T10:00:00Z",
			"turns":     []any{map[string]any{"id": "turn-1"}},
		},
	})
	if err != nil {
		t.Fatalf("Merge() error = %v", err)
	}
	if len(items) != 1 || items[0]["title"] != "first" {
		t.Fatalf("Merge() items = %#v", items)
	}

	items, err = mergeConversationHistory(history, "user-a", []map[string]any{
		{
			"id":        "conversation-1",
			"title":     "older",
			"updatedAt": "2026-07-15T09:00:00Z",
			"turns":     []any{},
		},
		{
			"id":        "conversation-2",
			"title":     "second",
			"updatedAt": "2026-07-15T11:00:00Z",
			"turns":     []any{},
		},
	})
	if err != nil {
		t.Fatalf("second Merge() error = %v", err)
	}
	if len(items) != 2 || items[0]["id"] != "conversation-2" || items[1]["title"] != "first" {
		t.Fatalf("second Merge() items = %#v", items)
	}

	other, err := listImageConversationHistoryForTest(history, "user-b")
	if err != nil {
		t.Fatalf("List(other) error = %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("other owner saw conversations: %#v", other)
	}

	reloaded := NewImageConversationHistoryService(backend)
	items, err = listImageConversationHistoryForTest(reloaded, "user-a")
	if err != nil || len(items) != 2 {
		t.Fatalf("reloaded List() items=%#v error=%v", items, err)
	}

	removed, _, err := reloaded.DeleteMinimal(context.Background(), "user-a", "conversation-1")
	items, listErr := listImageConversationHistoryForTest(reloaded, "user-a")
	if err != nil || listErr != nil || !removed || len(items) != 1 {
		t.Fatalf("DeleteMinimal() items=%#v removed=%v error=%v listError=%v", items, removed, err, listErr)
	}
	items, err = mergeConversationHistory(reloaded, "user-a", []map[string]any{{
		"id": "conversation-1", "revision": 99, "title": "stale device", "updatedAt": "2099-01-01T00:00:00Z", "turns": []any{},
	}})
	if err != nil || len(items) != 1 {
		t.Fatalf("deleted conversation was resurrected: items=%#v error=%v", items, err)
	}
	if _, err := reloaded.ClearMinimal(context.Background(), "user-a"); err != nil {
		t.Fatalf("ClearMinimal() error = %v", err)
	}
	items, err = listImageConversationHistoryForTest(reloaded, "user-a")
	if err != nil || len(items) != 0 {
		t.Fatalf("List() after Clear items=%#v error=%v", items, err)
	}
	items, err = mergeConversationHistory(reloaded, "user-a", []map[string]any{{
		"id": "conversation-2", "revision": 100, "title": "stale after clear", "updatedAt": "2099-01-01T00:00:00Z", "turns": []any{},
	}})
	if err != nil || len(items) != 0 {
		t.Fatalf("cleared conversation was resurrected: items=%#v error=%v", items, err)
	}
}

func TestImageConversationHistoryServiceRejectsInvalidItems(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	for index, item := range []map[string]any{
		{"updatedAt": "2026-07-15T10:00:00Z", "turns": []any{}},
		{"id": "conversation-1", "turns": []any{}},
		{"id": "conversation-1", "updatedAt": "2026-07-15T10:00:00Z"},
	} {
		if _, err := mergeConversationHistory(history, "user-a", []map[string]any{item}); err == nil {
			t.Fatalf("case %d Merge() error = nil", index)
		} else {
			var validationErr ImageConversationHistoryValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("case %d Merge() error type = %T, want validation error", index, err)
			}
		}
	}
}

func TestImageConversationHistoryDeleteMissingItemPersistsTombstone(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	removed, _, err := history.DeleteMinimal(context.Background(), "user-a", "conversation-delayed")
	items, listErr := listImageConversationHistoryForTest(history, "user-a")
	if err != nil || listErr != nil || removed || len(items) != 0 {
		t.Fatalf("DeleteMinimal(missing) items=%#v removed=%v error=%v listError=%v", items, removed, err, listErr)
	}

	items, err = mergeConversationHistory(history, "user-a", []map[string]any{{
		"id":        "conversation-delayed",
		"revision":  99,
		"updatedAt": "2099-01-01T00:00:00Z",
		"turns":     []any{},
	}})
	if err != nil || len(items) != 0 {
		t.Fatalf("delayed save resurrected missing deleted item: items=%#v error=%v", items, err)
	}
}

func TestImageConversationHistoryClearWatermarkRejectsDelayedUnknownItems(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	delayedAt := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := history.ClearMinimal(context.Background(), "user-a"); err != nil {
		t.Fatalf("ClearMinimal() error = %v", err)
	}

	items, err := mergeConversationHistory(history, "user-a", []map[string]any{{
		"id":        "conversation-delayed",
		"revision":  1,
		"createdAt": delayedAt,
		"updatedAt": "2099-01-01T00:00:00Z",
		"turns":     []any{},
	}})
	if err != nil || len(items) != 0 {
		t.Fatalf("pre-clear unknown item was resurrected: items=%#v error=%v", items, err)
	}

	createdAfterClear := time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	items, err = mergeConversationHistory(history, "user-a", []map[string]any{{
		"id":        "conversation-new",
		"revision":  1,
		"createdAt": createdAfterClear,
		"updatedAt": createdAfterClear,
		"turns":     []any{},
	}})
	if err != nil || len(items) != 1 || items[0]["id"] != "conversation-new" {
		t.Fatalf("post-clear item was not accepted: items=%#v error=%v", items, err)
	}
}

func TestImageConversationHistoryMergeAcknowledgements(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	current := map[string]any{
		"id":        "conversation-ack",
		"revision":  7,
		"title":     "current",
		"createdAt": "2026-07-15T09:00:00Z",
		"updatedAt": "2026-07-15T10:00:00Z",
		"turns":     []any{},
	}
	acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{current}, nil)
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("initial acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{current}, nil)
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("idempotent acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	staleRevision := cloneImageConversationMap(current)
	staleRevision["revision"] = 6
	staleRevision["updatedAt"] = "2099-01-01T00:00:00Z"
	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{staleRevision}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("stale revision acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	staleTimestamp := cloneImageConversationMap(current)
	staleTimestamp["updatedAt"] = "2026-07-15T09:30:00Z"
	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{staleTimestamp}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("stale timestamp acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	concurrentSameRevision := cloneImageConversationMap(current)
	concurrentSameRevision["title"] = "conflicting concurrent update"
	concurrentSameRevision["updatedAt"] = "2026-07-15T11:00:00Z"
	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{concurrentSameRevision}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("same-revision conflict acknowledgement = %#v, error=%v", acknowledgements, err)
	}
	items, err := listImageConversationHistoryForTest(history, "user-a")
	if err != nil || len(items) != 1 || items[0]["title"] != "current" {
		t.Fatalf("same-revision conflict changed history: items=%#v error=%v", items, err)
	}

	if _, _, err := history.DeleteMinimal(context.Background(), "user-a", "conversation-ack"); err != nil {
		t.Fatalf("DeleteMinimal() error = %v", err)
	}
	deleted := cloneImageConversationMap(current)
	deleted["revision"] = 8
	deleted["updatedAt"] = "2099-01-01T00:00:00Z"
	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-a", []map[string]any{deleted}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || !acknowledgements[0].Gone {
		t.Fatalf("deleted acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	if _, err := history.ClearMinimal(context.Background(), "user-b"); err != nil {
		t.Fatalf("ClearMinimal() error = %v", err)
	}
	cleared := map[string]any{
		"id":        "conversation-before-clear",
		"revision":  1,
		"createdAt": time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
		"updatedAt": "2099-01-01T00:00:00Z",
		"turns":     []any{},
	}
	acknowledgements, _, err = history.MergeWithAcknowledgementsMinimal(context.Background(), "user-b", []map[string]any{cleared}, nil)
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || !acknowledgements[0].Gone {
		t.Fatalf("cleared acknowledgement = %#v, error=%v", acknowledgements, err)
	}
}

func TestImageConversationHistoryMergeKeepsTerminalImageAgainstStaleRunningSnapshots(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	terminal := imageConversationHistoryTestItem(7, "2026-07-15T10:00:00Z", "success", "task-1", "https://example.test/image.png")
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{terminal}); err != nil {
		t.Fatalf("terminal Merge() error = %v", err)
	}

	cases := []struct {
		name     string
		revision any
		at       string
		taskID   string
	}{
		{name: "lower revision", revision: 6, at: "2026-07-15T12:00:00Z", taskID: "task-1"},
		{name: "same version", revision: 7, at: "2026-07-15T10:00:00Z", taskID: "task-1"},
		{name: "future timestamp lower revision", revision: 5, at: "2099-01-01T00:00:00Z", taskID: "task-1"},
		{name: "missing task id", revision: 6, at: "2026-07-15T12:00:00Z", taskID: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			stale := imageConversationHistoryTestItem(testCase.revision, testCase.at, "loading", testCase.taskID, "")
			if _, err := mergeConversationHistory(history, "user-a", []map[string]any{stale}); err != nil {
				t.Fatalf("stale Merge() error = %v", err)
			}
			items, err := listImageConversationHistoryForTest(history, "user-a")
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}
			image := imageFromHistoryItem(t, items[0])
			if image["status"] != "success" || image["url"] != "https://example.test/image.png" {
				t.Fatalf("stale snapshot replaced terminal image: %#v", image)
			}
		})
	}
}

func TestSameImageTaskRequiresMatchingTaskIdentity(t *testing.T) {
	tests := []struct {
		name  string
		left  string
		right string
		want  bool
	}{
		{name: "same explicit task", left: "task-1", right: "task-1", want: true},
		{name: "different explicit task", left: "task-1", right: "task-2"},
		{name: "both taskless", want: true},
		{name: "left taskless", right: "task-1"},
		{name: "right taskless", left: "task-1"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			left := map[string]any{"taskId": testCase.left}
			right := map[string]any{"taskId": testCase.right}
			if got := sameImageTask(left, right); got != testCase.want {
				t.Fatalf("sameImageTask() = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestImageConversationHistoryMergeUsesTaskRevisionBeforeSnapshotStatus(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)
	newerRunning := imageConversationHistoryTestItem(1, "2026-07-15T10:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, newerRunning, 20, "running")
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{newerRunning}); err != nil {
		t.Fatalf("newer running Merge() error = %v", err)
	}

	olderQueued := imageConversationHistoryTestItem(2, "2026-07-15T11:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, olderQueued, 19, "queued")
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{olderQueued}); err != nil {
		t.Fatalf("older queued Merge() error = %v", err)
	}
	image := imageFromHistoryItem(t, mustListImageConversationHistory(t, history, "user-a"))
	if image["taskStatus"] != "running" || normalizeImageConversationRevision(image["taskRevision"]) != 20 {
		t.Fatalf("older queued snapshot replaced newer running snapshot: %#v", image)
	}

	terminal := imageConversationHistoryTestItem(3, "2026-07-15T12:00:00Z", "success", "task-revision", "https://example.test/final.png")
	setImageConversationTaskState(t, terminal, 21, "success")
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{terminal}); err != nil {
		t.Fatalf("terminal Merge() error = %v", err)
	}
	staleRunning := imageConversationHistoryTestItem(4, "2026-07-15T13:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, staleRunning, 20, "running")
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{staleRunning}); err != nil {
		t.Fatalf("stale running Merge() error = %v", err)
	}

	reloaded := NewImageConversationHistoryService(backend)
	image = imageFromHistoryItem(t, mustListImageConversationHistory(t, reloaded, "user-a"))
	if image["status"] != "success" || image["taskStatus"] != "success" || image["url"] != "https://example.test/final.png" || normalizeImageConversationRevision(image["taskRevision"]) != 21 {
		t.Fatalf("stale running snapshot replaced persisted terminal snapshot: %#v", image)
	}
}

func TestImageConversationHistoryTaskStatusRankBreaksEqualRevisionTies(t *testing.T) {
	testCases := []struct {
		name           string
		currentStatus  string
		incomingStatus string
		wantStatus     string
	}{
		{name: "success over error", currentStatus: "error", incomingStatus: "success", wantStatus: "success"},
		{name: "error over running", currentStatus: "running", incomingStatus: "error", wantStatus: "error"},
		{name: "cancelled over running", currentStatus: "running", incomingStatus: "cancelled", wantStatus: "cancelled"},
		{name: "running over queued", currentStatus: "queued", incomingStatus: "running", wantStatus: "running"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			current := imageConversationTaskStatusTestImage(testCase.currentStatus, 7)
			incoming := imageConversationTaskStatusTestImage(testCase.incomingStatus, 7)
			merged := mergeImageConversationImage(current, incoming)
			if got := util.Clean(merged["taskStatus"]); got != testCase.wantStatus {
				t.Fatalf("merged taskStatus = %q, want %q: %#v", got, testCase.wantStatus, merged)
			}
		})
	}
}

func TestImageConversationHistoryNewerTaskRevisionDoesNotBackfillStaleResult(t *testing.T) {
	current := imageConversationTaskStatusTestImage("running", 9)
	current["url"] = "https://example.test/stale.png"
	incoming := imageConversationTaskStatusTestImage("running", 10)
	merged := mergeImageConversationImage(current, incoming)
	if merged["taskStatus"] != "running" || merged["url"] != nil {
		t.Fatalf("newer running snapshot was polluted by stale terminal data: %#v", merged)
	}
}

func TestImageConversationHistoryHigherActiveRevisionCannotReopenTerminalTask(t *testing.T) {
	current := imageConversationTaskStatusTestImage("success", 9)
	current["url"] = "https://example.test/final.png"
	incoming := imageConversationTaskStatusTestImage("running", 10)
	merged := mergeImageConversationImage(current, incoming)
	if merged["taskStatus"] != "success" || merged["url"] != "https://example.test/final.png" {
		t.Fatalf("higher active revision reopened terminal task: %#v", merged)
	}
}

func TestImageConversationHistoryDropsActivePreviewOutputAndKeepsTerminalOutput(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)
	active := imageConversationHistoryTestItem(1, "2026-07-15T10:00:00Z", "loading", "task-preview", "https://example.test/preview.png")
	setImageConversationTaskState(t, active, 10, "running")
	activeImage := imageFromHistoryItem(t, active)
	activeImage["b64_json"] = "preview-base64"
	activeImage["path"] = "images/preview.png"
	activeImage["text_response"] = "partial response"
	activeImage["videoUrl"] = "/videos/preview.mp4"
	items, err := mergeConversationHistory(history, "user-a", []map[string]any{active})
	if err != nil {
		t.Fatalf("active preview Merge() error = %v", err)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, items[0]), false)
	if _, exists := imageFromHistoryItem(t, items[0])["videoUrl"]; exists {
		t.Fatal("active video output was persisted")
	}

	reloaded := NewImageConversationHistoryService(backend)
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, mustListImageConversationHistory(t, reloaded, "user-a")), false)

	terminal := imageConversationHistoryTestItem(2, "2026-07-15T11:00:00Z", "success", "task-preview", "https://example.test/final.png")
	setImageConversationTaskState(t, terminal, 11, "success")
	terminalImage := imageFromHistoryItem(t, terminal)
	terminalImage["b64_json"] = "final-base64"
	terminalImage["path"] = "images/final.png"
	terminalImage["text_response"] = "final response"
	terminalImage["videoUrl"] = "/videos/final.mp4"
	items, err = mergeConversationHistory(reloaded, "user-a", []map[string]any{terminal})
	if err != nil {
		t.Fatalf("terminal Merge() error = %v", err)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, items[0]), true)
	if got := imageFromHistoryItem(t, items[0])["videoUrl"]; got != "/videos/final.mp4" {
		t.Fatalf("terminal video output = %v, want /videos/final.mp4", got)
	}

	newTask := imageConversationHistoryTestItem(3, "2026-07-15T12:00:00Z", "success", "task-new", "https://example.test/new.png")
	setImageConversationTaskState(t, newTask, 1, "success")
	newTaskImage := imageFromHistoryItem(t, newTask)
	newTaskImage["b64_json"] = "new-base64"
	newTaskImage["path"] = "images/new.png"
	newTaskImage["text_response"] = "new response"
	items, err = mergeConversationHistory(reloaded, "user-a", []map[string]any{newTask})
	if err != nil {
		t.Fatalf("new terminal task Merge() error = %v", err)
	}
	image := imageFromHistoryItem(t, items[0])
	if image["taskId"] != "task-new" {
		t.Fatalf("new terminal task was not retained: %#v", image)
	}
	assertImageConversationOutputFields(t, image, true)
}

func TestImageConversationHistoryMergePreservesTurnsMissingFromNewerDeviceSnapshot(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	base := map[string]any{
		"id": "conversation-shared", "revision": 7, "updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{"id": "turn-device-a", "status": "success", "images": []any{}}},
	}
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{base}); err != nil {
		t.Fatalf("initial Merge() error = %v", err)
	}
	newer := map[string]any{
		"id": "conversation-shared", "revision": 8, "updatedAt": "2026-07-15T11:00:00Z",
		"turns": []any{map[string]any{"id": "turn-device-b", "status": "success", "images": []any{}}},
	}
	items, err := mergeConversationHistory(history, "user-a", []map[string]any{newer})
	if err != nil {
		t.Fatalf("newer Merge() error = %v", err)
	}
	turns := util.AsMapSlice(items[0]["turns"])
	if len(turns) != 2 {
		t.Fatalf("cross-device turns = %#v, want both turns", turns)
	}
}

func TestImageConversationHistoryMergeEqualVersionDoesNotResurrectOldImages(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	current := map[string]any{
		"id":        "conversation-1",
		"revision":  4,
		"updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{
			"id":     "turn-1",
			"status": "success",
			"images": []any{
				map[string]any{"id": "image-new", "taskId": "task-new", "status": "success", "url": "https://example.test/new.png"},
			},
		}},
	}
	if _, err := mergeConversationHistory(history, "user-a", []map[string]any{current}); err != nil {
		t.Fatalf("current Merge() error = %v", err)
	}
	stale := map[string]any{
		"id":        "conversation-1",
		"revision":  4,
		"updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{
			"id":     "turn-1",
			"status": "generating",
			"images": []any{
				map[string]any{"id": "image-old", "taskId": "task-old", "status": "loading"},
			},
		}},
	}
	items, err := mergeConversationHistory(history, "user-a", []map[string]any{stale})
	if err != nil {
		t.Fatalf("stale Merge() error = %v", err)
	}
	images := imagesFromHistoryItem(t, items[0])
	if len(images) != 1 || images[0]["id"] != "image-new" || images[0]["status"] != "success" {
		t.Fatalf("equal-version stale image changed current result: %#v", images)
	}
}

func TestImageConversationHistoryStatusDerivesQueuedBeforeRunning(t *testing.T) {
	cases := []struct {
		name  string
		image map[string]any
		want  string
	}{
		{
			name:  "queued task",
			image: map[string]any{"status": "loading", "taskStatus": "queued"},
			want:  "queued",
		},
		{
			name:  "loading task without task status",
			image: map[string]any{"status": "loading"},
			want:  "queued",
		},
		{
			name:  "running task",
			image: map[string]any{"status": "loading", "taskStatus": "running"},
			want:  "generating",
		},
		{
			name:  "terminal status wins",
			image: map[string]any{"status": "success", "taskStatus": "queued"},
			want:  "success",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := mergeImageConversationStatus("", "", []map[string]any{testCase.image})
			if got != testCase.want {
				t.Fatalf("mergeImageConversationStatus() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func imageConversationHistoryTestItem(revision any, updatedAt, status, taskID, url string) map[string]any {
	image := map[string]any{"id": "image-1", "taskId": taskID, "status": status}
	if url != "" {
		image["url"] = url
	}
	return map[string]any{
		"id":        "conversation-1",
		"revision":  revision,
		"updatedAt": updatedAt,
		"turns": []any{map[string]any{
			"id":     "turn-1",
			"status": status,
			"images": []any{image},
		}},
	}
}

func setImageConversationTaskState(t *testing.T, item map[string]any, taskRevision any, taskStatus string) {
	t.Helper()
	image := imageFromHistoryItem(t, item)
	image["taskRevision"] = taskRevision
	image["taskStatus"] = taskStatus
}

func imageConversationTaskStatusTestImage(taskStatus string, taskRevision any) map[string]any {
	status := "loading"
	if taskStatus == "success" || taskStatus == "error" || taskStatus == "cancelled" {
		status = taskStatus
	}
	return map[string]any{
		"id":           "image-1",
		"taskId":       "task-1",
		"taskRevision": taskRevision,
		"taskStatus":   taskStatus,
		"status":       status,
	}
}

func mustListImageConversationHistory(t *testing.T, history *ImageConversationHistoryService, ownerID string) map[string]any {
	t.Helper()
	items, err := listImageConversationHistoryForTest(history, ownerID)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("List() items = %#v, want one conversation", items)
	}
	return items[0]
}

func assertImageConversationOutputFields(t *testing.T, image map[string]any, present bool) {
	t.Helper()
	for _, key := range []string{"b64_json", "url", "path", "text_response"} {
		_, exists := image[key]
		if exists != present {
			t.Fatalf("image output field %q presence = %v, want %v: %#v", key, exists, present, image)
		}
	}
}

func imageFromHistoryItem(t *testing.T, item map[string]any) map[string]any {
	t.Helper()
	images := imagesFromHistoryItem(t, item)
	if len(images) != 1 {
		t.Fatalf("history images = %#v, want one image", images)
	}
	return images[0]
}

func imagesFromHistoryItem(t *testing.T, item map[string]any) []map[string]any {
	t.Helper()
	turns := util.AsMapSlice(item["turns"])
	if len(turns) == 0 {
		t.Fatalf("history turns = %#v, want one turn", item["turns"])
	}
	return util.AsMapSlice(turns[0]["images"])
}
