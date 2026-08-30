package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	myAssetDocumentDir = "my_assets"
	maxMyAssetItems    = 2000
	MyAssetPrivate     = "private"
	MyAssetPublic      = "public"
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

// UpsertMedia atomically adds generated media to a user's material library.
// The full-list Replace API is kept for manual library editing, while this
// method avoids lost updates when multiple generation tasks finish together.
func (s *MyAssetService) UpsertMedia(ownerID string, input MyAsset) ([]MyAsset, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return nil, fmt.Errorf("owner_id is required")
	}
	input.OwnerID = ""
	input.OwnerName = ""
	input.Owned = false
	item, err := normalizeMyAsset(input)
	if err != nil {
		return nil, err
	}
	if item.Kind == "text" {
		return nil, fmt.Errorf("generated asset must be media")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked(ownerID)
	if err != nil {
		return nil, err
	}
	matched := -1
	for index, existing := range items {
		if existing.ID == item.ID || item.StorageKey != "" && existing.StorageKey == item.StorageKey {
			matched = index
			break
		}
	}
	if matched >= 0 {
		if items[matched].CreatedAt != "" {
			item.CreatedAt = items[matched].CreatedAt
		}
		items[matched] = item
	} else {
		if len(items) >= maxMyAssetItems {
			return nil, fmt.Errorf("assets cannot contain more than %d items", maxMyAssetItems)
		}
		items = append(items, item)
	}
	sortMyAssets(items)
	if err := saveStoredJSON(s.store, myAssetDocumentName(ownerID), map[string]any{"items": items}); err != nil {
		return nil, err
	}
	return append([]MyAsset(nil), items...), nil
}

func (s *MyAssetService) EnsureTextStorage(ctx context.Context, ownerID string, admin bool) ([]MyAsset, error) {
	items, err := s.List(ownerID)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Kind == "text" && item.StorageKey == "" {
			return s.Replace(ctx, ownerID, admin, items)
		}
	}
	return items, nil
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
