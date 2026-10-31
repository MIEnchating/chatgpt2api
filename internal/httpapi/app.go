package httpapi

import (
	"context"
	cryptorand "crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/config"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
	"chatgpt2api/internal/videocontract"
	frontend "chatgpt2api/internal/web"
)

const (
	maxLoginPageImageSize         = 10 << 20
	maxSiteIconSize               = 2 << 20
	maxRelayImageBytes            = 40 << 20
	maxRelayImageMultipartMemory  = 1 << 20
	maxRelayImageEditRequestBytes = 192 << 20
	maxLoginRequestBodyBytes      = 64 << 10
	relayImageLocalizationTimeout = time.Minute
	authSessionCookieName         = "chatgpt2api_session"
	defaultVideoModel             = "grok-imagine-video"
)

var (
	errRelayImageTooLarge    = errors.New("image file is too large")
	errTooManyRelayMasks     = errors.New("only one mask file is allowed")
	errUnsupportedRelayImage = errors.New("unsupported image format")
)

type App struct {
	ctx                     context.Context
	config                  *config.Store
	auth                    *service.AuthService
	logs                    *service.LogService
	logger                  *service.Logger
	proxy                   *service.ProxyService
	images                  *service.ImageService
	conversationAssets      *service.ImageConversationAssetService
	tasks                   *service.ImageTaskService
	prompts                 *service.PromptFavoriteService
	myAssets                *service.MyAssetService
	history                 *service.ImageConversationHistoryService
	canvasAgent             *service.CanvasAgentService
	canvas                  *service.CanvasDocumentService
	agentSkills             *service.AgentSkillService
	autoDL                  *service.AutoDLService
	fileLifecycle           *service.FileLifecycleService
	announce                *service.AnnouncementService
	videoContracts          *videocontract.VideoModelContractService
	imagePreferences        *service.ImageGenerationPreferenceService
	customRelayConfigs      *service.CustomRelayConfigService
	workflows               *service.WorkflowService
	storageFiles            *service.GenericStorageService
	newAPIKeys              *service.NewAPITokenReader
	newAPIKeysMu            sync.RWMutex
	newRelayTokenReader     func(service.NewAPITokenReaderConfig) (*service.NewAPITokenReader, error)
	newSafeRelayHTTPClient  func(time.Duration) *http.Client
	newImageDownloadClient  func(time.Duration) *http.Client
	cancel                  context.CancelFunc
	historyWriteLimiter     *imageConversationHistoryWriteLimiter
	imageUploadSlots        chan struct{}
	storageUploadSlots      chan struct{}
	videoDir                string
	audioDir                string
	videoReferenceDir       string
	referenceSigningKey     [32]byte
	loginLimiter            *loginRateLimiter
	ssoSessions             ssoSessionCache
	settingsMu              sync.Mutex
	backgroundWorkers       sync.WaitGroup
	storageBackendCloser    io.Closer
	storageBackendCloseOnce sync.Once

	imageCleanup             imageCleanupWorker
	conversationAssetCleanup imageConversationAssetCleanupWorker
}

type imageCleanupWorker struct {
	mu           sync.Mutex
	queued       bool
	running      bool
	closed       bool
	done         chan struct{}
	activeCancel context.CancelFunc
	closeWait    time.Duration
}

type appStartupCleanup struct {
	cancel  context.CancelFunc
	actions []func()
	done    bool
}

func (c *appStartupCleanup) add(action func()) {
	if c == nil || c.done || action == nil {
		return
	}
	c.actions = append(c.actions, action)
}

func (c *appStartupCleanup) run() {
	if c == nil || c.done {
		return
	}
	c.done = true
	if c.cancel != nil {
		c.cancel()
	}
	for index := len(c.actions) - 1; index >= 0; index-- {
		c.actions[index]()
	}
	c.cancel = nil
	c.actions = nil
}

func (c *appStartupCleanup) commit() {
	if c == nil || c.done {
		return
	}
	c.done = true
	c.cancel = nil
	c.actions = nil
}

