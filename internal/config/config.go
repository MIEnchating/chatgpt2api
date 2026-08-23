package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

var settingEnvKeys = map[string]string{
	"base_url":                          "IMAGE_BASE_URL",
	"app_title":                         "APP_TITLE",
	"project_name":                      "PROJECT_NAME",
	"site_icon_url":                     "SITE_ICON_URL",
	"relay_base_url":                    "API_BASE_URL",
	"proxy":                             "PROXY",
	"image_models":                      "IMAGE_MODELS",
	"video_models":                      "VIDEO_MODELS",
	"chat_models":                       "CHAT_MODELS",
	"refresh_account_interval_minute":   "REFRESH_ACCOUNT_INTERVAL_MINUTE",
	"image_task_timeout_seconds":        "CREATION_TASK_TIMEOUT_SECONDS",
	"user_default_concurrent_limit":     "USER_DEFAULT_CONCURRENT_LIMIT",
	"user_default_rpm_limit":            "USER_DEFAULT_RPM_LIMIT",
	"image_retention_days":              "IMAGE_RETENTION_DAYS",
	"image_storage_limit_mb":            "IMAGE_STORAGE_LIMIT_MB",
	"image_storage_backend":             "IMAGE_STORAGE_BACKEND",
	"s3_endpoint":                       "S3_ENDPOINT",
	"s3_region":                         "S3_REGION",
	"s3_bucket":                         "S3_BUCKET",
	"s3_prefix":                         "S3_PREFIX",
	"s3_use_path_style":                 "S3_USE_PATH_STYLE",
	"auto_remove_invalid_accounts":      "AUTO_REMOVE_INVALID_ACCOUNTS",
	"auto_remove_rate_limited_accounts": "AUTO_REMOVE_RATE_LIMITED_ACCOUNTS",
	"log_retention_days":                "LOG_RETENTION_DAYS",
	"default_log_view":                  "DEFAULT_LOG_VIEW",
	"log_levels":                        "LOG_LEVELS",
	"login_page_image_url":              "LOGIN_PAGE_IMAGE_URL",
	"login_page_image_mode":             "LOGIN_PAGE_IMAGE_MODE",
	"login_page_image_zoom":             "LOGIN_PAGE_IMAGE_ZOOM",
	"login_page_image_position_x":       "LOGIN_PAGE_IMAGE_POSITION_X",
	"login_page_image_position_y":       "LOGIN_PAGE_IMAGE_POSITION_Y",
	"text_account_schedule_mode":        "TEXT_ACCOUNT_SCHEDULE_MODE",
	"image_account_schedule_mode":       "IMAGE_ACCOUNT_SCHEDULE_MODE",
	"prompt_sources":                    "PROMPT_SOURCES",
}

var legacySettingEnvKeys = map[string][]string{
	"base_url":                          {"CHATGPT2API_BASE_URL"},
	"app_title":                         {"CHATGPT2API_APP_TITLE"},
	"project_name":                      {"CHATGPT2API_PROJECT_NAME"},
	"site_icon_url":                     {"CHATGPT2API_SITE_ICON_URL"},
	"relay_base_url":                    {"RELAY_BASE_URL", "CHATGPT2API_RELAY_BASE_URL"},
	"proxy":                             {"CHATGPT2API_PROXY"},
	"image_models":                      {"CHATGPT2API_IMAGE_MODELS"},
	"video_models":                      {"CHATGPT2API_VIDEO_MODELS"},
	"chat_models":                       {"CHATGPT2API_CHAT_MODELS"},
	"refresh_account_interval_minute":   {"CHATGPT2API_REFRESH_ACCOUNT_INTERVAL_MINUTE"},
	"image_task_timeout_seconds":        {"IMAGE_TASK_TIMEOUT_SECONDS", "CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS"},
	"user_default_concurrent_limit":     {"CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT"},
	"user_default_rpm_limit":            {"CHATGPT2API_USER_DEFAULT_RPM_LIMIT"},
	"image_retention_days":              {"CHATGPT2API_IMAGE_RETENTION_DAYS"},
	"image_storage_limit_mb":            {"CHATGPT2API_IMAGE_STORAGE_LIMIT_MB"},
	"image_storage_backend":             {"CHATGPT2API_IMAGE_STORAGE_BACKEND"},
	"s3_endpoint":                       {"CHATGPT2API_S3_ENDPOINT"},
	"s3_region":                         {"CHATGPT2API_S3_REGION"},
	"s3_bucket":                         {"CHATGPT2API_S3_BUCKET"},
	"s3_prefix":                         {"CHATGPT2API_S3_PREFIX"},
	"s3_use_path_style":                 {"CHATGPT2API_S3_USE_PATH_STYLE"},
	"auto_remove_invalid_accounts":      {"CHATGPT2API_AUTO_REMOVE_INVALID_ACCOUNTS"},
	"auto_remove_rate_limited_accounts": {"CHATGPT2API_AUTO_REMOVE_RATE_LIMITED_ACCOUNTS"},
	"log_retention_days":                {"CHATGPT2API_LOG_RETENTION_DAYS"},
	"default_log_view":                  {"CHATGPT2API_DEFAULT_LOG_VIEW"},
	"log_levels":                        {"CHATGPT2API_LOG_LEVELS"},
	"login_page_image_url":              {"CHATGPT2API_LOGIN_PAGE_IMAGE_URL"},
	"login_page_image_mode":             {"CHATGPT2API_LOGIN_PAGE_IMAGE_MODE"},
	"login_page_image_zoom":             {"CHATGPT2API_LOGIN_PAGE_IMAGE_ZOOM"},
	"login_page_image_position_x":       {"CHATGPT2API_LOGIN_PAGE_IMAGE_POSITION_X"},
	"login_page_image_position_y":       {"CHATGPT2API_LOGIN_PAGE_IMAGE_POSITION_Y"},
	"text_account_schedule_mode":        {"CHATGPT2API_TEXT_ACCOUNT_SCHEDULE_MODE"},
	"image_account_schedule_mode":       {"CHATGPT2API_IMAGE_ACCOUNT_SCHEDULE_MODE"},
}

var envKeyRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const (
	defaultImageTaskTimeoutSeconds = 300
	minImageTaskTimeoutSeconds     = 30
	maxImageTaskTimeoutSeconds     = 3600
	defaultBaseURL                 = "https://image.yunmian.tech"
	defaultRelayBaseURL            = "https://www.yunmian.tech"
	defaultAppTitle                = "云棉"
)

var (
	defaultImageModels = []string{util.ImageModelGPT, util.ImageModelGemini, util.ImageModelGrok}
	defaultVideoModels = []string{"sora-2", "grok-imagine-video-1.5", "kling-v3", "MiniMax-Hailuo-2.3", "doubao-seedance-2-5-260628"}
	defaultChatModels  = []string{util.ImageModelGPT55, util.ImageModelGPT54}
)

type Store struct {
	mu             sync.RWMutex
	RootDir        string
	DataDir        string
	EnvFile        string
	data           map[string]any
	storageBackend storage.Backend
}

type ImageStorageSettings struct {
	Backend      string
	Endpoint     string
	Region       string
	Bucket       string
	Prefix       string
	UsePathStyle bool
}

func NewStore() (*Store, error) {
	root, err := resolveRootDir()
	if err != nil {
		return nil, err
	}

	envFile := filepath.Join(root, ".env")
	envFileValues := readEnvObject(envFile)
	processEnvValues := currentSettingEnvValues()
	s := &Store{
		RootDir: root,
		DataDir: filepath.Join(root, "data"),
		EnvFile: envFile,
		data:    map[string]any{},
	}
	if err := os.MkdirAll(s.DataDir, 0o755); err != nil {
		return nil, err
	}
	s.loadEnvFile()
	s.data = settingsFromEnvValues(envFileValues)
	for key, value := range settingsFromEnvValues(processEnvValues) {
		s.data[key] = value
	}
	return s, nil
}

func resolveRootDir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	if configured := strings.TrimSpace(envValue("ROOT_DIR", "CHATGPT2API_ROOT")); configured != "" {
		return filepath.Abs(configured)
	}
	if root := findAncestorWithFile(cwd, ".env"); root != "" {
		return root, nil
	}
	if root := findAncestorWithProjectGoMod(cwd); root != "" {
		return root, nil
	}
	return filepath.Abs(cwd)
}

