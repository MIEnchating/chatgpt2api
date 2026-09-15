package service

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestMyAssetGroupsPersistMembershipWithoutDeletingAssets(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "groups.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	assets := NewMyAssetService(backend, nil)
	asset := MyAsset{ID: "image-1", Kind: "image", Title: "图片", URL: "/images/one.png", Tags: []string{}}
	if _, err := assets.Upsert(context.Background(), "owner-a", false, asset); err != nil {
		t.Fatal(err)
	}
	name := "灵感"
	groups, err := assets.MutateGroup("owner-a", "create", MyAssetGroupMutation{ID: "group-1", Name: &name, Add: []string{"owner-a:image-1"}})
	if err != nil || len(groups) != 1 || len(groups[0].AssetKeys) != 1 {
		t.Fatalf("create group = %#v, err = %v", groups, err)
	}
	if _, err := assets.MutateGroup("owner-a", "update", MyAssetGroupMutation{ID: "group-1", Remove: []string{"owner-a:image-1"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := assets.MutateGroup("owner-a", "delete", MyAssetGroupMutation{ID: "group-1"}); err != nil {
		t.Fatal(err)
	}
	items, err := assets.List("owner-a")
	if err != nil || len(items) != 1 || items[0].ID != asset.ID {
		t.Fatalf("assets after group delete = %#v, err = %v", items, err)
	}
}

func TestMyAssetGroupBatchReplacementNormalizesRemovalKeys(t *testing.T) {
	assets := NewMyAssetService(newTestStorageBackend(t), nil)
	name := "Batch"
	original := make([]string, 10000)
	removed := make([]string, len(original))
	for index := range original {
		original[index] = fmt.Sprintf("owner:original-%05d", index)
		removed[index] = " " + original[index] + " "
	}
	if _, err := assets.MutateGroup("owner", "create", MyAssetGroupMutation{ID: "batch", Name: &name, Add: original}); err != nil {
		t.Fatal(err)
	}
	added := []string{" owner:new-1 ", "owner:new-2", "owner:new-1", " owner:original-00000 "}
	groups, err := assets.MutateGroup("owner", "update", MyAssetGroupMutation{ID: "batch", Add: added, Remove: removed})
	if err != nil || len(groups) != 1 || !slices.Equal(groups[0].AssetKeys, []string{"self:new-1", "self:new-2"}) {
		t.Fatalf("batch replacement = %#v, error = %v", groups, err)
	}
	persisted, err := assets.ListGroups("owner")
	if err != nil || len(persisted) != 1 || !slices.Equal(persisted[0].AssetKeys, groups[0].AssetKeys) {
		t.Fatalf("persisted replacement = %#v, error = %v", persisted, err)
	}
	if added[0] != " owner:new-1 " || removed[0] != " owner:original-00000 " {
		t.Fatal("group mutation changed caller-owned inputs")
	}
}

func TestMyAssetLegacyTagsBecomeExistingGroupMemberships(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := backend.(storage.JSONDocumentBackend)
	if err := store.SaveJSONDocument(myAssetDocumentName("owner"), map[string]any{
		"items":  []map[string]any{{"id": "image", "kind": "image", "title": "image", "url": "/image.png", "tags": []string{"existing", "old-tag"}}},
		"groups": []MyAssetGroup{{ID: "group", Name: "existing", AssetKeys: []string{"owner:other", "shared:image"}}},
	}); err != nil {
		t.Fatal(err)
	}
	assets := NewMyAssetService(backend, nil)
	items, err := assets.List("owner")
	if err != nil || len(items) != 1 || !slices.Equal(items[0].Tags, []string{"existing", "old-tag"}) {
		t.Fatalf("migrated assets = %#v, %v", items, err)
	}
	groups, err := assets.ListGroups("owner")
	if err != nil || len(groups) != 2 || groups[0].ID != "group" || !slices.Equal(groups[0].AssetKeys, []string{"self:other", "shared:image", "self:image"}) {
		t.Fatalf("migrated groups = %#v, %v", groups, err)
	}
	raw, err := store.LoadJSONDocument(myAssetDocumentName("owner"))
	if err != nil || len(decodeMyAssets(raw)[0].Tags) != 0 {
		t.Fatalf("legacy tags remain duplicated in storage: %#v, %v", raw, err)
	}
	reloaded, err := NewMyAssetService(backend, nil).ListGroups("owner")
	if err != nil || len(reloaded) != 2 || reloaded[1].ID != groups[1].ID {
		t.Fatalf("migration was not durable: %#v, %v", reloaded, err)
	}
}

func TestMyAssetGroupRenameDeleteAndRetryUseOneTagRelation(t *testing.T) {
	assets := NewMyAssetService(newTestStorageBackend(t), nil)
	item := MyAsset{ID: "image", Kind: "image", Title: "image", URL: "/image.png", Tags: []string{"product"}}
	if _, err := assets.Upsert(context.Background(), "owner", false, item); err != nil {
		t.Fatal(err)
	}
	groups, err := assets.ListGroups("owner")
	if err != nil || len(groups) != 1 {
		t.Fatalf("groups = %#v, %v", groups, err)
	}
	name := "renamed"
	if _, err := assets.MutateGroup("owner", "update", MyAssetGroupMutation{ID: groups[0].ID, Name: &name}); err != nil {
		t.Fatal(err)
	}
	item.Tags = []string{}
	updated, err := assets.Upsert(context.Background(), "owner", false, item)
	if err != nil || !slices.Equal(updated.Tags, []string{"renamed"}) {
		t.Fatalf("metadata retry lost group membership: %#v, %v", updated, err)
	}
	if _, err := assets.MutateGroup("owner", "delete", MyAssetGroupMutation{ID: groups[0].ID}); err != nil {
		t.Fatal(err)
	}
	items, err := assets.List("owner")
	if err != nil || len(items) != 1 || len(items[0].Tags) != 0 {
		t.Fatalf("deleted label remained on asset: %#v, %v", items, err)
	}
}
