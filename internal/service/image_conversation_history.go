package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type ImageConversationHistoryService struct {
	rows               storage.ImageConversationBackend
	conversationAssets *ImageConversationAssetService
}

func (s *ImageConversationHistoryService) SetConversationAssetService(assets *ImageConversationAssetService) {
	if s != nil {
		s.conversationAssets = assets
	}
}

type ImageConversationMergeAcknowledgement struct {
	ID             string `json:"id"`
	Accepted       bool   `json:"accepted"`
	Gone           bool   `json:"gone"`
	ActualRevision int64  `json:"revision"`
}

type ImageConversationHistoryValidationError struct {
	Err error
}

func (e ImageConversationHistoryValidationError) Error() string {
	return e.Err.Error()
}

func (e ImageConversationHistoryValidationError) Unwrap() error {
	return e.Err
}

func NewImageConversationHistoryService(backend storage.Backend) *ImageConversationHistoryService {
	service := &ImageConversationHistoryService{}
	if rows, ok := backend.(storage.ImageConversationBackend); ok {
		service.rows = rows
	}
	return service
}

func (s *ImageConversationHistoryService) ConversationAssetReferencesContext(ctx context.Context, ownerID string) (map[string]struct{}, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := make(map[string]struct{})
	if s == nil || s.conversationAssets == nil {
		return result, nil
	}
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	if s.rows == nil {
		return nil, fmt.Errorf("image conversation row backend is required")
	}
	return s.conversationAssetReferencesFromRows(ctx, ownerID)
}

func normalizeImageConversationHistoryItem(raw map[string]any) (map[string]any, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("conversation is not valid json")
	}
	item := map[string]any{}
	if err := json.Unmarshal(data, &item); err != nil {
		return nil, fmt.Errorf("conversation is not valid json")
	}
	id := util.Clean(item["id"])
	if id == "" || len(id) > 200 {
		return nil, fmt.Errorf("conversation id is required")
	}
	updatedAt := strings.TrimSpace(util.Clean(item["updatedAt"]))
	if updatedAt == "" {
		return nil, fmt.Errorf("conversation updatedAt is required")
	}
	if _, ok := item["turns"].([]any); !ok {
		return nil, fmt.Errorf("conversation turns are required")
	}
	item["id"] = id
	item["updatedAt"] = updatedAt
	item["revision"] = normalizeImageConversationRevision(item["revision"])
	stripImageConversationActiveOutputs(item)
	return item, nil
}

func normalizeImageConversationRevision(value any) int64 {
	var revision int64
	switch typed := value.(type) {
	case int:
		revision = int64(typed)
	case int8:
		revision = int64(typed)
	case int16:
		revision = int64(typed)
	case int32:
		revision = int64(typed)
	case int64:
		revision = typed
	case uint:
		if uint64(typed) <= uint64(^uint64(0)>>1) {
			revision = int64(typed)
		}
	case uint8:
		revision = int64(typed)
	case uint16:
		revision = int64(typed)
	case uint32:
		revision = int64(typed)
	case uint64:
		if typed <= uint64(^uint64(0)>>1) {
			revision = int64(typed)
		}
	case float64:
		if typed >= 0 && typed <= float64(^uint64(0)>>1) && typed == float64(int64(typed)) {
			revision = int64(typed)
		}
	case json.Number:
		if parsed, err := strconv.ParseInt(string(typed), 10, 64); err == nil {
			revision = parsed
		}
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			revision = parsed
		}
	}
	if revision < 0 {
		return 0
	}
	return revision
}

func imageConversationUpdatedAt(item map[string]any) string {
	return strings.TrimSpace(util.Clean(item["updatedAt"]))
}

func imageConversationRevision(item map[string]any) int64 {
	return normalizeImageConversationRevision(item["revision"])
}

func compareImageConversationUpdatedAt(left, right string) int {
	leftTime, leftOK := parseImageConversationTime(left)
	rightTime, rightOK := parseImageConversationTime(right)
	if leftOK && rightOK {
		switch {
		case leftTime.After(rightTime):
			return 1
		case leftTime.Before(rightTime):
			return -1
		default:
			return 0
		}
	}
	return strings.Compare(strings.TrimSpace(left), strings.TrimSpace(right))
}

func parseImageConversationTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05",
	} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func imageConversationWasCleared(item map[string]any, clearedAt string) bool {
	clearedAt = strings.TrimSpace(clearedAt)
	if clearedAt == "" {
		return false
	}
	snapshotAt := strings.TrimSpace(util.Clean(item["createdAt"]))
	if snapshotAt == "" {
		snapshotAt = imageConversationUpdatedAt(item)
	}
	snapshotTime, snapshotOK := parseImageConversationTime(snapshotAt)
	clearedTime, clearedOK := parseImageConversationTime(clearedAt)
	if !snapshotOK {
		return true
	}
	if clearedOK {
		return !snapshotTime.After(clearedTime)
	}
	return compareImageConversationUpdatedAt(snapshotAt, clearedAt) <= 0
}

func compareImageConversationVersion(current, incoming map[string]any, incomingHasRevision bool) int {
	currentRevision := imageConversationRevision(current)
	incomingRevision := imageConversationRevision(incoming)
	if incomingHasRevision || currentRevision > 0 {
		switch {
		case incomingRevision > currentRevision:
			return 1
		case incomingRevision < currentRevision:
			return -1
		}
	}
	return compareImageConversationUpdatedAt(imageConversationUpdatedAt(incoming), imageConversationUpdatedAt(current))
}

func mergeImageConversationHistoryItem(current, incoming map[string]any, incomingHasRevision bool) map[string]any {
	version := compareImageConversationVersion(current, incoming, incomingHasRevision)
	base := current
	other := incoming
	if version > 0 {
		base = incoming
		other = current
	}
	merged := cloneImageConversationMap(base)
	merged["revision"] = imageConversationRevision(base)
	mergeImageConversationTurns(merged, other, true)
	return merged
}

func mergeImageConversationTurns(base, other map[string]any, includeMissing bool) {
	baseTurns := util.AsMapSlice(base["turns"])
	otherTurns := util.AsMapSlice(other["turns"])
	if len(baseTurns) == 0 && len(otherTurns) == 0 {
		return
	}
	byID := make(map[string]map[string]any, len(baseTurns)+len(otherTurns))
	order := make([]string, 0, len(baseTurns)+len(otherTurns))
	for _, turn := range baseTurns {
		id := strings.TrimSpace(util.Clean(turn["id"]))
		if id == "" {
			continue
		}
		byID[id] = turn
		order = append(order, id)
	}
	for _, turn := range otherTurns {
		id := strings.TrimSpace(util.Clean(turn["id"]))
		if id == "" {
			continue
		}
		current := byID[id]
		if current == nil {
			if includeMissing {
				byID[id] = cloneImageConversationMap(turn)
				order = append(order, id)
			}
			continue
		}
		byID[id] = mergeImageConversationTurn(current, turn)
	}
	turns := make([]map[string]any, 0, len(order))
	for _, id := range order {
		if turn := byID[id]; turn != nil {
			turns = append(turns, turn)
		}
	}
	base["turns"] = turns
}

func mergeImageConversationTurn(current, incoming map[string]any) map[string]any {
	merged := cloneImageConversationMap(current)
	for key, value := range incoming {
		if key != "images" && key != "status" {
			if _, exists := merged[key]; exists && strings.TrimSpace(util.Clean(merged[key])) != "" {
				continue
			}
			merged[key] = value
		}
	}
	mergeImageConversationImages(merged, incoming)
	merged["status"] = mergeImageConversationStatus(current["status"], incoming["status"], merged["images"])
	return merged
}

