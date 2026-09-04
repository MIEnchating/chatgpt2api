package config

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/util"
)

type blockingConfigString struct {
	value   string
	reached chan struct{}
	release chan struct{}
	once    sync.Once
}

func (v *blockingConfigString) String() string {
	v.once.Do(func() { close(v.reached) })
	<-v.release
	return v.value
}

func TestFloatSettingRejectsNonFiniteValues(t *testing.T) {
	for _, value := range []any{"NaN", "Inf", math.NaN(), math.Inf(-1)} {
		if got := floatSetting(value, 1.5); got != 1.5 {
			t.Fatalf("floatSetting(%v) = %v, want fallback", value, got)
		}
	}
	if got := floatSetting("2.25", 1.5); got != 2.25 {
		t.Fatalf("floatSetting(finite) = %v, want 2.25", got)
	}
}

func TestIntSettingSaturatesOutOfRangeNumbers(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	minInt := -maxInt - 1
	for _, value := range []any{^uint(0), ^uint64(0), math.MaxFloat64, json.Number("1e100"), strings.Repeat("9", 100)} {
		if got := intSetting(value, 17); got != maxInt {
			t.Errorf("intSetting(%T(%v)) = %d, want %d", value, value, got, maxInt)
		}
	}
	for _, value := range []any{-math.MaxFloat64, json.Number("-1e100"), "-" + strings.Repeat("9", 100)} {
		if got := intSetting(value, 17); got != minInt {
			t.Errorf("intSetting(%T(%v)) = %d, want %d", value, value, got, minInt)
		}
	}
	for _, value := range []any{math.NaN(), math.Inf(1), json.Number("NaN")} {
		if got := intSetting(value, 17); got != 17 {
			t.Errorf("intSetting(%T(%v)) = %d, want fallback", value, value, got)
		}
	}
}

func TestNormalizeImageRetentionDaysClampsExtremeValues(t *testing.T) {
	for _, test := range []struct {
		value any
		want  int
	}{
		{value: -1, want: 1},
		{value: 30, want: 30},
		{value: math.MaxInt, want: 3650},
		{value: strings.Repeat("9", 100), want: 3650},
	} {
		if got := normalizeImageRetentionDays(test.value); got != test.want {
			t.Fatalf("normalizeImageRetentionDays(%v) = %d, want %d", test.value, got, test.want)
		}
	}
}

func TestDefaultVideoModelsMatchReferenceWorkbenchDefault(t *testing.T) {
	if len(defaultVideoModels) == 0 || defaultVideoModels[0] != "grok-imagine-video" {
		t.Fatalf("default video models = %#v, want grok-imagine-video first", defaultVideoModels)
	}
}

func TestNormalizeModelListPreservesExplicitEmptyList(t *testing.T) {
	if got := normalizeModelList([]any{}, []string{"fallback"}); len(got) != 0 {
		t.Fatalf("normalizeModelList(explicit empty) = %#v, want empty", got)
	}
	if got := normalizeModelList(nil, []string{"fallback"}); len(got) != 1 || got[0] != "fallback" {
		t.Fatalf("normalizeModelList(nil) = %#v, want fallback", got)
	}
}

func TestStoreModelListsPreserveExplicitEmptyConfiguration(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for _, key := range []string{"IMAGE_MODELS", "VIDEO_MODELS", "TEXT_MODELS", "AUDIO_MODELS", "CHAT_MODELS"} {
		unsetEnv(t, key)
	}
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	for name, models := range map[string][]string{
		"image": store.ImageModels(),
		"video": store.VideoModels(),
		"text":  store.TextModels(),
		"audio": store.AudioModels(),
		"chat":  store.ChatModels(),
	} {
		if len(models) == 0 {
			t.Errorf("fresh %s models unexpectedly empty", name)
		}
	}
	if _, err := store.Update(map[string]any{
		"image_models": []string{},
		"video_models": []string{},
		"text_models":  []string{},
		"audio_models": []string{},
		"chat_models":  []string{},
	}); err != nil {
		t.Fatalf("Update(explicit empty model lists) error = %v", err)
	}

	for _, key := range []string{"IMAGE_MODELS", "VIDEO_MODELS", "TEXT_MODELS", "AUDIO_MODELS", "CHAT_MODELS"} {
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("unset %s before reload: %v", key, err)
		}
	}
	store, err = NewStore()
	if err != nil {
		t.Fatalf("reload NewStore() error = %v", err)
	}
	for name, models := range map[string][]string{
		"image": store.ImageModels(),
		"video": store.VideoModels(),
		"text":  store.TextModels(),
		"audio": store.AudioModels(),
		"chat":  store.ChatModels(),
	} {
		if len(models) != 0 {
			t.Errorf("%s models = %#v, want explicit empty list", name, models)
		}
	}
	for name, model := range map[string]string{
		"image": store.DefaultImageModel(),
		"text":  store.DefaultTextModel(),
		"audio": store.DefaultAudioModel(),
		"chat":  store.DefaultChatModel(),
	} {
		if model != "" {
			t.Errorf("default %s model = %q, want empty", name, model)
		}
	}

	public := store.Get()
	for _, key := range []string{"image_models", "video_models", "text_models", "audio_models"} {
		if models, ok := public[key].([]string); !ok || len(models) != 0 {
			t.Errorf("Get()[%q] = %#v, want empty []string", key, public[key])
		}
	}
	for _, key := range []string{"default_image_model", "default_text_model", "default_audio_model"} {
		if public[key] != "" {
			t.Errorf("Get()[%q] = %#v, want empty", key, public[key])
		}
	}
}

func TestAllowUserCustomRelayConfigDefaultsOffAndPersists(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	unsetEnv(t, "ALLOW_USER_CUSTOM_RELAY_CONFIG")
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	if store.AllowUserCustomRelayConfig() || store.Get()["allow_user_custom_relay_config"] != false {
		t.Fatalf("default allow_user_custom_relay_config = %#v", store.Get()["allow_user_custom_relay_config"])
	}
	if _, err := store.Update(map[string]any{"allow_user_custom_relay_config": true}); err != nil {
		t.Fatal(err)
	}
	if !store.AllowUserCustomRelayConfig() || store.Get()["allow_user_custom_relay_config"] != true {
		t.Fatalf("updated allow_user_custom_relay_config = %#v", store.Get()["allow_user_custom_relay_config"])
	}
}

