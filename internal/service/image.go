package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	maxImageRetentionDays = 3650
	ThumbnailSize         = 480
	thumbnailQuality      = 72
	thumbnailCacheVersion = 3
	thumbnailExtension    = ".jpg"
	imageReferencePrefix  = "references"
	imageReferenceMarker  = ".refs/"
	imageMetadataAttempts = 8

	ImageVisibilityPrivate = "private"
	ImageVisibilityPublic  = "public"
)

type ImageConfig interface {
	ImagesDir() string
	ImageThumbnailsDir() string
	ImageMetadataDir() string
	ImageRetentionDays() int
	ImageStorageLimitBytes() int64
}

type ImageAccessScope struct {
	OwnerID string
	All     bool
	Public  bool
	Visible bool
}

type imageMetadata struct {
	OwnerID           string
	OwnerName         string
	Visibility        string
	Deleting          bool
	PublishedAt       string
	Prompt            string
	GenerationSource  string
	Model             string
	Quality           string
	ResolutionPreset  string
	RequestedSize     string
	OutputFormat      string
	OutputCompression *int
	Background        string
	Moderation        string
	PartialImages     *int
	ReferenceImages   []imageReferenceMetadata
	SharePromptParams bool
	ShareReferences   bool
	Width             int
	Height            int
}

type GeneratedImageMetadata struct {
	Prompt            string
	GenerationSource  string
	Model             string
	Quality           string
	ResolutionPreset  string
	RequestedSize     string
	OutputFormat      string
	OutputCompression *int
	Background        string
	Moderation        string
	PartialImages     *int
	ReferenceImages   []GeneratedImageReference
	SharePromptParams bool
	ShareReferences   bool
}

const (
	ImageGenerationSourceWorkbench = "image-workbench"
	ImageGenerationSourceWorkflow  = "workflow"
	ImageGenerationSourceCanvas    = "canvas"
)

func NormalizeImageGenerationSource(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case ImageGenerationSourceWorkbench:
		return ImageGenerationSourceWorkbench
	case ImageGenerationSourceWorkflow:
		return ImageGenerationSourceWorkflow
	case ImageGenerationSourceCanvas:
		return ImageGenerationSourceCanvas
	default:
		return ""
	}
}

type GeneratedImageReference struct {
	Filename    string
	ContentType string
	Data        []byte
}

type ImageStorageCleanupOptions struct {
	RetentionDays   int
	MaxBytes        int64
	ClearThumbnails bool
	IncludePublic   bool
}

type ImageStorageGovernanceSummary struct {
	TotalBytes         int64  `json:"total_bytes"`
	ImagesBytes        int64  `json:"images_bytes"`
	ThumbnailsBytes    int64  `json:"thumbnails_bytes"`
	MetadataBytes      int64  `json:"metadata_bytes"`
	ReferenceBytes     int64  `json:"reference_bytes"`
	ImagesCount        int    `json:"images_count"`
	PublicImagesCount  int    `json:"public_images_count"`
	PrivateImagesCount int    `json:"private_images_count"`
	ThumbnailFiles     int    `json:"thumbnail_files"`
	MetadataFiles      int    `json:"metadata_files"`
	ReferenceFiles     int    `json:"reference_files"`
	LimitBytes         int64  `json:"limit_bytes"`
	OverLimitBytes     int64  `json:"over_limit_bytes"`
	OldestImageAt      string `json:"oldest_image_at,omitempty"`
	LatestImageAt      string `json:"latest_image_at,omitempty"`
}

type ImageStorageCleanupResult struct {
	RetentionDays             int    `json:"retention_days,omitempty"`
	MaxBytes                  int64  `json:"max_bytes,omitempty"`
	IncludePublic             bool   `json:"include_public,omitempty"`
	DeletedImages             int    `json:"deleted_images"`
	DeletedThumbnails         int    `json:"deleted_thumbnails"`
	DeletedMetadataFiles      int    `json:"deleted_metadata_files"`
	DeletedReferenceFiles     int    `json:"deleted_reference_files"`
	DeletedConversationAssets int    `json:"deleted_conversation_assets"`
	DeletedBytes              int64  `json:"deleted_bytes"`
	RemainingBytes            int64  `json:"remaining_bytes"`
	OverLimitBytes            int64  `json:"over_limit_bytes"`
	PreservedPublicImages     int    `json:"preserved_public_images,omitempty"`
	Action                    string `json:"action,omitempty"`
}

type imageReferenceMetadata struct {
	Path        string
	Filename    string
	ContentType string
	Size        int64
}

type ImageFileAccess struct {
	Rel        string
	Path       string
	Info       os.FileInfo
	Visibility string
	OwnerID    string
}

type ImageReferenceFileAccess struct {
	Rel         string
	SourceRel   string
	Path        string
	ContentType string
	Visibility  string
	OwnerID     string
	Shared      bool
}

type ImageVisibilityUpdateOptions struct {
	SharePromptParams bool
	ShareReferences   bool
}

type ImageService struct {
	config        ImageConfig
	store         storage.JSONDocumentBackend
	cleanupMu     sync.Mutex
	metadataMu    sync.Mutex
	thumbnailMu   sync.Mutex
	thumbnailJobs map[string]*thumbnailJob
}

type imageFileRef struct {
	rel  string
	path string
	info os.FileInfo
}

type thumbnailJob struct {
	done   chan struct{}
	result map[string]any
}

type imageCleanupCandidate struct {
	rel       string
	path      string
	info      os.FileInfo
	meta      imageMetadata
	groupSize int64
}

type imageStorageRemovalStats struct {
	bytes          int64
	images         int
	thumbnails     int
	metadataFiles  int
	referenceFiles int
}

func NewImageService(config ImageConfig, backend ...storage.Backend) *ImageService {
	return &ImageService{config: config, store: firstJSONDocumentStore(backend)}
}

