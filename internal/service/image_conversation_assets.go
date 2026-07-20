package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/HugoSmits86/nativewebp"
)

const (
	ImageConversationAssetURLPrefix        = "/conversation-assets/"
	ImageConversationAssetMaxBytes         = 40 << 20
	ImageConversationAssetsMaxDecodedBytes = 80 << 20
	ImageConversationAssetsMaxDataURLs     = 16
	ImageConversationAssetOrphanGrace      = time.Hour
	imageConversationAssetOwnerMarker      = ".owner"
)

var (
	ErrInvalidImageConversationAsset               = errors.New("invalid conversation image asset")
	ErrImageConversationAssetTooLarge              = errors.New("conversation image asset is too large")
	ErrImageConversationAssetNotFound              = errors.New("conversation image asset not found")
	ErrImageConversationAssetReferencesUnavailable = errors.New("conversation image asset references are unavailable")
	ErrImageConversationAssetStorageLimit          = errors.New("conversation image asset storage limit exceeded")
)

type ImageConversationAsset struct {
	AssetPath string `json:"assetPath"`
	URL       string `json:"url"`
	DataURL   string `json:"dataUrl"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Size      int64  `json:"size"`
}

type ImageConversationAssetAccess struct {
	AssetPath   string
	Path        string
	Info        os.FileInfo
	OwnerHash   string
	ContentHash string
	ContentType string
}

type ImageConversationAssetService struct {
	root       string
	processing chan struct{}
	mu         imageConversationAssetMutex
	limitBytes func() int64
	otherBytes func() int64
}

type imageConversationAssetMutex struct {
	once  sync.Once
	token chan struct{}
}

func (m *imageConversationAssetMutex) Lock() {
	_ = m.LockContext(context.Background())
}

func (m *imageConversationAssetMutex) LockContext(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	m.once.Do(func() {
		m.token = make(chan struct{}, 1)
		m.token <- struct{}{}
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-m.token:
		if err := ctx.Err(); err != nil {
			m.token <- struct{}{}
			return err
		}
		return nil
	}
}

func (m *imageConversationAssetMutex) Unlock() {
	m.once.Do(func() {
		m.token = make(chan struct{}, 1)
	})
	m.token <- struct{}{}
}

type ValidatedImageConversationAsset struct {
	service     *ImageConversationAssetService
	data        []byte
	contentType string
	extension   string
}

// ImageConversationAssetPreparation holds request-local decoded reference
// bytes. It is intentionally opaque so it cannot be reused across owners or
// service instances.
type ImageConversationAssetPreparation struct {
	service      *ImageConversationAssetService
	ownerID      string
	embedded     map[string]*ValidatedImageConversationAsset
	decodedBytes int64
	storeMu      sync.Mutex
	stored       map[string]ImageConversationAsset
	storeDone    bool
	storeErr     error
}

func (s *ImageConversationAssetService) SetStorageBudget(limitBytes, otherBytes func() int64) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.limitBytes = limitBytes
	s.otherBytes = otherBytes
	s.mu.Unlock()
}

type ImageConversationAssetGovernance struct {
	TotalBytes      int64 `json:"total_bytes"`
	FileCount       int   `json:"file_count"`
	ReferencedBytes int64 `json:"referenced_bytes"`
	ReferencedCount int   `json:"referenced_count"`
	GraceBytes      int64 `json:"grace_bytes"`
	GraceCount      int   `json:"grace_count"`
	OrphanBytes     int64 `json:"orphan_bytes"`
	OrphanCount     int   `json:"orphan_count"`
	DeletedBytes    int64 `json:"deleted_bytes,omitempty"`
	DeletedCount    int   `json:"deleted_count,omitempty"`
	LimitBytes      int64 `json:"limit_bytes,omitempty"`
	OverLimitBytes  int64 `json:"over_limit_bytes,omitempty"`
}

func NewImageConversationAssetService(root string) *ImageConversationAssetService {
	return &ImageConversationAssetService{
		root:       strings.TrimSpace(root),
		processing: make(chan struct{}, 2),
	}
}

func (s *ImageConversationAssetService) StoreReader(ctx context.Context, ownerID, filename string, reader io.Reader) (ImageConversationAsset, error) {
	validated, err := s.ReadValidatedReader(ctx, reader)
	if err != nil {
		return ImageConversationAsset{}, err
	}
	return s.StoreValidatedContext(ctx, ownerID, filename, validated)
}

// ReadValidatedReader bounds and validates an upload without mutating storage.
// Callers accepting a batch can validate every member before committing any of
// them, so a malformed trailing file cannot leave earlier files orphaned.
func (s *ImageConversationAssetService) ReadValidatedReader(ctx context.Context, reader io.Reader) (*ValidatedImageConversationAsset, error) {
	if reader == nil {
		return nil, ErrInvalidImageConversationAsset
	}
	release, err := s.acquireProcessing(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	data, err := io.ReadAll(io.LimitReader(reader, ImageConversationAssetMaxBytes+1))
	if err != nil {
		return nil, ErrInvalidImageConversationAsset
	}
	if len(data) > ImageConversationAssetMaxBytes {
		return nil, ErrImageConversationAssetTooLarge
	}
	contentType, extension, err := validateImageConversationAsset(data)
	if err != nil {
		return nil, err
	}
	return &ValidatedImageConversationAsset{service: s, data: data, contentType: contentType, extension: extension}, nil
}

func (s *ImageConversationAssetService) Store(ownerID, filename string, data []byte) (ImageConversationAsset, error) {
	contentType, extension, err := validateImageConversationAsset(data)
	if err != nil {
		return ImageConversationAsset{}, err
	}
	return s.StoreValidated(ownerID, filename, &ValidatedImageConversationAsset{
		service: s, data: data, contentType: contentType, extension: extension,
	})
}

func (s *ImageConversationAssetService) StoreValidated(ownerID, filename string, validated *ValidatedImageConversationAsset) (ImageConversationAsset, error) {
	return s.StoreValidatedContext(context.Background(), ownerID, filename, validated)
}

func (s *ImageConversationAssetService) StoreValidatedContext(ctx context.Context, ownerID, filename string, validated *ValidatedImageConversationAsset) (ImageConversationAsset, error) {
	items, err := s.StoreValidatedBatchContext(ctx, ownerID, []string{filename}, []*ValidatedImageConversationAsset{validated})
	if err != nil {
		return ImageConversationAsset{}, err
	}
	if len(items) != 1 {
		return ImageConversationAsset{}, ErrInvalidImageConversationAsset
	}
	return items[0], nil
}

func (s *ImageConversationAssetService) StoreValidatedBatch(ownerID string, filenames []string, validated []*ValidatedImageConversationAsset) ([]ImageConversationAsset, error) {
	return s.StoreValidatedBatchContext(context.Background(), ownerID, filenames, validated)
}

func (s *ImageConversationAssetService) StoreValidatedBatchContext(ctx context.Context, ownerID string, filenames []string, validated []*ValidatedImageConversationAsset) ([]ImageConversationAsset, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" || ownerID == "anonymous" || s == nil || s.root == "" || len(validated) == 0 || len(filenames) != len(validated) {
		return nil, ErrInvalidImageConversationAsset
	}
	ownerHash := imageConversationAssetHash([]byte(ownerID))
	root, err := filepath.Abs(s.root)
	if err != nil {
		return nil, err
	}
	type storeCandidate struct {
		data        []byte
		contentHash string
		destination string
		asset       ImageConversationAsset
	}
	candidates := make([]storeCandidate, len(validated))
	for index, item := range validated {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if item == nil || item.service != s || len(item.data) == 0 || item.contentType == "" || item.extension == "" {
			return nil, ErrInvalidImageConversationAsset
		}
		contentHash := imageConversationAssetHash(item.data)
		assetPath := path.Join(ownerHash, contentHash+item.extension)
		destination := filepath.Join(root, filepath.FromSlash(assetPath))
		if !pathInsideRoot(root, destination) {
			return nil, ErrInvalidImageConversationAsset
		}
		assetURL := ImageConversationAssetURLPrefix + assetPath
		candidates[index] = storeCandidate{
			data:        item.data,
			contentHash: contentHash,
			destination: destination,
			asset: ImageConversationAsset{
				AssetPath: assetPath,
				URL:       assetURL,
				DataURL:   assetURL,
				Name:      imageConversationAssetFilename(filenames[index], item.extension),
				Type:      item.contentType,
				Size:      int64(len(item.data)),
			},
		}
	}

	if err := s.mu.LockContext(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	newBytes := int64(0)
	newDestinations := make(map[string]struct{}, len(candidates))
	uniqueCandidates := make([]storeCandidate, 0, len(candidates))
	seenDestinations := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if _, duplicate := seenDestinations[candidate.destination]; duplicate {
			continue
		}
		seenDestinations[candidate.destination] = struct{}{}
		uniqueCandidates = append(uniqueCandidates, candidate)
		_, statErr := os.Lstat(candidate.destination)
		newFile := errors.Is(statErr, os.ErrNotExist)
		if statErr != nil && !newFile {
			return nil, statErr
		}
		if !newFile {
			continue
		}
		newDestinations[candidate.destination] = struct{}{}
		newBytes += int64(len(candidate.data))
	}
	if newBytes > 0 {
		allowed, quotaErr := s.canStoreLockedContext(ctx, newBytes)
		if quotaErr != nil {
			return nil, quotaErr
		}
		if !allowed {
			return nil, ErrImageConversationAssetStorageLimit
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	markerCreated, err := writeImageConversationAssetOwnerMarker(root, ownerHash, ownerID)
	if err != nil {
		return nil, err
	}
	createdDestinations := make([]string, 0, len(newDestinations))
	for _, candidate := range uniqueCandidates {
		if contextErr := ctx.Err(); contextErr != nil {
			err = contextErr
			break
		}
		created, writeErr := writeImageConversationAsset(candidate.destination, candidate.data, candidate.contentHash)
		if created {
			createdDestinations = append(createdDestinations, candidate.destination)
		}
		if writeErr != nil {
			err = writeErr
			break
		}
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		rollbackErr := rollbackImageConversationAssetBatch(root, ownerHash, createdDestinations, markerCreated)
		return nil, errors.Join(err, rollbackErr)
	}
	result := make([]ImageConversationAsset, len(candidates))
	for index, candidate := range candidates {
		result[index] = candidate.asset
	}
	return result, nil
}

func (s *ImageConversationAssetService) canStoreLockedContext(ctx context.Context, size int64) (bool, error) {
	if size < 1 || s.limitBytes == nil {
		return true, nil
	}
	limit := s.limitBytes()
	if limit <= 0 {
		return true, nil
	}
	governance, err := s.governanceLockedContext(ctx, "", nil, time.Time{}, limit)
	if err != nil {
		return false, err
	}
	usage := governance.TotalBytes
	if s.otherBytes != nil {
		if other := s.otherBytes(); other > 0 {
			usage += other
		}
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return usage <= limit-size, nil
}

func (s *ImageConversationAssetService) Governance() ImageConversationAssetGovernance {
	if s == nil {
		return ImageConversationAssetGovernance{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.governanceLocked("", nil, time.Time{}, 0)
}

func (s *ImageConversationAssetService) Owners() []string {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	root, err := filepath.Abs(s.root)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	owners := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !isLowerHexDigest(entry.Name()) {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(root, entry.Name(), imageConversationAssetOwnerMarker))
		if readErr != nil || len(data) == 0 || len(data) > 4096 {
			continue
		}
		ownerID := strings.TrimSpace(string(data))
		if ownerID != "" && imageConversationAssetHash([]byte(ownerID)) == entry.Name() {
			owners = append(owners, ownerID)
		}
	}
	return owners
}

func (s *ImageConversationAssetService) CleanupOrphans(ownerID string, referenced map[string]struct{}, grace time.Duration, limitBytes int64) (ImageConversationAssetGovernance, error) {
	return s.CleanupOrphansContext(context.Background(), ownerID, referenced, grace, limitBytes)
}

func (s *ImageConversationAssetService) CleanupOrphansContext(ctx context.Context, ownerID string, referenced map[string]struct{}, grace time.Duration, limitBytes int64) (ImageConversationAssetGovernance, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return ImageConversationAssetGovernance{}, err
	}
	ownerID = strings.TrimSpace(ownerID)
	if s == nil || ownerID == "" || referenced == nil {
		return ImageConversationAssetGovernance{}, ErrImageConversationAssetReferencesUnavailable
	}
	if grace < time.Minute {
		grace = time.Minute
	}
	ownerHash := imageConversationAssetHash([]byte(ownerID))
	canonicalReferences := make(map[string]struct{}, len(referenced))
	for value := range referenced {
		if err := ctx.Err(); err != nil {
			return ImageConversationAssetGovernance{}, err
		}
		assetPath, assetOwnerHash, _, _, err := parseImageConversationAssetPath(value)
		if err == nil && assetOwnerHash == ownerHash {
			canonicalReferences[assetPath] = struct{}{}
		}
	}
	if err := s.mu.LockContext(ctx); err != nil {
		return ImageConversationAssetGovernance{}, err
	}
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-grace)
	result, err := s.governanceLockedContext(ctx, ownerHash, canonicalReferences, cutoff, limitBytes)
	if err != nil {
		return result, err
	}
	root, err := filepath.Abs(s.root)
	if err != nil {
		return result, err
	}
	ownerRoot := filepath.Join(root, ownerHash)
	if !pathInsideRoot(root, ownerRoot) {
		return result, ErrInvalidImageConversationAsset
	}
	_ = filepath.WalkDir(ownerRoot, func(filePath string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil || entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, filePath)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == path.Join(ownerHash, imageConversationAssetOwnerMarker) {
			return nil
		}
		if _, ok := canonicalReferences[rel]; ok {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.ModTime().Before(cutoff) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if removeErr := os.Remove(filePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return nil
		}
		result.DeletedCount++
		result.DeletedBytes += info.Size()
		return nil
	})
	if err := ctx.Err(); err != nil {
		return result, err
	}
	remaining, err := s.governanceLockedContext(ctx, ownerHash, canonicalReferences, cutoff, limitBytes)
	if err != nil {
		return result, err
	}
	remaining.DeletedBytes = result.DeletedBytes
	remaining.DeletedCount = result.DeletedCount
	if err := ctx.Err(); err != nil {
		return remaining, err
	}
	if remaining.FileCount == 0 {
		empty, emptyErr := imageConversationAssetOwnerDirectoryEmptyContext(ctx, ownerRoot)
		if emptyErr != nil {
			return remaining, emptyErr
		}
		if empty {
			_ = os.Remove(filepath.Join(ownerRoot, imageConversationAssetOwnerMarker))
			if err := ctx.Err(); err != nil {
				return remaining, err
			}
			_ = os.Remove(ownerRoot)
		}
	}
	return remaining, nil
}

func imageConversationAssetOwnerDirectoryEmpty(ownerRoot string) bool {
	empty, _ := imageConversationAssetOwnerDirectoryEmptyContext(context.Background(), ownerRoot)
	return empty
}

func imageConversationAssetOwnerDirectoryEmptyContext(ctx context.Context, ownerRoot string) (bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	entries, err := os.ReadDir(ownerRoot)
	if err != nil {
		return errors.Is(err, os.ErrNotExist), nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Name() != imageConversationAssetOwnerMarker {
			return false, nil
		}
	}
	return true, nil
}

func (s *ImageConversationAssetService) governanceLocked(ownerHash string, referenced map[string]struct{}, cutoff time.Time, limitBytes int64) ImageConversationAssetGovernance {
	result, _ := s.governanceLockedContext(context.Background(), ownerHash, referenced, cutoff, limitBytes)
	return result
}

func (s *ImageConversationAssetService) governanceLockedContext(ctx context.Context, ownerHash string, referenced map[string]struct{}, cutoff time.Time, limitBytes int64) (ImageConversationAssetGovernance, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	result := ImageConversationAssetGovernance{LimitBytes: limitBytes}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	root, err := filepath.Abs(s.root)
	if err != nil {
		return result, err
	}
	scanRoot := root
	if ownerHash != "" {
		scanRoot = filepath.Join(root, ownerHash)
	}
	_ = filepath.WalkDir(scanRoot, func(filePath string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil || entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, filePath)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if _, _, _, _, parseErr := parseImageConversationAssetPath(rel); parseErr != nil {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		result.FileCount++
		result.TotalBytes += info.Size()
		if referenced == nil {
			return nil
		}
		if _, ok := referenced[rel]; ok {
			result.ReferencedCount++
			result.ReferencedBytes += info.Size()
		} else if cutoff.IsZero() || !info.ModTime().Before(cutoff) {
			result.GraceCount++
			result.GraceBytes += info.Size()
		} else {
			result.OrphanCount++
			result.OrphanBytes += info.Size()
		}
		return nil
	})
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if limitBytes > 0 && result.TotalBytes > limitBytes {
		result.OverLimitBytes = result.TotalBytes - limitBytes
	}
	return result, nil
}

func (s *ImageConversationAssetService) AssetizeReference(ctx context.Context, ownerID string, item map[string]any) (map[string]any, bool, error) {
	return s.assetizeReference(ctx, ownerID, item, true, nil)
}

func (s *ImageConversationAssetService) assetizeReference(ctx context.Context, ownerID string, item map[string]any, touchManaged bool, preparation *ImageConversationAssetPreparation) (map[string]any, bool, error) {
	if item == nil {
		return nil, false, ErrInvalidImageConversationAsset
	}
	dataURL := strings.TrimSpace(toString(item["dataUrl"]))
	if dataURL == "" {
		dataURL = strings.TrimSpace(toString(item["data_url"]))
	}
	if strings.HasPrefix(strings.ToLower(dataURL), "data:") {
		var asset ImageConversationAsset
		if preparation != nil {
			stored, ok := preparedStoredImageConversationAsset(s, ownerID, preparation, dataURL)
			if !ok {
				return nil, false, ErrInvalidImageConversationAsset
			}
			stored.Name = imageConversationAssetFilename(toString(item["name"]), filepath.Ext(stored.AssetPath))
			asset = stored
		} else {
			release, err := s.acquireProcessing(ctx)
			if err != nil {
				return nil, false, err
			}
			defer release()
			declaredType, decoded, err := parseImageConversationAssetDataURL(dataURL)
			if err != nil {
				return nil, false, err
			}
			actualType, extension, err := validateImageConversationAsset(decoded)
			if err != nil {
				return nil, false, err
			}
			if declaredType != actualType {
				return nil, false, fmt.Errorf("%w: data URL media type does not match file content", ErrInvalidImageConversationAsset)
			}
			asset, err = s.StoreValidatedContext(ctx, ownerID, toString(item["name"]), &ValidatedImageConversationAsset{
				service: s, data: decoded, contentType: actualType, extension: extension,
			})
			if err != nil {
				return nil, false, err
			}
		}
		next := cloneImageConversationAssetMap(item)
		delete(next, "dataUrl")
		delete(next, "data_url")
		applyImageConversationAsset(next, asset)
		return next, true, nil
	}

	value := firstImageConversationAssetValue(item)
	if value == "" {
		return cloneImageConversationAssetMap(item), false, nil
	}
	access, err := s.Access(value, ownerID, false)
	if err != nil {
		return nil, false, err
	}
	if touchManaged {
		if err := s.touch(access); err != nil {
			return nil, false, ErrImageConversationAssetNotFound
		}
	}
	asset := ImageConversationAsset{
		AssetPath: access.AssetPath,
		URL:       ImageConversationAssetURLPrefix + access.AssetPath,
		DataURL:   ImageConversationAssetURLPrefix + access.AssetPath,
		Name:      imageConversationAssetFilename(toString(item["name"]), filepath.Ext(access.AssetPath)),
		Type:      access.ContentType,
		Size:      access.Info.Size(),
	}
	next := cloneImageConversationAssetMap(item)
	delete(next, "data_url")
	applyImageConversationAsset(next, asset)
	changed := toString(item["assetPath"]) != asset.AssetPath ||
		toString(item["url"]) != asset.URL ||
		toString(item["dataUrl"]) != asset.DataURL ||
		toString(item["type"]) != asset.Type ||
		int64Value(item["size"]) != asset.Size
	return next, changed, nil
}

func (s *ImageConversationAssetService) touch(access ImageConversationAssetAccess) error {
	if s == nil || access.Path == "" {
		return ErrImageConversationAssetNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Lstat(access.Path)
	if err != nil || !info.Mode().IsRegular() {
		return ErrImageConversationAssetNotFound
	}
	now := time.Now()
	return os.Chtimes(access.Path, now, now)
}

func (s *ImageConversationAssetService) AssetizeConversation(ctx context.Context, ownerID string, item map[string]any) (map[string]any, map[string]struct{}, bool, error) {
	return s.assetizeConversation(ctx, ownerID, item, true, nil)
}

// PrepareConversations checks a complete batch without touching or creating
// files and retains decoded data URLs for the subsequent commit pass.
func (s *ImageConversationAssetService) PrepareConversations(ctx context.Context, ownerID string, items []map[string]any) (*ImageConversationAssetPreparation, error) {
	ownerID = strings.TrimSpace(ownerID)
	if s == nil || ownerID == "" || ownerID == "anonymous" {
		return nil, ErrInvalidImageConversationAsset
	}
	preparation := &ImageConversationAssetPreparation{
		service:  s,
		ownerID:  ownerID,
		embedded: make(map[string]*ValidatedImageConversationAsset),
	}
	for _, item := range items {
		if item == nil {
			return nil, ErrInvalidImageConversationAsset
		}
		if err := validateImageConversationDataURLBudget(item); err != nil {
			return nil, err
		}
	}
	for _, item := range items {
		turns, _ := imageConversationAssetAnySlice(item["turns"])
		for turnIndex, rawTurn := range turns {
			turn, ok := rawTurn.(map[string]any)
			if !ok {
				continue
			}
			references, _ := imageConversationAssetAnySlice(turn["referenceImages"])
			for referenceIndex, rawReference := range references {
				reference, ok := rawReference.(map[string]any)
				if !ok || !imageConversationReferenceNeedsAssetization(reference) {
					continue
				}
				if err := s.prepareReference(ctx, ownerID, reference, preparation); err != nil {
					return nil, fmt.Errorf("turn %d reference %d: %w", turnIndex+1, referenceIndex+1, err)
				}
			}
		}
	}
	return preparation, nil
}

func (s *ImageConversationAssetService) prepareReference(ctx context.Context, ownerID string, item map[string]any, preparation *ImageConversationAssetPreparation) error {
	dataURL := strings.TrimSpace(toString(item["dataUrl"]))
	if dataURL == "" {
		dataURL = strings.TrimSpace(toString(item["data_url"]))
	}
	if strings.HasPrefix(strings.ToLower(dataURL), "data:") {
		if _, ok := preparation.embedded[dataURL]; ok {
			return nil
		}
		release, err := s.acquireProcessing(ctx)
		if err != nil {
			return err
		}
		defer release()
		declaredType, data, err := parseImageConversationAssetDataURL(dataURL)
		if err != nil {
			return err
		}
		actualType, extension, err := validateImageConversationAsset(data)
		if err != nil {
			return err
		}
		if declaredType != actualType {
			return fmt.Errorf("%w: data URL media type does not match file content", ErrInvalidImageConversationAsset)
		}
		if int64(len(data)) > ImageConversationAssetsMaxDecodedBytes-preparation.decodedBytes {
			return fmt.Errorf("%w: embedded reference images exceed the total decoded size limit", ErrImageConversationAssetTooLarge)
		}
		preparation.decodedBytes += int64(len(data))
		preparation.embedded[dataURL] = &ValidatedImageConversationAsset{service: s, data: data, contentType: actualType, extension: extension}
		return nil
	}
	value := firstImageConversationAssetValue(item)
	if value == "" {
		return nil
	}
	_, err := s.Access(value, ownerID, false)
	return err
}

func (s *ImageConversationAssetService) storePreparedAssets(ctx context.Context, ownerID string, preparation *ImageConversationAssetPreparation) error {
	if preparation == nil || preparation.service != s || preparation.ownerID != strings.TrimSpace(ownerID) {
		return ErrInvalidImageConversationAsset
	}
	preparation.storeMu.Lock()
	defer preparation.storeMu.Unlock()
	if preparation.storeDone {
		return preparation.storeErr
	}
	preparation.storeDone = true
	preparation.stored = make(map[string]ImageConversationAsset, len(preparation.embedded))
	if len(preparation.embedded) == 0 {
		return nil
	}
	keys := make([]string, 0, len(preparation.embedded))
	filenames := make([]string, 0, len(preparation.embedded))
	validated := make([]*ValidatedImageConversationAsset, 0, len(preparation.embedded))
	for dataURL, asset := range preparation.embedded {
		keys = append(keys, dataURL)
		filenames = append(filenames, "reference")
		validated = append(validated, asset)
	}
	stored, err := s.StoreValidatedBatchContext(ctx, ownerID, filenames, validated)
	if err != nil {
		preparation.storeErr = err
		return err
	}
	for index, dataURL := range keys {
		preparation.stored[dataURL] = stored[index]
	}
	return nil
}

func preparedStoredImageConversationAsset(s *ImageConversationAssetService, ownerID string, preparation *ImageConversationAssetPreparation, dataURL string) (ImageConversationAsset, bool) {
	if preparation == nil || preparation.service != s || preparation.ownerID != strings.TrimSpace(ownerID) {
		return ImageConversationAsset{}, false
	}
	asset, ok := preparation.stored[dataURL]
	return asset, ok
}

func (s *ImageConversationAssetService) AssetizePreparedConversation(ctx context.Context, ownerID string, item map[string]any, preparation *ImageConversationAssetPreparation) (map[string]any, map[string]struct{}, bool, error) {
	if preparation == nil || preparation.service != s || preparation.ownerID != strings.TrimSpace(ownerID) {
		return nil, nil, false, ErrInvalidImageConversationAsset
	}
	if err := s.storePreparedAssets(ctx, ownerID, preparation); err != nil {
		return nil, nil, false, err
	}
	return s.assetizeConversation(ctx, ownerID, item, true, preparation)
}

func (s *ImageConversationAssetService) AssetizeStoredConversation(ctx context.Context, ownerID string, item map[string]any) (map[string]any, map[string]struct{}, bool, error) {
	return s.assetizeConversation(ctx, ownerID, item, false, nil)
}

func (s *ImageConversationAssetService) assetizeConversation(ctx context.Context, ownerID string, item map[string]any, touchManaged bool, preparation *ImageConversationAssetPreparation) (map[string]any, map[string]struct{}, bool, error) {
	if item == nil {
		return nil, nil, false, ErrInvalidImageConversationAsset
	}
	if err := validateImageConversationDataURLBudget(item); err != nil {
		return nil, nil, false, err
	}
	next := cloneImageConversationAssetMap(item)
	turns, ok := imageConversationAssetAnySlice(item["turns"])
	if !ok {
		return next, map[string]struct{}{}, false, nil
	}
	nextTurns := make([]any, len(turns))
	referenced := make(map[string]struct{})
	changed := false
	for turnIndex, rawTurn := range turns {
		turn, ok := rawTurn.(map[string]any)
		if !ok {
			nextTurns[turnIndex] = rawTurn
			continue
		}
		nextTurn := cloneImageConversationAssetMap(turn)
		references, hasReferences := imageConversationAssetAnySlice(turn["referenceImages"])
		if !hasReferences {
			nextTurns[turnIndex] = nextTurn
			continue
		}
		nextReferences := make([]any, len(references))
		for referenceIndex, rawReference := range references {
			reference, ok := rawReference.(map[string]any)
			if !ok {
				nextReferences[referenceIndex] = rawReference
				continue
			}
			nextReference := cloneImageConversationAssetMap(reference)
			needsAssetization := imageConversationReferenceNeedsAssetization(reference)
			if !touchManaged && imageConversationReferenceIsCanonical(reference) {
				needsAssetization = false
			}
			if needsAssetization {
				assetized, referenceChanged, err := s.assetizeReference(ctx, ownerID, reference, touchManaged, preparation)
				if err != nil {
					return nil, nil, false, fmt.Errorf("turn %d reference %d: %w", turnIndex+1, referenceIndex+1, err)
				}
				nextReference = assetized
				changed = changed || referenceChanged
			}
			if assetPath, _, _, _, err := parseImageConversationAssetPath(firstImageConversationAssetValue(nextReference)); err == nil {
				referenced[assetPath] = struct{}{}
			}
			nextReferences[referenceIndex] = nextReference
		}
		nextTurn["referenceImages"] = nextReferences
		nextTurns[turnIndex] = nextTurn
	}
	next["turns"] = nextTurns
	return next, referenced, changed, nil
}

func (s *ImageConversationAssetService) ReferencedAssetPaths(item map[string]any) map[string]struct{} {
	result := make(map[string]struct{})
	if item == nil {
		return result
	}
	turns, _ := imageConversationAssetAnySlice(item["turns"])
	for _, rawTurn := range turns {
		turn, _ := rawTurn.(map[string]any)
		references, _ := imageConversationAssetAnySlice(turn["referenceImages"])
		for _, rawReference := range references {
			reference, _ := rawReference.(map[string]any)
			if assetPath, _, _, _, err := parseImageConversationAssetPath(firstImageConversationAssetValue(reference)); err == nil {
				result[assetPath] = struct{}{}
			}
		}
	}
	return result
}

func validateImageConversationDataURLBudget(item map[string]any) error {
	count := 0
	decodedBytes := int64(0)
	turns, _ := imageConversationAssetAnySlice(item["turns"])
	for _, rawTurn := range turns {
		turn, _ := rawTurn.(map[string]any)
		references, _ := imageConversationAssetAnySlice(turn["referenceImages"])
		for _, rawReference := range references {
			reference, _ := rawReference.(map[string]any)
			dataURL := strings.TrimSpace(toString(reference["dataUrl"]))
			if dataURL == "" {
				dataURL = strings.TrimSpace(toString(reference["data_url"]))
			}
			if !strings.HasPrefix(strings.ToLower(dataURL), "data:") {
				continue
			}
			count++
			if count > ImageConversationAssetsMaxDataURLs {
				return fmt.Errorf("%w: too many embedded reference images", ErrInvalidImageConversationAsset)
			}
			size, err := imageConversationAssetDataURLDecodedSize(dataURL)
			if err != nil {
				return err
			}
			if size > ImageConversationAssetMaxBytes {
				return ErrImageConversationAssetTooLarge
			}
			decodedBytes += int64(size)
			if decodedBytes > ImageConversationAssetsMaxDecodedBytes {
				return fmt.Errorf("%w: embedded reference images exceed the total decoded size limit", ErrImageConversationAssetTooLarge)
			}
		}
	}
	return nil
}

func imageConversationAssetDataURLDecodedSize(value string) (int, error) {
	value = strings.TrimSpace(value)
	if len(value) < 5 || !strings.EqualFold(value[:5], "data:") {
		return 0, fmt.Errorf("%w: invalid data URL", ErrInvalidImageConversationAsset)
	}
	header, encoded, ok := strings.Cut(value[5:], ",")
	if !ok || encoded == "" {
		return 0, fmt.Errorf("%w: invalid data URL", ErrInvalidImageConversationAsset)
	}
	parts := strings.Split(header, ";")
	if len(parts) != 2 || normalizeImageConversationAssetContentType(parts[0]) == "" || !strings.EqualFold(strings.TrimSpace(parts[1]), "base64") || len(encoded)%4 != 0 {
		return 0, fmt.Errorf("%w: unsupported data URL", ErrInvalidImageConversationAsset)
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(ImageConversationAssetMaxBytes+1) {
		return ImageConversationAssetMaxBytes + 1, nil
	}
	size := base64.StdEncoding.DecodedLen(len(encoded))
	if strings.HasSuffix(encoded, "=") {
		size--
	}
	if strings.HasSuffix(encoded, "==") {
		size--
	}
	if size < 0 {
		return 0, fmt.Errorf("%w: invalid data URL", ErrInvalidImageConversationAsset)
	}
	return size, nil
}

func imageConversationReferenceNeedsAssetization(item map[string]any) bool {
	if item == nil {
		return false
	}
	dataURL := strings.TrimSpace(toString(item["dataUrl"]))
	if dataURL == "" {
		dataURL = strings.TrimSpace(toString(item["data_url"]))
	}
	if strings.HasPrefix(strings.ToLower(dataURL), "data:") {
		return true
	}
	for _, key := range []string{"assetPath", "asset_path", "dataUrl", "data_url", "url"} {
		value := strings.TrimSpace(toString(item[key]))
		if value == "" {
			continue
		}
		if _, _, _, _, err := parseImageConversationAssetPath(value); err == nil {
			return true
		}
		if key == "assetPath" || key == "asset_path" {
			return true
		}
	}
	return false
}

func imageConversationReferenceIsCanonical(item map[string]any) bool {
	if item == nil {
		return false
	}
	assetPath, _, _, contentType, err := parseImageConversationAssetPath(strings.TrimSpace(toString(item["assetPath"])))
	if err != nil {
		return false
	}
	assetURL := ImageConversationAssetURLPrefix + assetPath
	return strings.TrimSpace(toString(item["dataUrl"])) == assetURL &&
		strings.TrimSpace(toString(item["url"])) == assetURL &&
		normalizeImageConversationAssetContentType(toString(item["type"])) == contentType &&
		int64Value(item["size"]) > 0 &&
		strings.TrimSpace(toString(item["name"])) != ""
}

func imageConversationAssetAnySlice(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		return typed, true
	case []map[string]any:
		items := make([]any, len(typed))
		for index := range typed {
			items[index] = typed[index]
		}
		return items, true
	default:
		return nil, false
	}
}

func (s *ImageConversationAssetService) acquireProcessing(ctx context.Context) (func(), error) {
	if s == nil || s.processing == nil {
		return nil, ErrInvalidImageConversationAsset
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case s.processing <- struct{}{}:
		return func() { <-s.processing }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *ImageConversationAssetService) Access(value, ownerID string, allowAll bool) (ImageConversationAssetAccess, error) {
	if s == nil || strings.TrimSpace(s.root) == "" {
		return ImageConversationAssetAccess{}, ErrImageConversationAssetNotFound
	}
	assetPath, ownerHash, contentHash, contentType, err := parseImageConversationAssetPath(value)
	if err != nil {
		return ImageConversationAssetAccess{}, ErrImageConversationAssetNotFound
	}
	if !allowAll {
		ownerID = strings.TrimSpace(ownerID)
		if ownerID == "" || imageConversationAssetHash([]byte(ownerID)) != ownerHash {
			return ImageConversationAssetAccess{}, ErrImageConversationAssetNotFound
		}
	}
	root, err := filepath.Abs(s.root)
	if err != nil {
		return ImageConversationAssetAccess{}, err
	}
	filePath := filepath.Join(root, filepath.FromSlash(assetPath))
	if !pathInsideRoot(root, filePath) {
		return ImageConversationAssetAccess{}, ErrImageConversationAssetNotFound
	}
	info, err := os.Lstat(filePath)
	if err != nil || !info.Mode().IsRegular() {
		return ImageConversationAssetAccess{}, ErrImageConversationAssetNotFound
	}
	return ImageConversationAssetAccess{
		AssetPath:   assetPath,
		Path:        filePath,
		Info:        info,
		OwnerHash:   ownerHash,
		ContentHash: contentHash,
		ContentType: contentType,
	}, nil
}

func (s *ImageConversationAssetService) Root() string {
	if s == nil {
		return ""
	}
	return s.root
}

func validateImageConversationAsset(data []byte) (string, string, error) {
	if len(data) == 0 {
		return "", "", fmt.Errorf("%w: image file is empty", ErrInvalidImageConversationAsset)
	}
	if len(data) > ImageConversationAssetMaxBytes {
		return "", "", ErrImageConversationAssetTooLarge
	}
	contentType := normalizeImageConversationAssetContentType(http.DetectContentType(data))
	if contentType == "" {
		return "", "", fmt.Errorf("%w: unsupported image format", ErrInvalidImageConversationAsset)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 {
		return "", "", fmt.Errorf("%w: image file is corrupt", ErrInvalidImageConversationAsset)
	}
	if normalizeImageConversationAssetFormat(format) != contentType {
		return "", "", fmt.Errorf("%w: image type does not match file content", ErrInvalidImageConversationAsset)
	}
	switch contentType {
	case "image/png":
		return contentType, ".png", nil
	case "image/jpeg":
		return contentType, ".jpg", nil
	case "image/webp":
		return contentType, ".webp", nil
	default:
		return "", "", fmt.Errorf("%w: unsupported image format", ErrInvalidImageConversationAsset)
	}
}

func normalizeImageConversationAssetContentType(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch value {
	case "image/png", "image/jpeg", "image/webp":
		return value
	default:
		return ""
	}
}

func normalizeImageConversationAssetFormat(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	default:
		return ""
	}
}

func parseImageConversationAssetDataURL(value string) (string, []byte, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "data:") {
		return "", nil, fmt.Errorf("%w: invalid data URL", ErrInvalidImageConversationAsset)
	}
	header, encoded, ok := strings.Cut(value[5:], ",")
	if !ok || encoded == "" {
		return "", nil, fmt.Errorf("%w: invalid data URL", ErrInvalidImageConversationAsset)
	}
	parts := strings.Split(header, ";")
	declaredType := normalizeImageConversationAssetContentType(parts[0])
	if declaredType == "" || len(parts) != 2 || !strings.EqualFold(strings.TrimSpace(parts[1]), "base64") {
		return "", nil, fmt.Errorf("%w: unsupported data URL", ErrInvalidImageConversationAsset)
	}
	maxEncodedBytes := base64.StdEncoding.EncodedLen(ImageConversationAssetMaxBytes + 1)
	if len(encoded) > maxEncodedBytes {
		return "", nil, ErrImageConversationAssetTooLarge
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return "", nil, fmt.Errorf("%w: invalid base64 image", ErrInvalidImageConversationAsset)
	}
	if len(data) > ImageConversationAssetMaxBytes {
		return "", nil, ErrImageConversationAssetTooLarge
	}
	return declaredType, data, nil
}

func writeImageConversationAssetOwnerMarker(root, ownerHash, ownerID string) (bool, error) {
	if !isLowerHexDigest(ownerHash) || strings.TrimSpace(ownerID) == "" || imageConversationAssetHash([]byte(ownerID)) != ownerHash {
		return false, ErrInvalidImageConversationAsset
	}
	dir := filepath.Join(root, ownerHash)
	if !pathInsideRoot(root, dir) {
		return false, ErrInvalidImageConversationAsset
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	markerPath := filepath.Join(dir, imageConversationAssetOwnerMarker)
	if existing, err := os.ReadFile(markerPath); err == nil {
		if strings.TrimSpace(string(existing)) != ownerID {
			return false, ErrInvalidImageConversationAsset
		}
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	temporary, err := os.CreateTemp(dir, ".owner-*")
	if err != nil {
		return false, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return false, err
	}
	if _, err := temporary.WriteString(ownerID); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(temporaryPath, markerPath); err != nil {
		return false, err
	}
	return true, nil
}

func writeImageConversationAsset(destination string, data []byte, contentHash string) (bool, error) {
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() {
			return false, ErrInvalidImageConversationAsset
		}
		if err := verifyImageConversationAsset(destination, info, contentHash); err != nil {
			return false, err
		}
		now := time.Now()
		return false, os.Chtimes(destination, now, now)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return false, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".conversation-asset-*")
	if err != nil {
		return false, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return false, err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		if info, statErr := os.Stat(destination); statErr == nil {
			return false, verifyImageConversationAsset(destination, info, contentHash)
		}
		return false, err
	}
	info, err := os.Stat(destination)
	if err != nil {
		return true, err
	}
	return true, verifyImageConversationAsset(destination, info, contentHash)
}

func rollbackImageConversationAssetBatch(root, ownerHash string, destinations []string, markerCreated bool) error {
	errs := make([]error, 0, len(destinations)+1)
	for index := len(destinations) - 1; index >= 0; index-- {
		if err := os.Remove(destinations[index]); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if markerCreated {
		hasManagedAssets, err := imageConversationAssetOwnerHasManagedAssets(root, ownerHash)
		if err != nil {
			errs = append(errs, err)
		} else if !hasManagedAssets {
			markerPath := filepath.Join(root, ownerHash, imageConversationAssetOwnerMarker)
			if err := os.Remove(markerPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func imageConversationAssetOwnerHasManagedAssets(root, ownerHash string) (bool, error) {
	ownerRoot := filepath.Join(root, ownerHash)
	if !pathInsideRoot(root, ownerRoot) {
		return false, ErrInvalidImageConversationAsset
	}
	entries, err := os.ReadDir(ownerRoot)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		assetPath := path.Join(ownerHash, entry.Name())
		if _, _, _, _, err := parseImageConversationAssetPath(assetPath); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return false, err
		}
		if info.Mode().IsRegular() {
			return true, nil
		}
	}
	return false, nil
}

func verifyImageConversationAsset(filePath string, info os.FileInfo, contentHash string) error {
	if info == nil || info.IsDir() || info.Size() < 1 || info.Size() > ImageConversationAssetMaxBytes {
		return ErrInvalidImageConversationAsset
	}
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, io.LimitReader(file, ImageConversationAssetMaxBytes+1)); err != nil {
		return err
	}
	if fmt.Sprintf("%x", hasher.Sum(nil)) != contentHash {
		return ErrInvalidImageConversationAsset
	}
	return nil
}

func parseImageConversationAssetPath(value string) (string, string, string, string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", "", "", "", ErrInvalidImageConversationAsset
	}
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		if parsed.Scheme != "" || strings.HasPrefix(pathValue, "/") {
			if !strings.HasPrefix(pathValue, ImageConversationAssetURLPrefix) {
				return "", "", "", "", ErrInvalidImageConversationAsset
			}
			decoded, err := url.PathUnescape(strings.TrimPrefix(pathValue, ImageConversationAssetURLPrefix))
			if err != nil {
				return "", "", "", "", ErrInvalidImageConversationAsset
			}
			text = decoded
		}
	}
	assetPath := filepath.ToSlash(text)
	if assetPath == "" || strings.HasPrefix(assetPath, "/") || path.Clean(assetPath) != assetPath {
		return "", "", "", "", ErrInvalidImageConversationAsset
	}
	parts := strings.Split(assetPath, "/")
	if len(parts) != 2 || !isLowerHexDigest(parts[0]) {
		return "", "", "", "", ErrInvalidImageConversationAsset
	}
	extension := strings.ToLower(filepath.Ext(parts[1]))
	contentHash := strings.TrimSuffix(parts[1], extension)
	if !isLowerHexDigest(contentHash) {
		return "", "", "", "", ErrInvalidImageConversationAsset
	}
	contentType := ""
	switch extension {
	case ".png":
		contentType = "image/png"
	case ".jpg":
		contentType = "image/jpeg"
	case ".webp":
		contentType = "image/webp"
	default:
		return "", "", "", "", ErrInvalidImageConversationAsset
	}
	return assetPath, parts[0], contentHash, contentType, nil
}

func imageConversationAssetHash(value []byte) string {
	digest := sha256.Sum256(value)
	return fmt.Sprintf("%x", digest[:])
}

func isLowerHexDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func imageConversationAssetFilename(value, extension string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	name := path.Base(value)
	if name == "." || name == "/" || name == "" {
		return "reference" + extension
	}
	if len(name) > 255 {
		name = name[:255]
	}
	return name
}

func firstImageConversationAssetValue(item map[string]any) string {
	for _, key := range []string{"assetPath", "asset_path", "dataUrl", "data_url", "url"} {
		if value := strings.TrimSpace(toString(item[key])); value != "" {
			return value
		}
	}
	return ""
}

func cloneImageConversationAssetMap(item map[string]any) map[string]any {
	next := make(map[string]any, len(item)+4)
	for key, value := range item {
		next[key] = value
	}
	return next
}

func applyImageConversationAsset(item map[string]any, asset ImageConversationAsset) {
	delete(item, "asset_path")
	delete(item, "data_url")
	item["assetPath"] = asset.AssetPath
	item["url"] = asset.URL
	item["dataUrl"] = asset.DataURL
	item["name"] = asset.Name
	item["type"] = asset.Type
	item["size"] = asset.Size
}

func int64Value(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	default:
		return 0
	}
}
