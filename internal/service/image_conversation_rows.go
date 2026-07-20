package service

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	imageConversationCursorVersion = 1
	imageConversationDefaultLimit  = 30
	imageConversationMaximumLimit  = 100
	imageConversationInternalLimit = 500
	imageConversationCASAttempts   = 8

	imageConversationAssetPathsSummaryKey = "_conversationAssetPaths"
	imageConversationAssetRefsCompleteKey = "_conversationAssetPathsComplete"
)

type ImageConversationHistoryPage struct {
	Items      []map[string]any `json:"items"`
	NextCursor string           `json:"next_cursor,omitempty"`
	HasMore    bool             `json:"has_more"`
	Generation int64            `json:"generation"`
}

type ImageConversationHistoryCursorError struct {
	Err error
}

func (e ImageConversationHistoryCursorError) Error() string {
	if e.Err == nil {
		return "invalid image conversation cursor"
	}
	return e.Err.Error()
}

func (e ImageConversationHistoryCursorError) Unwrap() error { return e.Err }

type ImageConversationHistoryCursorInvalidatedError struct {
	Generation int64
}

func (e ImageConversationHistoryCursorInvalidatedError) Error() string {
	return "image conversation cursor was invalidated by a history change"
}

type imageConversationOpaqueCursor struct {
	Version         int    `json:"v"`
	Generation      int64  `json:"g"`
	UpdatedAtMillis int64  `json:"u"`
	ConversationKey string `json:"k"`
}

type normalizedImageConversationRowInput struct {
	item        map[string]any
	hasRevision bool
	inputHash   string
}

func (s *ImageConversationHistoryService) ListPage(ctx context.Context, ownerID, cursor string, limit int) (ImageConversationHistoryPage, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return ImageConversationHistoryPage{}, fmt.Errorf("owner_id is required")
	}
	if limit == 0 {
		limit = imageConversationDefaultLimit
	}
	if limit < 1 || limit > imageConversationMaximumLimit {
		return ImageConversationHistoryPage{}, ImageConversationHistoryCursorError{Err: fmt.Errorf("limit must be between 1 and %d", imageConversationMaximumLimit)}
	}
	if s.rows == nil {
		return s.listLegacyImageConversationPage(ownerID, cursor, limit)
	}

	storageCursor, _, err := decodeImageConversationCursor(cursor)
	if err != nil {
		return ImageConversationHistoryPage{}, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		state, stateErr := s.ensureImageConversationRows(ctx, ownerID)
		if stateErr != nil {
			return ImageConversationHistoryPage{}, stateErr
		}
		if storageCursor != nil && storageCursor.Generation != state.CursorGeneration {
			return ImageConversationHistoryPage{}, ImageConversationHistoryCursorInvalidatedError{Generation: state.CursorGeneration}
		}
		page, listErr := s.rows.List(ctx, ownerID, state.Generation, storageCursor, limit)
		if errors.Is(listErr, storage.ErrImageConversationGenerationStale) || errors.Is(listErr, storage.ErrImageConversationCursorStale) {
			latest, loadErr := s.rows.LoadOwnerState(ctx, ownerID)
			if loadErr != nil {
				return ImageConversationHistoryPage{}, loadErr
			}
			if storageCursor != nil {
				return ImageConversationHistoryPage{}, ImageConversationHistoryCursorInvalidatedError{Generation: latest.CursorGeneration}
			}
			continue
		}
		if listErr != nil {
			return ImageConversationHistoryPage{}, listErr
		}
		latest, loadErr := s.rows.LoadOwnerState(ctx, ownerID)
		if loadErr != nil {
			return ImageConversationHistoryPage{}, loadErr
		}
		if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
			if storageCursor != nil {
				return ImageConversationHistoryPage{}, ImageConversationHistoryCursorInvalidatedError{Generation: latest.CursorGeneration}
			}
			continue
		}
		items, decodeErr := imageConversationSummariesFromRecords(page.Records)
		if decodeErr != nil {
			return ImageConversationHistoryPage{}, decodeErr
		}
		nextCursor := ""
		if page.NextCursor != nil {
			nextCursor, err = encodeImageConversationCursor(page.NextCursor)
			if err != nil {
				return ImageConversationHistoryPage{}, err
			}
		}
		return ImageConversationHistoryPage{
			Items:      items,
			NextCursor: nextCursor,
			HasMore:    page.NextCursor != nil,
			Generation: state.CursorGeneration,
		}, nil
	}
	latest, err := s.rows.LoadOwnerState(ctx, ownerID)
	if err != nil {
		return ImageConversationHistoryPage{}, err
	}
	return ImageConversationHistoryPage{}, ImageConversationHistoryCursorInvalidatedError{Generation: latest.CursorGeneration}
}