func TestEnvExampleMatchesSupportedEnvironmentContract(t *testing.T) {
	root := findAncestorWithProjectGoMod(".")
	if root == "" {
		t.Fatal("project root not found")
	}
	data, err := os.ReadFile(filepath.Join(root, ".env.example"))
	if err != nil {
		t.Fatalf("read .env.example: %v", err)
	}
	contents := string(data)
	supported := map[string]struct{}{}
	for _, envKey := range settingEnvKeys {
		if envKey != "OBJECT_STORAGE_SETTINGS" && envKey != "PROMPT_SOURCES" {
			supported[envKey] = struct{}{}
		}
	}
	for _, envKey := range []string{
		"ADMIN_USERNAME", "ADMIN_PASSWORD", "STORAGE_BACKEND", "STORAGE_DATABASE_URL",
		"DOCKER_IMAGE", "DOCKER_NETWORK", "TZ", "PORT", "ROOT_DIR",
	} {
		supported[envKey] = struct{}{}
	}
	for envKey := range supported {
		pattern := regexp.MustCompile(`(?m)^#?\s*` + regexp.QuoteMeta(envKey) + `=`)
		if !pattern.MatchString(contents) {
			t.Errorf(".env.example does not document %s", envKey)
		}
	}
	for _, removed := range []string{
		"RELAY_DATABASE_URL", "RELAY_DATABASE_TYPE", "RELAY_DATABASE_DRIVER",
		"IMAGE_STORAGE_BACKEND", "S3_ENDPOINT", "S3_BUCKET", "S3_PREFIX",
		"AUTO_REMOVE_INVALID_ACCOUNTS", "AUTO_REMOVE_RATE_LIMITED_ACCOUNTS",
		"REFRESH_ACCOUNT_INTERVAL_MINUTE", "IMAGE_ACCOUNT_SCHEDULE_MODE", "TEXT_ACCOUNT_SCHEDULE_MODE",
	} {
		pattern := regexp.MustCompile(`(?m)^#?\s*` + regexp.QuoteMeta(removed) + `=`)
		if pattern.MatchString(contents) {
			t.Errorf(".env.example still contains removed variable %s", removed)
		}
	}
}

func TestStoreGenericStorageProvidersKeepSecretsAndRejectMixedEnabledTypes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "OBJECT_STORAGE_SETTINGS")
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	setting := model.StorageSetting{
		Mode: "server_sqlite_s3", AllowUserProvider: true, AllowUserGlobalProvider: true,
		Providers: []model.StorageProvider{{
			ID: "primary", Name: "R2", Type: "s3", Endpoint: "https://account.r2.cloudflarestorage.com",
			Region: "auto", Bucket: "canvas", AccessKeyID: "access", SecretAccessKey: "secret",
			PathPrefix: "canvas", Weight: 3, Enabled: true,
		}},
		CapacityCheck:           model.StorageCapacityCheckSetting{Enabled: true, Cron: "0 */6 * * *"},
		CapacityLimitBytes:      12 * 1024 * 1024 * 1024,
		LocalCapacityLimitBytes: 6 * 1024 * 1024 * 1024,
	}
	updated, err := store.Update(map[string]any{"storage": setting})
	if err != nil {
		t.Fatal(err)
	}
	publicSetting, ok := updated["storage"].(model.StorageSetting)
	if !ok || len(publicSetting.Providers) != 1 {
		t.Fatalf("public storage setting = %#v", updated["storage"])
	}
	if publicSetting.Providers[0].SecretAccessKey != "" {
		t.Fatal("storage provider secret leaked through settings response")
	}
	if got := store.StorageSettings().Providers[0].SecretAccessKey; got != "secret" {
		t.Fatalf("stored secret = %q", got)
	}
	if got := store.StorageSettings().LocalCapacityLimitBytes; got != 6*1024*1024*1024 {
		t.Fatalf("local capacity limit = %d", got)
	}

	redacted := publicSetting
	redacted.Providers[0].Name = "Renamed R2"
	if _, err := store.Update(map[string]any{"storage": redacted}); err != nil {
		t.Fatal(err)
	}
	if got := store.StorageSettings().Providers[0].SecretAccessKey; got != "secret" {
		t.Fatalf("redacted update replaced secret with %q", got)
	}

	replacement := publicSetting
	replacement.Providers[0].ID = "replacement"
	replacement.Providers[0].Name = "Replacement R2"
	replacement.Providers[0].AccessKeyID = "replacement-access"
	if _, err := store.Update(map[string]any{"storage": replacement}); err == nil || !strings.Contains(err.Error(), "enabled S3 provider is incomplete") {
		t.Fatalf("replacement provider without its own secret error = %v", err)
	}
	if provider := store.StorageSettings().Providers[0]; provider.ID != "primary" || provider.SecretAccessKey != "secret" {
		t.Fatalf("failed replacement changed stored provider = %#v", provider)
	}

	mixed := store.StorageSettings()
	mixed.Providers = append(mixed.Providers, model.StorageProvider{
		ID: "dav", Name: "DAV", Type: "webdav", Endpoint: "https://dav.example.test/root",
		PathPrefix: "canvas", Username: "user", Password: "password", Weight: 1, Enabled: true,
	})
	if _, err := store.Update(map[string]any{"storage": mixed}); err == nil || !strings.Contains(err.Error(), "cannot be enabled") {
		t.Fatalf("mixed enabled storage providers error = %v", err)
	}

	reloaded, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	providers := reloaded.StorageSettings().Providers
	if len(providers) != 1 || providers[0].Name != "Renamed R2" || providers[0].SecretAccessKey != "secret" {
		t.Fatalf("reloaded storage providers = %#v", providers)
	}
	if got := reloaded.StorageSettings().LocalCapacityLimitBytes; got != 6*1024*1024*1024 {
		t.Fatalf("reloaded local capacity limit = %d", got)
	}
}