func findAncestorWithFile(start, name string) string {
	dir, err := filepath.Abs(start)
	if err != nil {
		return ""
	}
	for {
		info, statErr := os.Stat(filepath.Join(dir, name))
		if statErr == nil && !info.IsDir() {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func findAncestorWithProjectGoMod(start string) string {
	dir, err := filepath.Abs(start)
	if err != nil {
		return ""
	}
	for {
		data, readErr := os.ReadFile(filepath.Join(dir, "go.mod"))
		if readErr == nil && strings.Contains(string(data), "module chatgpt2api") {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func (s *Store) AdminUsername() string {
	value := strings.TrimSpace(envValue("ADMIN_USERNAME", "CHATGPT2API_ADMIN_USERNAME"))
	if value == "" {
		return "admin"
	}
	return value
}

func (s *Store) AdminPassword() string {
	return strings.TrimSpace(envValue("ADMIN_PASSWORD", "CHATGPT2API_ADMIN_PASSWORD"))
}

func (s *Store) RefreshAccountIntervalMinute() int {
	return intSetting(s.settingValue("refresh_account_interval_minute", 5), 5)
}

func (s *Store) ImageRetentionDays() int {
	value := intSetting(s.settingValue("image_retention_days", 30), 30)
	if value < 1 {
		return 1
	}
	return value
}

func (s *Store) ImageStorageLimitMB() int {
	value := intSetting(s.settingValue("image_storage_limit_mb", 0), 0)
	if value < 0 {
		return 0
	}
	return value
}

func (s *Store) ImageStorageLimitBytes() int64 {
	mb := s.ImageStorageLimitMB()
	if mb <= 0 {
		return 0
	}
	return int64(mb) * 1024 * 1024
}

func (s *Store) ImageStorageBackend() string {
	value := strings.ToLower(strings.TrimSpace(fmt.Sprint(s.settingValue("image_storage_backend", "local"))))
	if value == "" {
		return "local"
	}
	return value
}

func (s *Store) S3Endpoint() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("s3_endpoint", "")))
}
func (s *Store) S3Region() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("s3_region", "")))
}
func (s *Store) S3Bucket() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("s3_bucket", "")))
}
func (s *Store) S3AccessKey() string {
	return strings.TrimSpace(envValue("S3_ACCESS_KEY", "CHATGPT2API_S3_ACCESS_KEY"))
}
func (s *Store) S3SecretKey() string {
	return strings.TrimSpace(envValue("S3_SECRET_KEY", "CHATGPT2API_S3_SECRET_KEY"))
}
func (s *Store) S3SessionToken() string {
	return strings.TrimSpace(envValue("S3_SESSION_TOKEN", "CHATGPT2API_S3_SESSION_TOKEN"))
}
func (s *Store) S3Prefix() string {
	return strings.Trim(strings.TrimSpace(fmt.Sprint(s.settingValue("s3_prefix", ""))), "/")
}
func (s *Store) S3UsePathStyle() bool {
	return util.ToBool(s.settingValue("s3_use_path_style", false))
}

func (s *Store) ImageStorageSettings() ImageStorageSettings {
	return ImageStorageSettings{
		Backend:      s.ImageStorageBackend(),
		Endpoint:     s.S3Endpoint(),
		Region:       s.S3Region(),
		Bucket:       s.S3Bucket(),
		Prefix:       s.S3Prefix(),
		UsePathStyle: s.S3UsePathStyle(),
	}
}

func (s *Store) ImageStorageSettingsWithUpdate(data map[string]any) ImageStorageSettings {
	settings := s.ImageStorageSettings()
	if value, ok := data["image_storage_backend"]; ok {
		settings.Backend = strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
		if settings.Backend == "" {
			settings.Backend = "local"
		}
	}
	if value, ok := data["s3_endpoint"]; ok {
		settings.Endpoint = strings.TrimSpace(fmt.Sprint(value))
	}
	if value, ok := data["s3_region"]; ok {
		settings.Region = strings.TrimSpace(fmt.Sprint(value))
	}
	if value, ok := data["s3_bucket"]; ok {
		settings.Bucket = strings.TrimSpace(fmt.Sprint(value))
	}
	if value, ok := data["s3_prefix"]; ok {
		settings.Prefix = strings.Trim(strings.TrimSpace(fmt.Sprint(value)), "/")
	}
	if value, ok := data["s3_use_path_style"]; ok {
		settings.UsePathStyle = util.ToBool(value)
	}
	return settings
}

func (s *Store) LogRetentionDays() int {
	value := intSetting(s.settingValue("log_retention_days", 7), 7)
	if value < 1 {
		return 1
	}
	if value > 3650 {
		return 3650
	}
	return value
}

func (s *Store) DefaultLogView() string {
	return normalizeDefaultLogView(s.settingValue("default_log_view", "meaningful"))
}

func (s *Store) ImageTaskTimeoutSeconds() int {
	return normalizeImageTaskTimeoutSeconds(s.settingValue("image_task_timeout_seconds", defaultImageTaskTimeoutSeconds))
}

func (s *Store) TextAccountScheduleMode() string {
	return normalizeAccountScheduleMode(s.settingValue("text_account_schedule_mode", "load_balance"))
}

func (s *Store) ImageAccountScheduleMode() string {
	return normalizeAccountScheduleMode(s.settingValue("image_account_schedule_mode", "load_balance"))
}

func (s *Store) UserDefaultConcurrentLimit() int {
	value := intSetting(s.settingValue("user_default_concurrent_limit", 0), 0)
	if value < 0 {
		return 0
	}
	return value
}

func (s *Store) UserDefaultRPMLimit() int {
	value := intSetting(s.settingValue("user_default_rpm_limit", 0), 0)
	if value < 0 {
		return 0
	}
	return value
}

func (s *Store) AutoRemoveInvalidAccounts() bool {
	return util.ToBool(s.settingValue("auto_remove_invalid_accounts", false))
}