func (w *imageCleanupWorker) scheduleContext(run func(context.Context)) {
	if w == nil || run == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if w.running {
		w.queued = true
		w.mu.Unlock()
		return
	}
	w.running = true
	w.done = make(chan struct{})
	done := w.done
	ctx, cancel := context.WithCancel(context.Background())
	w.activeCancel = cancel
	w.mu.Unlock()

	go func() {
		defer cancel()
		for {
			if ctx.Err() == nil {
				run(ctx)
			}
			w.mu.Lock()
			if w.closed || ctx.Err() != nil || !w.queued {
				w.queued = false
				w.running = false
				w.activeCancel = nil
				w.done = nil
				close(done)
				w.mu.Unlock()
				return
			}
			w.queued = false
			w.mu.Unlock()
		}
	}()
}

func (w *imageCleanupWorker) close() bool {
	if w == nil {
		return true
	}
	w.mu.Lock()
	w.closed = true
	w.queued = false
	done := w.done
	cancel := w.activeCancel
	w.activeCancel = nil
	closeWait := w.closeWait
	if closeWait <= 0 {
		closeWait = imageCleanupWorkerCloseWait
	}
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		timer := time.NewTimer(closeWait)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
		}
	}
	w.mu.Lock()
	drained := !w.running
	w.mu.Unlock()
	return drained
}

func (w *imageCleanupWorker) wait() {
	if w == nil {
		return
	}
	w.mu.Lock()
	running := w.running
	done := w.done
	w.mu.Unlock()
	if running && done != nil {
		<-done
	}
}

// Cleanup has no execution deadline during normal operation. This only bounds
// how long shutdown waits after cancellation before continuing teardown.
const imageCleanupWorkerCloseWait = time.Second