func TestStoreStorageCapacityUpdateUsesProviderIdentityAndConfigurationSnapshot(t *testing.T) {
	newStore := func(t *testing.T) *Store {
		t.Helper()
		t.Setenv("ROOT_DIR", t.TempDir())
		t.Setenv("OBJECT_STORAGE_SETTINGS", "")
		store, err := NewStore()
		if err != nil {
			t.Fatal(err)
		}
		_, err = store.Update(map[string]any{"storage": model.StorageSetting{
			CapacityLimitBytes: 100,
			Providers: []model.StorageProvider{
				{ID: "dav-a", Name: "DAV A", Type: model.StorageProviderTypeWebDAV, Endpoint: "https://dav-a.example.test", PathPrefix: "assets-a", Username: "user-a", Password: "secret-a", Weight: 1, Enabled: true, CapacityBytes: 7, CapacityCheckedAt: "before-a"},
				{ID: "dav-b", Name: "DAV B", Type: model.StorageProviderTypeWebDAV, Endpoint: "https://dav-b.example.test", PathPrefix: "assets-b", Username: "user-b", Password: "secret-b", Weight: 2, Enabled: true, CapacityBytes: 9, CapacityCheckedAt: "before-b"},
			},
		}})
		if err != nil {
			t.Fatal(err)
		}
		return store
	}
	providerByID := func(t *testing.T, setting model.StorageSetting, id string) model.StorageProvider {
		t.Helper()
		for _, provider := range setting.Providers {
			if provider.ID == id {
				return provider
			}
		}
		t.Fatalf("provider %q not found in %#v", id, setting.Providers)
		return model.StorageProvider{}
	}

	t.Run("reorder updates the matching provider", func(t *testing.T) {
		store := newStore(t)
		before := store.StorageSettings()
		expected := providerByID(t, before, "dav-a")
		before.Providers[0], before.Providers[1] = before.Providers[1], before.Providers[0]
		before.Providers[0].Name = "DAV B renamed"
		if _, err := store.Update(map[string]any{"storage": before}); err != nil {
			t.Fatal(err)
		}

		applied, err := store.UpdateStorageProviderCapacity(expected, 100, 42, "after-a", false)
		if err != nil || !applied {
			t.Fatalf("UpdateStorageProviderCapacity() = (%v, %v), want applied", applied, err)
		}
		after := store.StorageSettings()
		if after.Providers[0].ID != "dav-b" || after.Providers[0].Name != "DAV B renamed" || after.Providers[0].CapacityBytes != 9 || after.Providers[0].CapacityCheckedAt != "before-b" {
			t.Fatalf("reordered first provider was overwritten: %#v", after.Providers[0])
		}
		updated := providerByID(t, after, "dav-a")
		if updated.CapacityBytes != 42 || updated.CapacityCheckedAt != "after-a" || updated.CapacityExceeded {
			t.Fatalf("matching provider capacity = %#v", updated)
		}
	})

	t.Run("non measurement edits are preserved", func(t *testing.T) {
		store := newStore(t)
		setting := store.StorageSettings()
		expected := providerByID(t, setting, "dav-a")
		setting.Providers[0].Name = "Renamed while measuring"
		setting.Providers[0].Weight = 8
		setting.Providers[0].PublicBaseURL = "https://cdn.example.test"
		if _, err := store.Update(map[string]any{"storage": setting}); err != nil {
			t.Fatal(err)
		}

		applied, err := store.UpdateStorageProviderCapacity(expected, 100, 105, "after-a", true)
		if err != nil || !applied {
			t.Fatalf("UpdateStorageProviderCapacity() = (%v, %v), want applied", applied, err)
		}
		updated := providerByID(t, store.StorageSettings(), "dav-a")
		if updated.Name != "Renamed while measuring" || updated.Weight != 8 || updated.PublicBaseURL != "https://cdn.example.test" {
			t.Fatalf("concurrent non-measurement edit was overwritten: %#v", updated)
		}
		if updated.CapacityBytes != 105 || !updated.CapacityExceeded || updated.Enabled {
			t.Fatalf("capacity protection was not applied: %#v", updated)
		}
	})

	for _, test := range []struct {
		name   string
		mutate func(*model.StorageSetting)
	}{
		{name: "connection edit", mutate: func(setting *model.StorageSetting) {
			setting.Providers[0].Endpoint = "https://dav-new.example.test"
		}},
		{name: "enabled edit", mutate: func(setting *model.StorageSetting) {
			setting.Providers[0].Enabled = false
		}},
		{name: "capacity limit edit", mutate: func(setting *model.StorageSetting) {
			setting.CapacityLimitBytes = 200
		}},
		{name: "delete", mutate: func(setting *model.StorageSetting) {
			setting.Providers = setting.Providers[1:]
		}},
	} {
		t.Run(test.name+" skips stale result", func(t *testing.T) {
			store := newStore(t)
			setting := store.StorageSettings()
			expected := providerByID(t, setting, "dav-a")
			test.mutate(&setting)
			if _, err := store.Update(map[string]any{"storage": setting}); err != nil {
				t.Fatal(err)
			}

			applied, err := store.UpdateStorageProviderCapacity(expected, 100, 105, "stale", true)
			if err != nil || applied {
				t.Fatalf("UpdateStorageProviderCapacity() = (%v, %v), want skipped", applied, err)
			}
			after := store.StorageSettings()
			if test.name == "delete" {
				if len(after.Providers) != 1 || after.Providers[0].ID != "dav-b" {
					t.Fatalf("deleted provider was restored: %#v", after.Providers)
				}
				return
			}
			updated := providerByID(t, after, "dav-a")
			if updated.CapacityBytes != 7 || updated.CapacityCheckedAt != "before-a" || updated.CapacityExceeded {
				t.Fatalf("stale capacity result was persisted: %#v", updated)
			}
			if test.name == "connection edit" && updated.Endpoint != "https://dav-new.example.test" {
				t.Fatalf("connection edit was lost: %#v", updated)
			}
			if test.name == "enabled edit" && updated.Enabled {
				t.Fatalf("enabled edit was lost: %#v", updated)
			}
			if test.name == "capacity limit edit" && after.CapacityLimitBytes != 200 {
				t.Fatalf("capacity limit edit was lost: %#v", after)
			}
		})
	}
}