func (s *Store) AutoRemoveRateLimitedAccounts() bool {
	return util.ToBool(s.settingValue("auto_remove_rate_limited_accounts", false))
}

func (s *Store) BaseURL() string {
	return strings.TrimRight(strings.TrimSpace(fmt.Sprint(s.settingValue("base_url", defaultBaseURL))), "/")
}

func (s *Store) AppTitle() string {
	value := strings.TrimSpace(fmt.Sprint(s.settingValue("app_title", defaultAppTitle)))
	if value == "" || isLegacyDefaultAppTitle(value) {
		return defaultAppTitle
	}
	return value
}

func (s *Store) ProjectName() string {
	value := strings.TrimSpace(fmt.Sprint(s.settingValue("project_name", s.AppTitle())))
	if value == "" || isLegacyDefaultAppTitle(value) {
		return s.AppTitle()
	}
	return value
}

func isLegacyDefaultAppTitle(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "chatgpt2api":
		return true
	default:
		return false
	}
}

func (s *Store) RelayBaseURL() string {
	return strings.TrimRight(strings.TrimSpace(fmt.Sprint(s.settingValue("relay_base_url", defaultRelayBaseURL))), "/")
}

func (s *Store) RelayDatabaseURL() string {
	legacyURL := strings.TrimSpace(envValue("CHATGPT2API_NEWAPI_DATABASE_URL"))
	currentValue, currentConfigured := lookupEnvValue("DATABASE_URL", "RELAY_DATABASE_URL", "CHATGPT2API_RELAY_DATABASE_URL")
	currentURL := strings.TrimSpace(currentValue)
	if legacyURL != "" && legacyDatabaseURLBelongsToStorage() {
		return legacyURL
	}
	if !currentConfigured {
		return legacyURL
	}
	return currentURL
}

func (s *Store) RelayDatabaseType() string {
	value := strings.ToLower(strings.TrimSpace(envValue("DATABASE_TYPE", "RELAY_DATABASE_TYPE", "CHATGPT2API_DATABASE_TYPE")))
	if value == "" {
		return "newapi"
	}
	return value
}

func (s *Store) Proxy() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("proxy", "")))
}

func (s *Store) LogLevels() []string {
	raw := s.settingValue("log_levels", "")
	var parts []string
	switch v := raw.(type) {
	case []string:
		parts = v
	case []any:
		for _, item := range v {
			parts = append(parts, fmt.Sprint(item))
		}
	default:
		parts = strings.Split(fmt.Sprint(raw), ",")
	}
	allowed := map[string]struct{}{"debug": {}, "info": {}, "warning": {}, "error": {}}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		level := strings.ToLower(strings.TrimSpace(part))
		if _, ok := allowed[level]; ok {
			out = append(out, level)
		}
	}
	return out
}

func (s *Store) ImagesDir() string {
	path := filepath.Join(s.DataDir, "images")
	_ = os.MkdirAll(path, 0o755)
	return path
}

func (s *Store) ImageThumbnailsDir() string {
	path := filepath.Join(s.DataDir, "image_thumbnails")
	_ = os.MkdirAll(path, 0o755)
	return path
}

func (s *Store) ImageMetadataDir() string {
	path := filepath.Join(s.DataDir, "image_metadata")
	_ = os.MkdirAll(path, 0o755)
	return path
}

func (s *Store) LoginPageImagesDir() string {
	path := filepath.Join(s.DataDir, "login_page_images")
	_ = os.MkdirAll(path, 0o755)
	return path
}

func (s *Store) SiteIconsDir() string {
	path := filepath.Join(s.DataDir, "site_icons")
	_ = os.MkdirAll(path, 0o755)
	return path
}

func (s *Store) SiteIconURL() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("site_icon_url", "")))
}

func (s *Store) LoginPageImageURL() string {
	return strings.TrimSpace(fmt.Sprint(s.settingValue("login_page_image_url", "")))
}

func (s *Store) LoginPageImageMode() string {
	return normalizeLoginPageImageMode(s.settingValue("login_page_image_mode", "contain"))
}

func (s *Store) LoginPageImageZoom() float64 {
	return clampFloat(floatSetting(s.settingValue("login_page_image_zoom", 1), 1), 1, 3)
}

func (s *Store) LoginPageImagePositionX() float64 {
	return clampFloat(floatSetting(s.settingValue("login_page_image_position_x", 50), 50), 0, 100)
}

func (s *Store) LoginPageImagePositionY() float64 {
	return clampFloat(floatSetting(s.settingValue("login_page_image_position_y", 50), 50), 0, 100)
}

func (s *Store) ImageModels() []string {
	return normalizeModelList(s.settingValue("image_models", defaultImageModels), defaultImageModels)
}

func (s *Store) VideoModels() []string {
	return normalizeModelList(s.settingValue("video_models", defaultVideoModels), defaultVideoModels)
}