func (s *ImageService) SaveImageBytes(ctx context.Context, imageData []byte, baseURL, ownerID, ownerName string) (string, error) {
	if ctx == nil {
		return "", errors.New("image save context is required")
	}
	if len(imageData) == 0 {
		return "", errors.New("image data is empty")
	}
	if len(imageData) > util.MaxRasterImageEncodedBytes {
		return "", errors.New("image data is too large")
	}
	info, err := util.InspectRasterImage(imageData, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return "", fmt.Errorf("invalid image data: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	outputFormat := info.Format
	now := time.Now().UTC()
	filename := strconv.FormatInt(now.UnixNano(), 10) + "_" + util.NewHex(12) + "." + imageStorageExtension(outputFormat)
	rel := filepath.ToSlash(filepath.Join(now.Format("2006"), now.Format("01"), now.Format("02"), filename))
	imagePath := filepath.Join(s.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.WriteFile(imagePath, imageData, 0o644); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", errors.Join(err, s.rollbackSavedImage(rel, imagePath, false))
	}
	meta := imageMetadata{
		OwnerID: ownerID, OwnerName: ownerName, Visibility: ImageVisibilityPrivate,
		Width: info.Width, Height: info.Height, OutputFormat: outputFormat,
	}
	if err := s.writeImageMetadata(rel, meta); err != nil {
		return "", errors.Join(err, s.rollbackSavedImage(rel, imagePath, true))
	}
	if err := ctx.Err(); err != nil {
		return "", errors.Join(err, s.rollbackSavedImage(rel, imagePath, true))
	}
	return publicAssetURL(baseURL, "images", rel), nil
}

func (s *ImageService) rollbackSavedImage(rel, imagePath string, removeMetadata bool) error {
	var rollbackErrors []error
	if removeMetadata {
		if _, _, err := s.removeImageOwnerWithStats(rel); err != nil {
			rollbackErrors = append(rollbackErrors, fmt.Errorf("remove image metadata: %w", err))
		}
	}
	if err := os.Remove(imagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		rollbackErrors = append(rollbackErrors, fmt.Errorf("remove image data: %w", err))
	} else if err == nil {
		removeEmptyParentDirs(s.config.ImagesDir(), filepath.Dir(imagePath))
	}
	return errors.Join(rollbackErrors...)
}

func imageStorageExtension(format string) string {
	if NormalizeImageOutputFormat(format) == "jpeg" {
		return "jpg"
	}
	return NormalizeImageOutputFormat(format)
}

func storedImageSize(info os.FileInfo) int64 {
	if info != nil {
		return info.Size()
	}
	return 0
}

func storedImageTime(info os.FileInfo) time.Time {
	if info != nil {
		return info.ModTime()
	}
	return time.Time{}
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func (s *ImageService) StorageGovernance() (ImageStorageGovernanceSummary, error) {
	summary := ImageStorageGovernanceSummary{LimitBytes: s.config.ImageStorageLimitBytes()}
	candidates, err := s.imageCleanupCandidates()
	if err != nil {
		return summary, err
	}
	for _, candidate := range candidates {
		meta := candidate.meta
		summary.ImagesCount++
		summary.ImagesBytes += storedImageSize(candidate.info)
		if meta.Visibility == ImageVisibilityPublic {
			summary.PublicImagesCount++
		} else {
			summary.PrivateImagesCount++
		}
		created := storedImageTime(candidate.info).Format("2006-01-02 15:04:05")
		if summary.OldestImageAt == "" || created < summary.OldestImageAt {
			summary.OldestImageAt = created
		}
		if summary.LatestImageAt == "" || created > summary.LatestImageAt {
			summary.LatestImageAt = created
		}
	}
	summary.ThumbnailsBytes, summary.ThumbnailFiles, _, err = thumbnailCacheStats(s.config.ImageThumbnailsDir())
	if err != nil {
		return summary, err
	}
	summary.MetadataBytes, summary.MetadataFiles, err = directorySize(s.config.ImageMetadataDir(), s.imageReferencesDir())
	if err != nil {
		return summary, err
	}
	summary.ReferenceBytes, summary.ReferenceFiles, err = directorySize(s.imageReferencesDir(), "")
	if err != nil {
		return summary, err
	}
	summary.TotalBytes = summary.ImagesBytes + summary.ThumbnailsBytes + summary.MetadataBytes + summary.ReferenceBytes
	if summary.LimitBytes > 0 && summary.TotalBytes > summary.LimitBytes {
		summary.OverLimitBytes = summary.TotalBytes - summary.LimitBytes
	}
	return summary, nil
}

func (s *ImageService) CleanupStorage(options ImageStorageCleanupOptions) (ImageStorageCleanupResult, error) {
	s.cleanupMu.Lock()
	defer s.cleanupMu.Unlock()

	result := ImageStorageCleanupResult{
		RetentionDays: options.RetentionDays,
		MaxBytes:      options.MaxBytes,
		IncludePublic: options.IncludePublic,
	}
	if options.ClearThumbnails || options.RetentionDays > 0 || options.MaxBytes > 0 {
		if _, err := s.StorageGovernance(); err != nil {
			return result, err
		}
	}
	if options.ClearThumbnails {
		stats, err := s.clearThumbnailCache()
		if err != nil {
			return result, err
		}
		result.Action = "thumbnails"
		result.DeletedThumbnails += stats.thumbnails
		result.DeletedMetadataFiles += stats.metadataFiles
		result.DeletedBytes += stats.bytes
	}
	if options.RetentionDays > 0 {
		stats, preserved, err := s.cleanupByRetention(options.RetentionDays, options.IncludePublic)
		if err != nil {
			return result, err
		}
		if result.Action == "" {
			result.Action = "retention"
		}
		result.addRemovalStats(stats)
		result.PreservedPublicImages += preserved
	}
	if options.MaxBytes > 0 {
		stats, preserved, err := s.cleanupByStorageLimit(options.MaxBytes, options.IncludePublic)
		if err != nil {
			return result, err
		}
		if result.Action == "" {
			result.Action = "quota"
		}
		result.addRemovalStats(stats)
		result.PreservedPublicImages += preserved
	}
	summary, err := s.StorageGovernance()
	if err != nil {
		return result, err
	}
	result.RemainingBytes = summary.TotalBytes
	result.OverLimitBytes = summary.OverLimitBytes
	return result, nil
}

func (r *ImageStorageCleanupResult) addRemovalStats(stats imageStorageRemovalStats) {
	r.DeletedBytes += stats.bytes
	r.DeletedImages += stats.images
	r.DeletedThumbnails += stats.thumbnails
	r.DeletedMetadataFiles += stats.metadataFiles
	r.DeletedReferenceFiles += stats.referenceFiles
}

func (s *ImageService) ListImages(baseURL, startDate, endDate string, scope ImageAccessScope) (map[string]any, error) {
	empty := map[string]any{"items": []map[string]any{}, "groups": []map[string]any{}}
	root := s.config.ImagesDir()
	rootInfo, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return empty, nil
		}
		return nil, fmt.Errorf("inspect image directory: %w", err)
	}
	if !rootInfo.IsDir() {
		return nil, errors.New("image directory is not a directory")
	}
	metadataDocuments, metadataBatch, err := s.imageDocuments("image_metadata/")
	if err != nil {
		return nil, fmt.Errorf("list image metadata: %w", err)
	}
	thumbnailDocuments, thumbnailBatch, err := s.imageDocuments("image_thumbnails/")
	if err != nil {
		return nil, fmt.Errorf("list thumbnail metadata: %w", err)
	}
	items := make([]map[string]any, 0)
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		parts := strings.Split(rel, "/")
		day := info.ModTime().Format("2006-01-02")
		if len(parts) >= 4 {
			day = strings.Join(parts[:3], "-")
		}
		if startDate != "" && day < startDate {
			return nil
		}
		if endDate != "" && day > endDate {
			return nil
		}
		meta, err := s.imageMetadataFromDocuments(rel, metadataDocuments, metadataBatch)
		if err != nil {
			return fmt.Errorf("load metadata for %q: %w", rel, err)
		}
		if meta.Deleting {
			return nil
		}
		storedTime := storedImageTime(info)
		ownerID := meta.OwnerID
		if scope.Visible {
			if ownerID != scope.OwnerID && meta.Visibility != ImageVisibilityPublic {
				return nil
			}
		} else if scope.Public {
			if meta.Visibility != ImageVisibilityPublic {
				return nil
			}
		} else if !scope.All && (scope.OwnerID == "" || ownerID != scope.OwnerID) {
			return nil
		}
		thumb, err := s.thumbnailInfoFromDocuments(rel, info, thumbnailDocuments, thumbnailBatch)
		if err != nil {
			return fmt.Errorf("load thumbnail metadata for %q: %w", rel, err)
		}
		item := map[string]any{
			"name":       filepath.Base(path),
			"path":       rel,
			"date":       day,
			"size":       storedImageSize(info),
			"url":        publicAssetURL(baseURL, "images", rel),
			"created_at": storedTime.Format("2006-01-02 15:04:05"),
			"visibility": meta.Visibility,
		}
		sharedPublic := (scope.Public || scope.Visible) && ownerID != scope.OwnerID
		addImageMetadataFields(item, meta, imageMetadataFieldOptions{
			BaseURL:                baseURL,
			IncludeReusableFields:  !sharedPublic || meta.SharePromptParams,
			IncludeReferenceImages: !sharedPublic || meta.ShareReferences,
		})
		if thumbRel, ok := thumb["thumbnail_rel"].(string); ok && thumbRel != "" {
			item["thumbnail_url"] = thumbnailURL(baseURL, thumbRel, storedTime)
		} else {
			item["thumbnail_url"] = ""
		}
		if !setImageItemDimensions(item, firstNonZero(meta.Width, numericMetaValue(thumb["width"])), firstNonZero(meta.Height, numericMetaValue(thumb["height"]))) {
			if width, height, ok := imageFileDimensions(path); ok {
				setImageItemDimensions(item, width, height)
			}
		}
		items = append(items, item)
		return nil
	})
	if walkErr != nil {
		if errors.Is(walkErr, os.ErrNotExist) {
			return empty, nil
		}
		return nil, fmt.Errorf("walk image directory: %w", walkErr)
	}
	sort.Slice(items, func(i, j int) bool {
		left := toString(items[i]["created_at"])
		right := toString(items[j]["created_at"])
		if scope.Public {
			left = firstNonEmptyString(toString(items[i]["published_at"]), left)
			right = firstNonEmptyString(toString(items[j]["published_at"]), right)
		}
		return strings.Compare(left, right) > 0
	})
	groupMap := map[string][]map[string]any{}
	var order []string
	for _, item := range items {
		day := toString(item["date"])
		if _, ok := groupMap[day]; !ok {
			order = append(order, day)
		}
		groupMap[day] = append(groupMap[day], item)
	}
	groups := make([]map[string]any, 0, len(order))
	for _, day := range order {
		groups = append(groups, map[string]any{"date": day, "items": groupMap[day]})
	}
	return map[string]any{"items": items, "groups": groups}, nil
}

func (s *ImageService) UpdateImageVisibility(value, visibility string, scope ImageAccessScope, optionValues ...ImageVisibilityUpdateOptions) (map[string]any, error) {
	visibility, err := NormalizeImageVisibility(visibility)
	if err != nil {
		return nil, err
	}
	options := ImageVisibilityUpdateOptions{}
	if len(optionValues) > 0 {
		options = optionValues[0]
	}
	if visibility != ImageVisibilityPublic {
		options = ImageVisibilityUpdateOptions{}
	}
	rel, err := imageRelativePathFromValue(value)
	if err != nil {
		return nil, err
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return nil, err
	}
	ref, err := s.imageFileRef(imageRoot, rel)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("image not found")
		}
		return nil, err
	}
	meta := s.imageMetadata(ref.rel)
	if meta.Deleting {
		return nil, errors.New("image not found")
	}
	if !scope.All && (scope.OwnerID == "" || meta.OwnerID != scope.OwnerID) {
		return nil, errors.New("image not found")
	}
	if err := s.writeImageMetadataForRefWithSharingOptions(ref, "", "", visibility, &options); err != nil {
		return nil, err
	}
	nextMeta := s.imageMetadata(ref.rel)
	item := map[string]any{
		"name":       filepath.Base(ref.path),
		"path":       ref.rel,
		"date":       imageDay(ref.rel, storedImageTime(ref.info)),
		"size":       storedImageSize(ref.info),
		"visibility": nextMeta.Visibility,
		"created_at": storedImageTime(ref.info).Format("2006-01-02 15:04:05"),
	}
	addImageMetadataFields(item, nextMeta)
	if nextMeta.Width > 0 && nextMeta.Height > 0 {
		setImageItemDimensions(item, nextMeta.Width, nextMeta.Height)
	} else if width, height, ok := imageFileDimensions(ref.path); ok {
		setImageItemDimensions(item, width, height)
	}
	return item, nil
}

func (s *ImageService) ImageFileAccess(value string, scope ImageAccessScope) (ImageFileAccess, error) {
	rel, err := imageRelativePathFromValue(value)
	if err != nil {
		return ImageFileAccess{}, err
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return ImageFileAccess{}, err
	}
	ref, err := s.imageFileRef(imageRoot, rel)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ImageFileAccess{}, errors.New("image not found")
		}
		return ImageFileAccess{}, err
	}
	meta := s.imageMetadata(ref.rel)
	if !imageMetadataAllowsAccess(meta, scope) {
		return ImageFileAccess{}, errors.New("image not found")
	}
	return ImageFileAccess{
		Rel:        ref.rel,
		Path:       ref.path,
		Info:       ref.info,
		Visibility: meta.Visibility,
		OwnerID:    meta.OwnerID,
	}, nil
}

