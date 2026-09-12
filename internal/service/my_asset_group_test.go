package service

import (
	"context"
	"path/filepath"
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