func (s *ImageConversationHistoryService) GetItem(ctx context.Context, ownerID, conversationID string) (map[string]any, bool, int64, error) {
	ownerID = util.Clean(ownerID)
	conversationID = util.Clean(conversationID)
	if ownerID == "" || conversationID == "" {
		return nil, false, 0, fmt.Errorf("owner_id and conversation id are required")
	}
	if s.rows == nil {
		items, err := s.List(ownerID)
		if err != nil {
			return nil, false, 1, err
		}
		for _, item := range items {
			if util.Clean(item["id"]) == conversationID {
				return item, true, 1, nil
			}
		}
		return nil, false, 1, nil
	}
	for attempt := 0; attempt < 3; attempt++ {
		state, err := s.ensureImageConversationRows(ctx, ownerID)
		if err != nil {
			return nil, false, 0, err
		}
		record, ok, err := s.rows.Load(ctx, ownerID, conversationID)
		if err != nil && !errors.Is(err, storage.ErrImageConversationGone) {
			return nil, false, state.CursorGeneration, err
		}
		latest, stateErr := s.rows.LoadOwnerState(ctx, ownerID)
		if stateErr != nil {
			return nil, false, state.CursorGeneration, stateErr
		}
		if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
			continue
		}
		if errors.Is(err, storage.ErrImageConversationGone) || !ok || record.DeletedAtMillis > 0 || len(record.Data) == 0 {
			return nil, false, latest.CursorGeneration, nil
		}
		items, changed, decodeErr := s.assetizeImageConversationRecords(ctx, ownerID, latest.Generation, []storage.ImageConversationRecord{record})
		if errors.Is(decodeErr, storage.ErrImageConversationCASConflict) || errors.Is(decodeErr, storage.ErrImageConversationGenerationStale) {
			continue
		}
		if errors.Is(decodeErr, storage.ErrImageConversationGone) {
			return nil, false, latest.CursorGeneration, nil
		}
		if decodeErr != nil {
			return nil, false, latest.CursorGeneration, decodeErr
		}
		if changed {
			continue
		}
		return items[0], true, latest.CursorGeneration, nil
	}
	return nil, false, 0, storage.ErrImageConversationGenerationStale
}

func (s *ImageConversationHistoryService) ListActive(ctx context.Context, ownerID string, limit int) ([]map[string]any, int64, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, 0, fmt.Errorf("owner_id is required")
	}
	if limit == 0 {
		limit = imageConversationInternalLimit
	}
	if limit < 0 || limit > imageConversationInternalLimit {
		return nil, 0, ImageConversationHistoryCursorError{Err: fmt.Errorf("active limit must not exceed %d", imageConversationInternalLimit)}
	}
	if s.rows == nil {
		items, err := s.List(ownerID)
		if err != nil {
			return nil, 1, err
		}
		active := make([]map[string]any, 0)
		for _, item := range items {
			if imageConversationHasActiveTasks(item) {
				active = append(active, item)
				if len(active) == limit {
					break
				}
			}
		}
		return active, 1, nil
	}
	for attempt := 0; attempt < 3; attempt++ {
		state, err := s.ensureImageConversationRows(ctx, ownerID)
		if err != nil {
			return nil, 0, err
		}
		records, err := s.rows.ListActive(ctx, ownerID, state.Generation, limit)
		if errors.Is(err, storage.ErrImageConversationGenerationStale) || errors.Is(err, storage.ErrImageConversationCursorStale) {
			continue
		}
		if err != nil {
			return nil, state.CursorGeneration, err
		}
		latest, loadErr := s.rows.LoadOwnerState(ctx, ownerID)
		if loadErr != nil {
			return nil, state.CursorGeneration, loadErr
		}
		if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
			continue
		}
		items, changed, err := s.assetizeImageConversationRecords(ctx, ownerID, state.Generation, records)
		if errors.Is(err, storage.ErrImageConversationCASConflict) || errors.Is(err, storage.ErrImageConversationGenerationStale) || errors.Is(err, storage.ErrImageConversationGone) {
			continue
		}
		if changed {
			continue
		}
		return items, state.CursorGeneration, err
	}
	latest, err := s.rows.LoadOwnerState(ctx, ownerID)
	if err != nil {
		return nil, 0, err
	}
	return nil, latest.CursorGeneration, ImageConversationHistoryCursorInvalidatedError{Generation: latest.CursorGeneration}
}

// MergeWithAcknowledgementsMinimal persists snapshots without loading the
// owner's complete history. The generation is advisory: destructive changes
// force a reload and each ID is then checked against its tombstone/watermark.
func (s *ImageConversationHistoryService) MergeWithAcknowledgementsMinimal(ctx context.Context, ownerID string, incoming []map[string]any, expectedGeneration *int64) ([]ImageConversationMergeAcknowledgement, int64, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, 0, fmt.Errorf("owner_id is required")
	}
	if s.rows == nil {
		_, acknowledgements, err := s.MergeWithAcknowledgements(ownerID, incoming)
		return acknowledgements, 1, err
	}
	return s.mergeImageConversationRowsContext(ctx, ownerID, incoming, expectedGeneration, true)
}

func (s *ImageConversationHistoryService) DeleteMinimal(ctx context.Context, ownerID, conversationID string) (bool, int64, error) {
	ownerID = util.Clean(ownerID)
	conversationID = util.Clean(conversationID)
	if ownerID == "" || conversationID == "" {
		return false, 0, fmt.Errorf("owner_id and conversation id are required")
	}
	if s.rows == nil {
		_, removed, err := s.Delete(ownerID, conversationID)
		return removed, 1, err
	}
	if _, err := s.ensureImageConversationRows(ctx, ownerID); err != nil {
		return false, 0, err
	}
	removed, err := s.rows.Delete(ctx, ownerID, conversationID, time.Now().UTC().UnixMilli())
	if err != nil {
		return false, 0, err
	}
	state, err := s.rows.LoadOwnerState(ctx, ownerID)
	return removed, state.CursorGeneration, err
}