func (s *ImageService) ImageReferenceFileAccess(value string) (ImageReferenceFileAccess, error) {
	rel, err := imageReferenceRelativePathFromValue(value)
	if err != nil {
		return ImageReferenceFileAccess{}, err
	}
	sourceRel, err := sourceImageRelativePathFromReference(rel)
	if err != nil {
		return ImageReferenceFileAccess{}, err
	}
	meta := s.imageMetadata(sourceRel)
	if meta.Deleting {
		return ImageReferenceFileAccess{}, errors.New("image not found")
	}
	var metadata imageReferenceMetadata
	for _, ref := range meta.ReferenceImages {
		if ref.Path == rel {
			metadata = ref
			break
		}
	}
	if metadata.Path == "" {
		return ImageReferenceFileAccess{}, errors.New("image not found")
	}
	root, err := filepath.Abs(s.imageReferencesDir())
	if err != nil {
		return ImageReferenceFileAccess{}, err
	}
	refPath := filepath.Join(root, filepath.FromSlash(rel))
	if !pathInsideRoot(root, refPath) {
		return ImageReferenceFileAccess{}, errors.New("invalid image path")
	}
	info, err := os.Stat(refPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ImageReferenceFileAccess{}, errors.New("image not found")
		}
		return ImageReferenceFileAccess{}, err
	}
	if info.IsDir() {
		return ImageReferenceFileAccess{}, errors.New("image not found")
	}
	return ImageReferenceFileAccess{
		Rel:         rel,
		SourceRel:   sourceRel,
		Path:        refPath,
		ContentType: metadata.ContentType,
		Visibility:  meta.Visibility,
		OwnerID:     meta.OwnerID,
		Shared:      meta.ShareReferences,
	}, nil
}

func (s *ImageService) ImageBytes(value string, scope ImageAccessScope) ([]byte, string, error) {
	access, err := s.ImageFileAccess(value, scope)
	if err != nil {
		return nil, "", err
	}
	file, err := os.Open(access.Path)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, util.MaxRasterImageEncodedBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > util.MaxRasterImageEncodedBytes {
		return nil, "", errors.New("stored image is too large")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return nil, "", fmt.Errorf("invalid stored image: %w", err)
	}
	return data, info.ContentType, nil
}

func (s *ImageService) DeleteImages(paths []string, scope ImageAccessScope) (map[string]any, error) {
	if len(paths) == 0 {
		return nil, errors.New("paths is required")
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return nil, err
	}

	seen := make(map[string]struct{}, len(paths))
	normalized := make([]string, 0, len(paths))
	for _, value := range paths {
		rel, err := cleanImageRelativePath(value)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[rel]; ok {
			continue
		}
		seen[rel] = struct{}{}
		normalized = append(normalized, rel)
	}

	s.metadataMu.Lock()
	defer s.metadataMu.Unlock()

	candidates := make([]string, 0, len(normalized))
	missing := 0
	for _, rel := range normalized {
		ref, err := s.imageFileRef(imageRoot, rel)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				missing++
				continue
			}
			return nil, err
		}
		meta, err := s.loadImageMetadata(rel)
		if err != nil {
			return nil, err
		}
		if !scope.All && (scope.OwnerID == "" || meta.OwnerID != scope.OwnerID) {
			missing++
			continue
		}
		if _, err := s.imageGroupSize(rel, storedImageSize(ref.info)); err != nil {
			return nil, err
		}
		candidates = append(candidates, rel)
	}

	deleted := 0
	removedPaths := make([]string, 0, len(candidates))
	for _, rel := range candidates {
		stats, claimed, err := s.removeImageGroupIfLocked(rel, func(meta imageMetadata) bool {
			return scope.All || (scope.OwnerID != "" && meta.OwnerID == scope.OwnerID)
		})
		if err != nil {
			return nil, err
		}
		if !claimed {
			missing++
			continue
		}
		if stats.images == 0 {
			missing++
		} else {
			deleted++
		}
		removedPaths = append(removedPaths, rel)
	}
	return map[string]any{"deleted": deleted, "missing": missing, "paths": removedPaths}, nil
}

func (s *ImageService) RecordGeneratedImageMetadata(values []string, ownerID, ownerName, visibility string, metadataValues ...GeneratedImageMetadata) error {
	return s.recordGeneratedImages(values, ownerID, ownerName, visibility, false, metadataValues...)
}

func (s *ImageService) recordGeneratedImages(values []string, ownerID, ownerName, visibility string, ensureThumbnails bool, metadataValues ...GeneratedImageMetadata) error {
	ownerID = strings.TrimSpace(ownerID)
	ownerName = strings.TrimSpace(ownerName)
	metadata := GeneratedImageMetadata{}
	if len(metadataValues) > 0 {
		metadata = metadataValues[0]
	}
	visibility, err := NormalizeImageVisibility(visibility)
	if err != nil {
		visibility = ImageVisibilityPrivate
	}
	var writeErrors []error
	for _, ref := range s.imageFileRefs(values) {
		if ensureThumbnails {
			s.ensureThumbnailForRef(ref)
		}
		if ownerID != "" && ownerID != "anonymous" {
			if err := s.writeImageMetadataForRef(ref, ownerID, ownerName, visibility, metadata); err != nil {
				writeErrors = append(writeErrors, fmt.Errorf("record generated image metadata for %s: %w", ref.rel, err))
			}
		}
	}
	return errors.Join(writeErrors...)
}

func (s *ImageService) EnsureThumbnails(values []string) {
	for _, ref := range s.imageFileRefs(values) {
		s.ensureThumbnailForRef(ref)
	}
}

func (s *ImageService) SourceImageRelativePathFromThumbnail(thumbnailRel string) (string, error) {
	return sourceImageRelativePathFromThumbnail(thumbnailRel)
}

func (s *ImageService) EnsureThumbnail(thumbnailRel string) error {
	sourceRel, err := s.SourceImageRelativePathFromThumbnail(thumbnailRel)
	if err != nil {
		return err
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return err
	}
	ref, err := s.imageFileRef(imageRoot, sourceRel)
	if err != nil {
		return err
	}
	thumb := s.ensureThumbnailForRef(ref)
	if toString(thumb["thumbnail_rel"]) == "" {
		return errors.New("thumbnail unavailable")
	}
	return nil
}

func (s *ImageService) thumbnailInfo(rel string, sourceInfo os.FileInfo) (map[string]any, error) {
	_, result, _, err := s.thumbnailCacheInfo(rel, sourceInfo.ModTime())
	return result, err
}

func (s *ImageService) thumbnailInfoFromDocuments(rel string, sourceInfo os.FileInfo, documents map[string]any, batched bool) (map[string]any, error) {
	if !batched {
		return s.thumbnailInfo(rel, sourceInfo)
	}
	thumbPath := s.thumbnailPath(rel)
	thumbRel := thumbnailRelativePath(s.config.ImageThumbnailsDir(), thumbPath)
	result := map[string]any{"thumbnail_rel": thumbRel}
	thumbInfo, err := os.Stat(thumbPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return nil, err
	}
	if thumbInfo.IsDir() {
		return nil, errors.New("thumbnail path is not a file")
	}
	if thumbInfo.ModTime().Before(sourceInfo.ModTime()) {
		return result, nil
	}
	documentName := thumbnailMetadataDocumentName(rel)
	raw, exists := documents[documentName]
	meta, ok := raw.(map[string]any)
	if exists && !ok {
		return nil, fmt.Errorf("thumbnail metadata document %q is not an object", documentName)
	}
	if !exists {
		meta, err = readImageMetadata(thumbPath+".json", sourceInfo.ModTime())
		if err != nil {
			return nil, err
		}
	}
	if !isCurrentThumbnailMetadata(meta) {
		return result, nil
	}
	for key, value := range meta {
		result[key] = value
	}
	return result, nil
}

func (s *ImageService) ensureThumbnailForRef(ref imageFileRef) map[string]any {
	if _, result, ok, err := s.thumbnailCacheInfo(ref.rel, ref.info.ModTime()); err == nil && ok {
		return result
	}
	return s.withThumbnailJob(ref.rel, func() map[string]any {
		if _, result, ok, err := s.thumbnailCacheInfo(ref.rel, ref.info.ModTime()); err == nil && ok {
			return result
		}
		return s.generateThumbnail(ref)
	})
}

func (s *ImageService) withThumbnailJob(rel string, run func() map[string]any) map[string]any {
	s.thumbnailMu.Lock()
	if s.thumbnailJobs == nil {
		s.thumbnailJobs = make(map[string]*thumbnailJob)
	}
	if job, ok := s.thumbnailJobs[rel]; ok {
		done := job.done
		s.thumbnailMu.Unlock()
		<-done
		return job.result
	}
	job := &thumbnailJob{done: make(chan struct{})}
	s.thumbnailJobs[rel] = job
	s.thumbnailMu.Unlock()

	job.result = run()

	s.thumbnailMu.Lock()
	delete(s.thumbnailJobs, rel)
	close(job.done)
	s.thumbnailMu.Unlock()
	return job.result
}

func (s *ImageService) thumbnailCacheInfo(rel string, sourceModTime time.Time) (string, map[string]any, bool, error) {
	thumbPath := s.thumbnailPath(rel)
	thumbRel := thumbnailRelativePath(s.config.ImageThumbnailsDir(), thumbPath)
	result := map[string]any{"thumbnail_rel": thumbRel}
	thumbInfo, err := os.Stat(thumbPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return thumbPath, result, false, nil
		}
		return thumbPath, result, false, err
	}
	if thumbInfo.IsDir() {
		return thumbPath, result, false, errors.New("thumbnail path is not a file")
	}
	if thumbInfo.ModTime().Before(sourceModTime) {
		return thumbPath, result, false, nil
	}
	meta, err := s.readThumbnailMetadata(rel, thumbPath+".json", sourceModTime)
	if err != nil {
		return thumbPath, result, false, err
	}
	if !isCurrentThumbnailMetadata(meta) {
		return thumbPath, result, false, nil
	}
	for key, value := range meta {
		result[key] = value
	}
	return thumbPath, result, true, nil
}