func (s *Store) ChatModels() []string {
	return normalizeModelList(s.settingValue("chat_models", defaultChatModels), defaultChatModels)
}

func (s *Store) DefaultImageModel() string {
	return firstString(s.ImageModels(), util.ImageModelGPT)
}

func (s *Store) DefaultChatModel() string {
	return firstString(s.ChatModels(), util.ImageModelGPT55)
}

func (s *Store) Get() map[string]any {
	s.mu.RLock()
	data := util.CopyMap(s.data)
	s.mu.RUnlock()
	delete(data, "image_concurrent_limit")
	delete(data, "chat_models")
	delete(data, "default_chat_model")
	data["refresh_account_interval_minute"] = s.RefreshAccountIntervalMinute()
	data["image_task_timeout_seconds"] = s.ImageTaskTimeoutSeconds()
	data["image_models"] = s.ImageModels()
	data["video_models"] = s.VideoModels()
	data["default_image_model"] = s.DefaultImageModel()
	data["user_default_concurrent_limit"] = s.UserDefaultConcurrentLimit()
	data["user_default_rpm_limit"] = s.UserDefaultRPMLimit()
	data["image_retention_days"] = s.ImageRetentionDays()
	data["image_storage_limit_mb"] = s.ImageStorageLimitMB()
	data["image_storage_backend"] = s.ImageStorageBackend()
	data["s3_endpoint"] = s.S3Endpoint()
	data["s3_region"] = s.S3Region()
	data["s3_bucket"] = s.S3Bucket()
	data["s3_prefix"] = s.S3Prefix()
	data["s3_use_path_style"] = s.S3UsePathStyle()
	data["s3_endpoint_configured"] = s.S3Endpoint() != ""
	data["s3_credentials_configured"] = s.S3AccessKey() != "" && s.S3SecretKey() != ""
	data["log_retention_days"] = s.LogRetentionDays()
	data["default_log_view"] = s.DefaultLogView()
	data["auto_remove_invalid_accounts"] = s.AutoRemoveInvalidAccounts()
	data["auto_remove_rate_limited_accounts"] = s.AutoRemoveRateLimitedAccounts()
	data["log_levels"] = s.LogLevels()
	data["proxy"] = s.Proxy()
	data["base_url"] = s.BaseURL()
	data["app_title"] = s.AppTitle()
	data["project_name"] = s.ProjectName()
	data["site_icon_url"] = s.SiteIconURL()
	data["relay_base_url"] = s.RelayBaseURL()
	data["login_page_image_url"] = s.LoginPageImageURL()
	data["login_page_image_mode"] = s.LoginPageImageMode()
	data["login_page_image_zoom"] = s.LoginPageImageZoom()
	data["login_page_image_position_x"] = s.LoginPageImagePositionX()
	data["login_page_image_position_y"] = s.LoginPageImagePositionY()
	if value, ok := data["prompt_sources"]; ok {
		data["prompt_sources"] = normalizePromptSourcesValue(value)
	}
	return data
}

func (s *Store) Update(data map[string]any) (map[string]any, error) {
	s.mu.Lock()
	next := util.CopyMap(s.data)
	for key, value := range data {
		if key == "s3_endpoint_configured" || key == "s3_credentials_configured" {
			continue
		}
		if key == "s3_access_key" || key == "s3_secret_key" || key == "s3_session_token" {
			continue
		}
		next[key] = value
	}
	delete(next, "image_concurrent_limit")
	if value, ok := next["login_page_image_mode"]; ok {
		next["login_page_image_mode"] = normalizeLoginPageImageMode(value)
	}
	if value, ok := next["image_task_timeout_seconds"]; ok {
		next["image_task_timeout_seconds"] = normalizeImageTaskTimeoutSeconds(value)
	}
	if value, ok := next["text_account_schedule_mode"]; ok {
		next["text_account_schedule_mode"] = normalizeAccountScheduleMode(value)
	}
	if value, ok := next["image_account_schedule_mode"]; ok {
		next["image_account_schedule_mode"] = normalizeAccountScheduleMode(value)
	}
	if value, ok := next["image_storage_limit_mb"]; ok {
		next["image_storage_limit_mb"] = normalizeNonNegativeInt(value)
	}
	if value, ok := next["image_storage_backend"]; ok {
		next["image_storage_backend"] = strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	}
	for _, key := range []string{"s3_endpoint", "s3_region", "s3_bucket"} {
		if value, ok := next[key]; ok {
			next[key] = strings.TrimSpace(fmt.Sprint(value))
		}
	}
	if value, ok := next["s3_prefix"]; ok {
		next["s3_prefix"] = strings.Trim(strings.TrimSpace(fmt.Sprint(value)), "/")
	}
	if value, ok := next["s3_use_path_style"]; ok {
		next["s3_use_path_style"] = util.ToBool(value)
	}
	if value, ok := next["image_models"]; ok {
		next["image_models"] = normalizeModelList(value, defaultImageModels)
	}
	if value, ok := next["video_models"]; ok {
		next["video_models"] = normalizeModelList(value, defaultVideoModels)
	}
	if value, ok := next["prompt_sources"]; ok {
		next["prompt_sources"] = normalizePromptSourcesValue(value)
	}
	delete(next, "chat_models")
	delete(next, "default_chat_model")
	if value, ok := next["app_title"]; ok {
		next["app_title"] = strings.TrimSpace(fmt.Sprint(value))
	}
	if value, ok := next["project_name"]; ok {
		next["project_name"] = strings.TrimSpace(fmt.Sprint(value))
	}
	if err := s.validateSettingsUpdateLocked(next); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	previous := s.data
	s.data = next
	err := s.saveLocked()
	if err != nil {
		s.data = previous
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return s.Get(), nil
}

func (s *Store) CleanupOldImages() int {
	cutoff := time.Now().Add(-time.Duration(s.ImageRetentionDays()) * 24 * time.Hour)
	removed := 0
	for _, dir := range []string{s.ImagesDir(), s.ImageThumbnailsDir(), s.ImageMetadataDir()} {
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			info, statErr := d.Info()
			if statErr == nil && info.ModTime().Before(cutoff) {
				if os.Remove(path) == nil {
					removed++
				}
			}
			return nil
		})
		removeEmptyDirs(dir)
	}
	return removed
}

