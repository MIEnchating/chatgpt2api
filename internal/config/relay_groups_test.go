package config

import "testing"

func TestRelayCreationGroupsNormalizeMissingNullAndPersistedNil(t *testing.T) {
	for _, value := range []any{nil, "", "  ", "<nil>"} {
		store := &Store{data: map[string]any{}, frozenSettings: true}
		for _, kind := range []string{"text", "image", "video", "audio"} {
			store.data["relay_"+kind+"_group"] = value
		}
		for _, kind := range []string{"text", "image", "video", "audio"} {
			if got := store.Get()["relay_"+kind+"_group"]; got != "" {
				t.Fatalf("value %v: %s group = %#v, want empty string", value, kind, got)
			}
		}
		if len(store.RelayCreationGroups()) != 0 {
			t.Fatalf("value %v enabled group creation", value)
		}
	}
	store := &Store{data: map[string]any{}, frozenSettings: true}
	if got := store.Get()["relay_text_group"]; got != "" {
		t.Fatalf("missing group = %#v", got)
	}
}

func TestRelayCreationGroupsSharedGroupAndClearPersist(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	t.Setenv("RELAY_TEXT_GROUP", "environment-group")
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]any{}
	for _, kind := range []string{"text", "image", "video", "audio"} {
		values["relay_"+kind+"_group"] = " shared "
	}
	if _, err := store.Update(values); err != nil {
		t.Fatal(err)
	}
	if groups := store.RelayCreationGroups(); len(groups) != 4 || groups["text"] != "shared" || groups["audio"] != "shared" {
		t.Fatalf("shared groups = %#v", groups)
	}
	for key := range values {
		values[key] = ""
	}
	if _, err := store.Update(values); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	if groups := reloaded.RelayCreationGroups(); len(groups) != 0 {
		t.Fatalf("cleared groups returned after reload: %#v", groups)
	}
}