func (s *ImageService) generateThumbnail(ref imageFileRef) map[string]any {
	thumbPath, result, _, err := s.thumbnailCacheInfo(ref.rel, ref.info.ModTime())
	if err != nil {
		return map[string]any{}
	}
	meta := s.imageMetadata(ref.rel)
	if meta.Deleting {
		return map[string]any{}
	}
	file, err := os.Open(ref.path)
	if err != nil {
		return map[string]any{}
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, util.MaxRasterImageEncodedBytes+1))
	if err != nil {
		return map[string]any{}
	}
	if len(data) > util.MaxRasterImageEncodedBytes {
		return map[string]any{}
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return map[string]any{}
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return map[string]any{}
	}
	thumb := resizeToFit(flattenImage(img), ThumbnailSize, ThumbnailSize)
	if _, err := os.Stat(ref.path); err != nil {
		return map[string]any{}
	}
	if err := writeJPEGThumbnail(thumbPath, thumb); err != nil {
		return map[string]any{}
	}
	if err := s.writeThumbnailMetadata(ref.rel, thumbPath+".json", map[string]any{
		"width":             info.Width,
		"height":            info.Height,
		"thumbnail_format":  "jpeg",
		"thumbnail_quality": thumbnailQuality,
		"thumbnail_size":    ThumbnailSize,
		"thumbnail_version": thumbnailCacheVersion,
	}); err != nil {
		_ = os.Remove(thumbPath)
		return map[string]any{}
	}
	result["width"] = info.Width
	result["height"] = info.Height
	return result
}

func (s *ImageService) imageFileRefs(values []string) []imageFileRef {
	if len(values) == 0 {
		return nil
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	refs := make([]imageFileRef, 0, len(values))
	for _, value := range values {
		rel, err := imageRelativePathFromValue(value)
		if err != nil {
			continue
		}
		if _, ok := seen[rel]; ok {
			continue
		}
		seen[rel] = struct{}{}
		ref, err := s.imageFileRef(imageRoot, rel)
		if err != nil {
			continue
		}
		refs = append(refs, ref)
	}
	return refs
}

func (s *ImageService) imageFileRef(imageRoot, rel string) (imageFileRef, error) {
	rel, err := cleanImageRelativePath(rel)
	if err != nil {
		return imageFileRef{}, err
	}
	imagePath := filepath.Join(imageRoot, filepath.FromSlash(rel))
	if !pathInsideRoot(imageRoot, imagePath) {
		return imageFileRef{}, errors.New("invalid image path")
	}
	info, err := os.Stat(imagePath)
	if err != nil {
		return imageFileRef{}, err
	}
	if info.IsDir() {
		return imageFileRef{}, errors.New("image path is not a file")
	}
	return imageFileRef{rel: rel, path: imagePath, info: info}, nil
}

func (s *ImageService) thumbnailPath(rel string) string {
	return filepath.Join(s.config.ImageThumbnailsDir(), filepath.FromSlash(rel)+thumbnailExtension)
}

func imageMetadataAllowsAccess(meta imageMetadata, scope ImageAccessScope) bool {
	if meta.Deleting {
		return false
	}
	if meta.Visibility == ImageVisibilityPublic {
		return true
	}
	if scope.All {
		return true
	}
	return scope.OwnerID != "" && meta.OwnerID == scope.OwnerID
}

func (s *ImageService) imageMetadata(rel string) imageMetadata {
	meta, err := s.loadImageMetadata(rel)
	if err != nil {
		return imageMetadata{Visibility: ImageVisibilityPrivate}
	}
	return meta
}

func (s *ImageService) imageDocuments(prefix string) (map[string]any, bool, error) {
	store, ok := s.store.(storage.JSONDocumentPrefixBackend)
	if !ok {
		return nil, false, nil
	}
	documents, err := store.ListJSONDocuments(prefix)
	if err != nil {
		return nil, true, err
	}
	return documents, true, nil
}

func (s *ImageService) imageMetadataFromDocuments(rel string, documents map[string]any, batched bool) (imageMetadata, error) {
	if !batched {
		return s.loadImageMetadata(rel)
	}
	documentName := imageOwnerDocumentName(rel)
	raw, exists := documents[documentName]
	if exists {
		meta, ok := raw.(map[string]any)
		if !ok {
			return imageMetadata{}, fmt.Errorf("image metadata document %q is not an object", documentName)
		}
		return normalizeImageMetadata(meta), nil
	}
	metaPath, err := s.imageOwnerMetadataPath(rel)
	if err != nil {
		return imageMetadata{}, err
	}
	data, err := os.ReadFile(metaPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return imageMetadata{Visibility: ImageVisibilityPrivate}, nil
		}
		return imageMetadata{}, err
	}
	var meta map[string]any
	if err := json.Unmarshal(data, &meta); err != nil {
		return imageMetadata{}, err
	}
	return normalizeImageMetadata(meta), nil
}

func (s *ImageService) loadImageMetadata(rel string) (imageMetadata, error) {
	metaPath, err := s.imageOwnerMetadataPath(rel)
	if err != nil {
		return imageMetadata{Visibility: ImageVisibilityPrivate}, err
	}
	var raw map[string]any
	if s.store != nil {
		value, err := s.store.LoadJSONDocument(imageOwnerDocumentName(rel))
		if err != nil {
			return imageMetadata{Visibility: ImageVisibilityPrivate}, err
		}
		if meta, ok := value.(map[string]any); ok {
			raw = meta
		}
	}
	if raw == nil {
		data, err := os.ReadFile(metaPath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return imageMetadata{Visibility: ImageVisibilityPrivate}, nil
			}
			return imageMetadata{Visibility: ImageVisibilityPrivate}, err
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			return imageMetadata{Visibility: ImageVisibilityPrivate}, err
		}
	}
	return normalizeImageMetadata(raw), nil
}

func normalizeImageMetadata(raw map[string]any) imageMetadata {
	visibility := strings.TrimSpace(toString(raw["visibility"]))
	if visibility != ImageVisibilityPublic {
		visibility = ImageVisibilityPrivate
	}
	return imageMetadata{
		OwnerID:           strings.TrimSpace(toString(raw["owner_id"])),
		OwnerName:         strings.TrimSpace(toString(raw["owner_name"])),
		Visibility:        visibility,
		Deleting:          boolMetadataValue(raw["deleting"]),
		PublishedAt:       strings.TrimSpace(toString(raw["published_at"])),
		Prompt:            strings.TrimSpace(toString(raw["prompt"])),
		GenerationSource:  NormalizeImageGenerationSource(toString(raw["generation_source"])),
		Model:             strings.TrimSpace(toString(raw["model"])),
		Quality:           strings.TrimSpace(toString(raw["quality"])),
		ResolutionPreset:  NormalizeImageResolutionPreset(toString(raw["resolution_preset"])),
		RequestedSize:     strings.TrimSpace(toString(raw["requested_size"])),
		OutputFormat:      normalizeOptionalImageOutputFormat(strings.TrimSpace(toString(raw["output_format"]))),
		OutputCompression: imageOutputCompressionMetadata(raw["output_compression"]),
		Background:        strings.TrimSpace(toString(raw["background"])),
		Moderation:        strings.TrimSpace(toString(raw["moderation"])),
		PartialImages:     positiveImageMetadataInt(raw["partial_images"]),
		ReferenceImages:   normalizeImageReferenceMetadata(raw["reference_images"]),
		SharePromptParams: boolMetadataValue(raw["share_prompt_parameters"]),
		ShareReferences:   boolMetadataValue(raw["share_reference_images"]),
		Width:             numericMetaValue(raw["width"]),
		Height:            numericMetaValue(raw["height"]),
	}
}

func (s *ImageService) writeImageMetadataForRef(ref imageFileRef, ownerID, ownerName, visibility string, metadataValues ...GeneratedImageMetadata) error {
	return s.writeImageMetadataForRefWithSharingOptions(ref, ownerID, ownerName, visibility, nil, metadataValues...)
}

func (s *ImageService) writeImageMetadataForRefWithSharingOptions(ref imageFileRef, ownerID, ownerName, visibility string, sharing *ImageVisibilityUpdateOptions, metadataValues ...GeneratedImageMetadata) error {
	s.metadataMu.Lock()
	defer s.metadataMu.Unlock()
	var lastErr error
	for attempt := 0; attempt < imageMetadataAttempts; attempt++ {
		lastErr = s.writeImageMetadataForRefOnce(ref, ownerID, ownerName, visibility, sharing, metadataValues...)
		if lastErr == nil || !errors.Is(lastErr, storage.ErrConcurrentRowUpdate) {
			return lastErr
		}
	}
	return fmt.Errorf("save image metadata after %d attempts: %w", imageMetadataAttempts, lastErr)
}