func (s *ImageConversationHistoryService) ClearMinimal(ctx context.Context, ownerID string) (int64, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return 0, fmt.Errorf("owner_id is required")
	}
	if s.rows == nil {
		if err := s.Clear(ownerID); err != nil {
			return 0, err
		}
		return 1, nil
	}
	now := time.Now().UTC()
	state, err := s.rows.Clear(ctx, ownerID, now.Format(time.RFC3339Nano), now.UnixMilli())
	return state.CursorGeneration, err
}

func (s *ImageConversationHistoryService) listAllImageConversationRows(ownerID string) ([]map[string]any, error) {
	ctx := context.Background()
attemptLoop:
	for attempt := 0; attempt < 3; attempt++ {
		state, err := s.ensureImageConversationRows(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0)
		var cursor *storage.ImageConversationCursor
		for {
			page, listErr := s.rows.List(ctx, ownerID, state.Generation, cursor, imageConversationInternalLimit)
			if errors.Is(listErr, storage.ErrImageConversationGenerationStale) || errors.Is(listErr, storage.ErrImageConversationCursorStale) {
				break
			}
			if listErr != nil {
				return nil, listErr
			}
			fullRecords := make([]storage.ImageConversationRecord, 0, len(page.Records))
			for _, summaryRecord := range page.Records {
				record, exists, loadErr := s.rows.Load(ctx, ownerID, summaryRecord.ID)
				if loadErr != nil {
					return nil, loadErr
				}
				if !exists || record.DeletedAtMillis > 0 || len(record.Data) == 0 {
					continue
				}
				fullRecords = append(fullRecords, record)
			}
			pageItems, _, decodeErr := s.assetizeImageConversationRecords(ctx, ownerID, state.Generation, fullRecords)
			if errors.Is(decodeErr, storage.ErrImageConversationCASConflict) || errors.Is(decodeErr, storage.ErrImageConversationGenerationStale) || errors.Is(decodeErr, storage.ErrImageConversationGone) {
				continue attemptLoop
			}
			if decodeErr != nil {
				return nil, decodeErr
			}
			items = append(items, pageItems...)
			if page.NextCursor == nil {
				latest, stateErr := s.rows.LoadOwnerState(ctx, ownerID)
				if stateErr != nil {
					return nil, stateErr
				}
				if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
					continue attemptLoop
				}
				return items, nil
			}
			cursor = page.NextCursor
		}
	}
	return nil, storage.ErrImageConversationGenerationStale
}