func NewApp() (*App, error) {
	startupCleanup := &appStartupCleanup{}
	defer startupCleanup.run()

	cfg, err := config.NewStore()
	if err != nil {
		return nil, err
	}
	storageBackend, err := cfg.StorageBackend()
	if err != nil {
		return nil, err
	}
	storageBackendCloser, _ := storageBackend.(io.Closer)
	if storageBackendCloser != nil {
		startupCleanup.add(func() { _ = storageBackendCloser.Close() })
	}
	ctx, cancel := context.WithCancel(context.Background())
	startupCleanup.cancel = cancel
	logs := service.NewLogService(storageBackend)
	logger, err := service.NewLogger(cfg.DataDir, cfg.LogLevels)
	if err != nil {
		return nil, err
	}
	startupCleanup.add(func() { _ = logger.Close() })
	proxy := service.NewProxyService(cfg)
	startupCleanup.add(proxy.Close)
	newAPIKeys, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{
		DatabaseURL:  cfg.RelayDatabaseConnectionURL(),
		DatabaseType: cfg.RelayDatabaseType(),
	})
	if err != nil {
		return nil, err
	}
	startupCleanup.add(func() { _ = newAPIKeys.Close() })
	auth, err := service.NewAuthService(storageBackend)
	if err != nil {
		return nil, err
	}
	storageFiles, err := service.NewGenericStorageService(storageBackend, cfg, filepath.Join(cfg.DataDir, "storage_files"), func(err error) {
		logger.Warning("scheduled storage capacity measurement failed", "error", err)
	})
	if err != nil {
		return nil, err
	}
	startupCleanup.add(storageFiles.Close)
	if err := storageFiles.RefreshCapacityScheduler(ctx); err != nil {
		return nil, fmt.Errorf("initialize storage capacity scheduler: %w", err)
	}
	bootstrap, err := auth.EnsureBootstrapAdmin(cfg.AdminUsername(), cfg.AdminPassword())
	if err != nil {
		return nil, err
	}
	if bootstrap.Created && bootstrap.Generated {
		fmt.Fprintf(os.Stderr, "bootstrap admin password generated: username=%s password=%s\n", bootstrap.Username, bootstrap.Password)
		logger.Warning("bootstrap admin password generated", "username", bootstrap.Username)
	}
	videoContracts := videocontract.NewVideoModelContractService(storageBackend)
	if err := videoContracts.Initialize(); err != nil {
		return nil, fmt.Errorf("initialize video model contracts: %w", err)
	}
	images := service.NewImageService(cfg, storageBackend)
	videoDir := filepath.Join(cfg.DataDir, "videos")
	if err := service.EnsureMediaDirectory(videoDir, 0o750); err != nil {
		return nil, fmt.Errorf("initialize video storage: %w", err)
	}
	videoReferenceDir := filepath.Join(videoDir, "references")
	if err := service.EnsureMediaDirectory(videoReferenceDir, 0o750); err != nil {
		return nil, fmt.Errorf("initialize video reference storage: %w", err)
	}
	audioDir := filepath.Join(cfg.DataDir, "audio")
	if err := service.EnsureMediaDirectory(audioDir, 0o750); err != nil {
		return nil, fmt.Errorf("initialize audio storage: %w", err)
	}
	canvas := service.NewCanvasDocumentService(storageBackend, func(ownerID, objectID string) error {
		_, err := storageFiles.InfoForIdentity(ownerID, false, objectID)
		return err
	})
	workflows := service.NewWorkflowService(storageBackend)
	fileLifecycle, err := service.NewFileLifecycleService(storageBackend)
	if err != nil {
		return nil, fmt.Errorf("initialize file lifecycle: %w", err)
	}
	myAssets := service.NewMyAssetService(storageBackend, storageFiles, canvas, workflows, fileLifecycle)
	app := &App{ctx: ctx, config: cfg, auth: auth, logs: logs, logger: logger, proxy: proxy, images: images, videoDir: videoDir, audioDir: audioDir, videoReferenceDir: videoReferenceDir, conversationAssets: service.NewImageConversationAssetService(filepath.Join(cfg.DataDir, "image_conversation_assets")), prompts: service.NewPromptFavoriteService(storageBackend), myAssets: myAssets, history: service.NewImageConversationHistoryService(storageBackend), canvas: canvas, agentSkills: service.NewAgentSkillService(storageBackend), autoDL: service.NewAutoDLService(), announce: service.NewAnnouncementService(storageBackend), videoContracts: videoContracts, imagePreferences: service.NewImageGenerationPreferenceService(storageBackend), customRelayConfigs: service.NewCustomRelayConfigService(storageBackend), workflows: workflows, storageFiles: storageFiles, newAPIKeys: newAPIKeys, newRelayTokenReader: service.NewNewAPITokenReader, newSafeRelayHTTPClient: service.SafeOutboundHTTPClient, cancel: cancel, historyWriteLimiter: newImageConversationHistoryWriteLimiter(imageConversationHistoryWriteParallelism), imageUploadSlots: make(chan struct{}, 2), storageUploadSlots: make(chan struct{}, 2), loginLimiter: newLoginRateLimiter(), storageBackendCloser: storageBackendCloser}
	app.fileLifecycle = fileLifecycle
	canvas.SetFileReferenceProtector(fileLifecycle)
	workflows.SetFileReferenceProtector(fileLifecycle)
	myAssets.SetFileReferenceProtector(fileLifecycle)
	app.history.SetFileReferenceProtector(fileLifecycle)
	if _, err := cryptorand.Read(app.referenceSigningKey[:]); err != nil {
		return nil, fmt.Errorf("initialize reference URL signing: %w", err)
	}
	app.conversationAssets.SetStorageBudget(cfg.ImageStorageLimitBytes, func() (int64, error) {
		summary, err := app.images.StorageGovernance()
		return summary.TotalBytes, err
	})
	app.history.SetConversationAssetService(app.conversationAssets)
	app.startVideoModelContractRefresher(ctx, time.Minute)
	app.tasks = service.NewStoredImageTaskService(storageBackend,
		func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
			return app.runLoggedImageTask(ctx, identity, payload, "/api/creation-tasks/image-generations", "文生图", func(ctx context.Context, payload map[string]any) (map[string]any, error) {
				if err := app.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
					return nil, err
				}
				return app.relayImageCreationTask(ctx, payload, nil, false)
			})
		},
		func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
			return app.runLoggedImageTask(ctx, identity, payload, "/api/creation-tasks/image-edits", "图生图", func(ctx context.Context, payload map[string]any) (map[string]any, error) {
				if err := app.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
					return nil, err
				}
				images, _ := payload["images"].([]protocol.UploadedImage)
				return app.relayImageCreationTask(ctx, payload, images, true)
			})
		},
		func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
			return app.runLoggedChatTask(ctx, identity, payload)
		},
		cfg.ImageRetentionDays,
		cfg.UserDefaultConcurrentLimit,
		cfg.UserDefaultRPMLimit,
	)
	app.canvasAgent = service.NewCanvasAgentService(ctx, canvas, app.agentSkills, app.runCanvasAgentModel, app.runCanvasAgentMedia)
	app.canvasAgent.SetWorkflowService(workflows)
	app.tasks.SetFileReferenceProtector(fileLifecycle)
	app.tasks.SetVideoHandler(func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
		return app.runLoggedVideoTask(ctx, identity, payload)
	})
	app.tasks.SetAudioHandler(func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
		return app.runLoggedAudioTask(ctx, identity, payload)
	})
	app.tasks.SetTaskTimeoutGetter(func() time.Duration {
		return time.Duration(app.config.ImageTaskTimeoutSeconds()) * time.Second
	})
	app.trackBackgroundDone(logs.StartRetentionCleaner(ctx, func() service.LogRetentionSchedule {
		return service.LogRetentionSchedule{
			Enabled:       cfg.LogCleanupScheduleEnabled(),
			RetentionDays: cfg.LogRetentionDays(),
			Hour:          cfg.LogCleanupHour(),
		}
	}, time.Hour, logger))
	if _, err := app.cleanupImageStorageWithOptions(service.ImageStorageCleanupOptions{
		RetentionDays: cfg.ImageRetentionDays(),
		MaxBytes:      cfg.ImageStorageLimitBytes(),
	}); err != nil {
		logger.Warning("initial image storage cleanup failed", "error", err)
	}
	app.startImageStorageCleaner(ctx, time.Hour)
	app.startImageConversationAssetCleaner(ctx, time.Hour)
	app.startMyAssetDeletionCleaner(ctx, time.Minute)
	app.startGeneratedMediaCleaner(ctx, time.Hour)
	startupCleanup.commit()
	return app, nil
}