func (s *ImageService) writeImageMetadataForRefOnce(ref imageFileRef, ownerID, ownerName, visibility string, sharing *ImageVisibilityUpdateOptions, metadataValues ...GeneratedImageMetadata) error {
	meta, err := s.loadImageMetadata(ref.rel)
	if err != nil {
		return err
	}
	if meta.Deleting {
		return errors.New("image is being deleted")
	}
	var finishReferenceReplacement func(bool)
	if ownerID = strings.TrimSpace(ownerID); ownerID != "" {
		meta.OwnerID = ownerID
	}
	if ownerName = strings.TrimSpace(ownerName); ownerName != "" {
		meta.OwnerName = ownerName
	}
	if visibility = strings.TrimSpace(visibility); visibility != "" {
		normalized, err := NormalizeImageVisibility(visibility)
		if err != nil {
			return err
		}
		if normalized == ImageVisibilityPublic {
			if meta.PublishedAt == "" || meta.Visibility != ImageVisibilityPublic {
				meta.PublishedAt = time.Now().UTC().Format(time.RFC3339Nano)
			}
		} else {
			meta.PublishedAt = ""
		}
		meta.Visibility = normalized
	}
	if len(metadataValues) > 0 {
		metadata := metadataValues[0]
		if prompt := strings.TrimSpace(metadata.Prompt); prompt != "" {
			meta.Prompt = prompt
		}
		if source := NormalizeImageGenerationSource(metadata.GenerationSource); source != "" {
			meta.GenerationSource = source
		}
		if model := strings.TrimSpace(metadata.Model); model != "" {
			meta.Model = model
		}
		if quality := strings.TrimSpace(metadata.Quality); quality != "" {
			meta.Quality = quality
		}
		if preset := NormalizeImageResolutionPreset(metadata.ResolutionPreset); preset != "" {
			meta.ResolutionPreset = preset
		}
		if requestedSize := strings.TrimSpace(metadata.RequestedSize); requestedSize != "" {
			meta.RequestedSize = requestedSize
		}
		if outputFormat := normalizeOptionalImageOutputFormat(metadata.OutputFormat); outputFormat != "" && meta.OutputFormat == "" {
			meta.OutputFormat = outputFormat
		}
		if metadata.OutputCompression != nil {
			compression := *metadata.OutputCompression
			if compression < 0 {
				compression = 0
			} else if compression > 100 {
				compression = 100
			}
			meta.OutputCompression = &compression
		}
		if background := strings.TrimSpace(metadata.Background); background != "" {
			meta.Background = background
		}
		if moderation := strings.TrimSpace(metadata.Moderation); moderation != "" {
			meta.Moderation = moderation
		}
		if metadata.PartialImages != nil && *metadata.PartialImages > 0 {
			partialImages := *metadata.PartialImages
			meta.PartialImages = &partialImages
		}
		if len(metadata.ReferenceImages) > 0 {
			references, finish, err := s.writeImageReferencesForRef(ref, metadata.ReferenceImages, meta.ReferenceImages)
			if err != nil {
				return err
			}
			meta.ReferenceImages = references
			finishReferenceReplacement = finish
		}
		if metadata.SharePromptParams || metadata.ShareReferences {
			meta.SharePromptParams = metadata.SharePromptParams
			meta.ShareReferences = metadata.ShareReferences
		}
	}
	if sharing != nil {
		meta.SharePromptParams = sharing.SharePromptParams
		meta.ShareReferences = sharing.ShareReferences
	}
	if meta.Visibility == "" {
		meta.Visibility = ImageVisibilityPrivate
	}
	err = s.writeImageMetadata(ref.rel, meta)
	if finishReferenceReplacement != nil {
		finishReferenceReplacement(err == nil)
	}
	return err
}

func (s *ImageService) writeImageMetadata(rel string, meta imageMetadata) error {
	metaPath, err := s.imageOwnerMetadataPath(rel)
	if err != nil {
		return err
	}
	value := map[string]any{
		"visibility": meta.Visibility,
		"updated_at": time.Now().UTC().Format(time.RFC3339Nano),
	}
	if meta.Deleting {
		value["deleting"] = true
	}
	if meta.OwnerID != "" {
		value["owner_id"] = meta.OwnerID
	}
	if meta.OwnerName != "" {
		value["owner_name"] = meta.OwnerName
	}
	if meta.PublishedAt != "" {
		value["published_at"] = meta.PublishedAt
	}
	if meta.Prompt != "" {
		value["prompt"] = meta.Prompt
	}
	if meta.GenerationSource != "" {
		value["generation_source"] = meta.GenerationSource
	}
	if meta.Model != "" {
		value["model"] = meta.Model
	}
	if meta.Quality != "" {
		value["quality"] = meta.Quality
	}
	if meta.ResolutionPreset != "" {
		value["resolution_preset"] = meta.ResolutionPreset
	}
	if meta.RequestedSize != "" {
		value["requested_size"] = meta.RequestedSize
	}
	if meta.OutputFormat != "" {
		value["output_format"] = meta.OutputFormat
	}
	if meta.OutputCompression != nil {
		value["output_compression"] = *meta.OutputCompression
	}
	if meta.Background != "" {
		value["background"] = meta.Background
	}
	if meta.Moderation != "" {
		value["moderation"] = meta.Moderation
	}
	if meta.PartialImages != nil {
		value["partial_images"] = *meta.PartialImages
	}
	if meta.SharePromptParams {
		value["share_prompt_parameters"] = true
	}
	if meta.ShareReferences {
		value["share_reference_images"] = true
	}
	if len(meta.ReferenceImages) > 0 {
		refs := make([]map[string]any, 0, len(meta.ReferenceImages))
		for _, ref := range meta.ReferenceImages {
			if ref.Path == "" {
				continue
			}
			item := map[string]any{"path": ref.Path}
			if ref.Filename != "" {
				item["filename"] = ref.Filename
			}
			if ref.ContentType != "" {
				item["content_type"] = ref.ContentType
			}
			if ref.Size > 0 {
				item["size"] = ref.Size
			}
			refs = append(refs, item)
		}
		if len(refs) > 0 {
			value["reference_images"] = refs
		}
	}
	if meta.Width > 0 && meta.Height > 0 {
		value["width"] = meta.Width
		value["height"] = meta.Height
	}
	if s.store != nil {
		return s.store.SaveJSONDocument(imageOwnerDocumentName(rel), value)
	}
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o755); err != nil {
		return err
	}
	return writeJSONFile(metaPath, value)
}

func (s *ImageService) imageReferencesDir() string {
	return filepath.Join(s.config.ImageMetadataDir(), imageReferencePrefix)
}

func (s *ImageService) writeImageReferencesForRef(ref imageFileRef, refs []GeneratedImageReference, previous []imageReferenceMetadata) ([]imageReferenceMetadata, func(bool), error) {
	if len(refs) == 0 {
		return nil, nil, nil
	}
	root, err := filepath.Abs(s.imageReferencesDir())
	if err != nil {
		return nil, nil, err
	}
	generation := util.NewHex(8)
	dirRel := filepath.ToSlash(filepath.Join(ref.rel+".refs", generation))
	dir := filepath.Join(root, filepath.FromSlash(dirRel))
	if !pathInsideRoot(root, dir) {
		return nil, nil, errors.New("invalid image reference path")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	cleanupGeneration := func() {
		_ = os.RemoveAll(dir)
		removeEmptyParentDirs(root, filepath.Dir(dir))
	}
	result := make([]imageReferenceMetadata, 0, len(refs))
	for index, source := range refs {
		if len(source.Data) == 0 {
			continue
		}
		info, inspectErr := util.InspectRasterImage(source.Data, "image/png", "image/jpeg", "image/webp", "image/gif")
		if inspectErr != nil || len(source.Data) > util.MaxRasterImageEncodedBytes {
			continue
		}
		filename := safeImageReferenceFilename(source.Filename, index)
		baseName := strings.TrimSuffix(filename, filepath.Ext(filename))
		if baseName == "" {
			baseName = "reference-" + strconv.Itoa(index+1)
		}
		filename = baseName + "." + imageReferenceStorageExtension(info.Format)
		rel := filepath.ToSlash(filepath.Join(dirRel, strconv.Itoa(index+1)+"-"+filename))
		if _, err := cleanImageReferenceRelativePath(rel); err != nil {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(rel))
		if !pathInsideRoot(root, path) || !pathInsideRoot(dir, path) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			cleanupGeneration()
			return nil, nil, err
		}
		if err := os.WriteFile(path, source.Data, 0o644); err != nil {
			cleanupGeneration()
			return nil, nil, err
		}
		result = append(result, imageReferenceMetadata{
			Path:        rel,
			Filename:    strings.TrimSpace(source.Filename),
			ContentType: info.ContentType,
			Size:        int64(len(source.Data)),
		})
	}
	if len(result) == 0 {
		cleanupGeneration()
	}
	finish := func(committed bool) {
		if !committed {
			cleanupGeneration()
			return
		}
		removeImageReferenceMetadataFiles(root, previous)
	}
	return result, finish, nil
}

func removeImageReferenceMetadataFiles(root string, references []imageReferenceMetadata) {
	for _, reference := range references {
		rel, err := cleanImageReferenceRelativePath(reference.Path)
		if err != nil {
			continue
		}
		filePath := filepath.Join(root, filepath.FromSlash(rel))
		if !pathInsideRoot(root, filePath) {
			continue
		}
		if err := os.Remove(filePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			continue
		}
		removeEmptyParentDirs(root, filepath.Dir(filePath))
	}
}

func imageReferenceStorageExtension(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "jpg":
		return "jpg"
	case "gif":
		return "gif"
	case "webp":
		return "webp"
	default:
		return "png"
	}
}

func (s *ImageService) imageCleanupCandidates() ([]imageCleanupCandidate, error) {
	root, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return nil, err
	}
	candidates := make([]imageCleanupCandidate, 0)
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if path == root && !d.IsDir() {
			return fmt.Errorf("image storage root is not a directory: %s", root)
		}
		if d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		info, statErr := d.Info()
		if statErr != nil {
			if errors.Is(statErr, os.ErrNotExist) {
				return nil
			}
			return statErr
		}
		meta, metaErr := s.loadImageMetadata(rel)
		if metaErr != nil {
			return metaErr
		}
		groupSize, groupErr := s.imageGroupSize(rel, storedImageSize(info))
		if groupErr != nil {
			return groupErr
		}
		candidates = append(candidates, imageCleanupCandidate{
			rel:       rel,
			path:      path,
			info:      info,
			meta:      meta,
			groupSize: groupSize,
		})
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, os.ErrNotExist) {
		return candidates, walkErr
	}
	return candidates, nil
}