func (s *Store) StorageBackend() (storage.Backend, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.storageBackend != nil {
		return s.storageBackend, nil
	}
	backend, err := storage.NewBackendFromEnv(s.DataDir)
	if err != nil {
		return nil, err
	}
	s.storageBackend = backend
	return backend, nil
}

func (s *Store) settingValue(key string, fallback any) any {
	s.mu.RLock()
	if value, ok := s.data[key]; ok {
		s.mu.RUnlock()
		return value
	}
	s.mu.RUnlock()
	if value, ok := lookupEnvValue(settingEnvNames(key)...); ok {
		return value
	}
	return fallback
}

func (s *Store) settingValueFromData(data map[string]any, key string, fallback any) any {
	if data != nil {
		if value, ok := data[key]; ok {
			return value
		}
	}
	if value, ok := lookupEnvValue(settingEnvNames(key)...); ok {
		return value
	}
	return fallback
}

func (s *Store) validateSettingsUpdateLocked(data map[string]any) error {
	relayBaseURL := strings.TrimSpace(fmt.Sprint(util.ValueOr(data["relay_base_url"], defaultRelayBaseURL)))
	if relayBaseURL == "" {
		return errors.New("baseurl is required")
	}
	if err := validateAbsoluteHTTPURL(relayBaseURL); err != nil {
		return errors.New("baseurl must be an absolute http(s) URL")
	}
	imageStorageBackend := strings.ToLower(strings.TrimSpace(fmt.Sprint(s.settingValueFromData(data, "image_storage_backend", "local"))))
	if imageStorageBackend == "" {
		imageStorageBackend = "local"
	}
	if imageStorageBackend != "local" && imageStorageBackend != "s3" {
		return errors.New("image storage backend must be local or s3")
	}
	s3Endpoint := strings.TrimSpace(fmt.Sprint(s.settingValueFromData(data, "s3_endpoint", "")))
	s3Bucket := strings.TrimSpace(fmt.Sprint(s.settingValueFromData(data, "s3_bucket", "")))
	s3Prefix := strings.Trim(strings.TrimSpace(fmt.Sprint(s.settingValueFromData(data, "s3_prefix", ""))), "/")
	if s3Endpoint != "" {
		if err := validateS3Endpoint(s3Endpoint); err != nil {
			return err
		}
	}
	if s3Prefix != "" {
		if err := validateS3Prefix(s3Prefix); err != nil {
			return err
		}
	}
	if imageStorageBackend == "s3" {
		if s3Endpoint == "" {
			return errors.New("S3 endpoint is required")
		}
		if s3Bucket == "" {
			return errors.New("S3 bucket is required")
		}
		if s.S3AccessKey() == "" || s.S3SecretKey() == "" {
			return errors.New("S3 access key and secret key must be configured on the server")
		}
	}
	return nil
}

func validateS3Endpoint(value string) error {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return errors.New("S3 endpoint must be a valid http(s) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("S3 endpoint must use http or https")
	}
	if parsed.User != nil || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("S3 endpoint must not contain user info, a path, query, or fragment")
	}
	return nil
}

func validateS3Prefix(value string) error {
	cleaned := path.Clean(strings.Trim(strings.TrimSpace(value), "/"))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, ":") {
		return errors.New("S3 prefix is invalid")
	}
	return nil
}