func (s *ImageConversationHistoryService) conversationAssetReferencesFromRows(ctx context.Context, ownerID string) (map[string]struct{}, error) {
	if ctx == nil {
		ctx = context.Background()
	}
attemptLoop:
	for attempt := 0; attempt < imageConversationCASAttempts; attempt++ {
		state, err := s.rows.LoadOwnerState(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Asset governance must remain a lightweight background read. A user's
		// normal history request owns legacy document migration; GC relies on the
		// orphan grace period until that migration has completed. Report the
		// reference set as unavailable so cleanup fails closed instead of treating
		// an unmigrated legacy document as an authoritative empty history.
		if !state.LegacyMigrated {
			return nil, ErrImageConversationAssetReferencesUnavailable
		}
		references := make(map[string]struct{})
		var cursor *storage.ImageConversationCursor
		for {
			page, listErr := s.rows.List(ctx, ownerID, state.Generation, cursor, imageConversationInternalLimit)
			if errors.Is(listErr, storage.ErrImageConversationGenerationStale) || errors.Is(listErr, storage.ErrImageConversationCursorStale) {
				continue attemptLoop
			}
			if listErr != nil {
				return nil, listErr
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}

			rewrites := make([]storage.ImageConversationCASRequest, 0)
			for _, summaryRecord := range page.Records {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				indexed, complete := imageConversationAssetReferencesFromSummary(summaryRecord.Summary, ownerID)
				if complete {
					mergeImageConversationAssetReferenceSets(references, indexed)
					continue
				}

				fullRecord, exists, loadErr := s.rows.Load(ctx, ownerID, summaryRecord.ID)
				if loadErr != nil || !exists || fullRecord.DeletedAtMillis > 0 || len(fullRecord.Data) == 0 {
					if loadErr != nil && !errors.Is(loadErr, storage.ErrImageConversationGone) {
						return nil, loadErr
					}
					continue attemptLoop
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				item, decodeErr := imageConversationItemFromRecord(fullRecord)
				if decodeErr != nil {
					return nil, decodeErr
				}
				mergeImageConversationAssetReferenceSets(
					references,
					imageConversationManagedAssetReferences(s.conversationAssets.ReferencedAssetPaths(item), ownerID),
				)

				nextSummary, encodeErr := json.Marshal(imageConversationHistorySummary(item))
				if encodeErr != nil {
					return nil, fmt.Errorf("marshal image conversation asset summary: %w", encodeErr)
				}
				_, nextComplete := imageConversationAssetReferencesFromSummary(nextSummary, ownerID)
				if !nextComplete || len(nextSummary) > storage.MaxImageConversationSummaryBytes || string(nextSummary) == string(fullRecord.Summary) {
					continue
				}
				fullRecord.Summary = nextSummary
				rewrites = append(rewrites, storage.ImageConversationCASRequest{
					ExpectedStorageVersion: fullRecord.StorageVersion,
					Record:                 fullRecord,
				})
			}

			if len(rewrites) > 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				_, rewriteErr := s.rows.BatchSaveCAS(ctx, ownerID, state.Generation, rewrites)
				if errors.Is(rewriteErr, storage.ErrImageConversationCASConflict) ||
					errors.Is(rewriteErr, storage.ErrImageConversationGenerationStale) ||
					errors.Is(rewriteErr, storage.ErrImageConversationGone) {
					continue attemptLoop
				}
				if rewriteErr != nil {
					return nil, rewriteErr
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				continue attemptLoop
			}

			if page.NextCursor == nil {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				latest, stateErr := s.rows.LoadOwnerState(ctx, ownerID)
				if stateErr != nil {
					return nil, stateErr
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
					continue attemptLoop
				}
				return references, nil
			}
			cursor = page.NextCursor
		}
	}
	return nil, storage.ErrImageConversationGenerationStale
}

func imageConversationAssetReferencesFromSummary(summary json.RawMessage, ownerID string) (map[string]struct{}, bool) {
	references := make(map[string]struct{})
	if len(summary) == 0 {
		return references, false
	}
	object := map[string]any{}
	if err := json.Unmarshal(summary, &object); err != nil || object == nil {
		return references, false
	}
	complete, ok := object[imageConversationAssetRefsCompleteKey].(bool)
	if !ok || !complete {
		return references, false
	}
	rawPaths, exists := object[imageConversationAssetPathsSummaryKey]
	if !exists {
		return references, false
	}
	paths, ok := rawPaths.([]any)
	if !ok {
		return references, false
	}
	expectedOwnerHash := imageConversationAssetHash([]byte(strings.TrimSpace(ownerID)))
	for _, rawPath := range paths {
		value, ok := rawPath.(string)
		if !ok {
			return map[string]struct{}{}, false
		}
		assetPath, ownerHash, _, _, err := parseImageConversationAssetPath(value)
		if err != nil || ownerHash != expectedOwnerHash {
			return map[string]struct{}{}, false
		}
		references[assetPath] = struct{}{}
	}
	return references, true
}

func imageConversationManagedAssetReferences(references map[string]struct{}, ownerID string) map[string]struct{} {
	result := make(map[string]struct{}, len(references))
	expectedOwnerHash := imageConversationAssetHash([]byte(strings.TrimSpace(ownerID)))
	for value := range references {
		assetPath, ownerHash, _, _, err := parseImageConversationAssetPath(value)
		if err == nil && ownerHash == expectedOwnerHash {
			result[assetPath] = struct{}{}
		}
	}
	return result
}

func mergeImageConversationAssetReferenceSets(destination, source map[string]struct{}) {
	for assetPath := range source {
		destination[assetPath] = struct{}{}
	}
}

func (s *ImageConversationHistoryService) deleteImageConversationRow(ownerID, conversationID string) (bool, error) {
	removed, _, err := s.DeleteMinimal(context.Background(), ownerID, conversationID)
	return removed, err
}

func (s *ImageConversationHistoryService) clearImageConversationRows(ownerID string) (storage.ImageConversationOwnerState, error) {
	generation, err := s.ClearMinimal(context.Background(), ownerID)
	return storage.ImageConversationOwnerState{CursorGeneration: generation, LegacyMigrated: err == nil}, err
}

func (s *ImageConversationHistoryService) mergeImageConversationRows(ownerID string, incoming []map[string]any, expectedGeneration *int64) ([]ImageConversationMergeAcknowledgement, int64, error) {
	return s.mergeImageConversationRowsContext(context.Background(), ownerID, incoming, expectedGeneration, false)
}

type imageConversationRowSnapshot struct {
	record storage.ImageConversationRecord
	exists bool
}

type plannedImageConversationRowWrite struct {
	inputIndex int
	accepted   bool
	request    storage.ImageConversationCASRequest
}

func (s *ImageConversationHistoryService) mergeImageConversationRowsContext(ctx context.Context, ownerID string, incoming []map[string]any, expectedGeneration *int64, strictRevision bool) ([]ImageConversationMergeAcknowledgement, int64, error) {
	// The client generation identifies a read snapshot. Writes are re-evaluated
	// per conversation against the latest internal tombstone/clear generation;
	// otherwise deleting X could incorrectly discard an in-flight save for Y.
	_ = expectedGeneration
	prepared := make([]normalizedImageConversationRowInput, 0, len(incoming))
	seen := make(map[string]struct{}, len(incoming))
	for _, raw := range incoming {
		incomingRevision, hasRevision := raw["revision"]
		item, err := normalizeImageConversationHistoryItem(raw)
		if err != nil {
			return nil, 0, ImageConversationHistoryValidationError{Err: err}
		}
		if hasRevision {
			item["revision"] = normalizeImageConversationRevision(incomingRevision)
		}
		id := util.Clean(item["id"])
		if _, exists := seen[id]; exists {
			return nil, 0, ImageConversationHistoryValidationError{Err: fmt.Errorf("duplicate conversation id: %s", id)}
		}
		seen[id] = struct{}{}
		prepared = append(prepared, normalizedImageConversationRowInput{
			item:        item,
			hasRevision: hasRevision,
		})
	}
	var assetPreparation *ImageConversationAssetPreparation
	if s.conversationAssets != nil {
		items := make([]map[string]any, len(prepared))
		for index := range prepared {
			items[index] = prepared[index].item
		}
		var assetErr error
		assetPreparation, assetErr = s.conversationAssets.PrepareConversations(ctx, ownerID, items)
		if assetErr != nil {
			return nil, 0, ImageConversationHistoryValidationError{Err: assetErr}
		}
	}
	for index := range prepared {
		item := prepared[index].item
		if s.conversationAssets != nil {
			assetized, _, _, assetErr := s.conversationAssets.AssetizePreparedConversation(ctx, ownerID, item, assetPreparation)
			if assetErr != nil {
				if errors.Is(assetErr, ErrImageConversationAssetStorageLimit) {
					return nil, 0, assetErr
				}
				return nil, 0, ImageConversationHistoryValidationError{Err: assetErr}
			}
			item = assetized
			prepared[index].item = assetized
		}
		data, err := json.Marshal(item)
		if err != nil {
			return nil, 0, ImageConversationHistoryValidationError{Err: fmt.Errorf("conversation is not valid json")}
		}
		prepared[index].inputHash = util.SHA256Hex(string(data))
	}

	state, err := s.ensureImageConversationRows(ctx, ownerID)
	if err != nil {
		return nil, 0, err
	}
	snapshots := make(map[string]imageConversationRowSnapshot, len(prepared))
	for attempt := 0; attempt < imageConversationCASAttempts; attempt++ {
		acknowledgements := make([]ImageConversationMergeAcknowledgement, len(prepared))
		plans := make([]plannedImageConversationRowWrite, 0, len(prepared))
		for index, input := range prepared {
			id := util.Clean(input.item["id"])
			snapshot, cached := snapshots[id]
			if !cached {
				current, exists, loadErr := s.rows.Load(ctx, ownerID, id)
				if loadErr != nil {
					return nil, state.CursorGeneration, loadErr
				}
				snapshot = imageConversationRowSnapshot{record: current, exists: exists}
				snapshots[id] = snapshot
			}
			acknowledgement, plan, planErr := planImageConversationRowWrite(state, input, snapshot, strictRevision)
			if planErr != nil {
				return nil, state.CursorGeneration, planErr
			}
			acknowledgements[index] = acknowledgement
			if plan != nil {
				plan.inputIndex = index
				plans = append(plans, *plan)
			}
		}
		if len(plans) == 0 {
			latest, loadErr := s.rows.LoadOwnerState(ctx, ownerID)
			if loadErr != nil {
				return nil, state.CursorGeneration, loadErr
			}
			if latest.Generation != state.Generation || latest.CursorGeneration != state.CursorGeneration {
				state = latest
				snapshots = make(map[string]imageConversationRowSnapshot, len(prepared))
				continue
			}
			return acknowledgements, state.CursorGeneration, nil
		}
		requests := make([]storage.ImageConversationCASRequest, len(plans))
		for index := range plans {
			requests[index] = plans[index].request
		}
		batch, saveErr := s.rows.BatchSaveCAS(ctx, ownerID, state.Generation, requests)
		if saveErr == nil {
			if len(batch.Items) != len(plans) {
				return nil, state.CursorGeneration, fmt.Errorf("image conversation batch CAS returned %d results for %d requests", len(batch.Items), len(plans))
			}
			for index, plan := range plans {
				saved := batch.Items[index].Current
				acknowledgements[plan.inputIndex].Accepted = plan.accepted
				acknowledgements[plan.inputIndex].ActualRevision = saved.Revision
			}
			return acknowledgements, batch.CursorGeneration, nil
		}
		if !errors.Is(saveErr, storage.ErrImageConversationCASConflict) &&
			!errors.Is(saveErr, storage.ErrImageConversationGone) &&
			!errors.Is(saveErr, storage.ErrImageConversationGenerationStale) {
			return nil, batch.CursorGeneration, saveErr
		}
		if errors.Is(saveErr, storage.ErrImageConversationGenerationStale) {
			latest, loadErr := s.rows.LoadOwnerState(ctx, ownerID)
			if loadErr != nil {
				return nil, state.CursorGeneration, loadErr
			}
			state = latest
			snapshots = make(map[string]imageConversationRowSnapshot, len(prepared))
		}
		if len(batch.Items) != len(plans) {
			return nil, state.CursorGeneration, saveErr
		}
		for _, item := range batch.Items {
			snapshots[item.ID] = imageConversationRowSnapshot{record: item.Current, exists: item.Exists}
		}
	}
	return nil, state.CursorGeneration, storage.ErrImageConversationCASConflict
}

func planImageConversationRowWrite(
	state storage.ImageConversationOwnerState,
	input normalizedImageConversationRowInput,
	snapshot imageConversationRowSnapshot,
	strictRevision bool,
) (ImageConversationMergeAcknowledgement, *plannedImageConversationRowWrite, error) {
	id := util.Clean(input.item["id"])
	acknowledgement := ImageConversationMergeAcknowledgement{ID: id}
	currentRecord := snapshot.record
	exists := snapshot.exists
	if exists && (currentRecord.DeletedAtMillis > 0 || len(currentRecord.Data) == 0) {
		acknowledgement.Gone = true
		return acknowledgement, nil, nil
	}

	var candidate map[string]any
	expectedStorageVersion := int64(0)
	acceptedCandidate := true
	acceptedHash := input.inputHash
	if !exists {
		if imageConversationWasCleared(input.item, state.ClearedAt) {
			acknowledgement.Gone = true
			return acknowledgement, nil, nil
		}
		candidate = input.item
	} else {
		current, decodeErr := imageConversationItemFromRecord(currentRecord)
		if decodeErr != nil {
			return acknowledgement, nil, decodeErr
		}
		expectedStorageVersion = currentRecord.StorageVersion
		currentRevision := imageConversationRevision(current)
		incomingRevision := imageConversationRevision(input.item)
		if input.hasRevision && currentRevision > 0 && incomingRevision == currentRevision {
			persistedHash := currentRecord.AcceptedHash
			if persistedHash == "" {
				persistedHash = util.SHA256Hex(string(currentRecord.Data))
			}
			acknowledgement.Accepted = persistedHash == input.inputHash
			acknowledgement.ActualRevision = currentRevision
			return acknowledgement, nil, nil
		}
		version := compareImageConversationVersion(current, input.item, input.hasRevision)
		if version < 0 || (version == 0 && !mapsAreEqualImageConversations(current, input.item)) {
			if strictRevision {
				acknowledgement.ActualRevision = currentRevision
				return acknowledgement, nil, nil
			}
			candidate = mergeImageConversationHistoryItem(current, input.item, input.hasRevision)
			if mapsAreEqualImageConversations(candidate, current) {
				acknowledgement.ActualRevision = currentRevision
				return acknowledgement, nil, nil
			}
			acceptedCandidate = false
			acceptedHash = currentRecord.AcceptedHash
			if acceptedHash == "" {
				acceptedHash = util.SHA256Hex(string(currentRecord.Data))
			}
		}
		if version == 0 && candidate == nil {
			acknowledgement.Accepted = true
			acknowledgement.ActualRevision = currentRevision
			return acknowledgement, nil, nil
		}
		if candidate == nil {
			candidate = mergeImageConversationHistoryItem(current, input.item, input.hasRevision)
		}
	}

	record, recordErr := imageConversationRecordFromItem(candidate, acceptedHash)
	if recordErr != nil {
		return acknowledgement, nil, recordErr
	}
	return acknowledgement, &plannedImageConversationRowWrite{
		accepted: acceptedCandidate,
		request: storage.ImageConversationCASRequest{
			ExpectedStorageVersion: expectedStorageVersion,
			Record:                 record,
		},
	}, nil
}

func (s *ImageConversationHistoryService) ensureImageConversationRows(ctx context.Context, ownerID string) (storage.ImageConversationOwnerState, error) {
	lock := s.lockForOwner(ownerID)
	lock.Lock()
	defer lock.Unlock()

	state, err := s.rows.LoadOwnerState(ctx, ownerID)
	if err != nil || state.LegacyMigrated {
		return state, err
	}
	records := make([]storage.ImageConversationRecord, 0)
	if s.store != nil {
		items, deleted, clearedAt, removedActiveOutput, loadErr := s.loadDocumentLocked(ownerID)
		if loadErr != nil {
			return state, loadErr
		}
		for _, item := range items {
			record, recordErr := imageConversationRecordFromItem(item, "")
			if recordErr != nil {
				return state, recordErr
			}
			records = append(records, record)
		}
		for id, deletedAt := range deleted {
			deletedAtMillis := imageConversationTimestampMillis(deletedAt)
			if deletedAtMillis == 0 {
				deletedAtMillis = 1
			}
			records = append(records, storage.ImageConversationRecord{ID: id, DeletedAtMillis: deletedAtMillis})
		}
		state.ClearedAt = clearedAt
		state.ClearedAtMillis = imageConversationTimestampMillis(clearedAt)
		migrated, migrateErr := s.rows.MigrateLegacy(ctx, ownerID, records, state)
		if migrateErr != nil {
			return state, migrateErr
		}
		if removedActiveOutput {
			_ = s.saveLocked(ownerID, items, deleted, clearedAt)
		}
		return migrated, nil
	}
	return s.rows.MigrateLegacy(ctx, ownerID, records, state)
}

func imageConversationRecordFromItem(item map[string]any, acceptedHash string) (storage.ImageConversationRecord, error) {
	data, err := json.Marshal(item)
	if err != nil {
		return storage.ImageConversationRecord{}, fmt.Errorf("marshal image conversation: %w", err)
	}
	createdAt := strings.TrimSpace(util.Clean(item["createdAt"]))
	if createdAt == "" {
		createdAt = imageConversationUpdatedAt(item)
	}
	summary, err := json.Marshal(imageConversationHistorySummary(item))
	if err != nil {
		return storage.ImageConversationRecord{}, fmt.Errorf("marshal image conversation summary: %w", err)
	}
	return storage.ImageConversationRecord{
		ID:              util.Clean(item["id"]),
		Revision:        imageConversationRevision(item),
		AcceptedHash:    acceptedHash,
		CreatedAtMillis: imageConversationTimestampMillis(createdAt),
		UpdatedAtMillis: imageConversationTimestampMillis(imageConversationUpdatedAt(item)),
		Active:          imageConversationHasActiveTasks(item),
		Summary:         summary,
		Data:            data,
	}, nil
}

func imageConversationItemFromRecord(record storage.ImageConversationRecord) (map[string]any, error) {
	if len(record.Data) == 0 {
		return nil, fmt.Errorf("image conversation %q has empty persisted data", record.ID)
	}
	item := map[string]any{}
	if err := json.Unmarshal(record.Data, &item); err != nil {
		return nil, fmt.Errorf("decode image conversation %q: %w", record.ID, err)
	}
	normalized, err := normalizeImageConversationHistoryItem(item)
	if err != nil {
		return nil, fmt.Errorf("decode image conversation %q: %w", record.ID, err)
	}
	if util.Clean(normalized["id"]) != record.ID {
		return nil, storage.ErrImageConversationHashCollision
	}
	normalized["revision"] = record.Revision
	return normalized, nil
}

func (s *ImageConversationHistoryService) assetizeImageConversationRecords(
	ctx context.Context,
	ownerID string,
	generation int64,
	records []storage.ImageConversationRecord,
) ([]map[string]any, bool, error) {
	items := make([]map[string]any, len(records))
	if len(records) == 0 {
		return items, false, nil
	}
	requests := make([]storage.ImageConversationCASRequest, 0, len(records))
	changed := false
	for index, record := range records {
		item, err := imageConversationItemFromRecord(record)
		if err != nil {
			return nil, false, err
		}
		if s.conversationAssets == nil {
			items[index] = item
			continue
		}
		assetized, _, itemChanged, err := s.conversationAssets.AssetizeStoredConversation(ctx, ownerID, item)
		if err != nil {
			if errors.Is(err, ErrImageConversationAssetStorageLimit) {
				items[index] = item
				continue
			}
			return nil, false, err
		}
		items[index] = assetized
		if !itemChanged {
			continue
		}
		// The client replay is assetized before hashing, so the durable accepted
		// hash must move to the rewritten representation as well. Keeping the old
		// Base64 hash would turn an equivalent same-revision retry into a conflict.
		nextRecord, err := imageConversationRecordFromItem(assetized, "")
		if err != nil {
			return nil, false, err
		}
		requests = append(requests, storage.ImageConversationCASRequest{
			ExpectedStorageVersion: record.StorageVersion,
			Record:                 nextRecord,
		})
		changed = true
	}
	if len(requests) == 0 {
		return items, false, nil
	}
	_, err := s.rows.BatchSaveCAS(ctx, ownerID, generation, requests)
	if err != nil {
		return nil, false, err
	}
	return items, changed, nil
}

func imageConversationItemsFromRecords(records []storage.ImageConversationRecord) ([]map[string]any, error) {
	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		item, err := imageConversationItemFromRecord(record)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func imageConversationSummariesFromRecords(records []storage.ImageConversationRecord) ([]map[string]any, error) {
	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		item, err := imageConversationSummaryFromRecord(record)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func imageConversationSummaryFromRecord(record storage.ImageConversationRecord) (map[string]any, error) {
	if len(record.Summary) == 0 {
		return nil, fmt.Errorf("image conversation %q has empty persisted summary", record.ID)
	}
	item := map[string]any{}
	if err := json.Unmarshal(record.Summary, &item); err != nil {
		return nil, fmt.Errorf("decode image conversation summary %q: %w", record.ID, err)
	}
	if item == nil {
		return nil, fmt.Errorf("decode image conversation summary %q: expected object", record.ID)
	}
	if id := util.Clean(item["id"]); id != "" && id != record.ID {
		return nil, storage.ErrImageConversationHashCollision
	}
	item["id"] = record.ID
	item["revision"] = record.Revision
	item["historySummaryOnly"] = true
	delete(item, imageConversationAssetPathsSummaryKey)
	delete(item, imageConversationAssetRefsCompleteKey)
	summary := util.StringMap(item["historySummary"])
	item["historySummary"] = map[string]any{
		"turnCount": util.ToInt(summary["turnCount"], 0),
		"queued":    util.ToInt(summary["queued"], 0),
		"running":   util.ToInt(summary["running"], 0),
	}
	return item, nil
}

func imageConversationHistorySummary(item map[string]any) map[string]any {
	turns := util.AsMapSlice(item["turns"])
	queued := 0
	running := 0
	for _, turn := range turns {
		hasQueued := false
		hasRunning := false
		for _, image := range util.AsMapSlice(turn["images"]) {
			if imageConversationImageIsRunning(image) {
				hasRunning = true
				break
			}
			if imageConversationImageIsQueued(image) {
				hasQueued = true
			}
		}
		if hasRunning || (!hasQueued && util.Clean(turn["status"]) == "generating") {
			running++
			continue
		}
		if hasQueued || util.Clean(turn["status"]) == "queued" {
			queued++
		}
	}
	assetPaths, assetRefsComplete := imageConversationAssetSummaryFromItem(item)
	return map[string]any{
		"id":                                  util.Clean(item["id"]),
		"revision":                            imageConversationRevision(item),
		"title":                               util.Clean(item["title"]),
		"createdAt":                           strings.TrimSpace(util.Clean(item["createdAt"])),
		"updatedAt":                           imageConversationUpdatedAt(item),
		"historySummary":                      map[string]any{"turnCount": len(turns), "queued": queued, "running": running},
		"historySummaryOnly":                  true,
		imageConversationAssetPathsSummaryKey: assetPaths,
		imageConversationAssetRefsCompleteKey: assetRefsComplete,
	}
}

func imageConversationAssetSummaryFromItem(item map[string]any) ([]string, bool) {
	paths := make(map[string]struct{})
	complete := true
	for _, turn := range util.AsMapSlice(item["turns"]) {
		for _, reference := range util.AsMapSlice(turn["referenceImages"]) {
			value := firstImageConversationAssetValue(reference)
			if value == "" {
				continue
			}
			assetPath, _, _, _, err := parseImageConversationAssetPath(value)
			if err == nil {
				paths[assetPath] = struct{}{}
				continue
			}
			if util.Clean(reference["assetPath"]) != "" ||
				util.Clean(reference["asset_path"]) != "" ||
				strings.Contains(value, ImageConversationAssetURLPrefix) {
				complete = false
			}
		}
	}
	result := make([]string, 0, len(paths))
	for assetPath := range paths {
		result = append(result, assetPath)
	}
	sort.Strings(result)
	return result, complete
}

func imageConversationHasActiveTasks(item map[string]any) bool {
	for _, turn := range util.AsMapSlice(item["turns"]) {
		status := util.Clean(turn["status"])
		if status == "queued" || status == "generating" {
			return true
		}
		for _, image := range util.AsMapSlice(turn["images"]) {
			if imageConversationImageIsRunning(image) || imageConversationImageIsQueued(image) {
				return true
			}
		}
	}
	return false
}

func imageConversationTimestampMillis(value string) int64 {
	parsed, ok := parseImageConversationTime(value)
	if !ok {
		return 0
	}
	millis := parsed.UnixMilli()
	if millis < 0 {
		return 0
	}
	return millis
}

func mapsAreEqualImageConversations(left, right map[string]any) bool {
	leftData, leftErr := json.Marshal(left)
	rightData, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftData) == string(rightData)
}

func encodeImageConversationCursor(cursor *storage.ImageConversationCursor) (string, error) {
	if cursor == nil {
		return "", nil
	}
	payload, err := json.Marshal(imageConversationOpaqueCursor{
		Version:         imageConversationCursorVersion,
		Generation:      cursor.Generation,
		UpdatedAtMillis: cursor.UpdatedAtMillis,
		ConversationKey: cursor.ConversationKey,
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeImageConversationCursor(value string) (*storage.ImageConversationCursor, int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, 0, nil
	}
	if len(value) > 1024 {
		return nil, 0, ImageConversationHistoryCursorError{Err: fmt.Errorf("invalid image conversation cursor")}
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, 0, ImageConversationHistoryCursorError{Err: fmt.Errorf("invalid image conversation cursor")}
	}
	decoded := imageConversationOpaqueCursor{}
	if err := json.Unmarshal(payload, &decoded); err != nil || decoded.Version != imageConversationCursorVersion || decoded.Generation < 1 || decoded.UpdatedAtMillis < 0 || !validImageConversationKey(decoded.ConversationKey) {
		return nil, 0, ImageConversationHistoryCursorError{Err: fmt.Errorf("invalid image conversation cursor")}
	}
	return &storage.ImageConversationCursor{
		Generation:      decoded.Generation,
		UpdatedAtMillis: decoded.UpdatedAtMillis,
		ConversationKey: decoded.ConversationKey,
	}, decoded.Generation, nil
}

func validImageConversationKey(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (s *ImageConversationHistoryService) listLegacyImageConversationPage(ownerID, cursor string, limit int) (ImageConversationHistoryPage, error) {
	items, err := s.List(ownerID)
	if err != nil {
		return ImageConversationHistoryPage{}, err
	}
	records := make([]storage.ImageConversationRecord, 0, len(items))
	for _, item := range items {
		record, recordErr := imageConversationRecordFromItem(item, "")
		if recordErr != nil {
			return ImageConversationHistoryPage{}, recordErr
		}
		records = append(records, record)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].UpdatedAtMillis != records[j].UpdatedAtMillis {
			return records[i].UpdatedAtMillis > records[j].UpdatedAtMillis
		}
		return util.SHA256Hex(records[i].ID) > util.SHA256Hex(records[j].ID)
	})
	storageCursor, generation, err := decodeImageConversationCursor(cursor)
	if err != nil {
		return ImageConversationHistoryPage{}, err
	}
	if storageCursor != nil && generation != 1 {
		return ImageConversationHistoryPage{}, ImageConversationHistoryCursorInvalidatedError{Generation: 1}
	}
	start := 0
	if storageCursor != nil {
		start = len(records)
		for index, record := range records {
			key := util.SHA256Hex(record.ID)
			if record.UpdatedAtMillis < storageCursor.UpdatedAtMillis || (record.UpdatedAtMillis == storageCursor.UpdatedAtMillis && key < storageCursor.ConversationKey) {
				start = index
				break
			}
		}
	}
	end := start + limit
	if end > len(records) {
		end = len(records)
	}
	pageRecords := records[start:end]
	pageItems, err := imageConversationSummariesFromRecords(pageRecords)
	if err != nil {
		return ImageConversationHistoryPage{}, err
	}
	next := ""
	if end < len(records) && len(pageRecords) > 0 {
		last := pageRecords[len(pageRecords)-1]
		next, err = encodeImageConversationCursor(&storage.ImageConversationCursor{
			Generation:      1,
			UpdatedAtMillis: last.UpdatedAtMillis,
			ConversationKey: util.SHA256Hex(last.ID),
		})
		if err != nil {
			return ImageConversationHistoryPage{}, err
		}
	}
	return ImageConversationHistoryPage{Items: pageItems, NextCursor: next, HasMore: next != "", Generation: 1}, nil
}