func (s *ImageService) cleanupByRetention(retentionDays int, includePublic bool) (imageStorageRemovalStats, int, error) {
	if retentionDays < 1 {
		retentionDays = 1
	}
	if retentionDays > maxImageRetentionDays {
		retentionDays = maxImageRetentionDays
	}
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	var total imageStorageRemovalStats
	preservedPublic := 0
	candidates, err := s.imageCleanupCandidates()
	if err != nil {
		return total, preservedPublic, err
	}
	for _, candidate := range candidates {
		if !storedImageTime(candidate.info).Before(cutoff) {
			continue
		}
		stats, claimed, err := s.removeImageGroupIf(candidate.rel, func(meta imageMetadata) bool {
			return includePublic || meta.Visibility != ImageVisibilityPublic
		})
		if err != nil {
			return total, preservedPublic, err
		}
		if !claimed {
			preservedPublic++
			continue
		}
		total.add(stats)
	}
	return total, preservedPublic, nil
}

func (s *ImageService) cleanupByStorageLimit(maxBytes int64, includePublic bool) (imageStorageRemovalStats, int, error) {
	if maxBytes <= 0 {
		return imageStorageRemovalStats{}, 0, nil
	}
	summary, err := s.StorageGovernance()
	if err != nil {
		return imageStorageRemovalStats{}, 0, err
	}
	if summary.TotalBytes <= maxBytes {
		return imageStorageRemovalStats{}, 0, nil
	}
	candidates, err := s.imageCleanupCandidates()
	if err != nil {
		return imageStorageRemovalStats{}, 0, err
	}
	sort.Slice(candidates, func(i, j int) bool {
		leftPublic := candidates[i].meta.Visibility == ImageVisibilityPublic
		rightPublic := candidates[j].meta.Visibility == ImageVisibilityPublic
		if leftPublic != rightPublic {
			return !leftPublic
		}
		return storedImageTime(candidates[i].info).Before(storedImageTime(candidates[j].info))
	})
	current := summary.TotalBytes
	var total imageStorageRemovalStats
	preservedPublic := 0
	for _, candidate := range candidates {
		if current <= maxBytes {
			break
		}
		stats, claimed, err := s.removeImageGroupIf(candidate.rel, func(meta imageMetadata) bool {
			return includePublic || meta.Visibility != ImageVisibilityPublic
		})
		if err != nil {
			return total, preservedPublic, err
		}
		if !claimed {
			preservedPublic++
			continue
		}
		total.add(stats)
		if stats.bytes > 0 {
			current -= stats.bytes
		} else {
			current -= candidate.groupSize
		}
	}
	return total, preservedPublic, nil
}

func (s *ImageService) removeImageGroupIf(rel string, allowed func(imageMetadata) bool) (imageStorageRemovalStats, bool, error) {
	rel, err := cleanImageRelativePath(rel)
	if err != nil {
		return imageStorageRemovalStats{}, false, err
	}
	s.metadataMu.Lock()
	defer s.metadataMu.Unlock()
	return s.removeImageGroupIfLocked(rel, allowed)
}

func (s *ImageService) removeImageGroupIfLocked(rel string, allowed func(imageMetadata) bool) (imageStorageRemovalStats, bool, error) {
	var stats imageStorageRemovalStats
	_, claimed, err := s.markImageDeletingLocked(rel, allowed)
	if err != nil {
		return stats, false, err
	}
	if !claimed {
		return stats, false, nil
	}
	if removed, bytes, err := s.removeImageReferencesWithStats(rel); err != nil {
		return stats, true, err
	} else {
		stats.referenceFiles += removed
		stats.bytes += bytes
	}
	imageRoot, err := filepath.Abs(s.config.ImagesDir())
	if err != nil {
		return stats, true, err
	}
	imagePath := filepath.Join(imageRoot, filepath.FromSlash(rel))
	if !pathInsideRoot(imageRoot, imagePath) {
		return stats, true, errors.New("invalid image path")
	}
	if removed, bytes, err := removeFileWithStats(imagePath); err != nil {
		return stats, true, err
	} else if removed {
		stats.images++
		stats.bytes += bytes
	}
	removeEmptyParentDirs(imageRoot, filepath.Dir(imagePath))
	thumbnailRoot, err := filepath.Abs(s.config.ImageThumbnailsDir())
	if err != nil {
		return stats, true, err
	}
	if removed, bytes, err := s.removeImageThumbnailWithStats(thumbnailRoot, rel); err != nil {
		return stats, true, err
	} else if removed > 0 {
		stats.thumbnails++
		if removed > 1 {
			stats.metadataFiles += removed - 1
		}
		stats.bytes += bytes
	}
	if removed, bytes, err := s.removeImageOwnerWithStats(rel); err != nil {
		return stats, true, err
	} else {
		stats.metadataFiles += removed
		stats.bytes += bytes
	}
	return stats, true, nil
}

func (s *ImageService) markImageDeletingLocked(rel string, allowed func(imageMetadata) bool) (imageMetadata, bool, error) {
	var lastErr error
	for attempt := 0; attempt < imageMetadataAttempts; attempt++ {
		meta, err := s.loadImageMetadata(rel)
		if err != nil {
			return imageMetadata{}, false, err
		}
		if meta.Deleting {
			return meta, true, nil
		}
		if allowed != nil && !allowed(meta) {
			return meta, false, nil
		}
		meta.Deleting = true
		lastErr = s.writeImageMetadata(rel, meta)
		if lastErr == nil {
			return meta, true, nil
		}
		if !errors.Is(lastErr, storage.ErrConcurrentRowUpdate) {
			return imageMetadata{}, false, lastErr
		}
	}
	return imageMetadata{}, false, fmt.Errorf("mark image deleting after %d attempts: %w", imageMetadataAttempts, lastErr)
}

func (s *ImageService) removeImageOwnerWithStats(rel string) (int, int64, error) {
	if s.store != nil {
		var lastErr error
		for attempt := 0; attempt < imageMetadataAttempts; attempt++ {
			lastErr = s.store.DeleteJSONDocument(imageOwnerDocumentName(rel))
			if lastErr == nil {
				return 1, 0, nil
			}
			if !errors.Is(lastErr, storage.ErrConcurrentRowUpdate) {
				return 0, 0, lastErr
			}
			value, loadErr := s.store.LoadJSONDocument(imageOwnerDocumentName(rel))
			if loadErr != nil {
				return 0, 0, loadErr
			}
			if value == nil {
				return 0, 0, nil
			}
		}
		return 0, 0, fmt.Errorf("delete image metadata after %d attempts: %w", imageMetadataAttempts, lastErr)
	}
	metaPath, err := s.imageOwnerMetadataPath(rel)
	if err != nil {
		return 0, 0, err
	}
	removed, bytes, err := removeFileWithStats(metaPath)
	if err != nil {
		return 0, 0, err
	}
	if removed {
		removeEmptyParentDirs(s.config.ImageMetadataDir(), filepath.Dir(metaPath))
		return 1, bytes, nil
	}
	return 0, 0, nil
}

func (s *ImageService) removeImageReferencesWithStats(sourceRel string) (int, int64, error) {
	sourceRel, err := cleanImageRelativePath(sourceRel)
	if err != nil {
		return 0, 0, err
	}
	root, err := filepath.Abs(s.imageReferencesDir())
	if err != nil {
		return 0, 0, err
	}
	dir := filepath.Join(root, filepath.FromSlash(sourceRel+".refs"))
	if !pathInsideRoot(root, dir) {
		return 0, 0, errors.New("invalid image path")
	}
	bytes, files, err := directorySize(dir, "")
	if err != nil {
		return 0, 0, err
	}
	removeErr := os.RemoveAll(dir)
	if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return 0, 0, removeErr
	}
	removeEmptyParentDirs(root, filepath.Dir(dir))
	return files, bytes, nil
}

func (s *ImageService) removeImageThumbnailWithStats(root, rel string) (int, int64, error) {
	thumbPath := filepath.Join(root, filepath.FromSlash(rel)+thumbnailExtension)
	if !pathInsideRoot(root, thumbPath) {
		return 0, 0, errors.New("invalid image path")
	}
	removed := 0
	var bytes int64
	if didRemove, size, err := removeFileWithStats(thumbPath); err != nil {
		return 0, 0, err
	} else if didRemove {
		removed++
		bytes += size
	}
	if didRemove, size, err := removeFileWithStats(thumbPath + ".json"); err != nil {
		return 0, 0, err
	} else if didRemove {
		removed++
		bytes += size
	}
	if s.store != nil {
		if err := s.store.DeleteJSONDocument(thumbnailMetadataDocumentName(rel)); err != nil {
			return 0, 0, err
		}
	}
	removeEmptyParentDirs(root, filepath.Dir(thumbPath))
	return removed, bytes, nil
}

func (s *ImageService) clearThumbnailCache() (imageStorageRemovalStats, error) {
	root := s.config.ImageThumbnailsDir()
	bytes, thumbnails, metadataFiles, err := thumbnailCacheStats(root)
	if err != nil {
		return imageStorageRemovalStats{}, err
	}
	if err := os.RemoveAll(root); err != nil && !errors.Is(err, os.ErrNotExist) {
		return imageStorageRemovalStats{}, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return imageStorageRemovalStats{}, err
	}
	return imageStorageRemovalStats{bytes: bytes, thumbnails: thumbnails, metadataFiles: metadataFiles}, nil
}

func (s *ImageService) imageGroupSize(rel string, imageSize int64) (int64, error) {
	total := imageSize
	thumbPath := s.thumbnailPath(rel)
	for _, path := range []string{thumbPath, thumbPath + ".json"} {
		info, err := os.Stat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return 0, err
		}
		if !info.IsDir() {
			total += info.Size()
		}
	}
	metaPath, err := s.imageOwnerMetadataPath(rel)
	if err != nil {
		return 0, err
	}
	info, statErr := os.Stat(metaPath)
	if statErr != nil {
		if !errors.Is(statErr, os.ErrNotExist) {
			return 0, statErr
		}
	} else if !info.IsDir() {
		total += info.Size()
	}
	refDir := filepath.Join(s.imageReferencesDir(), filepath.FromSlash(rel+".refs"))
	refBytes, _, err := directorySize(refDir, "")
	if err != nil {
		return 0, err
	}
	total += refBytes
	return total, nil
}

