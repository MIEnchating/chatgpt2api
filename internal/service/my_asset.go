package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	myAssetDocumentDir  = "my_assets"
	maxMyAssetItems     = 2000
	myAssetSaveAttempts = 8
	MyAssetPrivate      = "private"
	MyAssetPublic       = "public"
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
	mu      sync.Mutex
	store   storage.JSONDocumentBackend
	objects MyAssetObjectStorage
}

type MyAssetObjectStorage interface {
	Upload(context.Context, string, bool, string, string, []byte, *StorageObjectProviderInput) (UploadedStorageObject, error)
	Delete(context.Context, string, bool, string, *StorageObjectProviderInput) error
}

func NewMyAssetService(backend storage.Backend, objects MyAssetObjectStorage) *MyAssetService {
	return &MyAssetService{store: jsonDocumentStoreFromBackend(backend), objects: objects}
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

func (s *MyAssetService) Replace(ctx context.Context, ownerID string, admin bool, input []MyAsset) ([]MyAsset, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	if len(input) > maxMyAssetItems {
		return nil, fmt.Errorf("assets cannot contain more than %d items", maxMyAssetItems)
	}
	items := make([]MyAsset, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, candidate := range input {
		candidate.OwnerID = ""
		candidate.OwnerName = ""
		candidate.Owned = false
		item, err := normalizeMyAsset(candidate)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[item.ID]; exists {
			return nil, fmt.Errorf("asset id %q is duplicated", item.ID)
		}
		seen[item.ID] = struct{}{}
		items = append(items, item)
	}
	sortMyAssets(items)

	s.mu.Lock()
	previous, err := s.loadLocked(ownerID)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	previousByID := make(map[string]MyAsset, len(previous))
	staleTextKeys := make(map[string]struct{})
	for _, item := range previous {
		previousByID[item.ID] = item
		if item.Kind == "text" && item.StorageKey != "" {
			staleTextKeys[item.StorageKey] = struct{}{}
		}
	}
	createdObjectIDs := make([]string, 0)
	for index := range items {
		item := &items[index]
		if item.Kind != "text" {
			continue
		}
		previousItem, exists := previousByID[item.ID]
		if exists && previousItem.Kind == "text" && previousItem.Content == item.Content && previousItem.StorageKey != "" {
			item.StorageKey = previousItem.StorageKey
			item.URL = previousItem.URL
			item.MIMEType = previousItem.MIMEType
			item.Bytes = previousItem.Bytes
			delete(staleTextKeys, item.StorageKey)
			continue
		}
		if s.objects == nil {
			s.mu.Unlock()
			return nil, fmt.Errorf("asset object storage is required")
		}
		uploaded, uploadErr := s.objects.Upload(ctx, ownerID, admin, item.ID+".txt", "text/plain; charset=utf-8", []byte(item.Content), nil)
		if uploadErr != nil {
			s.mu.Unlock()
			s.deleteTextObjects(ctx, ownerID, admin, createdObjectIDs)
			return nil, fmt.Errorf("store text asset %q: %w", item.Title, uploadErr)
		}
		item.StorageKey = uploaded.StorageKey
		item.URL = uploaded.URL
		item.MIMEType = uploaded.MIMEType
		item.Bytes = uploaded.Bytes
		createdObjectIDs = append(createdObjectIDs, uploaded.ID)
		delete(staleTextKeys, item.StorageKey)
	}
	if err := saveStoredJSON(s.store, myAssetDocumentName(ownerID), map[string]any{"items": items}); err != nil {
		s.mu.Unlock()
		s.deleteTextObjects(ctx, ownerID, admin, createdObjectIDs)
		return nil, err
	}
	s.mu.Unlock()
	if s.objects != nil {
		cleanupCtx := context.WithoutCancel(ctx)
		for key := range staleTextKeys {
			if id := storageObjectIDFromKey(key); id != "" {
				_ = s.objects.Delete(cleanupCtx, ownerID, admin, id, nil)
			}
		}
	}
	return append([]MyAsset(nil), items...), nil
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

	s.mu.Lock()
	var staged *UploadedStorageObject
	var saved MyAsset
	var staleTextKey string
	var lastErr error
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		items, loadErr := s.loadLocked(ownerID)
		if loadErr != nil {
			lastErr = loadErr
			break
		}
		matched := myAssetIndex(items, item)
		candidate := item
		var previous MyAsset
		if matched >= 0 {
			previous = items[matched]
			if previous.CreatedAt != "" {
				candidate.CreatedAt = previous.CreatedAt
			}
		} else if len(items) >= maxMyAssetItems {
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
				}
				candidate.StorageKey = staged.StorageKey
				candidate.URL = staged.URL
				candidate.MIMEType = staged.MIMEType
				candidate.Bytes = staged.Bytes
			}
		}

		if matched >= 0 {
			items[matched] = candidate
		} else {
			items = append(items, candidate)
		}
		sortMyAssets(items)
		if saveErr := saveStoredJSON(s.store, myAssetDocumentName(ownerID), map[string]any{"items": items}); saveErr != nil {
			lastErr = saveErr
			if errors.Is(saveErr, storage.ErrConcurrentRowUpdate) && attempt+1 < myAssetSaveAttempts {
				continue
			}
			break
		}
		saved = candidate
		if previous.Kind == "text" && previous.StorageKey != "" && previous.StorageKey != candidate.StorageKey {
			staleTextKey = previous.StorageKey
		}
		lastErr = nil
		break
	}
	s.mu.Unlock()

	if lastErr != nil {
		if staged != nil {
			s.deleteTextObjects(ctx, ownerID, admin, []string{staged.ID})
		}
		return MyAsset{}, lastErr
	}
	if staged != nil && saved.StorageKey != staged.StorageKey {
		s.deleteTextObjects(ctx, ownerID, admin, []string{staged.ID})
	}
	if id := storageObjectIDFromKey(staleTextKey); id != "" {
		s.deleteTextObjects(ctx, ownerID, admin, []string{id})
	}
	return saved, nil
}

