package service

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestCreationGroupsReadNewAPIDatabaseWithoutTokens(t *testing.T) {
	databaseURL := newTestNewAPIDatabase(t)
	db := openTestNewAPIDatabase(t, databaseURL)
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE options (`key` TEXT PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	groups, err := reader.CreationGroups(context.Background())
	if err != nil || len(groups) != 0 {
		t.Fatalf("empty config = %v, %v", groups, err)
	}
	if _, err := db.Exec("INSERT INTO options (`key`, value) VALUES (?, ?)", "GroupRatio", `{"shared":1,"draw":1.5,"auto":1,"":1}`); err != nil {
		t.Fatal(err)
	}
	groups, err = reader.CreationGroups(context.Background())
	if err != nil || !reflect.DeepEqual(groups, []string{"draw", "shared"}) {
		t.Fatalf("groups = %v, %v", groups, err)
	}
	if _, err := db.Exec("UPDATE options SET value = ?", `invalid`); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.CreationGroups(context.Background()); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := reader.CreationGroups(ctx); err == nil {
		t.Fatal("canceled query succeeded")
	}
}

func TestCreationGroupsReadOnlyActiveSub2APIGroups(t *testing.T) {
	databaseURL := newTestSub2APIDatabase(t)
	insertTestSub2APIGroup(t, databaseURL, 1, "shared", "active", false)
	insertTestSub2APIGroup(t, databaseURL, 2, "disabled", "disabled", false)
	insertTestSub2APIGroup(t, databaseURL, 3, "deleted", "active", true)
	insertTestSub2APIGroup(t, databaseURL, 4, "draw", "active", false)
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: databaseURL, DatabaseType: "sub2api"})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	groups, err := reader.CreationGroups(context.Background())
	if err != nil || !reflect.DeepEqual(groups, []string{"draw", "shared"}) {
		t.Fatalf("groups = %v, %v", groups, err)
	}
}

func TestCreationGroupsRequireDatabase(t *testing.T) {
	var reader *NewAPITokenReader
	if _, err := reader.CreationGroups(context.Background()); err == nil {
		t.Fatal("missing database accepted")
	}
}

func TestRelayKeysInSharedGroupRemainIndividuallySelectable(t *testing.T) {
	databaseURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, databaseURL, 1, "alice", "alice@example.test")
	kinds := []string{"text", "image", "video", "audio"}
	for index, kind := range kinds {
		insertTestNewAPITokenNamed(t, databaseURL, index+1, 1, "shared", kind, kind+"-key", time.Now().Unix()+3600, 10, false)
	}
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, kind := range kinds {
		selection, err := reader.TokenForIdentityGroupAndName(context.Background(), Identity{ID: "newapi:1"}, "shared", kind)
		if err != nil || selection.Key != "sk-"+kind+"-key" || selection.Group != "shared" || !reflect.DeepEqual(selection.Names, kinds) {
			t.Fatalf("%s selection = %#v, %v", kind, selection, err)
		}
	}
}
