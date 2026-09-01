package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	myAssetDocumentDir                 = "my_assets"
	myAssetDocumentGenerationField     = "generation"
	myAssetDocumentOwnerIDField        = "ownerID"
	myAssetPendingObjectDeletionsField = "pendingObjectDeletions"
	maxMyAssetItems                    = 2000
	myAssetSaveAttempts                = 8
	myAssetRequestCleanupBatchSize     = 1
	myAssetRequestCleanupTimeout       = time.Second
	MyAssetPrivate                     = "private"
	MyAssetPublic                      = "public"
)

type MyAssetOwner struct {
	ID   string
	Name string
}

type MyAsset struct {
	ID         string         `json:"id"`
	Kind       string         `json:"kind"`
	Title      string         `json:"title"`
	CoverURL   string         `json:"coverUrl,omitempty"`
	URL        string         `json:"url,omitempty"`
	StorageKey string         `json:"storageKey,omitempty"`
	Content    string         `json:"content,omitempty"`
	MIMEType   string         `json:"mimeType,omitempty"`
	Bytes      int64          `json:"bytes,omitempty"`
	Width      int            `json:"width,omitempty"`
	Height     int            `json:"height,omitempty"`
	DurationMs int64          `json:"durationMs,omitempty"`
	Tags       []string       `json:"tags"`
	Visibility string         `json:"visibility"`
	Source     string         `json:"source,omitempty"`
	Note       string         `json:"note,omitempty"`
	CreatedAt  string         `json:"createdAt"`
	UpdatedAt  string         `json:"updatedAt"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	OwnerID    string         `json:"ownerId,omitempty"`
	OwnerName  string         `json:"ownerName,omitempty"`
	Owned      bool           `json:"owned,omitempty"`
}

type MyAssetTextGovernance struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

type myAssetDocument struct {
	ownerID                string
	items                  []MyAsset
	pendingObjectDeletions []string
	generation             int64
}

var ErrStorageObjectInUse = errors.New("storage object is still referenced")

func (s *MyAssetService) ListVisible(viewerID string, admin bool, owners []MyAssetOwner) ([]MyAsset, error) {
	viewerID = strings.TrimSpace(viewerID)
	if viewerID == "" {
		return nil, fmt.Errorf("viewer_id is required")
	}
	ownerByID := make(map[string]MyAssetOwner, len(owners)+1)
	for _, owner := range owners {
		owner.ID = strings.TrimSpace(owner.ID)
		owner.Name = strings.TrimSpace(owner.Name)
		if owner.ID != "" {
			ownerByID[owner.ID] = owner
		}
	}
	if _, exists := ownerByID[viewerID]; !exists {
		ownerByID[viewerID] = MyAssetOwner{ID: viewerID}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	documents, batched := s.listAssetDocumentsLocked()
	items := make([]MyAsset, 0)
	for _, owner := range ownerByID {
		var ownedItems []MyAsset
		if batched {
			ownedItems = decodeMyAssets(documents[myAssetDocumentName(owner.ID)])
		} else {
			var err error
			ownedItems, err = s.loadLocked(owner.ID)
			if err != nil {
				return nil, err
			}
		}
		for _, item := range ownedItems {
			owned := owner.ID == viewerID
			if !admin && !owned && item.Visibility != MyAssetPublic {
				continue
			}
			item.OwnerID = owner.ID
			item.OwnerName = owner.Name
			item.Owned = owned
			items = append(items, item)
		}
	}
	sortMyAssets(items)
	return items, nil
}

func (s *MyAssetService) TextGovernance(viewerID string, admin bool, owners []MyAssetOwner) (MyAssetTextGovernance, error) {
	items, err := s.ListVisible(viewerID, admin, owners)
	if err != nil {
		return MyAssetTextGovernance{}, err
	}
	result := MyAssetTextGovernance{}
	for _, item := range items {
		if item.Kind != "text" {
			continue
		}
		result.Count++
		result.Bytes += int64(len([]byte(item.Content)))
	}
	return result, nil
}

type MyAssetService struct {
	mu                  sync.Mutex
	store               storage.JSONDocumentBackend
	objects             MyAssetObjectStorage
	deletionCoordinator StorageObjectDeletionCoordinator
}

type MyAssetObjectStorage interface {
	Upload(context.Context, string, bool, string, string, []byte, *StorageObjectProviderInput) (UploadedStorageObject, error)
	InfoForIdentity(string, bool, string) (model.StorageObject, error)
	Delete(context.Context, string, bool, string, *StorageObjectProviderInput) error
}

type StorageObjectDeletionCoordinator interface {
	ReserveStorageObjectDeletion(ownerID, objectID string) error
	CompleteStorageObjectDeletion(ownerID, objectID string) error
}

func NewMyAssetService(backend storage.Backend, objects MyAssetObjectStorage, coordinators ...StorageObjectDeletionCoordinator) *MyAssetService {
	service := &MyAssetService{store: jsonDocumentStoreFromBackend(backend), objects: objects}
	if len(coordinators) > 0 {
		service.deletionCoordinator = coordinators[0]
	}
	return service
}

func (s *MyAssetService) List(ownerID string) ([]MyAsset, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(ownerID)
}

// Upsert applies one asset mutation to the latest stored document. Retrying the
// item-level intent after a document CAS conflict preserves unrelated writes.
func (s *MyAssetService) Upsert(ctx context.Context, ownerID string, admin bool, input MyAsset) (MyAsset, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return MyAsset{}, fmt.Errorf("owner_id is required")
	}
	input.OwnerID = ""
	input.OwnerName = ""
	input.Owned = false
	item, err := normalizeMyAsset(input)
	if err != nil {
		return MyAsset{}, err
	}

	var staged *UploadedStorageObject
	var saved MyAsset
	var lastErr error
	for attempt := 0; attempt < myAssetSaveAttempts; {
		s.mu.Lock()
		document, loadErr := s.loadDocumentLocked(ownerID)
		if loadErr != nil {
			s.mu.Unlock()
			lastErr = loadErr
			break
		}
		items := document.items
		matched := myAssetIndex(items, item)
		candidate := item
		var previous MyAsset
		if matched >= 0 {
			previous = items[matched]
			if previous.CreatedAt != "" {
				candidate.CreatedAt = previous.CreatedAt
			}
		} else if len(items) >= maxMyAssetItems {
			s.mu.Unlock()
			lastErr = fmt.Errorf("assets cannot contain more than %d items", maxMyAssetItems)
			break
		}

		if candidate.Kind == "text" {
			candidate.StorageKey = ""
			candidate.URL = ""
			candidate.MIMEType = ""
			candidate.Bytes = 0
			if previous.Kind == "text" && previous.Content == candidate.Content && previous.StorageKey != "" {
				candidate.StorageKey = previous.StorageKey
				candidate.URL = previous.URL
				candidate.MIMEType = previous.MIMEType
				candidate.Bytes = previous.Bytes
			} else {
				if staged == nil {
					s.mu.Unlock()
					if s.objects == nil {
						lastErr = fmt.Errorf("asset object storage is required")
						break
					}
					uploaded, uploadErr := s.objects.Upload(ctx, ownerID, admin, candidate.ID+".txt", "text/plain; charset=utf-8", []byte(candidate.Content), nil)
					if uploadErr != nil {
						lastErr = fmt.Errorf("store text asset %q: %w", candidate.Title, uploadErr)
						break
					}
					staged = &uploaded
					continue
				}
				candidate.StorageKey = staged.StorageKey
				candidate.URL = staged.URL
				candidate.MIMEType = staged.MIMEType
				candidate.Bytes = staged.Bytes
			}
		} else if validateErr := s.validateMediaStorageObject(ownerID, candidate, document); validateErr != nil {
			s.mu.Unlock()
			lastErr = validateErr
			break
		}

		if matched >= 0 {
			items[matched] = candidate
		} else {
			items = append(items, candidate)
		}
		sortMyAssets(items)
		pending := append([]string(nil), document.pendingObjectDeletions...)
		if previous.Kind == "text" && previous.StorageKey != "" && previous.StorageKey != candidate.StorageKey {
			pending = appendMyAssetObjectDeletionIDs(pending, storageObjectIDFromKey(previous.StorageKey))
		}
		if staged != nil {
			stagedID := firstNonEmpty(staged.ID, storageObjectIDFromKey(staged.StorageKey))
			if storageObjectIDFromKey(candidate.StorageKey) != strings.TrimSpace(stagedID) {
				pending = appendMyAssetObjectDeletionIDs(pending, stagedID)
			}
		}
		document.items = items
		document.pendingObjectDeletions = pending
		saveErr := s.saveDocumentLocked(ownerID, document)
		s.mu.Unlock()
		attempt++
		if saveErr != nil {
			lastErr = saveErr
			if errors.Is(saveErr, storage.ErrConcurrentRowUpdate) && attempt < myAssetSaveAttempts {
				continue
			}
			break
		}
		saved = candidate
		lastErr = nil
		break
	}

	if lastErr != nil {
		if staged != nil {
			stagedID := firstNonEmpty(staged.ID, storageObjectIDFromKey(staged.StorageKey))
			if cleanupErr := s.cleanupUncommittedTextObject(ctx, ownerID, admin, stagedID); cleanupErr != nil {
				lastErr = errors.Join(lastErr, cleanupErr)
			}
		}
		return MyAsset{}, lastErr
	}
	// The asset mutation is already committed. Failed cleanup remains in the
	// document outbox and must not make the mutation appear to have failed.
	_ = s.retryPendingObjectDeletionsForRequest(ctx, ownerID, admin)
	return saved, nil
}

func (s *MyAssetService) EnsureTextStorage(ctx context.Context, ownerID string, admin bool) ([]MyAsset, error) {
	// A normal asset-page load is also the low-cost recovery path for durable
	// cleanup work left by an earlier provider failure or process restart.
	_ = s.retryPendingObjectDeletionsForRequest(ctx, ownerID, admin)
	items, err := s.List(ownerID)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Kind == "text" && item.StorageKey == "" {
			if _, err := s.Upsert(ctx, ownerID, admin, item); err != nil {
				return nil, err
			}
		}
	}
	return s.List(ownerID)
}

// Delete removes one asset from the latest stored document. Text object
// cleanup runs only after the document mutation has committed.
func (s *MyAssetService) Delete(ctx context.Context, ownerID string, admin bool, id string) (bool, error) {
	ownerID = strings.TrimSpace(ownerID)
	id = strings.TrimSpace(id)
	if ownerID == "" {
		return false, fmt.Errorf("owner_id is required")
	}
	if id == "" {
		return false, fmt.Errorf("asset id is required")
	}

	s.mu.Lock()
	removedOnce := false
	cleanupIDs := make([]string, 0, 1)
	var lastErr error
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, loadErr := s.loadDocumentLocked(ownerID)
		if loadErr != nil {
			lastErr = loadErr
			break
		}
		items := document.items
		index := -1
		for itemIndex := range items {
			if items[itemIndex].ID == id {
				index = itemIndex
				break
			}
		}
		if index < 0 {
			pending := appendMyAssetObjectDeletionIDs(document.pendingObjectDeletions, cleanupIDs...)
			if len(pending) != len(document.pendingObjectDeletions) {
				document.items = items
				document.pendingObjectDeletions = pending
				if saveErr := s.saveDocumentLocked(ownerID, document); saveErr != nil {
					lastErr = saveErr
					if errors.Is(saveErr, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
						continue
					}
					break
				}
			}
			lastErr = nil
			break
		}
		removedOnce = true
		if items[index].Kind == "text" {
			cleanupIDs = appendMyAssetObjectDeletionIDs(cleanupIDs, storageObjectIDFromKey(items[index].StorageKey))
		}
		items = append(items[:index], items[index+1:]...)
		document.items = items
		document.pendingObjectDeletions = appendMyAssetObjectDeletionIDs(document.pendingObjectDeletions, cleanupIDs...)
		if saveErr := s.saveDocumentLocked(ownerID, document); saveErr != nil {
			lastErr = saveErr
			if errors.Is(saveErr, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			break
		}
		lastErr = nil
		break
	}
	s.mu.Unlock()
	if lastErr != nil {
		return false, lastErr
	}
	// The asset mutation is already committed. Failed cleanup remains in the
	// document outbox and must not make the mutation appear to have failed.
	_ = s.retryPendingObjectDeletionsForRequest(ctx, ownerID, admin)
	return removedOnce, nil
}

func myAssetIndex(items []MyAsset, candidate MyAsset) int {
	for index, existing := range items {
		if existing.ID == candidate.ID || candidate.Kind != "text" && candidate.StorageKey != "" && existing.StorageKey == candidate.StorageKey {
			return index
		}
	}
	return -1
}

func (s *MyAssetService) cleanupUncommittedTextObject(ctx context.Context, ownerID string, admin bool, objectID string) error {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return nil
	}
	queued, err := s.enqueueObjectDeletion(ownerID, objectID)
	if err != nil {
		// A failed document save may have committed remotely. Without a durable
		// outbox entry, deleting here could remove an object the document references.
		return fmt.Errorf("persist text asset cleanup: %w", err)
	}
	if !queued {
		return nil
	}
	return s.retryPendingObjectDeletionsWithBudget(ctx, ownerID, admin, objectID, nil)
}

func (s *MyAssetService) enqueueObjectDeletion(ownerID, objectID string) (bool, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, err := s.loadDocumentLocked(ownerID)
		if err != nil {
			return false, err
		}
		if myAssetDocumentReferencesObject(document, objectID) {
			return false, nil
		}
		pending := appendMyAssetObjectDeletionIDs(document.pendingObjectDeletions, objectID)
		if len(pending) == len(document.pendingObjectDeletions) {
			return true, nil
		}
		document.pendingObjectDeletions = pending
		if err := s.saveDocumentLocked(ownerID, document); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			return false, err
		}
		return true, nil
	}
	return false, storage.ErrConcurrentRowUpdate
}

// RetryAllPendingObjectDeletions performs a bounded recovery sweep. It handles
// one object per owner so a large backlog cannot monopolize the server, while
// periodic calls eventually drain durable work left by crashes or providers.
func (s *MyAssetService) RetryAllPendingObjectDeletions(ctx context.Context, knownOwnerIDs ...string) error {
	owners, err := s.pendingObjectDeletionOwners(knownOwnerIDs...)
	if err != nil {
		return err
	}
	cleanupErrors := make([]error, 0)
	for _, ownerID := range owners {
		if ctx != nil {
			if err := ctx.Err(); err != nil {
				cleanupErrors = append(cleanupErrors, err)
				break
			}
		}
		if err := s.retryPendingObjectDeletions(ctx, ownerID, false, myAssetRequestCleanupBatchSize, "", nil); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("retry pending asset deletions for %q: %w", ownerID, err))
		}
	}
	return errors.Join(cleanupErrors...)
}

func (s *MyAssetService) pendingObjectDeletionOwners(knownOwnerIDs ...string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, ok := s.store.(storage.JSONDocumentPrefixBackend)
	if !ok {
		return nil, errors.New("storage document prefix backend is required")
	}
	documents, err := store.ListJSONDocuments(myAssetDocumentDir + "/")
	if err != nil {
		return nil, err
	}
	owners := make(map[string]struct{})
	knownOwnerByDocument := make(map[string]string, len(knownOwnerIDs))
	for _, knownOwnerID := range knownOwnerIDs {
		knownOwnerID = strings.TrimSpace(knownOwnerID)
		if knownOwnerID != "" {
			knownOwnerByDocument[myAssetDocumentName(knownOwnerID)] = knownOwnerID
		}
	}
	for name, raw := range documents {
		value := util.StringMap(raw)
		if len(appendMyAssetObjectDeletionIDs(nil, util.AsStringSlice(value[myAssetPendingObjectDeletionsField])...)) == 0 {
			continue
		}
		ownerID := strings.TrimSpace(util.Clean(value[myAssetDocumentOwnerIDField]))
		if ownerID == "" {
			ownerID = knownOwnerByDocument[name]
		}
		if ownerID != "" {
			owners[ownerID] = struct{}{}
		}
	}
	result := make([]string, 0, len(owners))
	for ownerID := range owners {
		result = append(result, ownerID)
	}
	sort.Strings(result)
	return result, nil
}

// DeleteStorageObject serializes an explicit object deletion with asset
// mutations by publishing a durable tombstone before provider I/O begins.
func (s *MyAssetService) DeleteStorageObject(ctx context.Context, requesterID string, admin bool, objectID string, provider *StorageObjectProviderInput) error {
	requesterID = strings.TrimSpace(requesterID)
	objectID = strings.TrimSpace(objectID)
	if requesterID == "" || objectID == "" {
		return errors.New("user and storage object id are required")
	}
	if s.objects == nil {
		return errors.New("asset object storage is required")
	}
	object, err := s.objects.InfoForIdentity(requesterID, admin, objectID)
	if errors.Is(err, storage.ErrStorageObjectNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	ownerID := strings.TrimSpace(object.CreatedBy)
	if ownerID == "" {
		ownerID = requesterID
	}
	queued, err := s.enqueueObjectDeletion(ownerID, objectID)
	if err != nil {
		return fmt.Errorf("persist storage object deletion: %w", err)
	}
	if !queued {
		return fmt.Errorf("%w by an asset: %q", ErrStorageObjectInUse, objectID)
	}
	deleteErr := s.retryPendingObjectDeletionsWithBudget(ctx, ownerID, admin, objectID, provider)
	if errors.Is(deleteErr, ErrStorageObjectInUse) {
		if cancelErr := s.cancelObjectDeletion(ownerID, objectID); cancelErr != nil {
			return errors.Join(deleteErr, fmt.Errorf("cancel storage object deletion: %w", cancelErr))
		}
	}
	return deleteErr
}

func (s *MyAssetService) cancelObjectDeletion(ownerID, objectID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, err := s.loadDocumentLocked(ownerID)
		if err != nil {
			return err
		}
		remaining := make([]string, 0, len(document.pendingObjectDeletions))
		for _, pendingID := range document.pendingObjectDeletions {
			if pendingID != objectID {
				remaining = append(remaining, pendingID)
			}
		}
		if len(remaining) == len(document.pendingObjectDeletions) {
			return nil
		}
		document.pendingObjectDeletions = remaining
		if err := s.saveDocumentLocked(ownerID, document); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

func (s *MyAssetService) retryPendingObjectDeletionsForRequest(ctx context.Context, ownerID string, admin bool) error {
	return s.retryPendingObjectDeletionsWithBudget(ctx, ownerID, admin, "", nil)
}

func (s *MyAssetService) retryPendingObjectDeletionsWithBudget(ctx context.Context, ownerID string, admin bool, preferredObjectID string, provider *StorageObjectProviderInput) error {
	if ctx == nil {
		ctx = context.Background()
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), myAssetRequestCleanupTimeout)
	defer cancel()
	return s.retryPendingObjectDeletions(cleanupCtx, ownerID, admin, myAssetRequestCleanupBatchSize, preferredObjectID, provider)
}

func (s *MyAssetService) retryPendingObjectDeletions(ctx context.Context, ownerID string, admin bool, limit int, preferredObjectID string, provider *StorageObjectProviderInput) error {
	if ctx == nil {
		ctx = context.Background()
	}

	// Keep deletion markers durable while provider I/O runs. This prevents a
	// concurrent media upsert from claiming an object selected for deletion.
	s.mu.Lock()
	var candidates []string
	snapshotReady := false
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, err := s.loadDocumentLocked(ownerID)
		if err != nil {
			s.mu.Unlock()
			return err
		}
		if len(document.pendingObjectDeletions) == 0 {
			s.mu.Unlock()
			return nil
		}
		candidates = make([]string, 0, len(document.pendingObjectDeletions))
		for _, objectID := range document.pendingObjectDeletions {
			if !myAssetDocumentReferencesObject(document, objectID) {
				candidates = append(candidates, objectID)
			}
		}
		if len(candidates) == len(document.pendingObjectDeletions) {
			snapshotReady = true
			break
		}
		document.pendingObjectDeletions = candidates
		if err := s.saveDocumentLocked(ownerID, document); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			s.mu.Unlock()
			return fmt.Errorf("save asset object cleanup: %w", err)
		}
		snapshotReady = true
		break
	}
	s.mu.Unlock()
	if !snapshotReady {
		return storage.ErrConcurrentRowUpdate
	}
	if len(candidates) == 0 {
		return nil
	}
	if s.objects == nil {
		return errors.New("asset object storage is required")
	}
	selected := candidates
	preferredObjectID = strings.TrimSpace(preferredObjectID)
	if preferredObjectID != "" {
		selected = nil
		for _, objectID := range candidates {
			if objectID == preferredObjectID {
				selected = []string{objectID}
				break
			}
		}
	} else if limit > 0 && len(selected) > limit {
		selected = selected[:limit]
	}
	if len(selected) == 0 {
		return nil
	}

	deleted := make(map[string]struct{}, len(selected))
	attempted := make(map[string]struct{}, len(selected))
	deleteErrors := make([]error, 0)
	for _, objectID := range selected {
		attempted[objectID] = struct{}{}
		if err := ctx.Err(); err != nil {
			deleteErrors = append(deleteErrors, err)
			continue
		}
		if s.deletionCoordinator != nil {
			if err := s.deletionCoordinator.ReserveStorageObjectDeletion(ownerID, objectID); err != nil {
				deleteErrors = append(deleteErrors, fmt.Errorf("reserve asset storage object deletion %q: %w", objectID, err))
				continue
			}
		}
		deleteProvider := (*StorageObjectProviderInput)(nil)
		if objectID == preferredObjectID {
			deleteProvider = provider
		}
		if err := s.objects.Delete(ctx, ownerID, admin, objectID, deleteProvider); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf("delete asset storage object %q: %w", objectID, err))
			continue
		}
		if s.deletionCoordinator != nil {
			if err := s.deletionCoordinator.CompleteStorageObjectDeletion(ownerID, objectID); err != nil {
				deleteErrors = append(deleteErrors, fmt.Errorf("complete asset storage object deletion %q: %w", objectID, err))
				continue
			}
		}
		deleted[objectID] = struct{}{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, err := s.loadDocumentLocked(ownerID)
		if err != nil {
			return errors.Join(errors.Join(deleteErrors...), err)
		}
		remaining := make([]string, 0, len(document.pendingObjectDeletions))
		deferred := make([]string, 0, len(attempted))
		for _, objectID := range document.pendingObjectDeletions {
			_, deletionCompleted := deleted[objectID]
			if myAssetDocumentReferencesObject(document, objectID) || deletionCompleted {
				continue
			}
			if _, deletionAttempted := attempted[objectID]; deletionAttempted {
				deferred = append(deferred, objectID)
				continue
			}
			remaining = append(remaining, objectID)
		}
		remaining = append(remaining, deferred...)
		if slices.Equal(remaining, document.pendingObjectDeletions) {
			return errors.Join(deleteErrors...)
		}
		document.pendingObjectDeletions = remaining
		if err := s.saveDocumentLocked(ownerID, document); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			return errors.Join(errors.Join(deleteErrors...), fmt.Errorf("save asset object cleanup: %w", err))
		}
		return errors.Join(deleteErrors...)
	}
	return errors.Join(errors.Join(deleteErrors...), storage.ErrConcurrentRowUpdate)
}

func (s *MyAssetService) validateMediaStorageObject(ownerID string, item MyAsset, document myAssetDocument) error {
	if item.Kind == "text" || !strings.HasPrefix(item.StorageKey, "server:") {
		return nil
	}
	objectID := storageObjectIDFromKey(item.StorageKey)
	if objectID == "" {
		return errors.New("asset storage object id is required")
	}
	for _, pendingID := range document.pendingObjectDeletions {
		if pendingID == objectID {
			return fmt.Errorf("storage object %q is pending deletion", objectID)
		}
	}
	if s.objects == nil {
		return errors.New("asset object storage is required")
	}
	object, err := s.objects.InfoForIdentity(ownerID, false, objectID)
	if err != nil {
		return fmt.Errorf("load asset storage object %q: %w", objectID, err)
	}
	if strings.TrimSpace(object.CreatedBy) != ownerID {
		return fmt.Errorf("storage object %q does not belong to the asset owner", objectID)
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(object.MIMEType)), item.Kind+"/") {
		return fmt.Errorf("storage object %q MIME type %q is incompatible with asset kind %q", objectID, object.MIMEType, item.Kind)
	}
	return nil
}

func myAssetDocumentReferencesObject(document myAssetDocument, objectID string) bool {
	objectID = strings.TrimSpace(objectID)
	for _, item := range document.items {
		if storageObjectIDFromKey(item.StorageKey) == objectID {
			return true
		}
	}
	return false
}

func appendMyAssetObjectDeletionIDs(current []string, ids ...string) []string {
	result := make([]string, 0, len(current)+len(ids))
	seen := make(map[string]struct{}, cap(result))
	for _, id := range append(append([]string(nil), current...), ids...) {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func storageObjectIDFromKey(key string) string {
	const prefix = "server:"
	if !strings.HasPrefix(key, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(key, prefix))
}

func (s *MyAssetService) loadLocked(ownerID string) ([]MyAsset, error) {
	document, err := s.loadDocumentLocked(ownerID)
	return document.items, err
}

func (s *MyAssetService) loadDocumentLocked(ownerID string) (myAssetDocument, error) {
	raw, err := loadStoredJSON(s.store, myAssetDocumentName(ownerID))
	if err != nil {
		return myAssetDocument{}, err
	}
	value := util.StringMap(raw)
	return myAssetDocument{
		ownerID:                strings.TrimSpace(util.Clean(value[myAssetDocumentOwnerIDField])),
		items:                  decodeMyAssets(raw),
		pendingObjectDeletions: appendMyAssetObjectDeletionIDs(nil, util.AsStringSlice(value[myAssetPendingObjectDeletionsField])...),
		generation:             int64(util.ToInt(value[myAssetDocumentGenerationField], 0)),
	}, nil
}

func (s *MyAssetService) saveDocumentLocked(ownerID string, document myAssetDocument) error {
	document.ownerID = strings.TrimSpace(ownerID)
	document.generation++
	if document.generation <= 0 {
		document.generation = 1
	}
	value := map[string]any{"items": document.items, myAssetDocumentGenerationField: document.generation, myAssetDocumentOwnerIDField: document.ownerID}
	if len(document.pendingObjectDeletions) > 0 {
		value[myAssetPendingObjectDeletionsField] = document.pendingObjectDeletions
	}
	return saveStoredJSON(s.store, myAssetDocumentName(ownerID), value)
}

func (s *MyAssetService) listAssetDocumentsLocked() (map[string]any, bool) {
	store, ok := s.store.(storage.JSONDocumentPrefixBackend)
	if !ok {
		return nil, false
	}
	documents, err := store.ListJSONDocuments(myAssetDocumentDir + "/")
	if err != nil {
		return nil, false
	}
	return documents, true
}

func decodeMyAssets(raw any) []MyAsset {
	items := make([]MyAsset, 0)
	for _, candidate := range util.AsMapSlice(util.StringMap(raw)["items"]) {
		item, err := normalizeMyAsset(MyAsset{
			ID: util.Clean(candidate["id"]), Kind: util.Clean(candidate["kind"]), Title: util.Clean(candidate["title"]),
			CoverURL: util.Clean(candidate["coverUrl"]), URL: util.Clean(candidate["url"]), StorageKey: util.Clean(candidate["storageKey"]), Content: util.Clean(candidate["content"]),
			MIMEType: util.Clean(candidate["mimeType"]), Tags: cleanMyAssetStrings(candidate["tags"], 24), Visibility: util.Clean(candidate["visibility"]), Source: util.Clean(candidate["source"]), Note: util.Clean(candidate["note"]),
			Bytes: int64(util.ToInt(candidate["bytes"], 0)), Width: util.ToInt(candidate["width"], 0), Height: util.ToInt(candidate["height"], 0), DurationMs: int64(util.ToInt(candidate["durationMs"], 0)),
			CreatedAt: util.Clean(candidate["createdAt"]), UpdatedAt: util.Clean(candidate["updatedAt"]), Metadata: util.StringMap(candidate["metadata"]),
		})
		if err == nil {
			items = append(items, item)
		}
	}
	sortMyAssets(items)
	return items
}

func normalizeMyAsset(item MyAsset) (MyAsset, error) {
	item.ID = strings.TrimSpace(item.ID)
	item.Kind = strings.TrimSpace(item.Kind)
	item.Title = strings.TrimSpace(item.Title)
	item.CoverURL = strings.TrimSpace(item.CoverURL)
	item.URL = strings.TrimSpace(item.URL)
	item.StorageKey = strings.TrimSpace(item.StorageKey)
	item.Content = strings.TrimSpace(item.Content)
	item.MIMEType = strings.TrimSpace(item.MIMEType)
	item.Visibility = strings.ToLower(strings.TrimSpace(item.Visibility))
	item.Source = strings.TrimSpace(item.Source)
	item.Note = strings.TrimSpace(item.Note)
	item.CreatedAt = strings.TrimSpace(item.CreatedAt)
	item.UpdatedAt = strings.TrimSpace(item.UpdatedAt)
	if item.ID == "" || item.Title == "" {
		return MyAsset{}, fmt.Errorf("asset id and title are required")
	}
	if item.Kind != "text" && item.Kind != "image" && item.Kind != "video" && item.Kind != "audio" {
		return MyAsset{}, fmt.Errorf("asset kind %q is invalid", item.Kind)
	}
	if item.Visibility == "" {
		item.Visibility = MyAssetPrivate
	}
	if item.Visibility != MyAssetPrivate && item.Visibility != MyAssetPublic {
		return MyAsset{}, fmt.Errorf("asset visibility %q is invalid", item.Visibility)
	}
	if item.Kind == "text" && item.Content == "" {
		return MyAsset{}, fmt.Errorf("text asset content is required")
	}
	if item.Kind != "text" && item.URL == "" {
		return MyAsset{}, fmt.Errorf("media asset url is required")
	}
	if strings.HasPrefix(strings.ToLower(item.URL), "blob:") || strings.HasPrefix(strings.ToLower(item.CoverURL), "blob:") {
		return MyAsset{}, fmt.Errorf("blob URLs cannot be persisted; upload the file first")
	}
	if item.Bytes < 0 || item.Width < 0 || item.Height < 0 || item.DurationMs < 0 {
		return MyAsset{}, fmt.Errorf("asset media metadata cannot be negative")
	}
	item.Tags = cleanMyAssetStrings(item.Tags, 24)
	if item.CreatedAt == "" {
		item.CreatedAt = util.NowISO()
	}
	if item.UpdatedAt == "" {
		item.UpdatedAt = item.CreatedAt
	}
	return item, nil
}

func cleanMyAssetStrings(value any, limit int) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0)
	for _, raw := range util.AsStringSlice(value) {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		result = append(result, item)
		if len(result) >= limit {
			break
		}
	}
	return result
}

func sortMyAssets(items []MyAsset) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
}

func myAssetDocumentName(ownerID string) string {
	return myAssetDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}