func (a *App) startMyAssetDeletionCleaner(ctx context.Context, interval time.Duration) {
	if a == nil || a.myAssets == nil {
		return
	}
	if interval <= 0 {
		interval = time.Hour
	}
	run := func() {
		if a.fileLifecycle != nil {
			if err := a.fileLifecycle.Sweep(ctx, a.myAssets); err != nil && ctx.Err() == nil && a.logger != nil {
				a.logger.Warning("unreferenced file cleanup failed", "error", err)
			}
		}
		if err := a.myAssets.RetryAllPendingObjectDeletions(ctx, a.myAssetCleanupOwnerIDs()...); err != nil && ctx.Err() == nil && a.logger != nil {
			a.logger.Warning("retry pending asset object deletions failed", "error", err)
		}
	}
	a.backgroundWorkers.Add(1)
	go func() {
		defer a.backgroundWorkers.Done()
		run()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}

func (a *App) myAssetCleanupOwnerIDs() []string {
	owners := map[string]struct{}{"admin": {}}
	if a != nil && a.auth != nil {
		for _, item := range a.auth.ListUsers() {
			ownerID := firstNonEmpty(util.Clean(item["owner_id"]), util.Clean(item["id"]))
			if ownerID != "" {
				owners[ownerID] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(owners))
	for ownerID := range owners {
		result = append(result, ownerID)
	}
	sort.Strings(result)
	return result
}

func (a *App) startVideoModelContractRefresher(ctx context.Context, interval time.Duration) {
	if a == nil || a.videoContracts == nil || interval <= 0 {
		return
	}
	a.backgroundWorkers.Add(1)
	go func() {
		defer a.backgroundWorkers.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.videoContracts.Initialize(); err != nil && a.logger != nil {
					a.logger.Warning("refresh video model contracts failed", "error", err)
				}
			}
		}
	}()
}

func (a *App) runLoggedVideoTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	start := time.Now()
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	model := util.Clean(payload["model"])
	payload["model"] = model
	if err := a.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
		return nil, err
	}
	result, err := a.relayVideoTask(ctx, payload)
	urls := collectURLs(result)
	if err != nil {
		a.logCall(ctx, identity, "视频生成", http.MethodPost, "/api/creation-tasks/video-generations", model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, payloadAuditCapture(payload))
		return result, err
	}
	a.logCall(ctx, identity, "视频生成", http.MethodPost, "/api/creation-tasks/video-generations", model, start, "success", http.StatusOK, "", urls, payloadAuditCapture(payload))
	return result, nil
}