func normalizeDefaultLogView(value any) string {
	switch strings.ToLower(strings.TrimSpace(fmt.Sprint(value))) {
	case "all", "meaningful", "business":
		return strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	default:
		return "meaningful"
	}
}

func validateAbsoluteHTTPURL(value string) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("scheme must be http or https")
	}
	if parsed.Host == "" {
		return errors.New("host is required")
	}
	return nil
}

func (s *Store) saveLocked() error {
	updates := map[string]string{}
	keys := make([]string, 0, len(settingEnvKeys))
	for key := range settingEnvKeys {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value, ok := s.data[key]; ok {
			updates[settingEnvKeys[key]] = stringifySettingEnvValue(key, value)
		}
	}
	if err := writeEnvUpdates(s.EnvFile, updates); err != nil {
		return err
	}
	for key, value := range updates {
		_ = os.Setenv(key, value)
	}
	return nil
}

func (s *Store) loadEnvFile() {
	for key, value := range readEnvObject(s.EnvFile) {
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, value)
		}
	}
}

func settingsFromEnvValues(values map[string]string) map[string]any {
	settings := map[string]any{}
	for settingKey := range settingEnvKeys {
		for _, envKey := range settingEnvNames(settingKey) {
			if value, ok := values[envKey]; ok {
				if settingKey == "prompt_sources" {
					settings[settingKey] = normalizePromptSourcesValue(value)
				} else {
					settings[settingKey] = value
				}
				break
			}
		}
	}
	return settings
}

func currentSettingEnvValues() map[string]string {
	values := map[string]string{}
	for settingKey := range settingEnvKeys {
		for _, envKey := range settingEnvNames(settingKey) {
			if value, ok := os.LookupEnv(envKey); ok {
				values[envKey] = value
			}
		}
	}
	return values
}

func settingEnvNames(settingKey string) []string {
	primary := settingEnvKeys[settingKey]
	aliases := legacySettingEnvKeys[settingKey]
	if primary == "" {
		return aliases
	}
	return append([]string{primary}, aliases...)
}

func envValue(names ...string) string {
	value, _ := lookupEnvValue(names...)
	return value
}

func lookupEnvValue(names ...string) (string, bool) {
	for _, name := range names {
		if name == "" {
			continue
		}
		if value, ok := os.LookupEnv(name); ok {
			return value, true
		}
	}
	return "", false
}

func legacyDatabaseURLBelongsToStorage() bool {
	if _, configured := os.LookupEnv("STORAGE_DATABASE_URL"); configured {
		return false
	}
	backend := strings.ToLower(strings.TrimSpace(envValue("STORAGE_BACKEND")))
	if backend == "postgres" || backend == "postgresql" || backend == "mysql" || backend == "database" {
		return true
	}
	databaseURL := strings.ToLower(strings.TrimSpace(envValue("DATABASE_URL")))
	return backend == "sqlite" && strings.HasPrefix(databaseURL, "sqlite:")
}

func intSetting(value any, fallback int) int {
	switch v := value.(type) {
	case int:
		return v
	case int8:
		return int(v)
	case int16:
		return int(v)
	case int32:
		return int(v)
	case int64:
		return int(v)
	case uint:
		return int(v)
	case uint8:
		return int(v)
	case uint16:
		return int(v)
	case uint32:
		return int(v)
	case uint64:
		return int(v)
	case float32:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
		if f, err := v.Float64(); err == nil {
			return int(f)
		}
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return n
		}
	}
	return fallback
}

func floatSetting(value any, fallback float64) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err == nil {
			return n
		}
	}
	return fallback
}

func normalizeLoginPageImageMode(value any) string {
	mode := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	switch mode {
	case "cover", "contain", "fill":
		return mode
	default:
		return "contain"
	}
}

func normalizeImageTaskTimeoutSeconds(value any) int {
	seconds := intSetting(value, defaultImageTaskTimeoutSeconds)
	if seconds < minImageTaskTimeoutSeconds {
		return minImageTaskTimeoutSeconds
	}
	if seconds > maxImageTaskTimeoutSeconds {
		return maxImageTaskTimeoutSeconds
	}
	return seconds
}

func normalizeAccountScheduleMode(value any) string {
	mode := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	if mode == "fill_first" {
		return "fill_first"
	}
	return "load_balance"
}

func normalizeNonNegativeInt(value any) int {
	n := intSetting(value, 0)
	if n < 0 {
		return 0
	}
	return n
}

func normalizeDefaultSubscriptionPeriod(value any) string {
	switch strings.ToLower(strings.TrimSpace(fmt.Sprint(value))) {
	case "daily", "weekly", "monthly":
		return strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	default:
		return "monthly"
	}
}

