package service

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRelayOnboardingReusesAllKeysByGroup(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPIUser(t, dbURL, 2, "bob", "bob@example.test")
	now := time.Now().Unix()
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "shared", "first", "first-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 2, 1, "shared", "second", "second-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 3, 1, "elsewhere", "shared", "wrong-key", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 4, 2, "shared", "bob-only", "private", now+3600, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 5, 1, "shared", "expired", "expired", now-1, 10, false)
	insertTestNewAPITokenNamed(t, dbURL, 6, 1, "shared", "empty", "empty", now+3600, 0, false)
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	mappings := map[string]string{"text": "shared", "image": "shared", "video": "shared", "audio": ""}
	result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, mappings, func(context.Context, string) error { t.Fatal("created despite existing keys"); return nil })
	if len(warnings) > 0 {
		t.Fatal(warnings)
	}
	for _, kind := range []string{"text", "image", "video"} {
		if !reflect.DeepEqual(result[kind], []string{"first", "second"}) {
			t.Fatalf("%s = %#v", kind, result[kind])
		}
	}
	if _, exists := result["audio"]; exists {
		t.Fatal("empty mapping enabled audio")
	}
}

func TestRelayOnboardingCreatesOncePerGroupAcrossCategoriesAndConcurrentLogins(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var calls atomic.Int32
	create := func(ctx context.Context, group string) error {
		calls.Add(1)
		insertTestNewAPITokenNamed(t, dbURL, 1, 1, group, "created", "new-key", -1, 0, true)
		return nil
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, map[string]string{"text": "shared", "image": "shared"}, create)
			if len(warnings) > 0 || !reflect.DeepEqual(result["text"], []string{"created"}) || !reflect.DeepEqual(result["image"], result["text"]) {
				t.Errorf("result=%v warnings=%v", result, warnings)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("created %d keys", calls.Load())
	}
}

func TestRelayOnboardingDoesNotCreateOnReadFailureOrAmbiguousName(t *testing.T) {
	for _, scenario := range []string{"database", "duplicate"} {
		t.Run(scenario, func(t *testing.T) {
			dbURL := newTestNewAPIDatabase(t)
			insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
			reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			if scenario == "database" {
				db := openTestNewAPIDatabase(t, dbURL)
				defer db.Close()
				if _, err := db.Exec("DROP TABLE tokens"); err != nil {
					t.Fatal(err)
				}
			} else {
				insertTestNewAPITokenNamed(t, dbURL, 1, 1, "shared", "same", "key-a", -1, 0, true)
				insertTestNewAPITokenNamed(t, dbURL, 2, 1, "other", "same", "key-b", -1, 0, true)
			}
			_, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, map[string]string{"text": "shared"}, func(context.Context, string) error { t.Fatal("must not create"); return nil })
			if len(warnings) != 1 {
				t.Fatalf("warnings=%v", warnings)
			}
		})
	}
}

func TestRelayOnboardingDoesNotRetryFailedCreationForSharedCategories(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	calls := 0
	result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, map[string]string{"text": "shared", "image": "shared"}, func(context.Context, string) error { calls++; return errors.New("timeout") })
	if calls != 1 || len(warnings) != 1 || len(result) != 0 {
		t.Fatalf("calls=%d warnings=%v result=%v", calls, warnings, result)
	}
}

func TestRelayOnboardingSub2APIReusesGroupRegardlessOfKeyNames(t *testing.T) {
	dbURL := newTestSub2APIDatabase(t)
	insertTestSub2APIUser(t, dbURL, 1, "alice", "alice@example.test", "user", 10)
	insertTestSub2APIGroup(t, dbURL, 10, "shared", "active", false)
	insertTestSub2APIKey(t, dbURL, 1, 1, "key-a", "first", 10, "active", 0, 0, time.Time{}, false)
	insertTestSub2APIKey(t, dbURL, 2, 1, "key-b", "second", 10, "active", 0, 0, time.Time{}, false)
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL, DatabaseType: "sub2api"})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "sub2api:1"}, map[string]string{"image": "shared", "video": "shared"}, func(context.Context, string) error { t.Fatal("created despite existing keys"); return nil })
	if len(warnings) != 0 || !reflect.DeepEqual(result["image"], []string{"first", "second"}) || !reflect.DeepEqual(result["image"], result["video"]) {
		t.Fatalf("result=%v warnings=%v", result, warnings)
	}
}

func TestRelayOnboardingRejectsAutoGroupWithoutCreating(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, map[string]string{"image": "auto", "video": "auto"}, func(context.Context, string) error { t.Fatal("created auto key"); return nil })
	if len(result) != 0 || len(warnings) != 1 {
		t.Fatalf("result=%v warnings=%v", result, warnings)
	}
}

func TestRelayOnboardingWithoutCreationCredentialOnlyReusesExistingKeys(t *testing.T) {
	dbURL := newTestNewAPIDatabase(t)
	insertTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertTestNewAPITokenNamed(t, dbURL, 1, 1, "existing", "original-name", "key", -1, 0, true)
	reader, err := NewNewAPITokenReader(NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	result, warnings := reader.EnsureCreationGroupTokens(context.Background(), Identity{ID: "newapi:1"}, map[string]string{"text": "existing", "image": "missing"}, nil)
	if !reflect.DeepEqual(result["text"], []string{"original-name"}) || len(result["image"]) != 0 || len(warnings) != 1 {
		t.Fatalf("result=%v warnings=%v", result, warnings)
	}
}