func TestStoreIgnoresRemovedImageObjectStorageSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_STORAGE_BACKEND", "s3")
	t.Setenv("S3_ENDPOINT", "https://s3.example.test")
	t.Setenv("S3_ACCESS_KEY", "legacy-access")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	updated, err := store.Update(map[string]any{
		"image_storage_backend": "s3",
		"s3_endpoint":           "https://s3.example.test",
		"s3_access_key":         "browser-access",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	for _, key := range []string{"image_storage_backend", "s3_endpoint", "s3_access_key"} {
		if _, ok := updated[key]; ok {
			t.Fatalf("removed setting %q is still active: %#v", key, updated)
		}
	}
}

func TestStoreRelayDatabaseConfigDoesNotExposeCredentials(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for _, key := range []string{
		"DATABASE_URL",
		"DATABASE_DRIVER",
		"DATABASE_HOST",
		"DATABASE_PORT",
		"DATABASE_NAME",
		"DATABASE_USER",
		"DATABASE_PASSWORD",
	} {
		unsetEnv(t, key)
	}

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	config, err := store.Update(map[string]any{
		"relay_database_driver":   "postgres",
		"relay_database_host":     "db.internal",
		"relay_database_port":     "5433",
		"relay_database_name":     "newapi",
		"relay_database_user":     "reader",
		"relay_database_password": "top-secret",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	for _, key := range []string{"relay_database_url", "relay_database_password"} {
		if _, ok := config[key]; ok {
			t.Fatalf("%s leaked in config response: %#v", key, config)
		}
	}
	assertConfigValue(t, config, "relay_database_host", "db.internal")
	assertConfigValue(t, config, "relay_database_port", "5433")
	assertConfigValue(t, config, "relay_database_name", "newapi")
	assertConfigValue(t, config, "relay_database_user", "reader")
	assertConfigValue(t, config, "relay_database_password_configured", true)

	if _, err := store.Update(map[string]any{"proxy": ""}); err != nil {
		t.Fatalf("Update(without password) error = %v", err)
	}
	if got := store.RelayDatabaseConnectionURL(); !strings.Contains(got, "reader:top-secret@db.internal:5433") {
		t.Fatalf("RelayDatabaseConnectionURL() lost the write-only password: %q", got)
	}
}

func TestStoreRelayDatabaseURLCredentialsAreWriteOnly(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("DATABASE_URL", "postgresql://reader:p%40ss@db.internal:5434/sub2api")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	config := store.Get()
	for _, key := range []string{"relay_database_url", "relay_database_password"} {
		if _, ok := config[key]; ok {
			t.Fatalf("%s leaked in config response: %#v", key, config)
		}
	}
	assertConfigValue(t, config, "relay_database_driver", "postgres")
	assertConfigValue(t, config, "relay_database_host", "db.internal")
	assertConfigValue(t, config, "relay_database_port", "5434")
	assertConfigValue(t, config, "relay_database_name", "sub2api")
	assertConfigValue(t, config, "relay_database_user", "reader")
	assertConfigValue(t, config, "relay_database_password_configured", true)
}

func TestStoreIgnoresRemovedEnvironmentNames(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for _, key := range []string{
		"ADMIN_USERNAME", "ADMIN_PASSWORD", "IMAGE_BASE_URL", "API_BASE_URL", "IMAGE_MODELS",
		"CREATION_TASK_TIMEOUT_SECONDS",
	} {
		unsetEnv(t, key)
	}
	t.Setenv("CHATGPT2API_ADMIN_USERNAME", "legacy-admin")
	t.Setenv("CHATGPT2API_ADMIN_PASSWORD", "legacy-password")
	t.Setenv("CHATGPT2API_BASE_URL", "https://legacy-images.example")
	t.Setenv("CHATGPT2API_RELAY_BASE_URL", "https://legacy-api.example")
	t.Setenv("CHATGPT2API_IMAGE_MODELS", "legacy-image,legacy-image-2")
	t.Setenv("CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS", "420")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.AdminUsername() != "admin" || store.AdminPassword() != "" {
		t.Fatalf("removed admin variables are still active: %q / %q", store.AdminUsername(), store.AdminPassword())
	}
	if store.BaseURL() != defaultBaseURL || store.RelayBaseURL() != defaultRelayBaseURL {
		t.Fatalf("removed URL variables are still active: %q / %q", store.BaseURL(), store.RelayBaseURL())
	}
	if got := strings.Join(store.ImageModels(), ","); got == "legacy-image,legacy-image-2" {
		t.Fatalf("removed image model variable is still active: %q", got)
	}
	if store.ImageTaskTimeoutSeconds() != defaultImageTaskTimeoutSeconds {
		t.Fatalf("removed timeout variable is still active: %d", store.ImageTaskTimeoutSeconds())
	}
}

func TestStorePersistsPromptSourcesAsJSON(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "PROMPT_SOURCES")
	t.Cleanup(func() { _ = os.Unsetenv("PROMPT_SOURCES") })

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	sources := []any{
		map[string]any{
			"id":       "custom-source",
			"label":    "自定义来源",
			"url":      "https://example.test/prompts.json",
			"homepage": "https://example.test/prompts",
			"format":   "generic-json",
			"enabled":  true,
		},
	}
	updated, err := store.Update(map[string]any{"prompt_sources": sources})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	updatedSources, ok := updated["prompt_sources"].([]any)
	if !ok || len(updatedSources) != 1 {
		t.Fatalf("updated prompt_sources = %#v", updated["prompt_sources"])
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	if !strings.Contains(string(envData), "PROMPT_SOURCES=") || !strings.Contains(string(envData), "custom-source") {
		t.Fatalf("prompt sources were not persisted as JSON: %s", envData)
	}

	reloaded, err := NewStore()
	if err != nil {
		t.Fatalf("reload NewStore() error = %v", err)
	}
	reloadedSources, ok := reloaded.Get()["prompt_sources"].([]any)
	if !ok || len(reloadedSources) != 1 {
		t.Fatalf("reloaded prompt_sources = %#v", reloaded.Get()["prompt_sources"])
	}
	reloadedSource, ok := reloadedSources[0].(map[string]any)
	if !ok || reloadedSource["url"] != "https://example.test/prompts.json" {
		t.Fatalf("reloaded source = %#v", reloadedSources[0])
	}
	if reloadedSource["homepage"] != "https://example.test/prompts" {
		t.Fatalf("reloaded source homepage = %#v", reloadedSource["homepage"])
	}
}

func TestStorePromptSourcesDoNotExposeMutableState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "PROMPT_SOURCES")

	tags := []any{"original"}
	metadata := map[string]any{"owner": "original"}
	source := map[string]any{
		"id":       "custom-source",
		"label":    "Original",
		"tags":     tags,
		"metadata": metadata,
	}
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Update(map[string]any{"prompt_sources": []any{source}}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	source["label"] = "mutated input"
	tags[0] = "mutated input"
	metadata["owner"] = "mutated input"
	first := store.Get()["prompt_sources"].([]any)[0].(map[string]any)
	if first["label"] != "Original" || first["tags"].([]any)[0] != "original" || first["metadata"].(map[string]any)["owner"] != "original" {
		t.Fatalf("prompt_sources changed through Update() input: %#v", first)
	}

	first["label"] = "mutated output"
	first["tags"].([]any)[0] = "mutated output"
	first["metadata"].(map[string]any)["owner"] = "mutated output"
	second := store.Get()["prompt_sources"].([]any)[0].(map[string]any)
	if second["label"] != "Original" || second["tags"].([]any)[0] != "original" || second["metadata"].(map[string]any)["owner"] != "original" {
		t.Fatalf("prompt_sources changed through Get() result: %#v", second)
	}
}

func TestStoreGetUsesOneSettingsSnapshot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("PROJECT_NAME", "Old project")

	blockingTitle := &blockingConfigString{
		value:   "Old title",
		reached: make(chan struct{}),
		release: make(chan struct{}),
	}
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	store.mu.Lock()
	store.data["app_title"] = blockingTitle
	delete(store.data, "project_name")
	store.mu.Unlock()

	result := make(chan map[string]any, 1)
	go func() { result <- store.Get() }()
	<-blockingTitle.reached
	store.mu.Lock()
	store.data["app_title"] = "New title"
	store.mu.Unlock()
	if err := os.Setenv("PROJECT_NAME", "New project"); err != nil {
		t.Fatalf("Setenv(PROJECT_NAME): %v", err)
	}
	close(blockingTitle.release)

	settings := <-result
	if settings["app_title"] != "Old title" || settings["project_name"] != "Old project" {
		t.Fatalf("Get() mixed settings versions: app_title=%q project_name=%q", settings["app_title"], settings["project_name"])
	}
}

func TestStorePersistsLogCleanupSchedule(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "LOG_CLEANUP_SCHEDULE_ENABLED")
	unsetEnv(t, "LOG_CLEANUP_HOUR")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	updated, err := store.Update(map[string]any{
		"log_cleanup_schedule_enabled": true,
		"log_cleanup_hour":             4,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if !store.LogCleanupScheduleEnabled() || store.LogCleanupHour() != 4 {
		t.Fatalf("log cleanup schedule = enabled %v hour %d", store.LogCleanupScheduleEnabled(), store.LogCleanupHour())
	}
	if updated["log_cleanup_schedule_enabled"] != true || updated["log_cleanup_hour"] != 4 {
		t.Fatalf("updated log cleanup schedule = %#v, %#v", updated["log_cleanup_schedule_enabled"], updated["log_cleanup_hour"])
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	if !strings.Contains(string(envData), "LOG_CLEANUP_SCHEDULE_ENABLED=true") || !strings.Contains(string(envData), "LOG_CLEANUP_HOUR=4") {
		t.Fatalf("log cleanup schedule was not persisted: %s", envData)
	}

	updated, err = store.Update(map[string]any{"log_cleanup_hour": 99})
	if err != nil {
		t.Fatalf("Update(invalid hour) error = %v", err)
	}
	if updated["log_cleanup_hour"] != 3 {
		t.Fatalf("invalid log cleanup hour = %#v, want 3", updated["log_cleanup_hour"])
	}
}

func TestStoreDefaultImageModelsIncludeProviderRoutes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "IMAGE_MODELS")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	want := strings.Join([]string{
		util.ImageModelGPT,
		util.ImageModelGemini,
		util.ImageModelGrok,
	}, ",")
	if got := strings.Join(store.ImageModels(), ","); got != want {
		t.Fatalf("ImageModels() = %q, want %q", got, want)
	}
}

func TestStoreUpdatePersistsRuntimeSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "IMAGE_BASE_URL")
	unsetEnv(t, "API_BASE_URL")
	unsetEnv(t, "PROXY")
	unsetEnv(t, "IMAGE_MODELS")
	unsetEnv(t, "CHAT_MODELS")
	unsetEnv(t, "CREATION_TASK_TIMEOUT_SECONDS")
	unsetEnv(t, "USER_DEFAULT_CONCURRENT_LIMIT")
	unsetEnv(t, "USER_DEFAULT_RPM_LIMIT")
	unsetEnv(t, "IMAGE_RETENTION_DAYS")
	unsetEnv(t, "IMAGE_STORAGE_LIMIT_MB")
	unsetEnv(t, "LOG_RETENTION_DAYS")
	unsetEnv(t, "DEFAULT_LOG_VIEW")
	unsetEnv(t, "LOG_LEVELS")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.BaseURL() != "" {
		t.Fatalf("BaseURL() default = %q", store.BaseURL())
	}
	if store.RelayBaseURL() != "https://www.yunmian.tech" {
		t.Fatalf("RelayBaseURL() default = %q", store.RelayBaseURL())
	}

	got, err := store.Update(map[string]any{
		"base_url":                      "https://example.test/root/",
		"proxy":                         "http://127.0.0.1:8080",
		"image_models":                  []any{"gpt-image-2"},
		"text_models":                   []any{"gpt-5.5"},
		"audio_models":                  []any{"gpt-4o-mini-tts"},
		"image_concurrent_limit":        3,
		"image_task_timeout_seconds":    420,
		"user_default_concurrent_limit": 2,
		"user_default_rpm_limit":        30,
		"image_retention_days":          14,
		"image_storage_limit_mb":        512,
		"log_retention_days":            21,
		"log_levels":                    []any{"debug", "error"},
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if store.BaseURL() != "https://example.test/root" {
		t.Fatalf("BaseURL() = %q", store.BaseURL())
	}
	if models := strings.Join(store.ImageModels(), ","); models != "gpt-image-2" {
		t.Fatalf("ImageModels() = %q, want gpt-image-2", models)
	}
	if models := strings.Join(store.TextModels(), ","); models != "gpt-5.5" {
		t.Fatalf("TextModels() = %q, want gpt-5.5", models)
	}
	if models := strings.Join(store.AudioModels(), ","); models != "gpt-4o-mini-tts" {
		t.Fatalf("AudioModels() = %q, want gpt-4o-mini-tts", models)
	}
	assertConfigValue(t, got, "default_image_model", "gpt-image-2")
	if _, ok := got["chat_models"]; ok {
		t.Fatalf("chat_models leaked in config response: %#v", got)
	}
	if _, ok := got["default_chat_model"]; ok {
		t.Fatalf("default_chat_model leaked in config response: %#v", got)
	}
	if _, ok := got["image_concurrent_limit"]; ok {
		t.Fatalf("removed image_concurrent_limit leaked in config response: %#v", got)
	}

	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	envText := string(envData)
	for _, want := range []string{
		"IMAGE_BASE_URL=https://example.test/root/",
		"PROXY=http://127.0.0.1:8080",
		"IMAGE_MODELS=gpt-image-2",
		"CREATION_TASK_TIMEOUT_SECONDS=420",
		"USER_DEFAULT_CONCURRENT_LIMIT=2",
		"USER_DEFAULT_RPM_LIMIT=30",
		"IMAGE_RETENTION_DAYS=14",
		"IMAGE_STORAGE_LIMIT_MB=512",
		"LOG_RETENTION_DAYS=21",
		"LOG_LEVELS=debug,error",
	} {
		if !strings.Contains(envText, want) {
			t.Fatalf(".env missing %q in:\n%s", want, envText)
		}
	}
	if strings.Contains(envText, "IMAGE_CONCURRENT_LIMIT") {
		t.Fatalf(".env persisted removed image concurrent limit:\n%s", envText)
	}
}

func TestStoreReadsRelayDatabaseConfig(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("DATABASE_URL", "postgresql://relay.example/sub2api")
	t.Setenv("DATABASE_TYPE", "sub2api")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.RelayDatabaseURL(); got != "postgresql://relay.example/sub2api" {
		t.Fatalf("RelayDatabaseURL() = %q", got)
	}
	if got := store.RelayDatabaseType(); got != "sub2api" {
		t.Fatalf("RelayDatabaseType() = %q", got)
	}
}

func TestStoreKeepsUpstreamAndStorageDatabaseURLsSeparate(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("DATABASE_URL", "postgresql://upstream.example/newapi")
	t.Setenv("STORAGE_DATABASE_URL", "postgresql://business.example/chatgpt2api")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.RelayDatabaseURL(); got != "postgresql://upstream.example/newapi" {
		t.Fatalf("RelayDatabaseURL() = %q, want upstream database", got)
	}
}

func TestStoreBuildsRelayDatabaseURLsFromStructuredFields(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	_, err = store.Update(map[string]any{
		"relay_database_driver":   "postgres",
		"relay_database_host":     "db.internal",
		"relay_database_port":     "5433",
		"relay_database_name":     "newapi",
		"relay_database_user":     "app",
		"relay_database_password": "p@ss",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if got := store.RelayDatabaseConnectionURL(); got != "postgresql://app:p%40ss@db.internal:5433/newapi?sslmode=disable" {
		t.Fatalf("RelayDatabaseConnectionURL() = %q", got)
	}
	_, err = store.Update(map[string]any{"relay_database_driver": "sqlite", "relay_database_name": "/app/data/newapi.db"})
	if err != nil {
		t.Fatalf("Update(sqlite) error = %v", err)
	}
	if got := store.RelayDatabaseConnectionURL(); got != "sqlite:////app/data/newapi.db" {
		t.Fatalf("RelayDatabaseConnectionURL(sqlite) = %q", got)
	}
	_, err = store.Update(map[string]any{
		"relay_database_driver":   "mysql",
		"relay_database_host":     "mysql.internal",
		"relay_database_port":     "3307",
		"relay_database_name":     "sub2api",
		"relay_database_user":     "reader",
		"relay_database_password": "secret",
	})
	if err != nil {
		t.Fatalf("Update(mysql) error = %v", err)
	}
	if got := store.RelayDatabaseConnectionURL(); got != "mysql://reader:secret@mysql.internal:3307/sub2api" {
		t.Fatalf("RelayDatabaseConnectionURL(mysql) = %q", got)
	}
}

func TestStoreNormalizesUnsupportedLoginPageImageMode(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "LOGIN_PAGE_IMAGE_MODE")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{"login_page_image_mode": "repeat"})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	assertConfigValue(t, got, "login_page_image_mode", "contain")
	if store.LoginPageImageMode() != "contain" {
		t.Fatalf("LoginPageImageMode() = %q, want contain", store.LoginPageImageMode())
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	envText := string(envData)
	if strings.Contains(envText, "LOGIN_PAGE_IMAGE_MODE=repeat") {
		t.Fatalf(".env persisted unsupported login page image mode:\n%s", envText)
	}
	if !strings.Contains(envText, "LOGIN_PAGE_IMAGE_MODE=contain") {
		t.Fatalf(".env missing normalized login page image mode:\n%s", envText)
	}
}

func TestStoreNormalizesImageTaskTimeoutSeconds(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "CREATION_TASK_TIMEOUT_SECONDS")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	got, err := store.Update(map[string]any{"image_task_timeout_seconds": 5})
	if err != nil {
		t.Fatalf("Update() min error = %v", err)
	}
	assertConfigValue(t, got, "image_task_timeout_seconds", 30)
	if store.ImageTaskTimeoutSeconds() != 30 {
		t.Fatalf("ImageTaskTimeoutSeconds() = %d, want 30", store.ImageTaskTimeoutSeconds())
	}

	got, err = store.Update(map[string]any{"image_task_timeout_seconds": 7200})
	if err != nil {
		t.Fatalf("Update() max error = %v", err)
	}
	assertConfigValue(t, got, "image_task_timeout_seconds", 3600)
	if store.ImageTaskTimeoutSeconds() != 3600 {
		t.Fatalf("ImageTaskTimeoutSeconds() = %d, want 3600", store.ImageTaskTimeoutSeconds())
	}

	got, err = store.Update(map[string]any{"image_task_timeout_seconds": float64(900)})
	if err != nil {
		t.Fatalf("Update() json number error = %v", err)
	}
	assertConfigValue(t, got, "image_task_timeout_seconds", 900)
	if store.ImageTaskTimeoutSeconds() != 900 {
		t.Fatalf("ImageTaskTimeoutSeconds() = %d, want 900", store.ImageTaskTimeoutSeconds())
	}
}

func TestStoreUpdateRefreshesEnvFileBackedRuntimeSettings(t *testing.T) {
	root := t.TempDir()
	envText := strings.Join([]string{
		"IMAGE_BASE_URL=https://old.example/root",
		"PROXY=http://127.0.0.1:8080",
		"CREATION_TASK_TIMEOUT_SECONDS=300",
		"USER_DEFAULT_CONCURRENT_LIMIT=2",
		"USER_DEFAULT_RPM_LIMIT=30",
		"IMAGE_RETENTION_DAYS=30",
		"IMAGE_STORAGE_LIMIT_MB=2048",
		"LOG_RETENTION_DAYS=7",
		"LOG_LEVELS=warning,error",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(envText), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_BASE_URL", "https://old.example/root")
	t.Setenv("PROXY", "http://127.0.0.1:8080")
	t.Setenv("CREATION_TASK_TIMEOUT_SECONDS", "300")
	t.Setenv("USER_DEFAULT_CONCURRENT_LIMIT", "2")
	t.Setenv("USER_DEFAULT_RPM_LIMIT", "30")
	t.Setenv("IMAGE_RETENTION_DAYS", "30")
	t.Setenv("IMAGE_STORAGE_LIMIT_MB", "2048")
	t.Setenv("LOG_RETENTION_DAYS", "7")
	t.Setenv("LOG_LEVELS", "warning,error")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{
		"base_url":                      "https://new.example/root/",
		"proxy":                         "http://127.0.0.1:9090",
		"image_task_timeout_seconds":    480,
		"user_default_concurrent_limit": 3,
		"user_default_rpm_limit":        45,
		"image_retention_days":          12,
		"image_storage_limit_mb":        1024,
		"log_retention_days":            30,
		"log_levels":                    []any{"debug", "info"},
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	assertConfigValue(t, got, "base_url", "https://new.example/root")
	assertConfigValue(t, got, "proxy", "http://127.0.0.1:9090")
	assertConfigValue(t, got, "image_task_timeout_seconds", 480)
	assertConfigValue(t, got, "user_default_concurrent_limit", 3)
	assertConfigValue(t, got, "user_default_rpm_limit", 45)
	assertConfigValue(t, got, "image_retention_days", 12)
	assertConfigValue(t, got, "image_storage_limit_mb", 1024)
	if store.ImageStorageLimitBytes() != 1024*1024*1024 {
		t.Fatalf("ImageStorageLimitBytes() = %d, want 1GiB", store.ImageStorageLimitBytes())
	}
	assertConfigValue(t, got, "log_retention_days", 30)
	if levels := strings.Join(store.LogLevels(), ","); levels != "debug,info" {
		t.Fatalf("LogLevels() = %q, want debug,info", levels)
	}

	for key, want := range map[string]string{
		"IMAGE_BASE_URL":                "https://new.example/root/",
		"PROXY":                         "http://127.0.0.1:9090",
		"CREATION_TASK_TIMEOUT_SECONDS": "480",
		"USER_DEFAULT_CONCURRENT_LIMIT": "3",
		"USER_DEFAULT_RPM_LIMIT":        "45",
		"IMAGE_RETENTION_DAYS":          "12",
		"IMAGE_STORAGE_LIMIT_MB":        "1024",
		"LOG_RETENTION_DAYS":            "30",
		"LOG_LEVELS":                    "debug,info",
	} {
		if gotEnv := os.Getenv(key); gotEnv != want {
			t.Fatalf("%s = %q, want %q", key, gotEnv, want)
		}
	}
}

func TestImageStorageLimitBytesDoesNotOverflowLargestInt(t *testing.T) {
	maxMB := int(^uint(0) >> 1)
	store := &Store{data: map[string]any{"image_storage_limit_mb": maxMB}}
	want := int64(math.MaxInt64)
	if int64(maxMB) <= math.MaxInt64/(1024*1024) {
		want = int64(maxMB) * 1024 * 1024
	}
	if got := store.ImageStorageLimitBytes(); got != want {
		t.Fatalf("ImageStorageLimitBytes() = %d, want %d", got, want)
	}
}

func TestStoreUpdateOverridesEnvOnlyRuntimeSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for key, value := range map[string]string{
		"IMAGE_BASE_URL":                "https://old.example/root",
		"PROXY":                         "http://127.0.0.1:8080",
		"CREATION_TASK_TIMEOUT_SECONDS": "300",
		"USER_DEFAULT_CONCURRENT_LIMIT": "2",
		"USER_DEFAULT_RPM_LIMIT":        "30",
		"IMAGE_RETENTION_DAYS":          "30",
		"IMAGE_STORAGE_LIMIT_MB":        "2048",
		"LOG_RETENTION_DAYS":            "7",
		"LOG_LEVELS":                    "warning,error",
		"LOGIN_PAGE_IMAGE_URL":          "https://old.example/login.png",
		"LOGIN_PAGE_IMAGE_MODE":         "contain",
		"LOGIN_PAGE_IMAGE_ZOOM":         "1",
		"LOGIN_PAGE_IMAGE_POSITION_X":   "50",
		"LOGIN_PAGE_IMAGE_POSITION_Y":   "50",
	} {
		t.Setenv(key, value)
	}

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{
		"base_url":                      "https://new.example/root/",
		"proxy":                         "http://127.0.0.1:9090",
		"image_task_timeout_seconds":    480,
		"user_default_concurrent_limit": 3,
		"user_default_rpm_limit":        45,
		"image_retention_days":          12,
		"image_storage_limit_mb":        1024,
		"log_retention_days":            30,
		"log_levels":                    []any{"debug", "info"},
		"login_page_image_url":          "https://new.example/login.png",
		"login_page_image_mode":         "cover",
		"login_page_image_zoom":         2,
		"login_page_image_position_x":   25,
		"login_page_image_position_y":   75,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	assertConfigValue(t, got, "base_url", "https://new.example/root")
	assertConfigValue(t, got, "proxy", "http://127.0.0.1:9090")
	assertConfigValue(t, got, "image_task_timeout_seconds", 480)
	assertConfigValue(t, got, "user_default_concurrent_limit", 3)
	assertConfigValue(t, got, "user_default_rpm_limit", 45)
	assertConfigValue(t, got, "image_retention_days", 12)
	assertConfigValue(t, got, "image_storage_limit_mb", 1024)
	assertConfigValue(t, got, "log_retention_days", 30)
	assertConfigValue(t, got, "login_page_image_url", "https://new.example/login.png")
	assertConfigValue(t, got, "login_page_image_mode", "cover")
	assertConfigValue(t, got, "login_page_image_zoom", float64(2))
	assertConfigValue(t, got, "login_page_image_position_x", float64(25))
	assertConfigValue(t, got, "login_page_image_position_y", float64(75))
	if levels := strings.Join(store.LogLevels(), ","); levels != "debug,info" {
		t.Fatalf("LogLevels() = %q, want debug,info", levels)
	}

	for key, want := range map[string]string{
		"IMAGE_BASE_URL":                "https://new.example/root/",
		"PROXY":                         "http://127.0.0.1:9090",
		"CREATION_TASK_TIMEOUT_SECONDS": "480",
		"USER_DEFAULT_CONCURRENT_LIMIT": "3",
		"USER_DEFAULT_RPM_LIMIT":        "45",
		"IMAGE_RETENTION_DAYS":          "12",
		"IMAGE_STORAGE_LIMIT_MB":        "1024",
		"LOG_RETENTION_DAYS":            "30",
		"LOG_LEVELS":                    "debug,info",
		"LOGIN_PAGE_IMAGE_URL":          "https://new.example/login.png",
		"LOGIN_PAGE_IMAGE_MODE":         "cover",
		"LOGIN_PAGE_IMAGE_ZOOM":         "2",
		"LOGIN_PAGE_IMAGE_POSITION_X":   "25",
		"LOGIN_PAGE_IMAGE_POSITION_Y":   "75",
	} {
		if gotEnv := os.Getenv(key); gotEnv != want {
			t.Fatalf("%s = %q, want %q", key, gotEnv, want)
		}
	}
}

func TestNewStoreDiscoversEnvFromParentDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("IMAGE_BASE_URL=https://parent.example\n"), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	nested := filepath.Join(root, "cmd", "chatgpt2api")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}
	originalWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	if err := os.Chdir(nested); err != nil {
		t.Fatalf("Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalWD)
	})
	unsetEnv(t, "ROOT_DIR")
	unsetEnv(t, "IMAGE_BASE_URL")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.RootDir != root {
		t.Fatalf("RootDir = %q, want %q", store.RootDir, root)
	}
	if store.BaseURL() != "https://parent.example" {
		t.Fatalf("BaseURL() = %q", store.BaseURL())
	}
}

func TestStoreReadsRelayBaseURLFromEnvFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("API_BASE_URL=https://relay.example/root/\n"), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "API_BASE_URL")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.RelayBaseURL(); got != "https://relay.example/root" {
		t.Fatalf("RelayBaseURL() = %q, want configured base URL", got)
	}
}