func (a *App) Close() {
	if a.cancel != nil {
		a.cancel()
	}
	if a.canvasAgent != nil {
		a.canvasAgent.Close()
	}
	imageCleanupDrained := a.closeImageStorageCleaner()
	conversationCleanupDrained := a.closeImageConversationAssetCleaner()
	a.backgroundWorkers.Wait()
	if a.storageFiles != nil {
		a.storageFiles.Close()
	}
	if a.tasks != nil {
		if err := a.tasks.Close(); err != nil && a.logger != nil {
			a.logger.Warning("persist image tasks during shutdown failed", "error", err)
		}
	}
	if a.proxy != nil {
		a.proxy.Close()
	}
	cleanupDrained := imageCleanupDrained && conversationCleanupDrained
	if !cleanupDrained && a.logger != nil {
		a.logger.Warning("storage backend close deferred until unfinished cleanup exits")
	}
	if a.logger != nil {
		_ = a.logger.Close()
	}
	a.closeRelayTokenReaders()
	if cleanupDrained {
		a.closeStorageBackend()
		return
	}
	go func() {
		a.imageCleanup.wait()
		a.conversationAssetCleanup.wait()
		a.closeStorageBackend()
	}()
}

func (a *App) closeStorageBackend() {
	if a == nil {
		return
	}
	a.storageBackendCloseOnce.Do(func() {
		closer := a.storageBackendCloser
		if closer == nil && a.config != nil {
			backend, err := a.config.StorageBackend()
			if err == nil {
				closer, _ = backend.(io.Closer)
			}
		}
		if closer != nil {
			_ = closer.Close()
		}
	})
}

func (a *App) trackBackgroundDone(done <-chan struct{}) {
	if a == nil || done == nil {
		return
	}
	a.backgroundWorkers.Add(1)
	go func() {
		defer a.backgroundWorkers.Done()
		<-done
	}()
}

func (a *App) Logger() *service.Logger {
	return a.logger
}

func (a *App) handleUpstreamModels(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	started := time.Now()
	relayAPIKey := ""
	relayBaseURL := a.relayBaseURL()
	group := strings.TrimSpace(r.URL.Query().Get("group"))
	tokenName := strings.TrimSpace(r.URL.Query().Get("token_name"))
	if service.CustomRelayConfigIDFromTokenName(tokenName) != "" {
		credential, err := a.relayCredentialForIdentitySelection(r.Context(), identity, group, tokenName)
		if err != nil {
			a.writeUpstreamModelsResponse(w, r, nil, err, started, identity)
			return
		}
		relayAPIKey = credential.APIKey
		relayBaseURL = credential.BaseURL
		if credential.Custom {
			r = r.WithContext(withCustomRelayContext(r.Context()))
		}
		if a.handleExternalWorkflowModels(w, r, credential, started, identity) {
			return
		}
	}
	newAPIKeys, releaseRelayTokenReader := a.acquireRelayTokenReader()
	defer releaseRelayTokenReader()
	if relayAPIKey == "" && newAPIKeys != nil {
		if group != "" || tokenName != "" {
			var err error
			relayAPIKey, err = newAPIKeys.KeyForIdentityGroupAndName(r.Context(), identity, group, tokenName)
			if err != nil {
				a.writeUpstreamModelsResponse(w, r, nil, a.relayTokenSelectionHTTPError(err), started, identity)
				return
			}
		} else {
			var err error
			relayAPIKey, err = newAPIKeys.KeyForIdentity(r.Context(), identity)
			if err != nil {
				a.writeUpstreamModelsResponse(w, r, nil, a.relayTokenSelectionHTTPError(err), started, identity)
				return
			}
		}
	}
	result, err := a.relayListModelsAt(r.Context(), relayBaseURL, relayAPIKey)
	a.writeUpstreamModelsResponse(w, r, result, err, started, identity)
}