func (s *MyAssetService) EnsureTextStorage(ctx context.Context, ownerID string, admin bool) ([]MyAsset, error) {
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
	staleTextKey := ""
	var lastErr error
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		items, loadErr := s.loadLocked(ownerID)
		if loadErr != nil {
			lastErr = loadErr
			break
		}
		index := -1
		for itemIndex := range items {
			if items[itemIndex].ID == id {
				index = itemIndex
				break
			}
		}
		if index < 0 {
			lastErr = nil
			break
		}
		removedOnce = true
		if items[index].Kind == "text" {
			staleTextKey = items[index].StorageKey
		}
		items = append(items[:index], items[index+1:]...)
		if saveErr := saveStoredJSON(s.store, myAssetDocumentName(ownerID), map[string]any{"items": items}); saveErr != nil {
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
	if removedOnce {
		if objectID := storageObjectIDFromKey(staleTextKey); objectID != "" {
			s.deleteTextObjects(ctx, ownerID, admin, []string{objectID})
		}
	}
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

func (s *MyAssetService) deleteTextObjects(ctx context.Context, ownerID string, admin bool, ids []string) {
	if s.objects == nil {
		return
	}
	cleanupCtx := context.WithoutCancel(ctx)
	for _, id := range ids {
		if id != "" {
			_ = s.objects.Delete(cleanupCtx, ownerID, admin, id, nil)
		}
	}
}

func storageObjectIDFromKey(key string) string {
	const prefix = "server:"
	if !strings.HasPrefix(key, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(key, prefix))
}

func (s *MyAssetService) loadLocked(ownerID string) ([]MyAsset, error) {
	raw, err := loadStoredJSON(s.store, myAssetDocumentName(ownerID))
	if err != nil {
		return nil, err
	}
	return decodeMyAssets(raw), nil
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