func (s *ImageService) imageOwnerMetadataPath(rel string) (string, error) {
	rel, err := cleanImageRelativePath(rel)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(s.config.ImageMetadataDir())
	if err != nil {
		return "", err
	}
	metaPath := filepath.Join(root, filepath.FromSlash(rel)+".json")
	if !pathInsideRoot(root, metaPath) {
		return "", errors.New("invalid image path")
	}
	return metaPath, nil
}

func (s *ImageService) readThumbnailMetadata(rel, metaPath string, sourceMtime time.Time) (map[string]any, error) {
	if s.store != nil {
		raw, err := s.store.LoadJSONDocument(thumbnailMetadataDocumentName(rel))
		if err != nil {
			return nil, err
		}
		if raw != nil {
			meta, ok := raw.(map[string]any)
			if !ok {
				return nil, errors.New("thumbnail metadata is not an object")
			}
			if meta["width"] != nil && meta["height"] != nil {
				return meta, nil
			}
		}
	}
	return readImageMetadata(metaPath, sourceMtime)
}

func (s *ImageService) writeThumbnailMetadata(rel, metaPath string, value map[string]any) error {
	meta, err := s.loadImageMetadata(rel)
	if err != nil {
		return err
	}
	if meta.Deleting {
		return errors.New("image is being deleted")
	}
	if s.store != nil {
		return s.store.SaveJSONDocument(thumbnailMetadataDocumentName(rel), value)
	}
	return writeJSONFile(metaPath, value)
}

func imageOwnerDocumentName(rel string) string {
	return "image_metadata/" + filepath.ToSlash(rel) + ".json"
}

type imageMetadataFieldOptions struct {
	BaseURL                string
	IncludeReusableFields  bool
	IncludeReferenceImages bool
}

func addImageMetadataFields(item map[string]any, meta imageMetadata, optionsValues ...imageMetadataFieldOptions) {
	options := imageMetadataFieldOptions{IncludeReusableFields: true, IncludeReferenceImages: true}
	if len(optionsValues) > 0 {
		options = optionsValues[0]
	}
	if meta.OwnerID != "" {
		item["owner_id"] = meta.OwnerID
	}
	if meta.OwnerName != "" {
		item["owner_name"] = meta.OwnerName
	}
	if meta.PublishedAt != "" {
		item["published_at"] = meta.PublishedAt
	}
	item["share_prompt_parameters"] = meta.SharePromptParams
	item["share_reference_images"] = meta.ShareReferences
	if meta.GenerationSource != "" {
		item["generation_source"] = meta.GenerationSource
	}
	if options.IncludeReusableFields {
		if meta.Prompt != "" {
			item["prompt"] = meta.Prompt
		}
		if meta.Model != "" {
			item["model"] = meta.Model
		}
		if meta.Quality != "" {
			item["quality"] = meta.Quality
		}
		if meta.ResolutionPreset != "" {
			item["resolution_preset"] = meta.ResolutionPreset
		}
		if meta.RequestedSize != "" {
			item["requested_size"] = meta.RequestedSize
		}
		if meta.OutputFormat != "" {
			item["output_format"] = meta.OutputFormat
		}
		if meta.OutputCompression != nil {
			item["output_compression"] = *meta.OutputCompression
		}
		if meta.Background != "" {
			item["background"] = meta.Background
		}
		if meta.Moderation != "" {
			item["moderation"] = meta.Moderation
		}
		if meta.PartialImages != nil {
			item["partial_images"] = *meta.PartialImages
		}
	}
	if options.IncludeReferenceImages && len(meta.ReferenceImages) > 0 {
		baseURL := strings.TrimSpace(options.BaseURL)
		referenceItems := make([]map[string]any, 0, len(meta.ReferenceImages))
		referenceURLs := make([]string, 0, len(meta.ReferenceImages))
		for _, ref := range meta.ReferenceImages {
			if ref.Path == "" {
				continue
			}
			refItem := map[string]any{"path": ref.Path}
			if ref.Filename != "" {
				refItem["filename"] = ref.Filename
			}
			if ref.ContentType != "" {
				refItem["content_type"] = ref.ContentType
			}
			if ref.Size > 0 {
				refItem["size"] = ref.Size
			}
			if baseURL != "" {
				url := publicAssetURL(baseURL, "image-references", ref.Path)
				refItem["url"] = url
				referenceURLs = append(referenceURLs, url)
			}
			referenceItems = append(referenceItems, refItem)
		}
		if len(referenceItems) > 0 {
			item["reference_images"] = referenceItems
		}
		if len(referenceURLs) > 0 {
			item["reference_image_urls"] = referenceURLs
		}
	}
}

func NormalizeImageVisibility(value string) (string, error) {
	switch strings.TrimSpace(value) {
	case "", ImageVisibilityPrivate:
		return ImageVisibilityPrivate, nil
	case ImageVisibilityPublic:
		return ImageVisibilityPublic, nil
	default:
		return "", errors.New("visibility must be private or public")
	}
}

func NormalizeImageResolutionPreset(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "512", "512px", "0.5k":
		return "512"
	case "1k":
		return "1k"
	case "1080p":
		return "1080p"
	case "2k":
		return "2k"
	case "4k":
		return "4k"
	default:
		return ""
	}
}

func imageDay(rel string, modTime time.Time) string {
	parts := strings.Split(rel, "/")
	if len(parts) >= 4 {
		return strings.Join(parts[:3], "-")
	}
	return modTime.Format("2006-01-02")
}

func thumbnailMetadataDocumentName(rel string) string {
	return "image_thumbnails/" + filepath.ToSlash(rel) + thumbnailExtension + ".json"
}

func sourceImageRelativePathFromThumbnail(value string) (string, error) {
	thumbnailRel, err := cleanImageRelativePath(value)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(thumbnailRel, thumbnailExtension) {
		return "", errors.New("invalid thumbnail path")
	}
	return cleanImageRelativePath(strings.TrimSuffix(thumbnailRel, thumbnailExtension))
}

func setImageItemDimensions(item map[string]any, widthValue, heightValue any) bool {
	width, height, ok := imageDimensionsFromValues(widthValue, heightValue)
	if !ok {
		return false
	}
	item["width"] = width
	item["height"] = height
	item["resolution"] = strconv.Itoa(width) + "x" + strconv.Itoa(height)
	item["aspect_ratio"] = simplifiedAspectRatio(width, height)
	item["orientation"] = imageOrientation(width, height)
	item["megapixels"] = float64(width) * float64(height) / 1_000_000
	return true
}

func imageDimensionsFromValues(widthValue, heightValue any) (int, int, bool) {
	width := numericMetaValue(widthValue)
	height := numericMetaValue(heightValue)
	if width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func imageFileDimensions(path string) (int, int, bool) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer file.Close()
	config, _, err := image.DecodeConfig(file)
	if err != nil || util.ValidateRasterImageDimensions(config.Width, config.Height) != nil {
		return 0, 0, false
	}
	return config.Width, config.Height, true
}

func simplifiedAspectRatio(width, height int) string {
	divisor := greatestCommonDivisor(width, height)
	if divisor <= 0 {
		return ""
	}
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

func imageOrientation(width, height int) string {
	if width == height {
		return "square"
	}
	if width > height {
		return "landscape"
	}
	return "portrait"
}

func greatestCommonDivisor(a, b int) int {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func thumbnailRelativePath(root, thumbPath string) string {
	rel, err := filepath.Rel(root, thumbPath)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

func publicAssetURL(baseURL, prefix, rel string) string {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.TrimRight(baseURL, "/") + "/" + strings.Trim(prefix, "/") + "/" + strings.Join(parts, "/")
}

func thumbnailURL(baseURL, thumbRel string, sourceModTime time.Time) string {
	return publicAssetURL(baseURL, "image-thumbnails", thumbRel) +
		"?v=" + strconv.Itoa(thumbnailCacheVersion) + "-" + strconv.FormatInt(sourceModTime.UnixNano(), 10)
}

func cleanImageRelativePath(value string) (string, error) {
	rel := filepath.ToSlash(strings.TrimSpace(value))
	if rel == "" || strings.ContainsRune(rel, 0) || strings.HasPrefix(rel, "/") || filepath.IsAbs(filepath.FromSlash(rel)) {
		return "", errors.New("invalid image path")
	}
	if path.Clean(rel) != rel {
		return "", errors.New("invalid image path")
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, ":") {
			return "", errors.New("invalid image path")
		}
	}
	return rel, nil
}

func imageRelativePathFromValue(value string) (string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", errors.New("invalid image path")
	}
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		if parsed.Scheme != "" || strings.HasPrefix(pathValue, "/") {
			for _, candidate := range []struct {
				prefix    string
				thumbnail bool
			}{
				{prefix: "/images/"},
				{prefix: "/image-thumbnails/", thumbnail: true},
			} {
				index := strings.Index(pathValue, candidate.prefix)
				if index < 0 {
					continue
				}
				rel, err := url.PathUnescape(pathValue[index+len(candidate.prefix):])
				if err != nil {
					return "", errors.New("invalid image path")
				}
				if candidate.thumbnail {
					return sourceImageRelativePathFromThumbnail(rel)
				}
				return cleanImageRelativePath(rel)
			}
			return "", errors.New("invalid image path")
		}
	}
	return cleanImageRelativePath(text)
}

func cleanImageReferenceRelativePath(value string) (string, error) {
	rel, err := cleanImageRelativePath(value)
	if err != nil {
		return "", err
	}
	if _, err := sourceImageRelativePathFromReference(rel); err != nil {
		return "", err
	}
	return rel, nil
}