func TestNewStoreRejectsUnreadableEnvironmentPath(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".env"), 0o755); err != nil {
		t.Fatalf("create .env directory: %v", err)
	}
	t.Setenv("ROOT_DIR", root)

	if _, err := NewStore(); err == nil || !strings.Contains(err.Error(), "read environment file") {
		t.Fatalf("NewStore() error = %v, want environment read failure", err)
	}
}

func TestNewStoreInitializesRequiredDataDirectories(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"images", "image_thumbnails", "image_metadata", "login_page_images", "site_icons"} {
		info, statErr := os.Stat(filepath.Join(store.DataDir, name))
		if statErr != nil || !info.IsDir() {
			t.Fatalf("required data directory %q: info = %#v, error = %v", name, info, statErr)
		}
	}
}

func TestNewStoreRejectsInvalidRequiredDataDirectory(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "images"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROOT_DIR", root)

	if _, err := NewStore(); err == nil || !strings.Contains(err.Error(), "initialize data directory") {
		t.Fatalf("NewStore() error = %v, want data directory failure", err)
	}
}

func TestStoreRejectsEnvironmentValuesContainingNullBytesBeforePersisting(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	previousTitle := store.AppTitle()

	if _, err := store.Update(map[string]any{"app_title": "invalid\x00title"}); err == nil || !strings.Contains(err.Error(), "contains a null byte") {
		t.Fatalf("Update() error = %v, want null-byte rejection", err)
	}
	if got := store.AppTitle(); got != previousTitle {
		t.Fatalf("AppTitle() = %q after rejected update, want %q", got, previousTitle)
	}
	if _, err := os.Stat(store.EnvFile); !os.IsNotExist(err) {
		t.Fatalf("rejected update persisted .env: %v", err)
	}
}