func (a *App) writeUpstreamModelsResponse(w http.ResponseWriter, r *http.Request, result map[string]any, err error, started time.Time, identity service.Identity) {
	const endpoint = "/api/profile/upstream-models"
	requestCapture := requestAuditCapture(r.Context())
	urls := collectURLs(result)
	if err != nil {
		a.logCall(r.Context(), identity, "上游模型列表", r.Method, endpoint, "models", started, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
		markRequestBusinessLogged(r)
		a.writeProtocolError(w, err)
		return
	}
	a.logCall(r.Context(), identity, "上游模型列表", r.Method, endpoint, "models", started, "success", http.StatusOK, "", urls, requestCapture)
	markRequestBusinessLogged(r)
	util.WriteJSON(w, http.StatusOK, result)
}

func imageMetadataPersistenceError(err error) error {
	if err == nil {
		return nil
	}
	return protocol.HTTPError{Status: http.StatusServiceUnavailable, Message: "failed to persist generated image metadata: " + err.Error()}
}

func protocolErrorHTTPStatus(err error) int {
	var httpErr protocol.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Status
	}
	var imageErr *protocol.ImageGenerationError
	if errors.As(err, &imageErr) {
		return imageErr.StatusCode
	}
	message := err.Error()
	if strings.Contains(strings.ToLower(message), "no available image quota") {
		return http.StatusTooManyRequests
	}
	return http.StatusBadGateway
}

func (a *App) writeProtocolError(w http.ResponseWriter, err error) {
	var httpErr protocol.HTTPError
	if errors.As(err, &httpErr) {
		util.WriteError(w, httpErr.Status, httpErr.Message)
		return
	}
	var imageErr *protocol.ImageGenerationError
	if errors.As(err, &imageErr) {
		util.WriteJSON(w, imageErr.StatusCode, imageErr.OpenAIError())
		return
	}
	message := err.Error()
	if strings.Contains(strings.ToLower(message), "no available image quota") {
		util.WriteJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]any{"message": "no available image quota", "type": "insufficient_quota", "param": nil, "code": "insufficient_quota"}})
		return
	}
	util.WriteJSON(w, http.StatusBadGateway, map[string]any{"detail": map[string]any{"error": message}})
}

func (a *App) handleStorageInfo(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	backend, err := a.config.StorageBackend()
	if err != nil {
		util.WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"backend": backend.Info(), "health": backend.HealthCheck()})
}

func (a *App) handleProxyTest(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}
	body, err := readJSONMap(r)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	candidate := strings.TrimSpace(util.Clean(body["url"]))
	if candidate == "" {
		candidate = a.config.Proxy()
	}
	if candidate == "" {
		util.WriteError(w, http.StatusBadRequest, "proxy url is required")
		return
	}
	if err := service.ValidateProxyTestTarget(candidate); err != nil {
		util.WriteError(w, http.StatusBadRequest, "代理地址不允许指向本机或内网")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"result": a.proxy.Test(candidate, 15*time.Second)})
}

func (a *App) resolveImageBaseURL() string {
	return a.config.BaseURL()
}

const (
	defaultJSONBodyLimit     int64 = 1 << 20
	maxCreationTaskJSONBytes int64 = 32 << 20
)

// readJSONMap decodes a JSON object with the default 1 MiB cap. Endpoints that
// legitimately carry larger bodies must call readJSONMapLimit explicitly.
func readJSONMap(r *http.Request) (map[string]any, error) {
	return readJSONMapLimit(r, defaultJSONBodyLimit)
}

func readJSONMapLimit(r *http.Request, limit int64) (map[string]any, error) {
	var body map[string]any
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	err := util.DecodeJSON(r.Body, &body)
	if body == nil {
		body = map[string]any{}
	}
	return body, err
}

func identityScope(identity service.Identity) string {
	if owner := util.Clean(identity.OwnerID); owner != "" {
		return owner
	}
	if id := util.Clean(identity.ID); id != "" {
		return id
	}
	return "anonymous"
}

func identityDisplayName(identity service.Identity) string {
	return firstNonEmpty(util.Clean(identity.Name), util.Clean(identity.CredentialName))
}

func imageAccessScope(identity service.Identity) service.ImageAccessScope {
	if identity.Role == service.AuthRoleAdmin {
		return service.ImageAccessScope{All: true}
	}
	return service.ImageAccessScope{OwnerID: identityScope(identity)}
}

