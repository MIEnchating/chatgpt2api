package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

func storeConversationAsset(assets *ImageConversationAssetService, ownerID, filename string, data []byte) (ImageConversationAsset, error) {
	contentType, extension, err := validateImageConversationAsset(data)
	if err != nil {
		return ImageConversationAsset{}, err
	}
	return assets.StoreValidatedContext(context.Background(), ownerID, filename, &ValidatedImageConversationAsset{
		service: assets, data: data, contentType: contentType, extension: extension,
	})
}

func assetizeConversationReference(assets *ImageConversationAssetService, ctx context.Context, ownerID string, item map[string]any) (map[string]any, bool, error) {
	return assets.assetizeReference(ctx, ownerID, item, true, nil)
}

func storeConversationAssetReader(assets *ImageConversationAssetService, ctx context.Context, ownerID, filename string, reader *bytes.Reader) (ImageConversationAsset, error) {
	validated, err := assets.ReadValidatedReader(ctx, reader)
	if err != nil {
		return ImageConversationAsset{}, err
	}
	return assets.StoreValidatedContext(ctx, ownerID, filename, validated)
}

func mustImageConversationAssetGovernance(t *testing.T, assets *ImageConversationAssetService) ImageConversationAssetGovernance {
	t.Helper()
	usage, err := assets.Governance()
	if err != nil {
		t.Fatalf("Governance() error = %v", err)
	}
	return usage
}

func TestImageConversationAssetServiceStoresPrivateContentAddressedAsset(t *testing.T) {
	root := t.TempDir()
	assets := NewImageConversationAssetService(root)
	data := imageConversationAssetTestPNG(t)

	first, err := storeConversationAsset(assets, "owner-a", "first.png", data)
	if err != nil {
		t.Fatalf("Store(first) error = %v", err)
	}
	second, err := storeConversationAsset(assets, "owner-a", "renamed.png", data)
	if err != nil {
		t.Fatalf("Store(second) error = %v", err)
	}
	if first.AssetPath != second.AssetPath || first.URL != first.DataURL || !strings.HasPrefix(first.URL, ImageConversationAssetURLPrefix) {
		t.Fatalf("content-addressed assets = first %#v second %#v", first, second)
	}
	if first.Type != "image/png" || first.Size != int64(len(data)) || first.Name != "first.png" {
		t.Fatalf("stored asset metadata = %#v", first)
	}

	access, err := assets.Access(first.URL, "owner-a", false)
	if err != nil || access.AssetPath != first.AssetPath || access.ContentType != "image/png" {
		t.Fatalf("Access(owner) = %#v, %v", access, err)
	}
	if _, err := assets.Access(first.URL, "owner-b", false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("Access(other owner) error = %v", err)
	}
	if _, err := assets.Access(first.URL, "", true); err != nil {
		t.Fatalf("Access(admin) error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 1 || usage.TotalBytes != int64(len(data)) {
		t.Fatalf("Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceAssetizesDataURLAndKeepsCompatibilityField(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	data := imageConversationAssetTestPNG(t)
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	item := map[string]any{
		"name": "reference.png", "type": "image/png", "source": "upload", "dataUrl": dataURL,
	}

	next, changed, err := assetizeConversationReference(assets, context.Background(), "owner-a", item)
	if err != nil || !changed {
		t.Fatalf("AssetizeReference(data URL) = %#v, %v, %v", next, changed, err)
	}
	managedURL, _ := next["dataUrl"].(string)
	if !strings.HasPrefix(managedURL, ImageConversationAssetURLPrefix) || next["url"] != managedURL || next["assetPath"] == "" {
		t.Fatalf("assetized reference = %#v", next)
	}
	if strings.Contains(managedURL, "base64") || strings.Contains(managedURL, "data:") {
		t.Fatalf("assetized dataUrl still embeds data: %q", managedURL)
	}

	replayed, replayChanged, err := assetizeConversationReference(assets, context.Background(), "owner-a", next)
	if err != nil || replayChanged || replayed["dataUrl"] != managedURL {
		t.Fatalf("AssetizeReference(replay) = %#v, %v, %v", replayed, replayChanged, err)
	}
	if _, _, err := assetizeConversationReference(assets, context.Background(), "owner-b", next); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("AssetizeReference(other owner) error = %v", err)
	}
}

func TestImageConversationAssetServiceRejectsInvalidFilesAndDeclaredTypeMismatch(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	if _, err := storeConversationAsset(assets, "owner", "fake.png", []byte("not an image")); !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("Store(fake) error = %v", err)
	}
	pngData := imageConversationAssetTestPNG(t)
	badDataURL := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(pngData)
	if _, _, err := assetizeConversationReference(assets, context.Background(), "owner", map[string]any{"dataUrl": badDataURL}); !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("AssetizeReference(mismatch) error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 {
		t.Fatalf("invalid asset left files behind: %#v", usage)
	}
	tooLarge := bytes.NewReader(make([]byte, ImageConversationAssetMaxBytes+1))
	if _, err := storeConversationAssetReader(assets, context.Background(), "owner", "large.png", tooLarge); !errors.Is(err, ErrImageConversationAssetTooLarge) {
		t.Fatalf("StoreReader(too large) error = %v", err)
	}
}

func TestImageConversationAssetServiceRejectsExcessEmbeddedReferenceCountBeforeWriting(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageConversationAssetTestPNG(t))
	references := make([]any, ImageConversationAssetsMaxDataURLs+1)
	for index := range references {
		references[index] = map[string]any{"name": "reference.png", "type": "image/png", "dataUrl": dataURL}
	}
	item := map[string]any{"turns": []any{map[string]any{"referenceImages": references}}}
	if _, err := assets.PrepareConversations(context.Background(), "owner", []map[string]any{item}); !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("PrepareConversations(excess references) error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 {
		t.Fatalf("rejected conversation wrote files: %#v", usage)
	}
}