func TestStoreUpdatePersistsRelayBaseURL(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "API_BASE_URL")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{
		"relay_base_url": "https://relay.example/root/",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if got["relay_base_url"] != "https://relay.example/root" {
		t.Fatalf("Update() relay_base_url = %#v, want trimmed URL", got["relay_base_url"])
	}
	if store.RelayBaseURL() != "https://relay.example/root" {
		t.Fatalf("RelayBaseURL() = %q, want saved URL", store.RelayBaseURL())
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	envText := string(envData)
	if want := "API_BASE_URL=https://relay.example/root/"; !strings.Contains(envText, want) {
		t.Fatalf(".env missing %q:\n%s", want, envText)
	}
}

func TestStoreUpdateRejectsInvalidRelayBaseURL(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "API_BASE_URL")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Update(map[string]any{"relay_base_url": "relay.invalid"}); err == nil {
		t.Fatal("Update() accepted invalid relay_base_url")
	}
}

func TestStoreUpdateValidatesProxyURLBeforePersisting(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "PROXY")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	for _, proxy := range []string{
		"http://proxy.example:8080",
		"https://user:password@proxy.example:8443",
		"socks5://127.0.0.1:1080",
		"socks5h://proxy.example:1080",
		"",
	} {
		if _, err := store.Update(map[string]any{"proxy": proxy}); err != nil {
			t.Fatalf("Update(proxy %q) error = %v", proxy, err)
		}
	}

	if _, err := store.Update(map[string]any{"proxy": "http://proxy.example:8080"}); err != nil {
		t.Fatal(err)
	}
	for _, proxy := range []string{
		"proxy.example:8080",
		"ftp://proxy.example:21",
		"http:///missing-host",
		"://invalid",
	} {
		if _, err := store.Update(map[string]any{"proxy": proxy}); err == nil {
			t.Errorf("Update(proxy %q) succeeded, want validation error", proxy)
		}
		if got := store.Proxy(); got != "http://proxy.example:8080" {
			t.Errorf("Proxy() = %q after rejected update, want previous value", got)
		}
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(envData), "ftp://") || strings.Contains(string(envData), "missing-host") {
		t.Fatalf("invalid proxy was persisted: %s", envData)
	}
}