func imageListAccessScope(identity service.Identity, value string) (service.ImageAccessScope, int, string) {
	switch strings.TrimSpace(value) {
	case "":
		return imageAccessScope(identity), 0, ""
	case "mine":
		return service.ImageAccessScope{OwnerID: identityScope(identity)}, 0, ""
	case "public":
		if identity.Role == service.AuthRoleAdmin {
			return service.ImageAccessScope{All: true}, 0, ""
		}
		return service.ImageAccessScope{Public: true}, 0, ""
	case "visible":
		return service.ImageAccessScope{OwnerID: identityScope(identity), Visible: true}, 0, ""
	case "all":
		if identity.Role != service.AuthRoleAdmin {
			return service.ImageAccessScope{}, http.StatusForbidden, "admin permission required"
		}
		return service.ImageAccessScope{All: true}, 0, ""
	default:
		return service.ImageAccessScope{}, http.StatusBadRequest, "scope must be mine, public, visible, or all"
	}
}

func (a *App) recordGeneratedImagesForPayload(identity service.Identity, urls []string, visibility string, payload map[string]any) error {
	if len(urls) == 0 || a.images == nil {
		return nil
	}
	ownerID := identityScope(identity)
	outputCompression, hasOutputCompression := imageOutputCompressionFromBody(payload["output_compression"])
	var outputCompressionPtr *int
	if hasOutputCompression {
		outputCompressionPtr = &outputCompression
	}
	sharePromptParams := util.ToBool(payload["share_prompt_parameters"])
	outputFormat := ""
	if rawOutputFormat := util.Clean(payload["output_format"]); rawOutputFormat != "" {
		outputFormat = service.NormalizeImageOutputFormat(rawOutputFormat)
	}
	err := a.images.RecordGeneratedImageMetadata(urls, ownerID, identityDisplayName(identity), visibility, service.GeneratedImageMetadata{
		Prompt:            util.Clean(payload["prompt"]),
		GenerationSource:  imageGenerationSourceFromPayload(payload),
		Model:             firstNonEmpty(util.Clean(payload["model"]), a.defaultImageModel()),
		Quality:           util.Clean(payload["quality"]),
		ResolutionPreset:  util.Clean(payload["image_resolution"]),
		RequestedSize:     util.Clean(payload["size"]),
		OutputFormat:      outputFormat,
		OutputCompression: outputCompressionPtr,
		Moderation:        util.Clean(payload["moderation"]),
		ReferenceImages:   imageReferenceMetadataFromPayload(payload),
		SharePromptParams: sharePromptParams,
		ShareReferences:   sharePromptParams && util.ToBool(payload["share_reference_images"]),
	})
	a.scheduleImageStorageCleanup()
	return err
}

func imageGenerationSourceFromPayload(payload map[string]any) string {
	if len(util.StringMap(payload["workflow_context"])) > 0 {
		return service.ImageGenerationSourceWorkflow
	}
	if source := service.NormalizeImageGenerationSource(util.Clean(payload["generation_source"])); source != "" {
		return source
	}
	return service.ImageGenerationSourceWorkbench
}

func (a *App) startImageStorageCleaner(ctx context.Context, interval time.Duration) {
	if a == nil || a.images == nil {
		return
	}
	if interval <= 0 {
		interval = time.Hour
	}
	a.backgroundWorkers.Add(1)
	go func() {
		defer a.backgroundWorkers.Done()
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.scheduleImageStorageCleanup()
				timer.Reset(interval)
			}
		}
	}()
}

func (a *App) scheduleImageStorageCleanup() {
	if a == nil || a.images == nil || a.config == nil {
		return
	}
	a.imageCleanup.scheduleContext(a.cleanupImageStorage)
}

func (a *App) closeImageStorageCleaner() bool {
	if a == nil {
		return true
	}
	return a.imageCleanup.close()
}

func (a *App) cleanupImageStorage(ctx context.Context) {
	if a == nil || a.images == nil || a.config == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return
	}
	options := service.ImageStorageCleanupOptions{
		RetentionDays: a.config.ImageRetentionDays(),
		MaxBytes:      a.config.ImageStorageLimitBytes(),
	}
	if ctx.Err() != nil {
		return
	}
	if _, err := a.cleanupImageStorageWithOptionsContext(ctx, options); err != nil && ctx.Err() == nil && a.logger != nil {
		a.logger.Warning("scheduled image storage cleanup failed", "error", err)
	}
}

