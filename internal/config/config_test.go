package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestStoreImageObjectStorageConfigDoesNotExposeCredentials(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_STORAGE_BACKEND", "s3")
	t.Setenv("S3_ENDPOINT", "https://s3.example.test")
	t.Setenv("S3_BUCKET", "private-images")
	t.Setenv("S3_PREFIX", "cloud-cotton/images")
	t.Setenv("S3_ACCESS_KEY", "test-access-key")
	t.Setenv("S3_SECRET_KEY", "test-secret-key")
	t.Setenv("S3_SESSION_TOKEN", "test-session-token")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	config := store.Get()
	assertConfigValue(t, config, "image_storage_backend", "s3")
	assertConfigValue(t, config, "s3_endpoint", "https://s3.example.test")
	assertConfigValue(t, config, "s3_bucket", "private-images")
	assertConfigValue(t, config, "s3_prefix", "cloud-cotton/images")
	assertConfigValue(t, config, "s3_endpoint_configured", true)
	assertConfigValue(t, config, "s3_credentials_configured", true)
	for _, key := range []string{"s3_access_key", "s3_secret_key", "s3_session_token"} {
		if _, ok := config[key]; ok {
			t.Fatalf("%s leaked in config response: %#v", key, config)
		}
	}

	updated, err := store.Update(map[string]any{
		"image_storage_backend": "local",
		"s3_endpoint":           "http://minio:9000",
		"s3_region":             "us-east-1",
		"s3_bucket":             "next-images",
		"s3_prefix":             "/gallery/",
		"s3_use_path_style":     true,
		"s3_access_key":         "browser-access-key",
		"s3_secret_key":         "browser-secret-key",
		"s3_session_token":      "browser-session-token",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	assertConfigValue(t, updated, "image_storage_backend", "local")
	assertConfigValue(t, updated, "s3_endpoint", "http://minio:9000")
	assertConfigValue(t, updated, "s3_region", "us-east-1")
	assertConfigValue(t, updated, "s3_bucket", "next-images")
	assertConfigValue(t, updated, "s3_prefix", "gallery")
	assertConfigValue(t, updated, "s3_use_path_style", true)
	if store.S3AccessKey() != "test-access-key" || store.S3SecretKey() != "test-secret-key" || store.S3SessionToken() != "test-session-token" {
		t.Fatal("browser-submitted S3 credentials replaced server credentials")
	}
	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	envText := string(envData)
	for _, forbidden := range []string{"browser-access-key", "browser-secret-key", "browser-session-token"} {
		if strings.Contains(envText, forbidden) {
			t.Fatalf("browser credential %q persisted in .env", forbidden)
		}
	}
}

func TestStoreReadsLegacyEnvironmentNamesWhenNewNamesAreUnset(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for _, key := range []string{
		"ADMIN_USERNAME", "ADMIN_PASSWORD", "IMAGE_BASE_URL", "API_BASE_URL", "IMAGE_MODELS",
		"CREATION_TASK_TIMEOUT_SECONDS", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY",
	} {
		unsetEnv(t, key)
	}
	t.Setenv("CHATGPT2API_ADMIN_USERNAME", "legacy-admin")
	t.Setenv("CHATGPT2API_ADMIN_PASSWORD", "legacy-password")
	t.Setenv("CHATGPT2API_BASE_URL", "https://legacy-images.example")
	t.Setenv("CHATGPT2API_RELAY_BASE_URL", "https://legacy-api.example")
	t.Setenv("CHATGPT2API_IMAGE_MODELS", "legacy-image,legacy-image-2")
	t.Setenv("CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS", "420")
	t.Setenv("CHATGPT2API_S3_ENDPOINT", "https://legacy-s3.example")
	t.Setenv("CHATGPT2API_S3_ACCESS_KEY", "legacy-access")
	t.Setenv("CHATGPT2API_S3_SECRET_KEY", "legacy-secret")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.AdminUsername() != "legacy-admin" || store.AdminPassword() != "legacy-password" {
		t.Fatalf("legacy admin settings were not read: %q / %q", store.AdminUsername(), store.AdminPassword())
	}
	if store.BaseURL() != "https://legacy-images.example" || store.RelayBaseURL() != "https://legacy-api.example" {
		t.Fatalf("legacy URLs were not read: %q / %q", store.BaseURL(), store.RelayBaseURL())
	}
	if got := strings.Join(store.ImageModels(), ","); got != "legacy-image,legacy-image-2" {
		t.Fatalf("legacy image models = %q", got)
	}
	if store.ImageTaskTimeoutSeconds() != 420 || store.S3Endpoint() != "https://legacy-s3.example" {
		t.Fatalf("legacy runtime settings were not read")
	}
	if store.S3AccessKey() != "legacy-access" || store.S3SecretKey() != "legacy-secret" {
		t.Fatalf("legacy S3 credentials were not read")
	}
}

func TestStorePrefersNewEnvironmentNameOverLegacyName(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_BASE_URL", "https://new.example")
	t.Setenv("CHATGPT2API_BASE_URL", "https://legacy.example")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.BaseURL() != "https://new.example" {
		t.Fatalf("BaseURL() = %q, want new value", store.BaseURL())
	}
}

func TestStorePrefersNewProcessEnvironmentOverLegacyEnvFile(t *testing.T) {
	root := t.TempDir()
	unsetEnv(t, "CHATGPT2API_BASE_URL")
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("CHATGPT2API_BASE_URL=https://legacy-file.example\n"), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_BASE_URL", "https://new-process.example")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.BaseURL() != "https://new-process.example" {
		t.Fatalf("BaseURL() = %q, want new process value", store.BaseURL())
	}
}

func TestStoreMigratesLegacyEnvFileSettingsWhenSaved(t *testing.T) {
	root := t.TempDir()
	envText := strings.Join([]string{
		"CHATGPT2API_BASE_URL=https://legacy.example",
		"CHATGPT2API_IMAGE_MODELS=legacy-image",
		"CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS=420",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(envText), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("ROOT_DIR", root)
	for _, key := range []string{
		"IMAGE_BASE_URL", "IMAGE_MODELS", "CREATION_TASK_TIMEOUT_SECONDS",
		"CHATGPT2API_BASE_URL", "CHATGPT2API_IMAGE_MODELS", "CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS",
	} {
		unsetEnv(t, key)
	}
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Update(map[string]any{"base_url": "https://saved.example"}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"IMAGE_BASE_URL=https://saved.example",
		"IMAGE_MODELS=legacy-image",
		"CREATION_TASK_TIMEOUT_SECONDS=420",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("migrated .env missing %q:\n%s", want, text)
		}
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
			"id":      "custom-source",
			"label":   "自定义来源",
			"url":     "https://example.test/prompts.json",
			"format":  "generic-json",
			"enabled": true,
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
}

func TestStoreRejectsInvalidImageObjectStorageSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("S3_ACCESS_KEY", "access")
	t.Setenv("S3_SECRET_KEY", "secret")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	for _, update := range []map[string]any{
		{"image_storage_backend": "ftp"},
		{"image_storage_backend": "s3", "s3_endpoint": "https://s3.example.test/path", "s3_bucket": "images"},
		{"image_storage_backend": "s3", "s3_endpoint": "https://s3.example.test", "s3_bucket": ""},
		{"image_storage_backend": "local", "s3_prefix": "../images"},
	} {
		if _, err := store.Update(update); err == nil {
			t.Fatalf("Update(%#v) accepted invalid object storage settings", update)
		}
	}
}

func TestStoreImageStorageBackendDefaultsToLocal(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "IMAGE_STORAGE_BACKEND")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.ImageStorageBackend(); got != "local" {
		t.Fatalf("ImageStorageBackend() = %q", got)
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
	unsetEnv(t, "REFRESH_ACCOUNT_INTERVAL_MINUTE")
	unsetEnv(t, "CREATION_TASK_TIMEOUT_SECONDS")
	unsetEnv(t, "USER_DEFAULT_CONCURRENT_LIMIT")
	unsetEnv(t, "USER_DEFAULT_RPM_LIMIT")
	unsetEnv(t, "IMAGE_RETENTION_DAYS")
	unsetEnv(t, "IMAGE_STORAGE_LIMIT_MB")
	unsetEnv(t, "LOG_RETENTION_DAYS")
	unsetEnv(t, "DEFAULT_LOG_VIEW")
	unsetEnv(t, "AUTO_REMOVE_INVALID_ACCOUNTS")
	unsetEnv(t, "AUTO_REMOVE_RATE_LIMITED_ACCOUNTS")
	unsetEnv(t, "LOG_LEVELS")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.BaseURL() != "https://image.yunmian.tech" {
		t.Fatalf("BaseURL() default = %q", store.BaseURL())
	}
	if store.RelayBaseURL() != "https://www.yunmian.tech" {
		t.Fatalf("RelayBaseURL() default = %q", store.RelayBaseURL())
	}

	got, err := store.Update(map[string]any{
		"base_url":                        "https://example.test/root/",
		"proxy":                           "http://127.0.0.1:8080",
		"image_models":                    []any{"gpt-image-2"},
		"refresh_account_interval_minute": 7,
		"image_concurrent_limit":          3,
		"image_task_timeout_seconds":      420,
		"user_default_concurrent_limit":   2,
		"user_default_rpm_limit":          30,
		"image_retention_days":            14,
		"image_storage_limit_mb":          512,
		"log_retention_days":              21,
		"log_levels":                      []any{"debug", "error"},
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
		"REFRESH_ACCOUNT_INTERVAL_MINUTE=7",
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

func TestStorePreservesLegacyUpstreamAndStorageDatabaseLayout(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("STORAGE_BACKEND", "postgres")
	unsetEnv(t, "STORAGE_DATABASE_URL")
	t.Setenv("DATABASE_URL", "postgresql://business.example/chatgpt2api")
	t.Setenv("CHATGPT2API_NEWAPI_DATABASE_URL", "postgresql://upstream.example/newapi")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.RelayDatabaseURL(); got != "postgresql://upstream.example/newapi" {
		t.Fatalf("RelayDatabaseURL() = %q, want legacy upstream database", got)
	}
}

func TestStoreUsesNewDatabaseURLAfterStorageDatabaseMigration(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("DATABASE_URL", "postgresql://new-upstream.example/newapi")
	t.Setenv("STORAGE_DATABASE_URL", "postgresql://business.example/chatgpt2api")
	t.Setenv("CHATGPT2API_NEWAPI_DATABASE_URL", "postgresql://legacy-upstream.example/newapi")
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if got := store.RelayDatabaseURL(); got != "postgresql://new-upstream.example/newapi" {
		t.Fatalf("RelayDatabaseURL() = %q, want new upstream database", got)
	}
}

func TestStoreNormalizesAccountScheduleModes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	unsetEnv(t, "TEXT_ACCOUNT_SCHEDULE_MODE")
	unsetEnv(t, "IMAGE_ACCOUNT_SCHEDULE_MODE")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if store.TextAccountScheduleMode() != "load_balance" {
		t.Fatalf("TextAccountScheduleMode() = %q, want load_balance", store.TextAccountScheduleMode())
	}
	if store.ImageAccountScheduleMode() != "load_balance" {
		t.Fatalf("ImageAccountScheduleMode() = %q, want load_balance", store.ImageAccountScheduleMode())
	}

	got, err := store.Update(map[string]any{
		"text_account_schedule_mode":  "fill_first",
		"image_account_schedule_mode": "invalid",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	assertConfigValue(t, got, "text_account_schedule_mode", "fill_first")
	assertConfigValue(t, got, "image_account_schedule_mode", "load_balance")
	if store.TextAccountScheduleMode() != "fill_first" {
		t.Fatalf("TextAccountScheduleMode() = %q, want fill_first", store.TextAccountScheduleMode())
	}
	if store.ImageAccountScheduleMode() != "load_balance" {
		t.Fatalf("ImageAccountScheduleMode() = %q, want load_balance", store.ImageAccountScheduleMode())
	}

	envData, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	envText := string(envData)
	for _, want := range []string{
		"TEXT_ACCOUNT_SCHEDULE_MODE=fill_first",
		"IMAGE_ACCOUNT_SCHEDULE_MODE=load_balance",
	} {
		if !strings.Contains(envText, want) {
			t.Fatalf(".env missing %q in:\n%s", want, envText)
		}
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
		"REFRESH_ACCOUNT_INTERVAL_MINUTE=5",
		"CREATION_TASK_TIMEOUT_SECONDS=300",
		"USER_DEFAULT_CONCURRENT_LIMIT=2",
		"USER_DEFAULT_RPM_LIMIT=30",
		"IMAGE_RETENTION_DAYS=30",
		"IMAGE_STORAGE_LIMIT_MB=2048",
		"LOG_RETENTION_DAYS=7",
		"AUTO_REMOVE_INVALID_ACCOUNTS=true",
		"AUTO_REMOVE_RATE_LIMITED_ACCOUNTS=false",
		"LOG_LEVELS=warning,error",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(envText), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("ROOT_DIR", root)
	t.Setenv("IMAGE_BASE_URL", "https://old.example/root")
	t.Setenv("PROXY", "http://127.0.0.1:8080")
	t.Setenv("REFRESH_ACCOUNT_INTERVAL_MINUTE", "5")
	t.Setenv("CREATION_TASK_TIMEOUT_SECONDS", "300")
	t.Setenv("USER_DEFAULT_CONCURRENT_LIMIT", "2")
	t.Setenv("USER_DEFAULT_RPM_LIMIT", "30")
	t.Setenv("IMAGE_RETENTION_DAYS", "30")
	t.Setenv("IMAGE_STORAGE_LIMIT_MB", "2048")
	t.Setenv("LOG_RETENTION_DAYS", "7")
	t.Setenv("AUTO_REMOVE_INVALID_ACCOUNTS", "true")
	t.Setenv("AUTO_REMOVE_RATE_LIMITED_ACCOUNTS", "false")
	t.Setenv("LOG_LEVELS", "warning,error")

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{
		"base_url":                          "https://new.example/root/",
		"proxy":                             "http://127.0.0.1:9090",
		"refresh_account_interval_minute":   9,
		"image_task_timeout_seconds":        480,
		"user_default_concurrent_limit":     3,
		"user_default_rpm_limit":            45,
		"image_retention_days":              12,
		"image_storage_limit_mb":            1024,
		"log_retention_days":                30,
		"auto_remove_invalid_accounts":      false,
		"auto_remove_rate_limited_accounts": true,
		"log_levels":                        []any{"debug", "info"},
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	assertConfigValue(t, got, "base_url", "https://new.example/root")
	assertConfigValue(t, got, "proxy", "http://127.0.0.1:9090")
	assertConfigValue(t, got, "refresh_account_interval_minute", 9)
	assertConfigValue(t, got, "image_task_timeout_seconds", 480)
	assertConfigValue(t, got, "user_default_concurrent_limit", 3)
	assertConfigValue(t, got, "user_default_rpm_limit", 45)
	assertConfigValue(t, got, "image_retention_days", 12)
	assertConfigValue(t, got, "image_storage_limit_mb", 1024)
	if store.ImageStorageLimitBytes() != 1024*1024*1024 {
		t.Fatalf("ImageStorageLimitBytes() = %d, want 1GiB", store.ImageStorageLimitBytes())
	}
	assertConfigValue(t, got, "log_retention_days", 30)
	assertConfigValue(t, got, "auto_remove_invalid_accounts", false)
	assertConfigValue(t, got, "auto_remove_rate_limited_accounts", true)
	if levels := strings.Join(store.LogLevels(), ","); levels != "debug,info" {
		t.Fatalf("LogLevels() = %q, want debug,info", levels)
	}

	for key, want := range map[string]string{
		"IMAGE_BASE_URL":                    "https://new.example/root/",
		"PROXY":                             "http://127.0.0.1:9090",
		"REFRESH_ACCOUNT_INTERVAL_MINUTE":   "9",
		"CREATION_TASK_TIMEOUT_SECONDS":     "480",
		"USER_DEFAULT_CONCURRENT_LIMIT":     "3",
		"USER_DEFAULT_RPM_LIMIT":            "45",
		"IMAGE_RETENTION_DAYS":              "12",
		"IMAGE_STORAGE_LIMIT_MB":            "1024",
		"LOG_RETENTION_DAYS":                "30",
		"AUTO_REMOVE_INVALID_ACCOUNTS":      "false",
		"AUTO_REMOVE_RATE_LIMITED_ACCOUNTS": "true",
		"LOG_LEVELS":                        "debug,info",
	} {
		if gotEnv := os.Getenv(key); gotEnv != want {
			t.Fatalf("%s = %q, want %q", key, gotEnv, want)
		}
	}
}

func TestStoreUpdateOverridesEnvOnlyRuntimeSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	for key, value := range map[string]string{
		"IMAGE_BASE_URL":                    "https://old.example/root",
		"PROXY":                             "http://127.0.0.1:8080",
		"REFRESH_ACCOUNT_INTERVAL_MINUTE":   "5",
		"CREATION_TASK_TIMEOUT_SECONDS":     "300",
		"USER_DEFAULT_CONCURRENT_LIMIT":     "2",
		"USER_DEFAULT_RPM_LIMIT":            "30",
		"IMAGE_RETENTION_DAYS":              "30",
		"IMAGE_STORAGE_LIMIT_MB":            "2048",
		"LOG_RETENTION_DAYS":                "7",
		"AUTO_REMOVE_INVALID_ACCOUNTS":      "true",
		"AUTO_REMOVE_RATE_LIMITED_ACCOUNTS": "false",
		"LOG_LEVELS":                        "warning,error",
		"LOGIN_PAGE_IMAGE_URL":              "https://old.example/login.png",
		"LOGIN_PAGE_IMAGE_MODE":             "contain",
		"LOGIN_PAGE_IMAGE_ZOOM":             "1",
		"LOGIN_PAGE_IMAGE_POSITION_X":       "50",
		"LOGIN_PAGE_IMAGE_POSITION_Y":       "50",
	} {
		t.Setenv(key, value)
	}

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	got, err := store.Update(map[string]any{
		"base_url":                          "https://new.example/root/",
		"proxy":                             "http://127.0.0.1:9090",
		"refresh_account_interval_minute":   9,
		"image_task_timeout_seconds":        480,
		"user_default_concurrent_limit":     3,
		"user_default_rpm_limit":            45,
		"image_retention_days":              12,
		"image_storage_limit_mb":            1024,
		"log_retention_days":                30,
		"auto_remove_invalid_accounts":      false,
		"auto_remove_rate_limited_accounts": true,
		"log_levels":                        []any{"debug", "info"},
		"login_page_image_url":              "https://new.example/login.png",
		"login_page_image_mode":             "cover",
		"login_page_image_zoom":             2,
		"login_page_image_position_x":       25,
		"login_page_image_position_y":       75,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	assertConfigValue(t, got, "base_url", "https://new.example/root")
	assertConfigValue(t, got, "proxy", "http://127.0.0.1:9090")
	assertConfigValue(t, got, "refresh_account_interval_minute", 9)
	assertConfigValue(t, got, "image_task_timeout_seconds", 480)
	assertConfigValue(t, got, "user_default_concurrent_limit", 3)
	assertConfigValue(t, got, "user_default_rpm_limit", 45)
	assertConfigValue(t, got, "image_retention_days", 12)
	assertConfigValue(t, got, "image_storage_limit_mb", 1024)
	assertConfigValue(t, got, "log_retention_days", 30)
	assertConfigValue(t, got, "auto_remove_invalid_accounts", false)
	assertConfigValue(t, got, "auto_remove_rate_limited_accounts", true)
	assertConfigValue(t, got, "login_page_image_url", "https://new.example/login.png")
	assertConfigValue(t, got, "login_page_image_mode", "cover")
	assertConfigValue(t, got, "login_page_image_zoom", float64(2))
	assertConfigValue(t, got, "login_page_image_position_x", float64(25))
	assertConfigValue(t, got, "login_page_image_position_y", float64(75))
	if levels := strings.Join(store.LogLevels(), ","); levels != "debug,info" {
		t.Fatalf("LogLevels() = %q, want debug,info", levels)
	}

	for key, want := range map[string]string{
		"IMAGE_BASE_URL":                    "https://new.example/root/",
		"PROXY":                             "http://127.0.0.1:9090",
		"REFRESH_ACCOUNT_INTERVAL_MINUTE":   "9",
		"CREATION_TASK_TIMEOUT_SECONDS":     "480",
		"USER_DEFAULT_CONCURRENT_LIMIT":     "3",
		"USER_DEFAULT_RPM_LIMIT":            "45",
		"IMAGE_RETENTION_DAYS":              "12",
		"IMAGE_STORAGE_LIMIT_MB":            "1024",
		"LOG_RETENTION_DAYS":                "30",
		"AUTO_REMOVE_INVALID_ACCOUNTS":      "false",
		"AUTO_REMOVE_RATE_LIMITED_ACCOUNTS": "true",
		"LOG_LEVELS":                        "debug,info",
		"LOGIN_PAGE_IMAGE_URL":              "https://new.example/login.png",
		"LOGIN_PAGE_IMAGE_MODE":             "cover",
		"LOGIN_PAGE_IMAGE_ZOOM":             "2",
		"LOGIN_PAGE_IMAGE_POSITION_X":       "25",
		"LOGIN_PAGE_IMAGE_POSITION_Y":       "75",
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
