package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/robfig/cron/v3"
)

const defaultStorageCapacityLimitBytes int64 = 9 * 1024 * 1024 * 1024

var ErrLocalStorageCapacityExceeded = errors.New("服务器本机素材容量已达到上限")

type StorageSettingsProvider interface {
	StorageSettings() model.StorageSetting
	UpdateStorageProvider(int, model.StorageProvider) error
}

type StorageObjectProviderInput struct {
	Enabled         *bool  `json:"enabled,omitempty"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	PathPrefix      string `json:"pathPrefix"`
	Username        string `json:"username"`
	Password        string `json:"password"`
}

type UserStorageProviders struct {
	S3     *StorageObjectProviderInput `json:"s3,omitempty"`
	WebDAV *StorageObjectProviderInput `json:"webdav,omitempty"`
}

type StoragePublicConfig struct {
	Mode                    string `json:"mode"`
	LocalStorageEnabled     bool   `json:"localStorageEnabled"`
	AllowUserProvider       bool   `json:"allowUserProvider"`
	AllowUserGlobalProvider bool   `json:"allowUserGlobalProvider"`
}

type UploadedStorageObject struct {
	ID         string `json:"id"`
	URL        string `json:"url"`
	StorageKey string `json:"storageKey"`
	Bytes      int64  `json:"bytes"`
	MIMEType   string `json:"mimeType"`
}

type DirectStorageObjectInput struct {
	Provider  StorageObjectProviderInput `json:"provider"`
	ObjectKey string                     `json:"objectKey"`
	MIMEType  string                     `json:"mimeType"`
	Bytes     int64                      `json:"bytes"`
}

type DownloadedStorageObject struct {
	Object        model.StorageObject
	Stream        io.ReadCloser
	StatusCode    int
	ContentLength int64
	ContentRange  string
	AcceptRanges  bool
}

type StorageCapacityResult struct {
	Bytes        int64  `json:"bytes"`
	LimitBytes   int64  `json:"limitBytes"`
	OverLimit    bool   `json:"overLimit"`
	CheckedAt    string `json:"checkedAt"`
	ProviderName string `json:"providerName"`
}

type LocalMediaGovernance struct {
	TotalBytes     int64 `json:"total_bytes"`
	IndexedBytes   int64 `json:"indexed_bytes"`
	UntrackedBytes int64 `json:"untracked_bytes"`
	TotalCount     int   `json:"total_count"`
	TextBytes      int64 `json:"text_bytes"`
	TextCount      int   `json:"text_count"`
	ImageBytes     int64 `json:"image_bytes"`
	ImageCount     int   `json:"image_count"`
	VideoBytes     int64 `json:"video_bytes"`
	VideoCount     int   `json:"video_count"`
	AudioBytes     int64 `json:"audio_bytes"`
	AudioCount     int   `json:"audio_count"`
	OtherBytes     int64 `json:"other_bytes"`
	OtherCount     int   `json:"other_count"`
	LimitBytes     int64 `json:"limit_bytes"`
	OverLimitBytes int64 `json:"over_limit_bytes"`
}

type GenericStorageService struct {
	settings             StorageSettingsProvider
	objects              storage.StorageObjectBackend
	documents            storage.JSONDocumentBackend
	localDir             string
	capacityErrorHandler func(error)
	mu                   sync.Mutex
	localCapacityMu      sync.Mutex
	cronMu               sync.Mutex
	cron                 *cron.Cron
}

func (s *GenericStorageService) RefreshCapacityScheduler(ctx context.Context) error {
	s.cronMu.Lock()
	defer s.cronMu.Unlock()
	if s.cron == nil {
		s.cron = cron.New()
		s.cron.Start()
	}
	for _, entry := range s.cron.Entries() {
		s.cron.Remove(entry.ID)
	}
	setting := s.settings.StorageSettings().CapacityCheck
	if !setting.Enabled {
		return nil
	}
	_, err := s.cron.AddFunc(setting.Cron, func() {
		s.runScheduledCapacityCheck(ctx)
	})
	return err
}

func (s *GenericStorageService) runScheduledCapacityCheck(ctx context.Context) {
	errorsFound := s.MeasureAll(ctx)
	if len(errorsFound) > 0 && s.capacityErrorHandler != nil {
		s.capacityErrorHandler(errors.Join(errorsFound...))
	}
}

func (s *GenericStorageService) Close() {
	s.cronMu.Lock()
	defer s.cronMu.Unlock()
	if s.cron != nil {
		stop := s.cron.Stop()
		<-stop.Done()
		s.cron = nil
	}
}

func NewGenericStorageService(backend storage.Backend, settings StorageSettingsProvider, localDir string, capacityErrorHandler func(error)) (*GenericStorageService, error) {
	objects, ok := backend.(storage.StorageObjectBackend)
	if !ok {
		return nil, errors.New("storage object backend is required")
	}
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		return nil, errors.New("storage document backend is required")
	}
	localDir = strings.TrimSpace(localDir)
	if localDir == "" {
		return nil, errors.New("local media storage directory is required")
	}
	if err := ensureLocalStorageDirectory(localDir); err != nil {
		return nil, err
	}
	return &GenericStorageService{
		settings: settings, objects: objects, documents: documents, localDir: localDir,
		capacityErrorHandler: capacityErrorHandler,
	}, nil
}

func (s *GenericStorageService) PublicConfig() StoragePublicConfig {
	setting := s.settings.StorageSettings()
	mode := "server_local"
	if hasAdminStorageProvider(setting) {
		mode = "server_external"
	} else if setting.AllowUserProvider {
		mode = "server_user_or_local"
	}
	return StoragePublicConfig{
		Mode: mode, LocalStorageEnabled: true, AllowUserProvider: setting.AllowUserProvider,
		AllowUserGlobalProvider: setting.AllowUserGlobalProvider,
	}
}

func (s *GenericStorageService) UserProviders(ownerID string) (UserStorageProviders, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return UserStorageProviders{}, errors.New("user is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadUserProvidersLocked(ownerID)
}

func (s *GenericStorageService) SaveUserProviders(ownerID string, incoming UserStorageProviders) (UserStorageProviders, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return UserStorageProviders{}, errors.New("user is required")
	}
	if !s.settings.StorageSettings().AllowUserProvider {
		return UserStorageProviders{}, errors.New("user storage providers are disabled")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadUserProvidersLocked(ownerID)
	if err != nil {
		return UserStorageProviders{}, err
	}
	mergeUserProvider := func(kind string, next **StorageObjectProviderInput, previous *StorageObjectProviderInput) error {
		if *next == nil {
			return nil
		}
		provider := **next
		provider.Type = kind
		if previous != nil {
			if strings.TrimSpace(provider.SecretAccessKey) == "" {
				provider.SecretAccessKey = previous.SecretAccessKey
			}
			if provider.Password == "" {
				provider.Password = previous.Password
			}
		}
		resolved := normalizeUserStorageProvider(ownerID, provider)
		if providerEnabled(provider.Enabled) && !storageProviderConfigured(resolved) {
			return errors.New("user storage provider is incomplete")
		}
		if resolved.PublicBaseURL != "" && storageObjectPublicURL(resolved, "health-check") == "" {
			return errors.New("user storage provider public base URL is invalid")
		}
		*next = &provider
		return nil
	}
	if err := mergeUserProvider(model.StorageProviderTypeS3, &incoming.S3, current.S3); err != nil {
		return UserStorageProviders{}, err
	}
	if err := mergeUserProvider(model.StorageProviderTypeWebDAV, &incoming.WebDAV, current.WebDAV); err != nil {
		return UserStorageProviders{}, err
	}
	if incoming.S3 == nil {
		incoming.S3 = current.S3
	}
	if incoming.WebDAV == nil {
		incoming.WebDAV = current.WebDAV
	}
	if err := validateUserStorageProviderTypes(incoming); err != nil {
		return UserStorageProviders{}, err
	}
	if err := s.documents.SaveJSONDocument(userStorageDocumentName(ownerID), incoming); err != nil {
		return UserStorageProviders{}, err
	}
	return incoming, nil
}

func (s *GenericStorageService) Upload(ctx context.Context, ownerID string, admin bool, filename, contentType string, data []byte, providerInput *StorageObjectProviderInput) (UploadedStorageObject, error) {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return UploadedStorageObject{}, errors.New("user is required")
	}
	if len(data) == 0 {
		return UploadedStorageObject{}, errors.New("file is empty")
	}
	setting := s.settings.StorageSettings()
	var provider model.StorageProvider
	var err error
	if providerInput != nil {
		if !setting.AllowUserProvider {
			return UploadedStorageObject{}, errors.New("user storage providers are disabled")
		}
		provider = normalizeUserStorageProvider(ownerID, *providerInput)
		if !provider.Enabled || !storageProviderConfigured(provider) {
			return UploadedStorageObject{}, errors.New("user storage provider is incomplete")
		}
	} else {
		provider, err = s.selectStorageProvider(ownerID, admin, setting)
		if err != nil {
			return UploadedStorageObject{}, err
		}
	}
	if provider.Type == model.StorageProviderTypeLocal {
		s.localCapacityMu.Lock()
		defer s.localCapacityMu.Unlock()
		limit := setting.LocalCapacityLimitBytes
		if limit > 0 {
			used, measureErr := measureLocalStorageProvider(provider)
			if measureErr != nil {
				return UploadedStorageObject{}, measureErr
			}
			incomingBytes := int64(len(data))
			if used >= limit || incomingBytes > limit-used {
				return UploadedStorageObject{}, ErrLocalStorageCapacityExceeded
			}
		}
	}
	objectID := uuid.NewString()
	extension := path.Ext(filename)
	if extension == "" {
		extension = extensionForMIMEType(contentType)
	}
	now := time.Now().UTC()
	objectKey := strings.Trim(path.Join(provider.PathPrefix, ownerID, now.Format("2006/01/02"), objectID+extension), "/")
	if contentType = strings.TrimSpace(contentType); contentType == "" {
		contentType = http.DetectContentType(data)
	}
	if err := putStorageObject(ctx, provider, objectKey, contentType, data); err != nil {
		return UploadedStorageObject{}, err
	}
	sum := sha256.Sum256(data)
	object := model.StorageObject{
		ID: objectID, ProviderID: provider.ID, Bucket: provider.Bucket, ObjectKey: objectKey,
		PublicURL: storageObjectPublicURL(provider, objectKey), MIMEType: contentType,
		Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), CreatedBy: ownerID,
		CreatedAt: now.Format(time.RFC3339Nano),
	}
	if err := s.objects.SaveStorageObject(object); err != nil {
		_ = deleteStorageObjectData(ctx, provider, objectKey)
		return UploadedStorageObject{}, err
	}
	objectURL := "/api/files/" + objectID + "/content"
	if object.PublicURL != "" {
		objectURL = object.PublicURL
	}
	return UploadedStorageObject{ID: objectID, URL: objectURL, StorageKey: "server:" + objectID, Bytes: object.Bytes, MIMEType: object.MIMEType}, nil
}

func (s *GenericStorageService) RegisterDirect(ownerID string, input DirectStorageObjectInput) (UploadedStorageObject, error) {
	ownerID = strings.TrimSpace(ownerID)
	setting := s.settings.StorageSettings()
	if ownerID == "" || !setting.AllowUserProvider || strings.ToLower(strings.TrimSpace(input.Provider.Type)) != model.StorageProviderTypeWebDAV {
		return UploadedStorageObject{}, errors.New("user WebDAV is disabled")
	}
	provider := normalizeUserStorageProvider(ownerID, input.Provider)
	if !provider.Enabled || !storageProviderConfigured(provider) {
		return UploadedStorageObject{}, errors.New("user WebDAV provider is incomplete")
	}
	objectKey, err := cleanStorageObjectPath(input.ObjectKey)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	prefix := strings.Trim(path.Join(provider.PathPrefix, ownerID), "/") + "/"
	if !strings.HasPrefix(objectKey, prefix) {
		return UploadedStorageObject{}, errors.New("WebDAV object path is invalid")
	}
	if input.Bytes < 0 {
		return UploadedStorageObject{}, errors.New("file size is invalid")
	}
	mimeType := strings.TrimSpace(input.MIMEType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	objectID := uuid.NewString()
	object := model.StorageObject{
		ID: objectID, ProviderID: provider.ID, ObjectKey: objectKey, MIMEType: mimeType,
		Bytes: input.Bytes, Direct: true, CreatedBy: ownerID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := s.objects.SaveStorageObject(object); err != nil {
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{
		ID: objectID, URL: "/api/files/" + objectID + "/content?direct=1", StorageKey: "server:" + objectID,
		Bytes: object.Bytes, MIMEType: object.MIMEType,
	}, nil
}

func (s *GenericStorageService) InfoForIdentity(ownerID string, admin bool, id string) (model.StorageObject, error) {
	return s.storageObjectForIdentity(ownerID, admin, id)
}

func (s *GenericStorageService) Delete(ctx context.Context, ownerID string, admin bool, id string, providerInput *StorageObjectProviderInput) error {
	object, err := s.objects.LoadStorageObject(strings.TrimSpace(id))
	if errors.Is(err, storage.ErrStorageObjectNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !admin && object.CreatedBy != ownerID {
		return errors.New("storage object permission denied")
	}
	providers := s.providersForObject(object)
	if providerInput != nil && s.settings.StorageSettings().AllowUserProvider {
		providers = append([]model.StorageProvider{normalizeUserStorageProvider(ownerID, *providerInput)}, providers...)
	}
	provider, ok := findStorageProviderForObject(object, providers)
	if !ok {
		return errors.New("storage provider does not exist")
	}
	if err := deleteStorageObjectData(ctx, provider, object.ObjectKey); err != nil {
		return err
	}
	return ignoreStorageObjectNotFound(s.objects.DeleteStorageObject(object.ID))
}

func (s *GenericStorageService) DeleteDirectRecord(ownerID string, id string) error {
	object, err := s.objects.LoadStorageObject(strings.TrimSpace(id))
	if errors.Is(err, storage.ErrStorageObjectNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if object.CreatedBy != strings.TrimSpace(ownerID) || !object.Direct {
		return errors.New("storage object permission denied")
	}
	return ignoreStorageObjectNotFound(s.objects.DeleteStorageObject(object.ID))
}

func (s *GenericStorageService) DownloadForIdentity(ctx context.Context, ownerID string, admin bool, id, rangeHeader string) (DownloadedStorageObject, error) {
	object, err := s.storageObjectForIdentity(ownerID, admin, id)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	provider, ok := findStorageProviderForObject(object, s.providersForObject(object))
	if ok && storageProviderConfigured(provider) {
		if download, downloadErr := downloadStorageObject(ctx, provider, object, rangeHeader); downloadErr == nil {
			return download, nil
		}
	}
	if strings.TrimSpace(object.PublicURL) != "" {
		return downloadPublicStorageObject(ctx, object, rangeHeader)
	}
	return DownloadedStorageObject{}, errors.New("storage provider does not exist")
}

func (s *GenericStorageService) storageObjectForIdentity(ownerID string, admin bool, id string) (model.StorageObject, error) {
	object, err := s.objects.LoadStorageObject(strings.TrimSpace(id))
	if err != nil {
		return model.StorageObject{}, err
	}
	if !admin && object.CreatedBy != strings.TrimSpace(ownerID) {
		return model.StorageObject{}, errors.New("storage object permission denied")
	}
	return object, nil
}

func (s *GenericStorageService) MeasureUser(ctx context.Context, ownerID string, input StorageObjectProviderInput) (StorageCapacityResult, error) {
	provider := normalizeUserStorageProvider(ownerID, input)
	bytesUsed, err := measureStorageProvider(ctx, provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	checkedAt := time.Now().UTC().Format(time.RFC3339Nano)
	return StorageCapacityResult{Bytes: bytesUsed, LimitBytes: defaultStorageCapacityLimitBytes, OverLimit: bytesUsed >= defaultStorageCapacityLimitBytes, CheckedAt: checkedAt, ProviderName: provider.Name}, nil
}

func (s *GenericStorageService) MeasureAdmin(ctx context.Context, index int, incoming *model.StorageProvider) (StorageCapacityResult, error) {
	if index == -1 {
		bytesUsed, err := measureStorageProvider(ctx, s.localStorageProvider())
		if err != nil {
			return StorageCapacityResult{}, err
		}
		limit := s.settings.StorageSettings().LocalCapacityLimitBytes
		return StorageCapacityResult{
			Bytes: bytesUsed, LimitBytes: limit, OverLimit: limit > 0 && bytesUsed >= limit,
			CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), ProviderName: "服务器本机",
		}, nil
	}
	setting := s.settings.StorageSettings()
	if index < 0 || index >= len(setting.Providers) {
		return StorageCapacityResult{}, errors.New("storage provider does not exist")
	}
	provider := setting.Providers[index]
	if incoming != nil {
		candidate := normalizeStorageProvider(*incoming)
		if candidate.SecretAccessKey == "" {
			candidate.SecretAccessKey = provider.SecretAccessKey
		}
		if candidate.Password == "" {
			candidate.Password = provider.Password
		}
		provider = candidate
	}
	bytesUsed, err := measureStorageProvider(ctx, provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	limit := setting.CapacityLimitBytes
	if limit <= 0 {
		limit = defaultStorageCapacityLimitBytes
	}
	provider.CapacityBytes = bytesUsed
	provider.CapacityCheckedAt = time.Now().UTC().Format(time.RFC3339Nano)
	provider.CapacityExceeded = bytesUsed >= limit
	if provider.CapacityExceeded {
		provider.Enabled = false
	}
	if err := s.settings.UpdateStorageProvider(index, provider); err != nil {
		return StorageCapacityResult{}, err
	}
	return StorageCapacityResult{Bytes: bytesUsed, LimitBytes: limit, OverLimit: provider.CapacityExceeded, CheckedAt: provider.CapacityCheckedAt, ProviderName: provider.Name}, nil
}

func (s *GenericStorageService) MeasureAll(ctx context.Context) []error {
	setting := s.settings.StorageSettings()
	errorsFound := make([]error, 0)
	if _, err := s.MeasureAdmin(ctx, -1, nil); err != nil {
		errorsFound = append(errorsFound, fmt.Errorf("measure server local storage: %w", err))
	}
	for index, provider := range setting.Providers {
		if !provider.Enabled {
			continue
		}
		if _, err := s.MeasureAdmin(ctx, index, nil); err != nil {
			errorsFound = append(errorsFound, fmt.Errorf("measure provider %q: %w", provider.Name, err))
		}
	}
	return errorsFound
}

func (s *GenericStorageService) LocalMediaGovernance() (LocalMediaGovernance, error) {
	provider := s.localStorageProvider()
	totalBytes, err := measureLocalStorageProvider(provider)
	if err != nil {
		return LocalMediaGovernance{}, err
	}
	usageByMIME, err := s.objects.StorageObjectUsageByMIME(provider.ID)
	if err != nil {
		return LocalMediaGovernance{}, err
	}
	result := LocalMediaGovernance{
		TotalBytes: totalBytes,
		LimitBytes: s.settings.StorageSettings().LocalCapacityLimitBytes,
	}
	for mimeType, usage := range usageByMIME {
		result.TotalCount += usage.Count
		result.IndexedBytes += usage.Bytes
		switch {
		case strings.HasPrefix(strings.ToLower(mimeType), "text/"):
			result.TextCount += usage.Count
			result.TextBytes += usage.Bytes
		case strings.HasPrefix(strings.ToLower(mimeType), "image/"):
			result.ImageCount += usage.Count
			result.ImageBytes += usage.Bytes
		case strings.HasPrefix(strings.ToLower(mimeType), "video/"):
			result.VideoCount += usage.Count
			result.VideoBytes += usage.Bytes
		case strings.HasPrefix(strings.ToLower(mimeType), "audio/"):
			result.AudioCount += usage.Count
			result.AudioBytes += usage.Bytes
		default:
			result.OtherCount += usage.Count
			result.OtherBytes += usage.Bytes
		}
	}
	if result.TotalBytes > result.IndexedBytes {
		result.UntrackedBytes = result.TotalBytes - result.IndexedBytes
	}
	if result.LimitBytes > 0 && result.TotalBytes > result.LimitBytes {
		result.OverLimitBytes = result.TotalBytes - result.LimitBytes
	}
	return result, nil
}

func (s *GenericStorageService) providersForObject(object model.StorageObject) []model.StorageProvider {
	providers := []model.StorageProvider{s.localStorageProvider()}
	if object.CreatedBy != "" && object.CreatedBy != "anonymous" {
		if userProviders, err := s.UserProviders(object.CreatedBy); err == nil {
			providers = append(providers, normalizedUserStorageProviders(object.CreatedBy, userProviders)...)
		}
	}
	return append(providers, s.settings.StorageSettings().Providers...)
}

func (s *GenericStorageService) localStorageProvider() model.StorageProvider {
	return model.StorageProvider{
		ID: "server-local", Name: "服务器本机", Type: model.StorageProviderTypeLocal,
		Endpoint: s.localDir, PathPrefix: "assets", Weight: 1, Enabled: true,
	}
}

func (s *GenericStorageService) selectStorageProvider(ownerID string, admin bool, setting model.StorageSetting) (model.StorageProvider, error) {
	if setting.AllowUserProvider {
		providers, err := s.UserProviders(ownerID)
		if err != nil {
			return model.StorageProvider{}, err
		}
		for _, provider := range normalizedUserStorageProviders(ownerID, providers) {
			if provider.Enabled && storageProviderConfigured(provider) {
				return provider, nil
			}
		}
	}
	if admin || setting.AllowUserGlobalProvider {
		if provider, err := selectStorageProvider(setting); err == nil {
			return provider, nil
		}
	}
	return s.localStorageProvider(), nil
}

func (s *GenericStorageService) loadUserProvidersLocked(ownerID string) (UserStorageProviders, error) {
	raw, err := s.documents.LoadJSONDocument(userStorageDocumentName(ownerID))
	if err != nil || raw == nil {
		return UserStorageProviders{}, err
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return UserStorageProviders{}, err
	}
	var providers UserStorageProviders
	if err := json.Unmarshal(encoded, &providers); err != nil {
		return UserStorageProviders{}, err
	}
	return providers, nil
}

func userStorageDocumentName(ownerID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(ownerID)))
	return "storage_users/" + hex.EncodeToString(sum[:]) + ".json"
}

func normalizedUserStorageProviders(ownerID string, inputs UserStorageProviders) []model.StorageProvider {
	providers := make([]model.StorageProvider, 0, 2)
	if inputs.S3 != nil {
		input := *inputs.S3
		input.Type = model.StorageProviderTypeS3
		providers = append(providers, normalizeUserStorageProvider(ownerID, input))
	}
	if inputs.WebDAV != nil {
		input := *inputs.WebDAV
		input.Type = model.StorageProviderTypeWebDAV
		providers = append(providers, normalizeUserStorageProvider(ownerID, input))
	}
	return providers
}

func normalizeUserStorageProvider(ownerID string, input StorageObjectProviderInput) model.StorageProvider {
	enabled := providerEnabled(input.Enabled)
	return normalizeStorageProvider(model.StorageProvider{
		ID:   "user-" + strings.TrimSpace(ownerID) + "-" + strings.ToLower(strings.TrimSpace(input.Type)),
		Name: input.Name, Type: input.Type, Endpoint: input.Endpoint, Region: input.Region,
		Bucket: input.Bucket, AccessKeyID: input.AccessKeyID, SecretAccessKey: input.SecretAccessKey,
		PublicBaseURL: input.PublicBaseURL, PathPrefix: input.PathPrefix,
		Username: input.Username, Password: input.Password, Weight: 1, Enabled: enabled, OwnerUserID: strings.TrimSpace(ownerID),
	})
}

func normalizeStorageProvider(provider model.StorageProvider) model.StorageProvider {
	provider.Name = strings.TrimSpace(provider.Name)
	provider.Type = strings.ToLower(strings.TrimSpace(provider.Type))
	provider.Endpoint = strings.TrimRight(strings.TrimSpace(provider.Endpoint), "/")
	provider.Region = strings.TrimSpace(provider.Region)
	provider.Bucket = strings.TrimSpace(provider.Bucket)
	provider.AccessKeyID = strings.TrimSpace(provider.AccessKeyID)
	provider.PathPrefix = strings.Trim(strings.TrimSpace(provider.PathPrefix), "/")
	provider.Username = strings.TrimSpace(provider.Username)
	if provider.Type == model.StorageProviderTypeS3 && provider.Region == "" {
		provider.Region = "auto"
	}
	if provider.Type == model.StorageProviderTypeWebDAV && provider.PathPrefix == "" {
		provider.PathPrefix = "assets"
	}
	if provider.Weight <= 0 {
		provider.Weight = 1
	}
	return provider
}

func providerEnabled(enabled *bool) bool {
	return enabled == nil || *enabled
}

func validateUserStorageProviderTypes(providers UserStorageProviders) error {
	s3Enabled := providers.S3 != nil && providerEnabled(providers.S3.Enabled)
	webDAVEnabled := providers.WebDAV != nil && providerEnabled(providers.WebDAV.Enabled)
	if s3Enabled && webDAVEnabled {
		return errors.New("S3/R2 and WebDAV cannot be enabled at the same time")
	}
	return nil
}

func hasAdminStorageProvider(setting model.StorageSetting) bool {
	for _, provider := range setting.Providers {
		if provider.Enabled && storageProviderConfigured(provider) {
			return true
		}
	}
	return false
}

func selectStorageProvider(setting model.StorageSetting) (model.StorageProvider, error) {
	candidates := make([]model.StorageProvider, 0)
	for _, provider := range setting.Providers {
		if !provider.Enabled || !storageProviderConfigured(provider) {
			continue
		}
		for weight := 0; weight < provider.Weight; weight++ {
			candidates = append(candidates, provider)
		}
	}
	if len(candidates) == 0 {
		return model.StorageProvider{}, errors.New("no storage provider is available")
	}
	return candidates[int(time.Now().UnixNano())%len(candidates)], nil
}

func storageProviderConfigured(provider model.StorageProvider) bool {
	if provider.Type == model.StorageProviderTypeLocal {
		return provider.Endpoint != ""
	}
	if provider.Endpoint == "" {
		return false
	}
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return provider.Bucket != "" && provider.AccessKeyID != "" && provider.SecretAccessKey != ""
	case model.StorageProviderTypeWebDAV:
		return provider.Username != "" && provider.Password != ""
	default:
		return false
	}
}

func findStorageProviderForObject(object model.StorageObject, providers []model.StorageProvider) (model.StorageProvider, bool) {
	for _, provider := range providers {
		if object.ProviderID != "" && provider.ID == object.ProviderID {
			return normalizeStorageProvider(provider), true
		}
		if object.Bucket != "" && provider.Bucket == object.Bucket {
			base := strings.TrimRight(strings.TrimSpace(provider.PublicBaseURL), "/")
			if object.PublicURL == "" || base == "" || strings.HasPrefix(object.PublicURL, base+"/") {
				return normalizeStorageProvider(provider), true
			}
		}
	}
	return model.StorageProvider{}, false
}

func downloadPublicStorageObject(ctx context.Context, object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, object.PublicURL, nil)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	if strings.TrimSpace(rangeHeader) != "" {
		request.Header.Set("Range", rangeHeader)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	if !storageDownloadStatus(response.StatusCode) {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		return DownloadedStorageObject{}, fmt.Errorf("storage object read failed: %s %s", response.Status, string(body))
	}
	return DownloadedStorageObject{
		Object: object, Stream: response.Body, StatusCode: response.StatusCode,
		ContentLength: response.ContentLength, ContentRange: response.Header.Get("Content-Range"),
		AcceptRanges: response.Header.Get("Accept-Ranges") != "" || response.StatusCode == http.StatusPartialContent,
	}, nil
}

func storageDownloadStatus(status int) bool {
	return status >= 200 && status < 300 || status == http.StatusRequestedRangeNotSatisfiable
}

func putStorageObject(ctx context.Context, provider model.StorageProvider, objectKey, contentType string, data []byte) error {
	switch provider.Type {
	case model.StorageProviderTypeLocal:
		return putLocalStorageObject(provider, objectKey, data)
	case model.StorageProviderTypeS3:
		client, err := newGenericS3Client(provider)
		if err != nil {
			return err
		}
		_, err = client.PutObject(ctx, provider.Bucket, objectKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
		return err
	case model.StorageProviderTypeWebDAV:
		return putGenericWebDAVObject(provider, objectKey, data)
	default:
		return errors.New("storage provider type is unsupported")
	}
}

func deleteStorageObjectData(ctx context.Context, provider model.StorageProvider, objectKey string) error {
	switch provider.Type {
	case model.StorageProviderTypeLocal:
		return deleteLocalStorageObject(provider, objectKey)
	case model.StorageProviderTypeS3:
		client, err := newGenericS3Client(provider)
		if err != nil {
			return err
		}
		return client.RemoveObject(ctx, provider.Bucket, objectKey, minio.RemoveObjectOptions{})
	case model.StorageProviderTypeWebDAV:
		return deleteGenericWebDAVObject(provider, objectKey)
	default:
		return errors.New("storage provider type is unsupported")
	}
}

func downloadStorageObject(ctx context.Context, provider model.StorageProvider, object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	if provider.Type == model.StorageProviderTypeLocal {
		return downloadLocalStorageObject(provider, object, rangeHeader)
	}
	if provider.Type == model.StorageProviderTypeWebDAV {
		return downloadGenericWebDAVObject(provider, object, rangeHeader)
	}
	client, err := newGenericS3Client(provider)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	info, err := client.StatObject(ctx, provider.Bucket, object.ObjectKey, minio.StatObjectOptions{})
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	options := minio.GetObjectOptions{}
	status := http.StatusOK
	contentLength := info.Size
	contentRange := ""
	if strings.TrimSpace(rangeHeader) != "" {
		byteRange, ok := parseStorageByteRange(rangeHeader, info.Size)
		if !ok {
			return DownloadedStorageObject{}, errors.New("requested storage range is invalid")
		}
		if err := options.SetRange(byteRange.offset, byteRange.offset+byteRange.length-1); err != nil {
			return DownloadedStorageObject{}, err
		}
		status = http.StatusPartialContent
		contentLength = byteRange.length
		contentRange = fmt.Sprintf("bytes %d-%d/%d", byteRange.offset, byteRange.offset+byteRange.length-1, info.Size)
	}
	stream, err := client.GetObject(ctx, provider.Bucket, object.ObjectKey, options)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	return DownloadedStorageObject{Object: object, Stream: stream, StatusCode: status, ContentLength: contentLength, ContentRange: contentRange, AcceptRanges: true}, nil
}

func measureStorageProvider(ctx context.Context, provider model.StorageProvider) (int64, error) {
	if !storageProviderConfigured(provider) {
		return 0, errors.New("storage provider is incomplete")
	}
	if provider.Type == model.StorageProviderTypeLocal {
		return measureLocalStorageProvider(provider)
	}
	if provider.Type == model.StorageProviderTypeWebDAV {
		return measureGenericWebDAVProvider(provider)
	}
	client, err := newGenericS3Client(provider)
	if err != nil {
		return 0, err
	}
	var total int64
	for object := range client.ListObjects(ctx, provider.Bucket, minio.ListObjectsOptions{Prefix: provider.PathPrefix, Recursive: true}) {
		if object.Err != nil {
			return 0, object.Err
		}
		total += object.Size
	}
	return total, nil
}

func newGenericS3Client(provider model.StorageProvider) (*minio.Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(provider.Endpoint))
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("S3 endpoint is invalid")
	}
	if parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return nil, errors.New("S3 endpoint must not contain a path, query, fragment, or credentials")
	}
	return minio.New(parsed.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(provider.AccessKeyID, provider.SecretAccessKey, ""),
		Secure: parsed.Scheme == "https", Region: provider.Region, BucketLookup: minio.BucketLookupPath,
	})
}

func storageObjectPublicURL(provider model.StorageProvider, objectKey string) string {
	base := strings.TrimRight(strings.TrimSpace(provider.PublicBaseURL), "/")
	if base == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	return base + "/" + escapeStorageObjectPath(objectKey)
}

func escapeStorageObjectPath(value string) string {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	for index := range parts {
		parts[index] = url.PathEscape(parts[index])
	}
	return strings.Join(parts, "/")
}

func extensionForMIMEType(contentType string) string {
	if extensions, err := mime.ExtensionsByType(strings.TrimSpace(contentType)); err == nil && len(extensions) > 0 {
		return extensions[0]
	}
	return ""
}

func ignoreStorageObjectNotFound(err error) error {
	if errors.Is(err, storage.ErrStorageObjectNotFound) {
		return nil
	}
	return err
}

type storageByteRange struct {
	offset int64
	length int64
}

func parseStorageByteRange(value string, size int64) (storageByteRange, bool) {
	value = strings.TrimSpace(value)
	if size <= 0 || !strings.HasPrefix(strings.ToLower(value), "bytes=") {
		return storageByteRange{}, false
	}
	value = strings.TrimSpace(value[len("bytes="):])
	if value == "" || strings.Contains(value, ",") {
		return storageByteRange{}, false
	}
	parts := strings.SplitN(value, "-", 2)
	if len(parts) != 2 {
		return storageByteRange{}, false
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return storageByteRange{}, false
		}
		if suffix > size {
			suffix = size
		}
		return storageByteRange{offset: size - suffix, length: suffix}, true
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return storageByteRange{}, false
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return storageByteRange{}, false
		}
		if end >= size {
			end = size - 1
		}
	}
	return storageByteRange{offset: start, length: end - start + 1}, true
}