func TestImageConversationAssetServiceRejectsRemovedReferenceFields(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	for _, field := range []string{"asset_path", "data_url"} {
		t.Run(field, func(t *testing.T) {
			item := map[string]any{"turns": []any{map[string]any{
				"referenceImages": []any{map[string]any{field: "removed"}},
			}}}
			if _, err := assets.PrepareConversations(context.Background(), "owner", []map[string]any{item}); !errors.Is(err, ErrInvalidImageConversationAsset) {
				t.Fatalf("PrepareConversations(%s) error = %v", field, err)
			}
		})
	}
}

func TestImageConversationAssetServiceConcurrentStoresDeduplicate(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	data := imageConversationAssetTestPNG(t)
	const workers = 24
	paths := make(chan string, workers)
	errorsCh := make(chan error, workers)
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			asset, err := storeConversationAsset(assets, "owner", "reference.png", data)
			if err != nil {
				errorsCh <- err
				return
			}
			paths <- asset.AssetPath
		}()
	}
	group.Wait()
	close(paths)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent Store() error = %v", err)
	}
	want := ""
	for assetPath := range paths {
		if want == "" {
			want = assetPath
		}
		if assetPath != want {
			t.Fatalf("concurrent Store() paths differ: %q and %q", want, assetPath)
		}
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 1 {
		t.Fatalf("concurrent Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceEnforcesCombinedStorageBudget(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	data := imageConversationAssetTestPNG(t)
	assets.SetStorageBudget(func() int64 { return int64(len(data) - 1) }, func() (int64, error) { return 0, nil })
	if _, err := storeConversationAsset(assets, "owner", "reference.png", data); !errors.Is(err, ErrImageConversationAssetStorageLimit) {
		t.Fatalf("Store(over budget) error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 || len(assets.Owners()) != 0 {
		t.Fatalf("over-budget store left data: usage=%#v owners=%#v", usage, assets.Owners())
	}
}

func TestImageConversationAssetServiceFailsClosedWhenOtherStorageUsageFails(t *testing.T) {
	root := t.TempDir()
	assets := NewImageConversationAssetService(root)
	data := imageConversationAssetTestPNG(t)
	usageErr := errors.New("image storage scan failed")
	assets.SetStorageBudget(func() int64 { return 1 << 30 }, func() (int64, error) {
		return 0, usageErr
	})

	if _, err := storeConversationAsset(assets, "owner", "reference.png", data); !errors.Is(err, usageErr) {
		t.Fatalf("Store(other storage scan failure) error = %v, want %v", err, usageErr)
	}
	usage := mustImageConversationAssetGovernance(t, assets)
	if usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("failed storage preflight wrote files: %#v", usage)
	}
	if owners := assets.Owners(); len(owners) != 0 {
		t.Fatalf("failed storage preflight wrote owner markers: %#v", owners)
	}
}

func TestImageConversationAssetServiceChecksBatchStorageBudgetOnce(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	firstData := imageConversationAssetTestPNG(t)
	secondData := append(append([]byte(nil), firstData...), 0)
	first, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(firstData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(first) error = %v", err)
	}
	second, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(secondData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(second) error = %v", err)
	}
	otherUsageCalls := 0
	assets.SetStorageBudget(func() int64 { return 1 << 30 }, func() (int64, error) {
		otherUsageCalls++
		return 0, nil
	})

	stored, err := assets.StoreValidatedBatchContext(context.Background(),
		"batch-budget-owner",
		[]string{"first.png", "second.png"},
		[]*ValidatedImageConversationAsset{first, second},
	)
	if err != nil {
		t.Fatalf("StoreValidatedBatch() error = %v", err)
	}
	if len(stored) != 2 || stored[0].AssetPath == stored[1].AssetPath {
		t.Fatalf("StoreValidatedBatch() assets = %#v", stored)
	}
	if otherUsageCalls != 1 {
		t.Fatalf("other storage usage checked %d times, want 1", otherUsageCalls)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 2 {
		t.Fatalf("batch Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceRejectsCombinedBatchBeforeWriting(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	firstData := imageConversationAssetTestPNG(t)
	secondData := append(append([]byte(nil), firstData...), 0)
	first, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(firstData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(first) error = %v", err)
	}
	second, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(secondData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(second) error = %v", err)
	}
	assets.SetStorageBudget(func() int64 { return int64(len(firstData) + len(secondData) - 1) }, func() (int64, error) { return 0, nil })

	_, err = assets.StoreValidatedBatchContext(context.Background(),
		"batch-over-budget-owner",
		[]string{"first.png", "second.png"},
		[]*ValidatedImageConversationAsset{first, second},
	)
	if !errors.Is(err, ErrImageConversationAssetStorageLimit) {
		t.Fatalf("StoreValidatedBatch(over budget) error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("over-budget batch wrote files: %#v", usage)
	}
	if owners := assets.Owners(); len(owners) != 0 {
		t.Fatalf("over-budget batch wrote owner marker: %#v", owners)
	}
}

func TestImageConversationAssetServiceDeduplicatesDestinationsWithinBatch(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	data := imageConversationAssetTestPNG(t)
	validated, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(data))
	if err != nil {
		t.Fatalf("ReadValidatedReader() error = %v", err)
	}
	assets.SetStorageBudget(func() int64 { return int64(len(data)) }, func() (int64, error) { return 0, nil })

	stored, err := assets.StoreValidatedBatchContext(context.Background(),
		"duplicate-batch-owner",
		[]string{"first.png", "second.png"},
		[]*ValidatedImageConversationAsset{validated, validated},
	)
	if err != nil {
		t.Fatalf("StoreValidatedBatch() error = %v", err)
	}
	if len(stored) != 2 || stored[0].AssetPath != stored[1].AssetPath {
		t.Fatalf("duplicate batch assets = %#v", stored)
	}
	if stored[0].Name != "first.png" || stored[1].Name != "second.png" {
		t.Fatalf("duplicate batch names = %#v", stored)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 1 || usage.TotalBytes != int64(len(data)) {
		t.Fatalf("duplicate batch Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceBatchBudgetCountsOnlyNewDestinations(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	firstData := imageConversationAssetTestPNG(t)
	secondData := append(append([]byte(nil), firstData...), 0)
	if _, err := storeConversationAsset(assets, "mixed-batch-owner", "existing.png", firstData); err != nil {
		t.Fatalf("Store(existing) error = %v", err)
	}
	first, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(firstData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(first) error = %v", err)
	}
	second, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(secondData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(second) error = %v", err)
	}
	otherUsageCalls := 0
	assets.SetStorageBudget(func() int64 { return int64(len(firstData) + len(secondData)) }, func() (int64, error) {
		otherUsageCalls++
		return 0, nil
	})

	stored, err := assets.StoreValidatedBatchContext(context.Background(),
		"mixed-batch-owner",
		[]string{"existing.png", "new.png"},
		[]*ValidatedImageConversationAsset{first, second},
	)
	if err != nil {
		t.Fatalf("StoreValidatedBatch() error = %v", err)
	}
	if len(stored) != 2 || stored[0].AssetPath == stored[1].AssetPath {
		t.Fatalf("mixed batch assets = %#v", stored)
	}
	if otherUsageCalls != 1 {
		t.Fatalf("mixed batch storage usage checked %d times, want 1", otherUsageCalls)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 2 || usage.TotalBytes != int64(len(firstData)+len(secondData)) {
		t.Fatalf("mixed batch Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceRollsBackPartialBatchWrite(t *testing.T) {
	root := t.TempDir()
	assets := NewImageConversationAssetService(root)
	firstData := imageConversationAssetTestPNG(t)
	secondData := append(append([]byte(nil), firstData...), 0)
	first, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(firstData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(first) error = %v", err)
	}
	second, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(secondData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(second) error = %v", err)
	}
	ownerID := "rollback-batch-owner"
	ownerHash := imageConversationAssetHash([]byte(ownerID))
	firstDestination := filepath.Join(root, ownerHash, imageConversationAssetHash(firstData)+first.extension)
	secondDestination := filepath.Join(root, ownerHash, imageConversationAssetHash(secondData)+second.extension)
	if err := os.MkdirAll(secondDestination, 0o755); err != nil {
		t.Fatalf("MkdirAll(invalid destination) error = %v", err)
	}

	_, err = assets.StoreValidatedBatchContext(context.Background(),
		ownerID,
		[]string{"first.png", "second.png"},
		[]*ValidatedImageConversationAsset{first, second},
	)
	if !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("StoreValidatedBatch(partial failure) error = %v", err)
	}
	if _, statErr := os.Stat(firstDestination); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("partial batch left the first asset behind: %v", statErr)
	}
	markerPath := filepath.Join(root, ownerHash, imageConversationAssetOwnerMarker)
	if _, statErr := os.Stat(markerPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("partial batch left the owner marker behind: %v", statErr)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("partial batch Governance() = %#v", usage)
	}
	if owners := assets.Owners(); len(owners) != 0 {
		t.Fatalf("partial batch Owners() = %#v", owners)
	}
}

func TestImageConversationAssetServiceKeepsRepairedOwnerMarkerWhenRollbackLeavesExistingAssets(t *testing.T) {
	root := t.TempDir()
	assets := NewImageConversationAssetService(root)
	ownerID := "existing-owner-marker"
	oldData := imageConversationAssetTestPNG(t)
	oldAsset, err := storeConversationAsset(assets, ownerID, "old.png", oldData)
	if err != nil {
		t.Fatalf("Store(old) error = %v", err)
	}
	ownerHash := imageConversationAssetHash([]byte(ownerID))
	markerPath := filepath.Join(root, ownerHash, imageConversationAssetOwnerMarker)
	if err := os.Remove(markerPath); err != nil {
		t.Fatalf("Remove(owner marker) error = %v", err)
	}

	firstData := append(append([]byte(nil), oldData...), 0)
	secondData := append(append([]byte(nil), oldData...), 0, 0)
	first, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(firstData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(first) error = %v", err)
	}
	second, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(secondData))
	if err != nil {
		t.Fatalf("ReadValidatedReader(second) error = %v", err)
	}
	firstDestination := filepath.Join(root, ownerHash, imageConversationAssetHash(firstData)+first.extension)
	secondDestination := filepath.Join(root, ownerHash, imageConversationAssetHash(secondData)+second.extension)
	if err := os.MkdirAll(secondDestination, 0o755); err != nil {
		t.Fatalf("MkdirAll(invalid destination) error = %v", err)
	}

	_, err = assets.StoreValidatedBatchContext(context.Background(),
		ownerID,
		[]string{"first.png", "second.png"},
		[]*ValidatedImageConversationAsset{first, second},
	)
	if !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("StoreValidatedBatch(partial failure) error = %v", err)
	}
	if _, statErr := os.Stat(firstDestination); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("partial batch left the new asset behind: %v", statErr)
	}
	if _, statErr := os.Stat(markerPath); statErr != nil {
		t.Fatalf("partial rollback removed the repaired owner marker: %v", statErr)
	}
	if _, err := assets.Access(oldAsset.AssetPath, ownerID, false); err != nil {
		t.Fatalf("existing asset became inaccessible after rollback: %v", err)
	}
	owners := assets.Owners()
	if len(owners) != 1 || owners[0] != ownerID {
		t.Fatalf("Owners() after repaired-marker rollback = %#v", owners)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 1 || usage.TotalBytes != int64(len(oldData)) {
		t.Fatalf("Governance() after repaired-marker rollback = %#v", usage)
	}
}

func TestImageConversationAssetBatchContextStopsWaitingForFilesystemLock(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	data := imageConversationAssetTestPNG(t)
	validated, err := assets.ReadValidatedReader(context.Background(), bytes.NewReader(data))
	if err != nil {
		t.Fatalf("ReadValidatedReader() error = %v", err)
	}
	assets.mu.Lock()
	defer assets.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	_, err = assets.StoreValidatedBatchContext(ctx, "cancelled-batch-owner", []string{"image.png"}, []*ValidatedImageConversationAsset{validated})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("StoreValidatedBatchContext() error = %v, want context deadline", err)
	}
}

func TestImageConversationHistoryStoresPreparedAssetsWithOneBudgetCheck(t *testing.T) {
	backend := newTestStorageBackend(t)
	assets := NewImageConversationAssetService(t.TempDir())
	otherUsageCalls := 0
	assets.SetStorageBudget(func() int64 { return 1 << 30 }, func() (int64, error) {
		otherUsageCalls++
		return 0, nil
	})
	history := NewImageConversationHistoryService(backend)
	history.SetConversationAssetService(assets)
	item := imageConversationAssetHistoryItem(t, "prepared-batch", 1, "success")
	firstReference := item["turns"].([]any)[0].(map[string]any)["referenceImages"].([]any)[0].(map[string]any)
	secondData := append(imageConversationAssetTestPNG(t), 0)
	secondReference := map[string]any{
		"name": "second.png", "type": "image/png",
		"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(secondData),
	}
	item["turns"].([]any)[0].(map[string]any)["referenceImages"] = []any{firstReference, secondReference}

	acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(
		context.Background(),
		"prepared-batch-owner",
		[]map[string]any{item},
	)
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted {
		t.Fatalf("MergeWithAcknowledgementsMinimal() acknowledgements=%#v error=%v", acknowledgements, err)
	}
	if otherUsageCalls != 1 {
		t.Fatalf("prepared asset budget checked %d times, want 1", otherUsageCalls)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 2 {
		t.Fatalf("prepared asset Governance() = %#v", usage)
	}
}

func TestImageConversationAssetServiceCleanupOnlyRemovesExpiredOrphans(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	firstData := imageConversationAssetTestPNG(t)
	secondData := append([]byte(nil), firstData...)
	secondData[len(secondData)-1] ^= 1
	first, err := storeConversationAsset(assets, "owner", "referenced.png", firstData)
	if err != nil {
		t.Fatalf("Store(referenced) error = %v", err)
	}
	second, err := storeConversationAsset(assets, "owner", "orphan.png", secondData)
	if err != nil {
		t.Fatalf("Store(orphan) error = %v", err)
	}
	old := time.Now().Add(-2 * time.Hour)
	for _, asset := range []ImageConversationAsset{first, second} {
		access, accessErr := assets.Access(asset.AssetPath, "owner", false)
		if accessErr != nil {
			t.Fatalf("Access(%s) error = %v", asset.AssetPath, accessErr)
		}
		if err := os.Chtimes(access.Path, old, old); err != nil {
			t.Fatalf("Chtimes(%s) error = %v", asset.AssetPath, err)
		}
	}

	result, err := assets.CleanupOrphansContext(context.Background(), "owner", map[string]struct{}{first.AssetPath: {}}, time.Hour, 0)
	if err != nil {
		t.Fatalf("CleanupOrphans() error = %v", err)
	}
	if result.DeletedCount != 1 || result.ReferencedCount != 1 || result.FileCount != 1 {
		t.Fatalf("CleanupOrphans() = %#v", result)
	}
	if _, err := assets.Access(first.URL, "owner", false); err != nil {
		t.Fatalf("referenced asset was deleted: %v", err)
	}
	if _, err := assets.Access(second.URL, "owner", false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("orphan asset still accessible: %v", err)
	}
}

func TestImageConversationAssetServiceCleanupExpiredIncludesReferencedAssets(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	oldAsset, err := storeConversationAsset(assets, "owner", "old.png", imageConversationAssetTestPNG(t))
	if err != nil {
		t.Fatalf("Store(old) error = %v", err)
	}
	newData := append([]byte(nil), imageConversationAssetTestPNG(t)...)
	newData[len(newData)-1] ^= 1
	newAsset, err := storeConversationAsset(assets, "owner", "new.png", newData)
	if err != nil {
		t.Fatalf("Store(new) error = %v", err)
	}
	oldAccess, err := assets.Access(oldAsset.AssetPath, "owner", false)
	if err != nil {
		t.Fatalf("Access(old) error = %v", err)
	}
	oldTime := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(oldAccess.Path, oldTime, oldTime); err != nil {
		t.Fatalf("Chtimes(old) error = %v", err)
	}

	result, err := assets.CleanupExpired(1)
	if err != nil {
		t.Fatalf("CleanupExpired() error = %v", err)
	}
	if result.DeletedCount != 1 || result.FileCount != 1 {
		t.Fatalf("CleanupExpired() = %#v", result)
	}
	if _, err := assets.Access(oldAsset.AssetPath, "owner", false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("expired asset still accessible: %v", err)
	}
	if _, err := assets.Access(newAsset.AssetPath, "owner", false); err != nil {
		t.Fatalf("recent asset was deleted: %v", err)
	}
}

func TestImageConversationAssetServiceCleanupToMaxBytesRemovesOldestFirst(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	oldAsset, err := storeConversationAsset(assets, "owner", "old.png", imageConversationAssetTestPNG(t))
	if err != nil {
		t.Fatalf("Store(old) error = %v", err)
	}
	newData := append([]byte(nil), imageConversationAssetTestPNG(t)...)
	newData[len(newData)-1] ^= 1
	newAsset, err := storeConversationAsset(assets, "owner", "new.png", newData)
	if err != nil {
		t.Fatalf("Store(new) error = %v", err)
	}
	oldAccess, err := assets.Access(oldAsset.AssetPath, "owner", false)
	if err != nil {
		t.Fatalf("Access(old) error = %v", err)
	}
	oldTime := time.Now().Add(-time.Hour)
	if err := os.Chtimes(oldAccess.Path, oldTime, oldTime); err != nil {
		t.Fatalf("Chtimes(old) error = %v", err)
	}

	result, err := assets.CleanupToMaxBytes(newAsset.Size)
	if err != nil {
		t.Fatalf("CleanupToMaxBytes() error = %v", err)
	}
	if result.DeletedCount != 1 || result.TotalBytes > newAsset.Size {
		t.Fatalf("CleanupToMaxBytes() = %#v", result)
	}
	if _, err := assets.Access(oldAsset.AssetPath, "owner", false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("oldest asset still accessible: %v", err)
	}
	if _, err := assets.Access(newAsset.AssetPath, "owner", false); err != nil {
		t.Fatalf("newest asset was deleted: %v", err)
	}
}

func TestImageConversationAssetCleanupContextStopsWaitingForFilesystemLock(t *testing.T) {
	assets := NewImageConversationAssetService(t.TempDir())
	assets.mu.Lock()
	defer assets.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	_, err := assets.CleanupOrphansContext(ctx, "owner", map[string]struct{}{}, time.Hour, 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("CleanupOrphansContext() error = %v, want context deadline", err)
	}
}

func TestImageConversationAssetFilesystemScansPropagateErrors(t *testing.T) {
	parent := t.TempDir()
	blocker := filepath.Join(parent, "not-a-directory")
	if err := os.WriteFile(blocker, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("WriteFile(blocker) error = %v", err)
	}
	assets := NewImageConversationAssetService(filepath.Join(blocker, "assets"))

	if _, err := assets.Governance(); err == nil {
		t.Fatal("Governance() error = nil, want filesystem traversal error")
	}
	if _, err := imageConversationAssetOwnerDirectoryEmptyContext(context.Background(), filepath.Join(blocker, "owner")); err == nil {
		t.Fatal("imageConversationAssetOwnerDirectoryEmptyContext() error = nil, want filesystem read error")
	}
}

func TestImageConversationAssetFilesystemScansRejectRootFile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "assets")
	if err := os.WriteFile(root, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("WriteFile(root) error = %v", err)
	}
	assets := NewImageConversationAssetService(root)

	if _, err := assets.Governance(); err == nil {
		t.Fatal("Governance(root file) error = nil, want filesystem traversal error")
	}
	if _, err := assets.CleanupExpired(1); err == nil {
		t.Fatal("CleanupExpired(root file) error = nil, want filesystem traversal error")
	}
}

func TestImageConversationAssetFilesystemScansAllowMissingDirectories(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	assets := NewImageConversationAssetService(root)

	usage, err := assets.Governance()
	if err != nil || usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("Governance(missing) = %#v, error = %v", usage, err)
	}
	result, err := assets.CleanupOrphansContext(context.Background(), "owner", map[string]struct{}{}, time.Hour, 0)
	if err != nil || result.FileCount != 0 || result.DeletedCount != 0 {
		t.Fatalf("CleanupOrphans(missing) = %#v, error = %v", result, err)
	}
}

func TestImageConversationHistoryMergeAssetizesBeforeAcceptedHash(t *testing.T) {
	backend := newTestStorageBackend(t)
	rows := backend.(storage.ImageConversationBackend)
	assets := NewImageConversationAssetService(t.TempDir())
	history := NewImageConversationHistoryService(backend)
	history.SetConversationAssetService(assets)
	ownerID := "assetized-merge-owner"
	item := imageConversationAssetHistoryItem(t, "assetized-merge", 1, "success")

	acknowledgements, generation, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item})
	if err != nil || len(acknowledgements) != 1 || !acknowledgements[0].Accepted {
		t.Fatalf("initial merge acknowledgements=%#v generation=%d error=%v", acknowledgements, generation, err)
	}
	record, exists, err := rows.Load(context.Background(), ownerID, "assetized-merge")
	if err != nil || !exists {
		t.Fatalf("Load() record=%#v exists=%v error=%v", record, exists, err)
	}
	if bytes.Contains(record.Data, []byte("data:image")) || !bytes.Contains(record.Data, []byte(ImageConversationAssetURLPrefix)) {
		t.Fatalf("persisted record still contains embedded image: %s", record.Data)
	}

	replayed, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item})
	if err != nil || len(replayed) != 1 || !replayed[0].Accepted || replayed[0].ActualRevision != 1 {
		t.Fatalf("replay acknowledgements=%#v error=%v", replayed, err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 1 {
		t.Fatalf("replay created duplicate files: %#v", usage)
	}
}

func TestImageConversationHistoryBatchPreflightRejectsBeforeWritingAnyAsset(t *testing.T) {
	backend := newTestStorageBackend(t)
	assets := NewImageConversationAssetService(t.TempDir())
	history := NewImageConversationHistoryService(backend)
	history.SetConversationAssetService(assets)
	valid := imageConversationAssetHistoryItem(t, "batch-preflight-valid", 1, "success")
	invalid := imageConversationAssetHistoryItem(t, "batch-preflight-invalid", 1, "success")
	invalidReference := invalid["turns"].([]any)[0].(map[string]any)["referenceImages"].([]any)[0].(map[string]any)
	invalidReference["dataUrl"] = strings.Replace(invalidReference["dataUrl"].(string), "data:image/png", "data:image/jpeg", 1)

	_, _, err := history.MergeWithAcknowledgementsMinimal(
		context.Background(),
		"batch-preflight-owner",
		[]map[string]any{valid, invalid},
	)
	var validationErr ImageConversationHistoryValidationError
	if !errors.As(err, &validationErr) || !errors.Is(err, ErrInvalidImageConversationAsset) {
		t.Fatalf("MergeWithAcknowledgementsMinimal() error = %v", err)
	}
	if usage := mustImageConversationAssetGovernance(t, assets); usage.FileCount != 0 || usage.TotalBytes != 0 {
		t.Fatalf("rejected batch wrote an earlier asset: %#v", usage)
	}
}

func TestImageConversationHistoryDetailLazyAssetizationUpdatesAcceptedHash(t *testing.T) {
	backend := newTestStorageBackend(t)
	rows := backend.(storage.ImageConversationBackend)
	ownerID := "lazy-asset-owner"
	item := imageConversationAssetHistoryItem(t, "lazy-asset", 7, "success")
	withoutAssets := NewImageConversationHistoryService(backend)
	acknowledgements, generation, err := withoutAssets.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item})
	if err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("seed merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	before, exists, err := rows.Load(context.Background(), ownerID, "lazy-asset")
	if err != nil || !exists || !bytes.Contains(before.Data, []byte("data:image")) {
		t.Fatalf("seed record=%#v exists=%v error=%v", before, exists, err)
	}

	assets := NewImageConversationAssetService(t.TempDir())
	withAssets := NewImageConversationHistoryService(backend)
	withAssets.SetConversationAssetService(assets)
	detail, found, detailGeneration, err := withAssets.GetItem(context.Background(), ownerID, "lazy-asset")
	if err != nil || !found || detailGeneration <= generation {
		t.Fatalf("GetItem() detail=%#v found=%v generation=%d error=%v", detail, found, detailGeneration, err)
	}
	reference := detail["turns"].([]any)[0].(map[string]any)["referenceImages"].([]any)[0].(map[string]any)
	if !strings.HasPrefix(reference["dataUrl"].(string), ImageConversationAssetURLPrefix) {
		t.Fatalf("lazy detail reference = %#v", reference)
	}
	after, exists, err := rows.Load(context.Background(), ownerID, "lazy-asset")
	if err != nil || !exists || after.Revision != before.Revision || after.StorageVersion != before.StorageVersion+1 || after.AcceptedHash == before.AcceptedHash {
		t.Fatalf("lazy rewritten record before=%#v after=%#v exists=%v error=%v", before, after, exists, err)
	}
	if bytes.Contains(after.Data, []byte("data:image")) {
		t.Fatalf("lazy rewritten record still has data URL: %s", after.Data)
	}

	replayed, _, err := withAssets.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{item})
	if err != nil || len(replayed) != 1 || !replayed[0].Accepted || replayed[0].ActualRevision != 7 {
		t.Fatalf("same revision replay acknowledgements=%#v error=%v", replayed, err)
	}
	unchanged, _, _ := rows.Load(context.Background(), ownerID, "lazy-asset")
	if unchanged.StorageVersion != after.StorageVersion {
		t.Fatalf("idempotent replay rewrote row: before=%d after=%d", after.StorageVersion, unchanged.StorageVersion)
	}
}