func mergeImageConversationImages(base, other map[string]any) {
	baseImages := util.AsMapSlice(base["images"])
	otherImages := util.AsMapSlice(other["images"])
	if len(baseImages) == 0 && len(otherImages) == 0 {
		return
	}
	byID := make(map[string]map[string]any, len(baseImages)+len(otherImages))
	order := make([]string, 0, len(baseImages)+len(otherImages))
	for _, image := range baseImages {
		id := strings.TrimSpace(util.Clean(image["id"]))
		if id == "" {
			continue
		}
		byID[id] = cloneImageConversationMap(image)
		order = append(order, id)
	}
	for _, image := range otherImages {
		id := strings.TrimSpace(util.Clean(image["id"]))
		if id == "" {
			continue
		}
		current := byID[id]
		if current == nil {
			// An empty image list carries no identity to protect. Accept the
			// incoming snapshot in that case, but do not resurrect IDs when a
			// newer/regenerated image is already present.
			if len(baseImages) == 0 {
				byID[id] = cloneImageConversationMap(image)
				order = append(order, id)
			}
			continue
		}
		if sameImageTask(current, image) {
			byID[id] = mergeImageConversationImage(current, image)
		}
	}
	images := make([]map[string]any, 0, len(order))
	for _, id := range order {
		if image := byID[id]; image != nil {
			images = append(images, image)
		}
	}
	base["images"] = images
}

func sameImageTask(left, right map[string]any) bool {
	leftTask := strings.TrimSpace(util.Clean(left["taskId"]))
	rightTask := strings.TrimSpace(util.Clean(right["taskId"]))
	return leftTask == rightTask
}

func mergeImageConversationImage(current, incoming map[string]any) map[string]any {
	comparison, comparedTaskRevision := compareImageConversationTaskSnapshot(current, incoming)
	base := current
	other := incoming
	if comparison > 0 {
		base = incoming
		other = current
	}
	if comparedTaskRevision {
		merged := cloneImageConversationMap(base)
		stripImageConversationActiveOutput(merged)
		return merged
	}
	merged := cloneImageConversationMap(base)
	for key, value := range other {
		if _, exists := merged[key]; !exists || strings.TrimSpace(util.Clean(merged[key])) == "" {
			merged[key] = value
		}
	}
	stripImageConversationActiveOutput(merged)
	return merged
}

func compareImageConversationTaskSnapshot(current, incoming map[string]any) (int, bool) {
	currentTaskID := strings.TrimSpace(util.Clean(current["taskId"]))
	incomingTaskID := strings.TrimSpace(util.Clean(incoming["taskId"]))
	currentRank := imageConversationStatusRank(current)
	incomingRank := imageConversationStatusRank(incoming)
	if currentTaskID != "" && currentTaskID == incomingTaskID && currentRank != incomingRank {
		// A task is monotonic: retries use a new taskId, so a later active
		// snapshot can never reopen a terminal output from the same task.
		if incomingRank > currentRank {
			return 1, false
		}
		return -1, false
	}
	if currentTaskID != "" && currentTaskID == incomingTaskID {
		currentRevision, currentHasRevision := imageConversationTaskRevision(current)
		incomingRevision, incomingHasRevision := imageConversationTaskRevision(incoming)
		if currentHasRevision && incomingHasRevision && currentRevision != incomingRevision {
			if incomingRevision > currentRevision {
				return 1, true
			}
			return -1, true
		}
	}

	switch {
	case incomingRank > currentRank:
		return 1, false
	case incomingRank < currentRank:
		return -1, false
	case imageConversationHasData(incoming) && !imageConversationHasData(current):
		return 1, false
	default:
		return 0, false
	}
}

func imageConversationTaskRevision(image map[string]any) (int64, bool) {
	value, exists := image["taskRevision"]
	if !exists {
		return 0, false
	}
	revision := normalizeImageConversationRevision(value)
	return revision, revision > 0
}

func imageConversationStatusRank(image map[string]any) int {
	status := util.Clean(image["status"])
	taskStatus := util.Clean(image["taskStatus"])
	switch {
	case status == "success", taskStatus == "success":
		return 4
	case status == "error", status == "cancelled", status == "message", taskStatus == "error", taskStatus == "cancelled":
		return 3
	case status == "generating", taskStatus == "running":
		return 2
	case status == "queued", status == "loading", taskStatus == "queued":
		return 1
	case imageConversationHasData(image):
		return 4
	default:
		return 0
	}
}