func TestEnvValueFormattingRoundTripsEscapes(t *testing.T) {
	for _, value := range []string{
		`literal\nsequence`,
		`literal\rsequence`,
		`literal\tsequence`,
		"line one\nline two\r\n\tindent",
		`quote " and trailing slash\`,
	} {
		if got := unquoteEnvValue(formatEnvValue(value)); got != value {
			t.Errorf("environment value round trip = %q, want %q", got, value)
		}
	}
}

func TestStringifySettingEnvValueRoundTripsStructuredSettings(t *testing.T) {
	promptSourcesJSON := stringifySettingEnvValue("prompt_sources", []any{
		map[string]any{"id": "source-1", "enabled": true},
	})
	var promptSources []map[string]any
	if err := json.Unmarshal([]byte(promptSourcesJSON), &promptSources); err != nil {
		t.Fatalf("decode prompt sources: %v", err)
	}
	if len(promptSources) != 1 || promptSources[0]["id"] != "source-1" || promptSources[0]["enabled"] != true {
		t.Fatalf("prompt sources round trip = %#v", promptSources)
	}

	storageJSON := stringifySettingEnvValue("storage", model.StorageSetting{
		AllowUserProvider:  true,
		CapacityLimitBytes: 1024,
		Providers: []model.StorageProvider{{
			ID: "storage-1", Name: "Primary", Type: model.StorageProviderTypeWebDAV,
			Endpoint: "https://dav.example.test/", Username: "user", Password: "secret",
		}},
	})
	var storageSetting model.StorageSetting
	if err := json.Unmarshal([]byte(storageJSON), &storageSetting); err != nil {
		t.Fatalf("decode storage setting: %v", err)
	}
	if storageSetting.Mode != "server_user_or_local" || storageSetting.CapacityLimitBytes != 1024 || len(storageSetting.Providers) != 1 {
		t.Fatalf("storage setting round trip = %#v", storageSetting)
	}
	provider := storageSetting.Providers[0]
	if provider.ID != "storage-1" || provider.Type != model.StorageProviderTypeWebDAV || provider.Endpoint != "https://dav.example.test" || provider.Password != "secret" {
		t.Fatalf("storage provider round trip = %#v", provider)
	}
}

func TestWriteEnvUpdatesReplacesDuplicateAssignments(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("DUPLICATE=old-first\nKEEP=unchanged\nDUPLICATE=old-last\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeEnvUpdates(path, map[string]string{"DUPLICATE": "new"}); err != nil {
		t.Fatal(err)
	}
	values, err := readEnvObject(path)
	if err != nil {
		t.Fatal(err)
	}
	if values["DUPLICATE"] != "new" || values["KEEP"] != "unchanged" {
		t.Fatalf("environment values = %#v", values)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), "DUPLICATE=old") || strings.Count(string(contents), "DUPLICATE=new") != 2 {
		t.Fatalf("updated environment file = %q", contents)
	}
}

func TestWriteEnvUpdatesProtectsEnvironmentFilePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := writeEnvUpdates(path, map[string]string{"DATABASE_PASSWORD": "secret"}); err != nil {
		t.Fatalf("create environment file: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("new environment file mode = %04o, want 0600", got)
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeEnvUpdates(path, map[string]string{"DATABASE_PASSWORD": "updated-secret"}); err != nil {
		t.Fatalf("update environment file: %v", err)
	}
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("updated environment file mode = %04o, want 0600", got)
	}
}

func TestWriteEnvUpdatesReturnsExistingFileReadError(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	err := writeEnvUpdates(path, map[string]string{"KEY": "value"})
	if err == nil || !strings.Contains(err.Error(), "read environment file") {
		t.Fatalf("writeEnvUpdates() error = %v, want contextual read error", err)
	}
}

func TestStoreAllowsEmptyImageBaseURLAndRejectsInvalidOverride(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "IMAGE_BASE_URL")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Update(map[string]any{"base_url": ""}); err != nil {
		t.Fatalf("Update(empty base_url) error = %v", err)
	}
	if store.BaseURL() != "" {
		t.Fatalf("BaseURL() = %q, want same-origin mode", store.BaseURL())
	}
	if _, err := store.Update(map[string]any{"base_url": "files.invalid"}); err == nil {
		t.Fatal("Update() accepted invalid image base URL")
	}
}

func assertConfigValue(t *testing.T, data map[string]any, key string, want any) {
	t.Helper()
	if got := data[key]; got != want {
		t.Fatalf("%s = %#v, want %#v", key, got, want)
	}
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	original, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("Unsetenv(%s): %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, original)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}