func TestImageConversationAssetReferencesRebuildAcrossUpdateDeleteAndClear(t *testing.T) {
	backend := newTestStorageBackend(t)
	assets := NewImageConversationAssetService(t.TempDir())
	history := NewImageConversationHistoryService(backend)
	history.SetConversationAssetService(assets)
	ownerID := "asset-reference-owner"
	first := imageConversationAssetHistoryItem(t, "reference-lifecycle", 1, "success")
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{first}); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("first merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	firstReferences, err := history.ConversationAssetReferencesContext(context.Background(), ownerID)
	if err != nil || len(firstReferences) != 1 {
		t.Fatalf("first references=%#v error=%v", firstReferences, err)
	}
	var firstPath string
	for assetPath := range firstReferences {
		firstPath = assetPath
	}

	second := imageConversationAssetHistoryItem(t, "reference-lifecycle", 2, "success")
	second["updatedAt"] = "2026-07-20T12:01:00Z"
	second["turns"].([]any)[0].(map[string]any)["referenceImages"] = []any{map[string]any{
		"name":    "second.png",
		"type":    "image/png",
		"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(imageConversationAssetTestPNG(t), 0)),
	}}
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{second}); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("second merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	secondReferences, err := history.ConversationAssetReferencesContext(context.Background(), ownerID)
	if err != nil || len(secondReferences) != 1 {
		t.Fatalf("second references=%#v error=%v", secondReferences, err)
	}
	if _, stillReferenced := secondReferences[firstPath]; stillReferenced {
		t.Fatalf("replaced asset remained referenced: %#v", secondReferences)
	}
	firstAccess, err := assets.Access(firstPath, ownerID, false)
	if err != nil {
		t.Fatalf("Access(firstPath) error = %v", err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(firstAccess.Path, old, old); err != nil {
		t.Fatalf("Chtimes(firstPath) error = %v", err)
	}
	if _, err := assets.CleanupOrphansContext(context.Background(), ownerID, secondReferences, time.Hour, 0); err != nil {
		t.Fatalf("CleanupOrphans(replaced) error = %v", err)
	}
	if _, err := assets.Access(firstPath, ownerID, false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("replaced asset was not removed: %v", err)
	}

	if _, _, err := history.DeleteMinimal(context.Background(), ownerID, "reference-lifecycle"); err != nil {
		t.Fatalf("DeleteMinimal() error = %v", err)
	}
	if references, err := history.ConversationAssetReferencesContext(context.Background(), ownerID); err != nil || len(references) != 0 {
		t.Fatalf("references after delete=%#v error=%v", references, err)
	}

	third := imageConversationAssetHistoryItem(t, "reference-after-delete", 1, "success")
	if acknowledgements, _, err := history.MergeWithAcknowledgementsMinimal(context.Background(), ownerID, []map[string]any{third}); err != nil || !acknowledgements[0].Accepted {
		t.Fatalf("third merge acknowledgements=%#v error=%v", acknowledgements, err)
	}
	thirdReferences, err := history.ConversationAssetReferencesContext(context.Background(), ownerID)
	if err != nil || len(thirdReferences) != 1 {
		t.Fatalf("third references=%#v error=%v", thirdReferences, err)
	}
	var thirdPath string
	for assetPath := range thirdReferences {
		thirdPath = assetPath
	}
	thirdAccess, err := assets.Access(thirdPath, ownerID, false)
	if err != nil {
		t.Fatalf("Access(thirdPath) error = %v", err)
	}
	if err := os.Chtimes(thirdAccess.Path, old, old); err != nil {
		t.Fatalf("Chtimes(thirdPath) error = %v", err)
	}
	if _, err := history.ClearMinimal(context.Background(), ownerID); err != nil {
		t.Fatalf("ClearMinimal() error = %v", err)
	}
	referencesAfterClear, err := history.ConversationAssetReferencesContext(context.Background(), ownerID)
	if err != nil || len(referencesAfterClear) != 0 {
		t.Fatalf("references after clear=%#v error=%v", referencesAfterClear, err)
	}
	if _, err := assets.CleanupOrphansContext(context.Background(), ownerID, referencesAfterClear, time.Hour, 0); err != nil {
		t.Fatalf("CleanupOrphans(clear) error = %v", err)
	}
	if _, err := assets.Access(thirdPath, ownerID, false); !errors.Is(err, ErrImageConversationAssetNotFound) {
		t.Fatalf("cleared asset was not removed: %v", err)
	}
}

func imageConversationAssetHistoryItem(t *testing.T, id string, revision int64, status string) map[string]any {
	t.Helper()
	data := imageConversationAssetTestPNG(t)
	return map[string]any{
		"id": id, "revision": revision, "title": id,
		"createdAt": "2026-07-20T12:00:00Z", "updatedAt": "2026-07-20T12:00:00Z",
		"turns": []any{map[string]any{
			"id": "turn-" + id, "status": status,
			"referenceImages": []any{map[string]any{
				"name": "reference.png", "type": "image/png",
				"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(data),
			}},
			"images": []any{},
		}},
	}
}

func imageConversationAssetTestPNG(t *testing.T) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			canvas.Set(x, y, color.RGBA{R: uint8(x * 20), G: uint8(y * 20), B: 180, A: 255})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, canvas); err != nil {
		t.Fatalf("png.Encode() error = %v", err)
	}
	return data.Bytes()
}