func imageConversationImageIsTerminal(image map[string]any) bool {
	status := util.Clean(image["status"])
	taskStatus := util.Clean(image["taskStatus"])
	switch {
	case status == "success", status == "error", status == "cancelled", status == "message":
		return true
	case taskStatus == "success", taskStatus == "error", taskStatus == "cancelled":
		return true
	default:
		return false
	}
}

func imageConversationImageIsRunning(image map[string]any) bool {
	status := util.Clean(image["status"])
	taskStatus := util.Clean(image["taskStatus"])
	if imageConversationImageIsTerminal(image) {
		return false
	}
	return status == "generating" || taskStatus == "running"
}

func imageConversationImageIsQueued(image map[string]any) bool {
	if imageConversationImageIsTerminal(image) || imageConversationImageIsRunning(image) {
		return false
	}
	status := util.Clean(image["status"])
	taskStatus := util.Clean(image["taskStatus"])
	return status == "queued" || status == "loading" || taskStatus == "queued"
}

func imageConversationHasData(image map[string]any) bool {
	for _, key := range []string{"b64_json", "url", "video_url", "videoUrl", "path", "text_response"} {
		if strings.TrimSpace(util.Clean(image[key])) != "" {
			return true
		}
	}
	return false
}

func stripImageConversationActiveOutputs(item map[string]any) bool {
	removed := false
	for _, turn := range util.AsMapSlice(item["turns"]) {
		for _, image := range util.AsMapSlice(turn["images"]) {
			if stripImageConversationActiveOutput(image) {
				removed = true
			}
		}
	}
	return removed
}

func stripImageConversationActiveOutput(image map[string]any) bool {
	if imageConversationImageIsTerminal(image) || (!imageConversationImageIsRunning(image) && !imageConversationImageIsQueued(image)) {
		return false
	}
	removed := false
	for _, key := range []string{"b64_json", "url", "video_url", "videoUrl", "path", "text_response"} {
		if _, exists := image[key]; exists {
			delete(image, key)
			removed = true
		}
	}
	return removed
}

func mergeImageConversationStatus(current, incoming any, images any) string {
	imageMaps := util.AsMapSlice(images)
	hasRunning := false
	hasQueued := false
	hasError := false
	hasCancelled := false
	hasSuccess := false
	hasMessage := false
	for _, image := range imageMaps {
		switch {
		case imageConversationImageIsRunning(image):
			hasRunning = true
		case imageConversationImageIsQueued(image):
			hasQueued = true
		case util.Clean(image["status"]) == "error" || util.Clean(image["taskStatus"]) == "error":
			hasError = true
		case util.Clean(image["status"]) == "cancelled" || util.Clean(image["taskStatus"]) == "cancelled":
			hasCancelled = true
		case util.Clean(image["status"]) == "message":
			hasMessage = true
		case imageConversationStatusRank(image) >= 4:
			hasSuccess = true
		}
	}
	if hasRunning {
		return "generating"
	}
	if hasQueued {
		return "queued"
	}
	if hasError {
		return "error"
	}
	if hasCancelled {
		return "cancelled"
	}
	if hasSuccess {
		return "success"
	}
	if hasMessage {
		return "message"
	}
	currentStatus := util.Clean(current)
	incomingStatus := util.Clean(incoming)
	if imageConversationTurnStatusRank(currentStatus) >= 3 && imageConversationTurnStatusRank(incomingStatus) < 3 {
		return currentStatus
	}
	if imageConversationTurnStatusRank(incomingStatus) > imageConversationTurnStatusRank(currentStatus) {
		return incomingStatus
	}
	if currentStatus == "" && incomingStatus != "" {
		return incomingStatus
	}
	return currentStatus
}

func imageConversationTurnStatusRank(status string) int {
	switch strings.TrimSpace(status) {
	case "success", "message":
		return 3
	case "error", "cancelled":
		return 2
	case "generating":
		return 1
	case "queued":
		return 0
	default:
		return -1
	}
}

func cloneImageConversationMap(source map[string]any) map[string]any {
	data, err := json.Marshal(source)
	if err != nil {
		return map[string]any{}
	}
	clone := map[string]any{}
	if err := json.Unmarshal(data, &clone); err != nil {
		return map[string]any{}
	}
	return clone
}
