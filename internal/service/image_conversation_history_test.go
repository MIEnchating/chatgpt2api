package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestImageConversationHistoryServicePersistsAndIsolatesOwners(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)

	items, err := history.Merge("user-a", []map[string]any{
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

	items, err = history.Merge("user-a", []map[string]any{
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

	other, err := history.List("user-b")
	if err != nil {
		t.Fatalf("List(other) error = %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("other owner saw conversations: %#v", other)
	}

	reloaded := NewImageConversationHistoryService(backend)
	items, err = reloaded.List("user-a")
	if err != nil || len(items) != 2 {
		t.Fatalf("reloaded List() items=%#v error=%v", items, err)
	}

	items, removed, err := reloaded.Delete("user-a", "conversation-1")
	if err != nil || !removed || len(items) != 1 {
		t.Fatalf("Delete() items=%#v removed=%v error=%v", items, removed, err)
	}
	items, err = reloaded.Merge("user-a", []map[string]any{{
		"id": "conversation-1", "revision": 99, "title": "stale device", "updatedAt": "2099-01-01T00:00:00Z", "turns": []any{},
	}})
	if err != nil || len(items) != 1 {
		t.Fatalf("deleted conversation was resurrected: items=%#v error=%v", items, err)
	}
	if err := reloaded.Clear("user-a"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	items, err = reloaded.List("user-a")
	if err != nil || len(items) != 0 {
		t.Fatalf("List() after Clear items=%#v error=%v", items, err)
	}
	items, err = reloaded.Merge("user-a", []map[string]any{{
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
		if _, err := history.Merge("user-a", []map[string]any{item}); err == nil {
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
	items, removed, err := history.Delete("user-a", "conversation-delayed")
	if err != nil || removed || len(items) != 0 {
		t.Fatalf("Delete(missing) items=%#v removed=%v error=%v", items, removed, err)
	}

	items, err = history.Merge("user-a", []map[string]any{{
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
	if err := history.Clear("user-a"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}

	items, err := history.Merge("user-a", []map[string]any{{
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
	items, err = history.Merge("user-a", []map[string]any{{
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
	_, acknowledgements, err := history.MergeWithAcknowledgements("user-a", []map[string]any{current})
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("initial acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	_, acknowledgements, err = history.MergeWithAcknowledgements("user-a", []map[string]any{current})
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("idempotent acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	staleRevision := cloneImageConversationMap(current)
	staleRevision["revision"] = 6
	staleRevision["updatedAt"] = "2099-01-01T00:00:00Z"
	_, acknowledgements, err = history.MergeWithAcknowledgements("user-a", []map[string]any{staleRevision})
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("stale revision acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	staleTimestamp := cloneImageConversationMap(current)
	staleTimestamp["updatedAt"] = "2026-07-15T09:30:00Z"
	_, acknowledgements, err = history.MergeWithAcknowledgements("user-a", []map[string]any{staleTimestamp})
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("stale timestamp acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	concurrentSameRevision := cloneImageConversationMap(current)
	concurrentSameRevision["title"] = "conflicting concurrent update"
	concurrentSameRevision["updatedAt"] = "2026-07-15T11:00:00Z"
	_, acknowledgements, err = history.MergeWithAcknowledgements("user-a", []map[string]any{concurrentSameRevision})
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || acknowledgements[0].Gone || acknowledgements[0].ActualRevision != 7 {
		t.Fatalf("same-revision conflict acknowledgement = %#v, error=%v", acknowledgements, err)
	}
	items, err := history.List("user-a")
	if err != nil || len(items) != 1 || items[0]["title"] != "current" {
		t.Fatalf("same-revision conflict changed history: items=%#v error=%v", items, err)
	}

	if _, _, err := history.Delete("user-a", "conversation-ack"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	deleted := cloneImageConversationMap(current)
	deleted["revision"] = 8
	deleted["updatedAt"] = "2099-01-01T00:00:00Z"
	_, acknowledgements, err = history.MergeWithAcknowledgements("user-a", []map[string]any{deleted})
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || !acknowledgements[0].Gone {
		t.Fatalf("deleted acknowledgement = %#v, error=%v", acknowledgements, err)
	}

	if err := history.Clear("user-b"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	cleared := map[string]any{
		"id":        "conversation-before-clear",
		"revision":  1,
		"createdAt": time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
		"updatedAt": "2099-01-01T00:00:00Z",
		"turns":     []any{},
	}
	_, acknowledgements, err = history.MergeWithAcknowledgements("user-b", []map[string]any{cleared})
	if err != nil || len(acknowledgements) != 1 || acknowledgements[0].Accepted || !acknowledgements[0].Gone {
		t.Fatalf("cleared acknowledgement = %#v, error=%v", acknowledgements, err)
	}
}

func TestImageConversationHistoryMergeKeepsTerminalImageAgainstStaleRunningSnapshots(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	terminal := imageConversationHistoryTestItem(7, "2026-07-15T10:00:00Z", "success", "task-1", "https://example.test/image.png")
	if _, err := history.Merge("user-a", []map[string]any{terminal}); err != nil {
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
		{name: "legacy missing task id", revision: 6, at: "2026-07-15T12:00:00Z", taskID: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			stale := imageConversationHistoryTestItem(testCase.revision, testCase.at, "loading", testCase.taskID, "")
			if _, err := history.Merge("user-a", []map[string]any{stale}); err != nil {
				t.Fatalf("stale Merge() error = %v", err)
			}
			items, err := history.List("user-a")
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

func TestImageConversationHistoryMergeAllowsTerminalUpgradeAndNormalizesRevision(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	active := imageConversationHistoryTestItem("2", "2026-07-15T10:00:00Z", "loading", "task-2", "")
	if _, err := history.Merge("user-a", []map[string]any{active}); err != nil {
		t.Fatalf("active Merge() error = %v", err)
	}
	terminal := imageConversationHistoryTestItem(1, "2026-07-15T09:00:00Z", "success", "task-2", "https://example.test/image-2.png")
	items, err := history.Merge("user-a", []map[string]any{terminal})
	if err != nil {
		t.Fatalf("terminal upgrade Merge() error = %v", err)
	}
	if got, ok := items[0]["revision"].(int64); !ok || got != 2 {
		t.Fatalf("revision = %#v (%T), want normalized current revision 2", items[0]["revision"], items[0]["revision"])
	}
	image := imageFromHistoryItem(t, items[0])
	if image["status"] != "success" || image["url"] != "https://example.test/image-2.png" {
		t.Fatalf("terminal upgrade was not retained: %#v", image)
	}
}

func TestImageConversationHistoryMergeUsesTaskRevisionBeforeSnapshotStatus(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)
	newerRunning := imageConversationHistoryTestItem(1, "2026-07-15T10:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, newerRunning, 20, "running")
	if _, err := history.Merge("user-a", []map[string]any{newerRunning}); err != nil {
		t.Fatalf("newer running Merge() error = %v", err)
	}

	olderQueued := imageConversationHistoryTestItem(2, "2026-07-15T11:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, olderQueued, 19, "queued")
	if _, err := history.Merge("user-a", []map[string]any{olderQueued}); err != nil {
		t.Fatalf("older queued Merge() error = %v", err)
	}
	image := imageFromHistoryItem(t, mustListImageConversationHistory(t, history, "user-a"))
	if image["taskStatus"] != "running" || normalizeImageConversationRevision(image["taskRevision"]) != 20 {
		t.Fatalf("older queued snapshot replaced newer running snapshot: %#v", image)
	}

	terminal := imageConversationHistoryTestItem(3, "2026-07-15T12:00:00Z", "success", "task-revision", "https://example.test/final.png")
	setImageConversationTaskState(t, terminal, 21, "success")
	if _, err := history.Merge("user-a", []map[string]any{terminal}); err != nil {
		t.Fatalf("terminal Merge() error = %v", err)
	}
	staleRunning := imageConversationHistoryTestItem(4, "2026-07-15T13:00:00Z", "loading", "task-revision", "")
	setImageConversationTaskState(t, staleRunning, 20, "running")
	if _, err := history.Merge("user-a", []map[string]any{staleRunning}); err != nil {
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
	items, err := history.Merge("user-a", []map[string]any{active})
	if err != nil {
		t.Fatalf("active preview Merge() error = %v", err)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, items[0]), false)

	reloaded := NewImageConversationHistoryService(backend)
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, mustListImageConversationHistory(t, reloaded, "user-a")), false)

	terminal := imageConversationHistoryTestItem(2, "2026-07-15T11:00:00Z", "success", "task-preview", "https://example.test/final.png")
	setImageConversationTaskState(t, terminal, 11, "success")
	terminalImage := imageFromHistoryItem(t, terminal)
	terminalImage["b64_json"] = "final-base64"
	terminalImage["path"] = "images/final.png"
	terminalImage["text_response"] = "final response"
	items, err = reloaded.Merge("user-a", []map[string]any{terminal})
	if err != nil {
		t.Fatalf("terminal Merge() error = %v", err)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, items[0]), true)

	newTask := imageConversationHistoryTestItem(3, "2026-07-15T12:00:00Z", "success", "task-new", "https://example.test/new.png")
	setImageConversationTaskState(t, newTask, 1, "success")
	newTaskImage := imageFromHistoryItem(t, newTask)
	newTaskImage["b64_json"] = "new-base64"
	newTaskImage["path"] = "images/new.png"
	newTaskImage["text_response"] = "new response"
	items, err = reloaded.Merge("user-a", []map[string]any{newTask})
	if err != nil {
		t.Fatalf("new terminal task Merge() error = %v", err)
	}
	image := imageFromHistoryItem(t, items[0])
	if image["taskId"] != "task-new" {
		t.Fatalf("new terminal task was not retained: %#v", image)
	}
	assertImageConversationOutputFields(t, image, true)
}

func TestImageConversationHistoryListMigratesStoredActivePreviewOutput(t *testing.T) {
	backend := newTestStorageBackend(t)
	history := NewImageConversationHistoryService(backend)
	ownerID := "legacy-preview-user"
	active := imageConversationHistoryTestItem(1, "2026-07-15T10:00:00Z", "loading", "task-preview", "https://example.test/preview.png")
	setImageConversationTaskState(t, active, 10, "running")
	image := imageFromHistoryItem(t, active)
	image["b64_json"] = "preview-base64"
	image["path"] = "images/preview.png"
	image["text_response"] = "partial response"
	documentName := imageConversationHistoryDocumentName(ownerID)
	if err := history.store.SaveJSONDocument(documentName, map[string]any{"items": []any{active}}); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	items, err := history.List(ownerID)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, items[0]), false)

	raw, err := history.store.LoadJSONDocument(documentName)
	if err != nil {
		t.Fatalf("LoadJSONDocument() error = %v", err)
	}
	storedItems := util.AsMapSlice(util.StringMap(raw)["items"])
	if len(storedItems) != 1 {
		t.Fatalf("stored items = %#v, want one conversation", storedItems)
	}
	assertImageConversationOutputFields(t, imageFromHistoryItem(t, storedItems[0]), false)
}

func TestImageConversationHistoryMergePreservesTurnsMissingFromNewerDeviceSnapshot(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	base := map[string]any{
		"id": "conversation-shared", "revision": 7, "updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{"id": "turn-device-a", "status": "success", "images": []any{}}},
	}
	if _, err := history.Merge("user-a", []map[string]any{base}); err != nil {
		t.Fatalf("initial Merge() error = %v", err)
	}
	newer := map[string]any{
		"id": "conversation-shared", "revision": 8, "updatedAt": "2026-07-15T11:00:00Z",
		"turns": []any{map[string]any{"id": "turn-device-b", "status": "success", "images": []any{}}},
	}
	items, err := history.Merge("user-a", []map[string]any{newer})
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
	if _, err := history.Merge("user-a", []map[string]any{current}); err != nil {
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
	items, err := history.Merge("user-a", []map[string]any{stale})
	if err != nil {
		t.Fatalf("stale Merge() error = %v", err)
	}
	images := imagesFromHistoryItem(t, items[0])
	if len(images) != 1 || images[0]["id"] != "image-new" || images[0]["status"] != "success" {
		t.Fatalf("equal-version stale image changed current result: %#v", images)
	}
}

func TestImageConversationHistoryMergeFillsAnEmptyTurnFromMatchingSnapshot(t *testing.T) {
	history := NewImageConversationHistoryService(newTestStorageBackend(t))
	current := map[string]any{
		"id":        "conversation-empty-turn",
		"updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{
			"id":     "turn-1",
			"status": "generating",
			"images": []any{},
		}},
	}
	if _, err := history.Merge("user-a", []map[string]any{current}); err != nil {
		t.Fatalf("current Merge() error = %v", err)
	}
	incoming := map[string]any{
		"id":        "conversation-empty-turn",
		"updatedAt": "2026-07-15T10:00:00Z",
		"turns": []any{map[string]any{
			"id":     "turn-1",
			"status": "success",
			"images": []any{map[string]any{
				"id":     "image-new",
				"taskId": "task-new",
				"status": "success",
				"url":    "https://example.test/new.png",
			}},
		}},
	}
	items, err := history.Merge("user-a", []map[string]any{incoming})
	if err != nil {
		t.Fatalf("incoming Merge() error = %v", err)
	}
	images := imagesFromHistoryItem(t, items[0])
	if len(images) != 1 || images[0]["id"] != "image-new" || images[0]["url"] != "https://example.test/new.png" {
		t.Fatalf("empty turn was not filled from matching snapshot: %#v", images)
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
			name:  "legacy loading task",
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

func TestImageConversationHistoryServiceDifferentOwnersCanMergeConcurrently(t *testing.T) {
	backend := newConcurrentHistoryBackend()
	history := NewImageConversationHistoryService(backend)
	const ownerCount = 8
	var waitGroup sync.WaitGroup
	for index := 0; index < ownerCount; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			owner := fmt.Sprintf("owner-%d", index)
			item := imageConversationHistoryTestItem(1, "2026-07-15T10:00:00Z", "success", fmt.Sprintf("task-%d", index), "https://example.test/image.png")
			if _, err := history.Merge(owner, []map[string]any{item}); err != nil {
				t.Errorf("Merge(%s) error = %v", owner, err)
			}
		}(index)
	}
	waitGroup.Wait()
	if backend.maxActive < 2 {
		t.Fatalf("different-owner operations never overlapped; max active storage calls = %d", backend.maxActive)
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
	items, err := history.List(ownerID)
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

type concurrentHistoryBackend struct {
	mu        sync.Mutex
	documents map[string]any
	active    int
	maxActive int
}

func newConcurrentHistoryBackend() *concurrentHistoryBackend {
	return &concurrentHistoryBackend{documents: map[string]any{}}
}

func (b *concurrentHistoryBackend) LoadAccounts() ([]map[string]any, error) { return nil, nil }
func (b *concurrentHistoryBackend) SaveAccounts([]map[string]any) error     { return nil }
func (b *concurrentHistoryBackend) LoadAuthKeys() ([]map[string]any, error) { return nil, nil }
func (b *concurrentHistoryBackend) SaveAuthKeys([]map[string]any) error     { return nil }
func (b *concurrentHistoryBackend) HealthCheck() map[string]any             { return map[string]any{} }
func (b *concurrentHistoryBackend) Info() map[string]any                    { return map[string]any{} }

func (b *concurrentHistoryBackend) LoadJSONDocument(name string) (any, error) {
	b.enter()
	defer b.exit()
	time.Sleep(time.Millisecond)
	b.mu.Lock()
	defer b.mu.Unlock()
	return cloneHistoryTestValue(b.documents[name]), nil
}

func (b *concurrentHistoryBackend) SaveJSONDocument(name string, value any) error {
	b.enter()
	defer b.exit()
	time.Sleep(time.Millisecond)
	b.mu.Lock()
	b.documents[name] = cloneHistoryTestValue(value)
	b.mu.Unlock()
	return nil
}

func (b *concurrentHistoryBackend) DeleteJSONDocument(name string) error {
	b.enter()
	defer b.exit()
	b.mu.Lock()
	delete(b.documents, name)
	b.mu.Unlock()
	return nil
}

func (b *concurrentHistoryBackend) enter() {
	b.mu.Lock()
	b.active++
	if b.active > b.maxActive {
		b.maxActive = b.active
	}
	b.mu.Unlock()
}

func (b *concurrentHistoryBackend) exit() {
	b.mu.Lock()
	b.active--
	b.mu.Unlock()
}

func cloneHistoryTestValue(value any) any {
	if value == nil {
		return nil
	}
	data, _ := json.Marshal(value)
	var clone any
	_ = json.Unmarshal(data, &clone)
	return clone
}

var _ storage.Backend = (*concurrentHistoryBackend)(nil)