func imageReferenceMetadataFromPayload(payload map[string]any) []service.GeneratedImageReference {
	if payload == nil {
		return nil
	}
	images := uploadedImagesFromPayload(payload["images"])
	if len(images) == 0 {
		images = protocol.ExtractChatContextImages(payload)
	}
	if len(images) == 0 {
		return nil
	}
	refs := make([]service.GeneratedImageReference, 0, len(images))
	for _, image := range images {
		if len(image.Data) == 0 {
			continue
		}
		refs = append(refs, service.GeneratedImageReference{
			Filename:    image.Filename,
			ContentType: image.ContentType,
			Data:        append([]byte(nil), image.Data...),
		})
	}
	return refs
}

func uploadedImagesFromPayload(value any) []protocol.UploadedImage {
	switch images := value.(type) {
	case []protocol.UploadedImage:
		return images
	case protocol.UploadedImage:
		return []protocol.UploadedImage{images}
	default:
		return nil
	}
}

func (a *App) decorateImageList(payload map[string]any) {
	ownerNames := a.imageOwnerDisplayNames()
	for _, item := range util.AsMapSlice(payload["items"]) {
		a.decorateImageItem(item, ownerNames)
	}
}

func (a *App) decorateImageItem(item map[string]any, ownerNames map[string]string) {
	if item == nil || util.Clean(item["owner_name"]) != "" {
		return
	}
	ownerID := util.Clean(item["owner_id"])
	if ownerID == "" {
		item["owner_name"] = "未知用户"
		return
	}
	if name := ownerNames[ownerID]; name != "" {
		item["owner_name"] = name
		return
	}
	item["owner_name"] = "未知用户"
}

func (a *App) imageOwnerDisplayNames() map[string]string {
	names := map[string]string{"admin": "管理员"}
	for _, item := range a.auth.ListUsers() {
		name := util.Clean(item["name"])
		if name == "" {
			continue
		}
		if id := util.Clean(item["id"]); id != "" {
			names[id] = name
		}
		if ownerID := util.Clean(item["owner_id"]); ownerID != "" {
			names[ownerID] = name
		}
	}
	return names
}

func collectURLs(v any) []string {
	switch x := v.(type) {
	case map[string]any:
		var urls []string
		for key, value := range x {
			if key == "url" {
				if u := util.Clean(value); u != "" {
					urls = append(urls, u)
				}
			} else if key == "urls" {
				for _, raw := range anyList(value) {
					if u := util.Clean(raw); u != "" {
						urls = append(urls, u)
					}
				}
			} else {
				urls = append(urls, collectURLs(value)...)
			}
		}
		return urls
	case []any:
		var urls []string
		for _, item := range x {
			urls = append(urls, collectURLs(item)...)
		}
		return urls
	case []map[string]any:
		var urls []string
		for _, item := range x {
			urls = append(urls, collectURLs(item)...)
		}
		return urls
	default:
		return nil
	}
}

func normalizedProtocolImageCount(value any) int {
	n, ok := util.StrictInt(value)
	if !ok || n < 1 {
		return 1
	}
	limit := util.MaxImageOutputCount()
	if n > limit {
		return limit
	}
	return n
}

func validProtocolImageCount(value any) bool {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return true
	}
	n, ok := util.StrictInt(value)
	return ok && n >= 1 && n <= util.MaxImageOutputCount()
}

func protocolImageCountRangeMessage() string {
	return fmt.Sprintf("n must be between 1 and %d", util.MaxImageOutputCount())
}

func normalizedRelayImageStreamOutputLimit(value int) int {
	if value < 1 {
		return 1
	}
	limit := util.MaxImageOutputCount()
	if value > limit {
		return limit
	}
	return value
}

func dedupe(items []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, item := range items {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

func anyList(v any) []any {
	if list, ok := v.([]any); ok {
		return list
	}
	if list, ok := v.([]map[string]any); ok {
		out := make([]any, len(list))
		for i, item := range list {
			out[i] = item
		}
		return out
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func firstString(values []string, fallback string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

// The built SPA only loads same-origin scripts and styles. Media and API
// calls may reach other HTTPS origins (object storage, upstream image hosts).
const webContentSecurityPolicy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; media-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`

func (a *App) serveWeb(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", webContentSecurityPolicy)
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	frontend.Handler().ServeHTTP(w, r)
}