func normalizeModelList(value any, fallback []string) []string {
	items := make([]string, 0)
	switch v := value.(type) {
	case []string:
		items = append(items, v...)
	case []any:
		for _, item := range v {
			items = append(items, fmt.Sprint(item))
		}
	case string:
		items = append(items, strings.Split(v, ",")...)
	default:
		items = append(items, strings.Split(fmt.Sprint(util.ValueOr(value, "")), ",")...)
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		model := strings.TrimSpace(item)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
}

func firstString(values []string, fallback string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

func clampFloat(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func readEnvObject(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		if info, statErr := os.Stat(path); statErr == nil && info.IsDir() {
			fmt.Fprintf(os.Stderr, "Warning: .env at %q is a directory, ignoring it.\n", path)
		}
		return map[string]string{}
	}
	result := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := parseEnvAssignment(line)
		if ok {
			result[key] = value
		}
	}
	return result
}

func parseEnvAssignment(line string) (string, string, bool) {
	stripped := strings.TrimSpace(line)
	if stripped == "" || strings.HasPrefix(stripped, "#") {
		return "", "", false
	}
	stripped = strings.TrimSpace(strings.TrimPrefix(stripped, "export "))
	key, value, ok := strings.Cut(stripped, "=")
	if !ok {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	if !envKeyRE.MatchString(key) {
		return "", "", false
	}
	return key, unquoteEnvValue(value), true
}

func unquoteEnvValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == value[len(value)-1] && (value[0] == '"' || value[0] == '\'') {
		inner := value[1 : len(value)-1]
		if value[0] == '"' {
			inner = strings.ReplaceAll(inner, `\n`, "\n")
			inner = strings.ReplaceAll(inner, `\r`, "\r")
			inner = strings.ReplaceAll(inner, `\t`, "\t")
			inner = strings.ReplaceAll(inner, `\"`, `"`)
			inner = strings.ReplaceAll(inner, `\\`, `\`)
		}
		return inner
	}
	for index, char := range value {
		if char == '#' && (index == 0 || value[index-1] == ' ' || value[index-1] == '\t') {
			return strings.TrimRight(value[:index], " \t")
		}
	}
	return value
}

func stringifyEnvValue(value any) string {
	switch v := value.(type) {
	case bool:
		if v {
			return "true"
		}
		return "false"
	case []string:
		return strings.Join(v, ",")
	case []any:
		items := make([]string, 0, len(v))
		for _, item := range v {
			if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
				items = append(items, s)
			}
		}
		return strings.Join(items, ",")
	default:
		return strings.TrimSpace(fmt.Sprint(util.ValueOr(value, "")))
	}
}

func stringifySettingEnvValue(settingKey string, value any) string {
	if settingKey == "prompt_sources" {
		encoded, err := json.Marshal(normalizePromptSourcesValue(value))
		if err == nil {
			return string(encoded)
		}
		return "[]"
	}
	return stringifyEnvValue(value)
}

func normalizePromptSourcesValue(value any) []any {
	switch v := value.(type) {
	case []any:
		return v
	case []map[string]any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			out = append(out, item)
		}
		return out
	case string:
		var decoded any
		if err := json.Unmarshal([]byte(strings.TrimSpace(v)), &decoded); err == nil {
			return normalizePromptSourcesValue(decoded)
		}
	}
	return []any{}
}

func writeEnvUpdates(path string, updates map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
	}
	pending := map[string]string{}
	for key, value := range updates {
		pending[key] = value
	}
	next := make([]string, 0, len(lines)+len(updates)+1)
	for _, line := range lines {
		key, _, ok := parseEnvAssignment(line)
		if ok {
			if value, exists := pending[key]; exists {
				next = append(next, formatEnvAssignment(key, value))
				delete(pending, key)
				continue
			}
		}
		next = append(next, line)
	}
	if len(pending) > 0 {
		if len(next) > 0 && strings.TrimSpace(next[len(next)-1]) != "" {
			next = append(next, "")
		}
		keys := make([]string, 0, len(pending))
		for key := range pending {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			next = append(next, formatEnvAssignment(key, pending[key]))
		}
	}
	return os.WriteFile(path, []byte(strings.TrimRight(strings.Join(next, "\n"), "\n")+"\n"), 0o644)
}

func formatEnvAssignment(key, value string) string {
	return key + "=" + formatEnvValue(value)
}

func formatEnvValue(value string) string {
	if value == "" {
		return ""
	}
	if regexp.MustCompile(`^[A-Za-z0-9_./:@%+\-,]*$`).MatchString(value) {
		return value
	}
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	return `"` + value + `"`
}

func removeEmptyDirs(root string) {
	var dirs []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() && path != root {
			dirs = append(dirs, path)
		}
		return nil
	})
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, dir := range dirs {
		_ = os.Remove(dir)
	}
}