func imageReferenceRelativePathFromValue(value string) (string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", errors.New("invalid image path")
	}
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		if parsed.Scheme != "" || strings.HasPrefix(pathValue, "/") {
			const imageReferencePrefix = "/image-references/"
			index := strings.Index(pathValue, imageReferencePrefix)
			if index < 0 {
				return "", errors.New("invalid image path")
			}
			rel, err := url.PathUnescape(pathValue[index+len(imageReferencePrefix):])
			if err != nil {
				return "", errors.New("invalid image path")
			}
			return cleanImageReferenceRelativePath(rel)
		}
	}
	return cleanImageReferenceRelativePath(text)
}

func sourceImageRelativePathFromReference(value string) (string, error) {
	rel, err := cleanImageRelativePath(value)
	if err != nil {
		return "", err
	}
	index := strings.LastIndex(rel, imageReferenceMarker)
	if index <= 0 || index+len(imageReferenceMarker) >= len(rel) {
		return "", errors.New("invalid image path")
	}
	return cleanImageRelativePath(rel[:index])
}

func normalizeImageReferenceMetadata(value any) []imageReferenceMetadata {
	items := util.AsMapSlice(value)
	if len(items) == 0 {
		return nil
	}
	refs := make([]imageReferenceMetadata, 0, len(items))
	for _, item := range items {
		rel, err := cleanImageReferenceRelativePath(toString(item["path"]))
		if err != nil {
			continue
		}
		refs = append(refs, imageReferenceMetadata{
			Path:        rel,
			Filename:    strings.TrimSpace(toString(item["filename"])),
			ContentType: strings.TrimSpace(toString(item["content_type"])),
			Size:        int64(numericMetaValue(item["size"])),
		})
	}
	return refs
}

func safeImageReferenceFilename(value string, index int) string {
	name := filepath.Base(filepath.ToSlash(strings.TrimSpace(value)))
	if name == "." || name == "/" || name == "" {
		name = "reference-" + strconv.Itoa(index+1) + ".png"
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	clean := strings.Trim(b.String(), ".- _")
	if clean == "" {
		clean = "reference-" + strconv.Itoa(index+1) + ".png"
	}
	if !strings.Contains(filepath.Base(clean), ".") {
		clean += ".png"
	}
	if len(clean) > 96 {
		ext := filepath.Ext(clean)
		stem := strings.TrimSuffix(clean, ext)
		limit := 96 - len(ext)
		if limit < 1 {
			return clean[:96]
		}
		if len(stem) > limit {
			stem = stem[:limit]
		}
		clean = stem + ext
	}
	return clean
}

func (s *imageStorageRemovalStats) add(next imageStorageRemovalStats) {
	s.bytes += next.bytes
	s.images += next.images
	s.thumbnails += next.thumbnails
	s.metadataFiles += next.metadataFiles
	s.referenceFiles += next.referenceFiles
}

func removeFileWithStats(path string) (bool, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, err
	}
	if info.IsDir() {
		return false, 0, nil
	}
	size := info.Size()
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, err
	}
	return true, size, nil
}

func directorySize(root, skipPrefix string) (int64, int, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return 0, 0, nil
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return 0, 0, err
	}
	root = absRoot
	if skipPrefix != "" {
		abs, err := filepath.Abs(skipPrefix)
		if err != nil {
			return 0, 0, err
		}
		skipPrefix = abs
	}
	var total int64
	files := 0
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if path == root && !d.IsDir() {
			return fmt.Errorf("storage directory is not a directory: %s", root)
		}
		if skipPrefix != "" {
			abs, absErr := filepath.Abs(path)
			if absErr != nil {
				return absErr
			}
			if abs == skipPrefix || strings.HasPrefix(abs, skipPrefix+string(os.PathSeparator)) {
				if d.IsDir() && abs != root {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if d.IsDir() {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			if errors.Is(statErr, os.ErrNotExist) {
				return nil
			}
			return statErr
		}
		total += info.Size()
		files++
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, os.ErrNotExist) {
		return total, files, walkErr
	}
	return total, files, nil
}

func thumbnailCacheStats(root string) (int64, int, int, error) {
	var bytes int64
	thumbnails := 0
	metadataFiles := 0
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if path == root && !d.IsDir() {
			return fmt.Errorf("thumbnail cache root is not a directory: %s", root)
		}
		if d.IsDir() {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			if errors.Is(statErr, os.ErrNotExist) {
				return nil
			}
			return statErr
		}
		bytes += info.Size()
		if strings.HasSuffix(path, ".json") {
			metadataFiles++
		} else {
			thumbnails++
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, os.ErrNotExist) {
		return bytes, thumbnails, metadataFiles, walkErr
	}
	return bytes, thumbnails, metadataFiles, nil
}

func writeJPEGThumbnail(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	encodeErr := jpeg.Encode(tmp, img, &jpeg.Options{Quality: thumbnailQuality})
	closeErr := tmp.Close()
	if encodeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		if encodeErr != nil {
			return encodeErr
		}
		return closeErr
	}
	if err := os.Rename(tmpPath, path); err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			_ = os.Remove(tmpPath)
			return err
		}
		if renameErr := os.Rename(tmpPath, path); renameErr != nil {
			_ = os.Remove(tmpPath)
			return renameErr
		}
	}
	return nil
}

func pathInsideRoot(root, target string) bool {
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, targetAbs)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func removeEmptyParentDirs(root, start string) {
	current, err := filepath.Abs(start)
	if err != nil {
		return
	}
	for pathInsideRoot(root, current) {
		err := os.Remove(current)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return
		}
		current = filepath.Dir(current)
	}
}

func readImageMetadata(path string, sourceMtime time.Time) (map[string]any, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("image metadata path is not a file")
	}
	if info.ModTime().Before(sourceMtime) {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var meta map[string]any
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	if meta["width"] == nil || meta["height"] == nil {
		return nil, nil
	}
	return meta, nil
}

func isCurrentThumbnailMetadata(meta map[string]any) bool {
	return numericMetaValue(meta["thumbnail_version"]) == thumbnailCacheVersion &&
		numericMetaValue(meta["thumbnail_size"]) == ThumbnailSize &&
		numericMetaValue(meta["thumbnail_quality"]) == thumbnailQuality
}

func numericMetaValue(value any) int {
	n, _ := imageMetadataIntValue(value)
	return n
}

func imageMetadataIntValue(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return int(n), true
		}
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return 0, false
		}
		n, err := strconv.Atoi(text)
		if err == nil {
			return n, true
		}
	default:
		return 0, false
	}
	return 0, false
}

func imageOutputCompressionMetadata(value any) *int {
	compression, ok := imageMetadataIntValue(value)
	if !ok {
		return nil
	}
	if compression < 0 {
		compression = 0
	} else if compression > 100 {
		compression = 100
	}
	return &compression
}

func positiveImageMetadataInt(value any) *int {
	count, ok := imageMetadataIntValue(value)
	if !ok {
		return nil
	}
	if count <= 0 {
		return nil
	}
	return &count
}

func boolMetadataValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		default:
			return false
		}
	case float64:
		return v != 0
	case int:
		return v != 0
	case json.Number:
		n, err := v.Int64()
		return err == nil && n != 0
	default:
		return false
	}
}

func flattenImage(src image.Image) image.Image {
	b := src.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, b, src, b.Min, draw.Over)
	return dst
}

func resizeToFit(src image.Image, maxW, maxH int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return src
	}
	scale := float64(maxW) / float64(w)
	if sh := float64(maxH) / float64(h); sh < scale {
		scale = sh
	}
	if scale > 1 {
		scale = 1
	}
	nw, nh := int(float64(w)*scale), int(float64(h)*scale)
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		fy := (float64(y)+0.5)*float64(h)/float64(nh) - 0.5
		y0 := int(fy)
		dy := fy - float64(y0)
		if y0 < 0 {
			y0 = 0
			dy = 0
		}
		y1 := y0 + 1
		if y1 >= h {
			y1 = h - 1
		}
		for x := 0; x < nw; x++ {
			fx := (float64(x)+0.5)*float64(w)/float64(nw) - 0.5
			x0 := int(fx)
			dx := fx - float64(x0)
			if x0 < 0 {
				x0 = 0
				dx = 0
			}
			x1 := x0 + 1
			if x1 >= w {
				x1 = w - 1
			}
			dst.Set(x, y, bilinearColor(
				src.At(b.Min.X+x0, b.Min.Y+y0),
				src.At(b.Min.X+x1, b.Min.Y+y0),
				src.At(b.Min.X+x0, b.Min.Y+y1),
				src.At(b.Min.X+x1, b.Min.Y+y1),
				dx,
				dy,
			))
		}
	}
	return dst
}

func bilinearColor(c00, c10, c01, c11 color.Color, dx, dy float64) color.RGBA {
	r00, g00, b00, a00 := c00.RGBA()
	r10, g10, b10, a10 := c10.RGBA()
	r01, g01, b01, a01 := c01.RGBA()
	r11, g11, b11, a11 := c11.RGBA()
	return color.RGBA{
		R: uint8(bilinearChannel(r00, r10, r01, r11, dx, dy) >> 8),
		G: uint8(bilinearChannel(g00, g10, g01, g11, dx, dy) >> 8),
		B: uint8(bilinearChannel(b00, b10, b01, b11, dx, dy) >> 8),
		A: uint8(bilinearChannel(a00, a10, a01, a11, dx, dy) >> 8),
	}
}

func bilinearChannel(c00, c10, c01, c11 uint32, dx, dy float64) uint32 {
	top := float64(c00)*(1-dx) + float64(c10)*dx
	bottom := float64(c01)*(1-dx) + float64(c11)*dx
	return uint32(top*(1-dy) + bottom*dy + 0.5)
}

func writeJSONFile(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
