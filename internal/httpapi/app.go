package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/config"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
	frontend "chatgpt2api/internal/web"
)

const (
	maxLoginPageImageSize         = 10 << 20
	maxSiteIconSize               = 2 << 20
	maxRelayImageBytes            = 40 << 20
	maxRelayImageMultipartMemory  = 1 << 20
	maxRelayImageEditRequestBytes = 192 << 20
	maxLoginRequestBodyBytes      = 64 << 10
	imageThumbnailCacheControl    = "public, max-age=31536000, immutable"
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
	ctx                 context.Context
	config              *config.Store
	auth                *service.AuthService
	logs                *service.LogService
	logger              *service.Logger
	proxy               *service.ProxyService
	engine              *protocol.Engine
	images              *service.ImageService
	conversationAssets  *service.ImageConversationAssetService
	tasks               *service.ImageTaskService
	prompts             *service.PromptFavoriteService
	myAssets            *service.MyAssetService
	history             *service.ImageConversationHistoryService
	canvas              *service.CanvasDocumentService
	announce            *service.AnnouncementService
	imagePreferences    *service.ImageGenerationPreferenceService
	workflows           *service.WorkflowService
	storageFiles        *service.GenericStorageService
	newAPIKeys          *service.NewAPITokenReader
	newAPIKeysMu        sync.RWMutex
	retiredNewAPIKeys   []*service.NewAPITokenReader
	cancel              context.CancelFunc
	historyWriteLimiter *imageConversationHistoryWriteLimiter
	imageUploadSlots    chan struct{}
	videoDir            string
	audioDir            string
	videoReferenceDir   string
	loginLimiter        *loginRateLimiter
	settingsMu          sync.Mutex

	imageCleanup             imageCleanupWorker
	conversationAssetCleanup imageConversationAssetCleanupWorker
}

type imageCleanupWorker struct {
	mu      sync.Mutex
	queued  bool
	running bool
	closed  bool
	done    chan struct{}
}

func (w *imageCleanupWorker) schedule(run func()) {
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
	w.mu.Unlock()

	go func() {
		for {
			run()
			w.mu.Lock()
			if w.closed || !w.queued {
				w.queued = false
				w.running = false
				close(done)
				w.mu.Unlock()
				return
			}
			w.queued = false
			w.mu.Unlock()
		}
	}()
}

func (w *imageCleanupWorker) close() {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.closed = true
	w.queued = false
	done := w.done
	w.mu.Unlock()
	if done != nil {
		<-done
	}
}

func NewApp() (*App, error) {
	cfg, err := config.NewStore()
	if err != nil {
		return nil, err
	}
	storageBackend, err := cfg.StorageBackend()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	logs := service.NewLogService(storageBackend)
	logger, err := service.NewLogger(cfg.DataDir, cfg.LogLevels)
	if err != nil {
		cancel()
		return nil, err
	}
	proxy := service.NewProxyService(cfg)
	newAPIKeys, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{
		DatabaseURL:  cfg.RelayDatabaseConnectionURL(),
		DatabaseType: cfg.RelayDatabaseType(),
	})
	if err != nil {
		cancel()
		return nil, err
	}
	auth, err := service.NewAuthService(storageBackend)
	if err != nil {
		cancel()
		return nil, err
	}
	storageFiles, err := service.NewGenericStorageService(storageBackend, cfg, filepath.Join(cfg.DataDir, "storage_files"))
	if err != nil {
		cancel()
		return nil, err
	}
	if err := storageFiles.RefreshCapacityScheduler(ctx); err != nil {
		cancel()
		return nil, fmt.Errorf("initialize storage capacity scheduler: %w", err)
	}
	bootstrap, err := auth.EnsureBootstrapAdmin(cfg.AdminUsername(), cfg.AdminPassword())
	if err != nil {
		cancel()
		return nil, err
	}
	if bootstrap.Created && bootstrap.Generated {
		fmt.Fprintf(os.Stderr, "bootstrap admin password generated: username=%s password=%s\n", bootstrap.Username, bootstrap.Password)
		logger.Warning("bootstrap admin password generated", "username", bootstrap.Username)
	}
	documentStore, _ := storageBackend.(storage.JSONDocumentBackend)
	images := service.NewImageService(cfg, storageBackend)
	engine := &protocol.Engine{Config: cfg, Storage: documentStore, Images: images}
	videoDir := filepath.Join(cfg.DataDir, "videos")
	if err := os.MkdirAll(videoDir, 0o755); err != nil {
		cancel()
		return nil, fmt.Errorf("initialize video storage: %w", err)
	}
	videoReferenceDir := filepath.Join(videoDir, "references")
	if err := os.MkdirAll(videoReferenceDir, 0o755); err != nil {
		cancel()
		return nil, fmt.Errorf("initialize video reference storage: %w", err)
	}
	audioDir := filepath.Join(cfg.DataDir, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		cancel()
		return nil, fmt.Errorf("initialize audio storage: %w", err)
	}
	app := &App{ctx: ctx, config: cfg, auth: auth, logs: logs, logger: logger, proxy: proxy, engine: engine, images: images, videoDir: videoDir, audioDir: audioDir, videoReferenceDir: videoReferenceDir, conversationAssets: service.NewImageConversationAssetService(filepath.Join(cfg.DataDir, "image_conversation_assets")), prompts: service.NewPromptFavoriteService(storageBackend), myAssets: service.NewMyAssetService(storageBackend, storageFiles), history: service.NewImageConversationHistoryService(storageBackend), canvas: service.NewCanvasDocumentService(storageBackend), announce: service.NewAnnouncementService(storageBackend), imagePreferences: service.NewImageGenerationPreferenceService(storageBackend), workflows: service.NewWorkflowService(storageBackend), storageFiles: storageFiles, newAPIKeys: newAPIKeys, cancel: cancel, historyWriteLimiter: newImageConversationHistoryWriteLimiter(imageConversationHistoryWriteParallelism), imageUploadSlots: make(chan struct{}, 2), loginLimiter: newLoginRateLimiter()}
	app.conversationAssets.SetStorageBudget(cfg.ImageStorageLimitBytes, func() int64 {
		return app.images.StorageGovernance().TotalBytes
	})
	app.history.SetConversationAssetService(app.conversationAssets)
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
	app.tasks.SetVideoHandler(func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
		return app.runLoggedVideoTask(ctx, identity, payload)
	})
	app.tasks.SetAudioHandler(func(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
		return app.runLoggedAudioTask(ctx, identity, payload)
	})
	app.tasks.SetTaskTimeoutGetter(func() time.Duration {
		return time.Duration(app.config.ImageTaskTimeoutSeconds()) * time.Second
	})
	logs.StartRetentionCleaner(ctx, cfg.LogRetentionDays, 24*time.Hour, logger)
	_, _ = app.images.CleanupStorage(service.ImageStorageCleanupOptions{
		RetentionDays: cfg.ImageRetentionDays(),
		MaxBytes:      cfg.ImageStorageLimitBytes(),
	})
	app.startImageStorageCleaner(ctx, time.Hour)
	app.startImageConversationAssetCleaner(ctx, time.Hour)
	return app, nil
}

func (a *App) runLoggedVideoTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	start := time.Now()
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	model := firstNonEmpty(util.Clean(payload["model"]), firstString(a.config.VideoModels(), defaultVideoModel))
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

func relayImageTaskResult(payload map[string]any, result map[string]any, stream *protocol.StreamResult, err error) (map[string]any, error) {
	if err != nil || stream == nil {
		return result, err
	}
	return collectRelayImageTaskStream(payload, stream)
}

func collectRelayImageTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	created := time.Now().Unix()
	model := ""
	message := ""
	outputLimit := normalizedProtocolImageCount(payload["n"], util.Clean(payload["model"]))
	accumulator := newRelayImageStreamAccumulator(outputLimit)
	onProgress := relayImageTaskProgressCallback(payload)

	for item := range stream.Items {
		if item == nil {
			continue
		}
		if value := util.ToInt(firstNonEmpty(util.Clean(item["created"]), util.Clean(item["created_at"])), 0); value > 0 {
			created = int64(value)
		}
		if model == "" {
			model = util.Clean(item["model"])
		}
		if text := util.Clean(item["message"]); text != "" {
			message = text
		} else if text := util.Clean(item["progress_text"]); text != "" {
			message += text
		}
		data := relayImageStreamItemData(item)
		if len(data) == 0 {
			continue
		}
		accumulator.apply(item, data)
		if onProgress != nil {
			onProgress(accumulator.progressData())
		}
	}

	data := accumulator.finalData()
	out := map[string]any{"created": created, "data": data}
	if model != "" {
		out["model"] = model
	}
	if len(data) == 0 && strings.TrimSpace(message) != "" {
		out["message"] = strings.TrimSpace(message)
	}
	if err := <-stream.Err; err != nil {
		if out["message"] == nil {
			out["message"] = err.Error()
		}
		return out, err
	}
	return out, nil
}

type relayImageStreamAccumulator struct {
	final    []map[string]any
	previews []map[string]any
}

func newRelayImageStreamAccumulator(outputLimit int) *relayImageStreamAccumulator {
	outputLimit = normalizedRelayImageStreamOutputLimit(outputLimit)
	return &relayImageStreamAccumulator{
		final:    make([]map[string]any, outputLimit),
		previews: make([]map[string]any, outputLimit),
	}
}

func (a *relayImageStreamAccumulator) apply(event map[string]any, data []map[string]any) {
	if a == nil || len(data) == 0 {
		return
	}
	partial := isRelayImagePartialEvent(event)
	if !partial && !isRelayImageCompletedEvent(event) {
		return
	}
	start, indexed := relayImageEventOutputIndex(event)
	for _, item := range data {
		if !indexed {
			start = a.nextFinalSlot()
		}
		if start < 0 || start >= len(a.final) {
			return
		}
		clone := cloneRelayImageData([]map[string]any{item})
		if len(clone) == 0 {
			continue
		}
		if partial {
			if a.final[start] == nil {
				clone[0]["preview"] = true
				a.previews[start] = clone[0]
			}
		} else {
			delete(clone[0], "preview")
			a.final[start] = clone[0]
			a.previews[start] = nil
		}
		start++
	}
}

func (a *relayImageStreamAccumulator) nextFinalSlot() int {
	if a == nil {
		return -1
	}
	for index, item := range a.final {
		if item == nil {
			return index
		}
	}
	return -1
}

func (a *relayImageStreamAccumulator) progressData() []map[string]any {
	if a == nil {
		return nil
	}
	length := 0
	for index := range a.final {
		if a.final[index] != nil || a.previews[index] != nil {
			length = index + 1
		}
	}
	data := make([]map[string]any, length)
	for index := range data {
		switch {
		case a.final[index] != nil:
			data[index] = cloneRelayImageData([]map[string]any{a.final[index]})[0]
		case a.previews[index] != nil:
			data[index] = cloneRelayImageData([]map[string]any{a.previews[index]})[0]
		default:
			data[index] = map[string]any{}
		}
	}
	return data
}

func (a *relayImageStreamAccumulator) finalData() []map[string]any {
	if a == nil {
		return nil
	}
	length := 0
	for index, item := range a.final {
		if item != nil {
			length = index + 1
		}
	}
	data := make([]map[string]any, length)
	for index := range data {
		if a.final[index] == nil {
			data[index] = map[string]any{}
			continue
		}
		data[index] = cloneRelayImageData([]map[string]any{a.final[index]})[0]
	}
	return data
}

func relayImageEventOutputIndex(event map[string]any) (int, bool) {
	for _, key := range []string{"output_index", "index"} {
		if _, exists := event[key]; !exists {
			continue
		}
		index := util.ToInt(event[key], -1)
		return index, index >= 0
	}
	return -1, false
}

func isRelayImagePartialEvent(event map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(util.Clean(event["type"])))
	return strings.HasSuffix(eventType, ".partial_image")
}

func isRelayImageCompletedEvent(event map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(util.Clean(event["type"])))
	return strings.HasSuffix(eventType, ".completed")
}

func relayImageTaskProgressCallback(payload map[string]any) protocol.ImageOutputProgressCallback {
	switch callback := payload["image_output_callback"].(type) {
	case protocol.ImageOutputProgressCallback:
		return callback
	case func([]map[string]any):
		return callback
	default:
		return nil
	}
}

func relayImageStreamItemData(item map[string]any) []map[string]any {
	if data := util.AsMapSlice(item["data"]); len(data) > 0 {
		return cloneRelayImageData(data)
	}
	data := map[string]any{}
	for _, key := range []string{"url", "b64_json", "revised_prompt", "text_response"} {
		if value, ok := item[key]; ok && util.Clean(value) != "" {
			data[key] = value
		}
	}
	if len(data) == 0 {
		return nil
	}
	return []map[string]any{data}
}

func cloneRelayImageData(items []map[string]any) []map[string]any {
	if len(items) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item == nil {
			continue
		}
		clone := make(map[string]any, len(item))
		for key, value := range item {
			clone[key] = value
		}
		out = append(out, clone)
	}
	return out
}

func (a *App) Close() {
	if a.storageFiles != nil {
		a.storageFiles.Close()
	}
	if a.cancel != nil {
		a.cancel()
	}
	if a.tasks != nil {
		a.tasks.Close()
	}
	a.closeImageStorageCleaner()
	a.closeImageConversationAssetCleaner()
	if a.logger != nil {
		_ = a.logger.Close()
	}
	a.closeRelayTokenReaders()
	if a.config != nil {
		if backend, err := a.config.StorageBackend(); err == nil {
			if closer, ok := backend.(interface{ Close() error }); ok {
				_ = closer.Close()
			}
		}
	}
}

func (a *App) Logger() *service.Logger {
	return a.logger
}

func (a *App) handleUpstreamModels(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	relayAPIKey := ""
	newAPIKeys := a.relayTokenReader()
	if newAPIKeys != nil {
		group := strings.TrimSpace(r.URL.Query().Get("group"))
		tokenName := strings.TrimSpace(r.URL.Query().Get("token_name"))
		if group != "" || tokenName != "" {
			var err error
			relayAPIKey, err = newAPIKeys.KeyForIdentityGroupAndName(r.Context(), identity, group, tokenName)
			if err != nil {
				a.writeProtocol(w, r, nil, nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}, "openai", "/api/profile/upstream-models", "models", identity, "上游模型列表", service.ImageVisibilityPrivate)
				return
			}
		} else {
			relayAPIKey, _ = newAPIKeys.KeyForIdentity(r.Context(), identity)
		}
	}
	result, err := a.relayListModels(r.Context(), relayAPIKey)
	a.writeProtocol(w, r, result, nil, err, "openai", "/api/profile/upstream-models", "models", identity, "上游模型列表", service.ImageVisibilityPrivate)
}

func (a *App) writeProtocol(w http.ResponseWriter, r *http.Request, result map[string]any, stream *protocol.StreamResult, err error, sseKind, endpoint, model string, identity service.Identity, summary, visibility string, imagePayloads ...map[string]any) {
	start := time.Now()
	requestCapture := requestAuditCapture(r.Context())
	if err != nil {
		urls := collectURLs(result)
		if recordErr := a.recordProtocolGeneratedImages(identity, urls, visibility, imagePayloads...); recordErr != nil {
			err = errors.Join(err, imageMetadataPersistenceError(recordErr))
		}
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
		markRequestBusinessLogged(r)
		a.writeProtocolError(w, err)
		return
	}
	if stream == nil {
		urls := collectURLs(result)
		if recordErr := a.recordProtocolGeneratedImages(identity, urls, visibility, imagePayloads...); recordErr != nil {
			err := imageMetadataPersistenceError(recordErr)
			a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
			markRequestBusinessLogged(r)
			a.writeProtocolError(w, err)
			return
		}
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "success", http.StatusOK, "", urls, requestCapture)
		markRequestBusinessLogged(r)
		util.WriteJSON(w, http.StatusOK, result)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, _ := w.(http.Flusher)
	if stream.Kind == "anthropic" || sseKind == "anthropic" {
		var urls []string
		for item := range stream.Items {
			urls = append(urls, collectURLs(item)...)
			event := firstNonEmpty(util.Clean(item["type"]), "message_delta")
			fmt.Fprintf(w, "event: %s\n", event)
			fmt.Fprintf(w, "data: %s\n\n", jsonString(item))
			if flusher != nil {
				flusher.Flush()
			}
		}
		upstreamErr := <-stream.Err
		recordErr := a.recordProtocolGeneratedImages(identity, urls, visibility, imagePayloads...)
		if upstreamErr != nil {
			loggedErr := upstreamErr
			if recordErr != nil {
				loggedErr = errors.Join(upstreamErr, imageMetadataPersistenceError(recordErr))
			}
			a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(upstreamErr), loggedErr.Error(), urls, requestCapture)
			markRequestBusinessLogged(r)
			fmt.Fprintf(w, "event: error\n")
			fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]any{"type": "error", "error": map[string]any{"type": fmt.Sprintf("%T", upstreamErr), "message": upstreamErr.Error()}}))
			return
		}
		if recordErr != nil {
			err := imageMetadataPersistenceError(recordErr)
			a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
			markRequestBusinessLogged(r)
			fmt.Fprintf(w, "event: error\n")
			fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]any{"type": "error", "error": map[string]any{"type": "persistence_error", "message": err.Error()}}))
			return
		}
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "success", http.StatusOK, "", urls, requestCapture)
		markRequestBusinessLogged(r)
		return
	}
	fmt.Fprint(w, ": stream-open\n\n")
	if flusher != nil {
		flusher.Flush()
	}
	var urls []string
	for item := range stream.Items {
		urls = append(urls, collectURLs(item)...)
		fmt.Fprintf(w, "data: %s\n\n", jsonString(item))
		if flusher != nil {
			flusher.Flush()
		}
	}
	upstreamErr := <-stream.Err
	recordErr := a.recordProtocolGeneratedImages(identity, urls, visibility, imagePayloads...)
	if upstreamErr != nil {
		loggedErr := upstreamErr
		if recordErr != nil {
			loggedErr = errors.Join(upstreamErr, imageMetadataPersistenceError(recordErr))
		}
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(upstreamErr), loggedErr.Error(), urls, requestCapture)
		markRequestBusinessLogged(r)
		fmt.Fprintf(w, "data: %s\n\n", jsonString(openAIErrorForStream(upstreamErr)))
	} else if recordErr != nil {
		err := imageMetadataPersistenceError(recordErr)
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
		markRequestBusinessLogged(r)
		fmt.Fprintf(w, "data: %s\n\n", jsonString(openAIErrorForStream(err)))
	} else {
		a.logCall(r.Context(), identity, summary, r.Method, endpoint, model, start, "success", http.StatusOK, "", urls, requestCapture)
		markRequestBusinessLogged(r)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
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

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginRequestBodyBytes)
	body, err := readJSONMap(r)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			util.WriteError(w, http.StatusRequestEntityTooLarge, "login payload is too large")
			return
		}
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	username := util.Clean(body["username"])
	password := util.Clean(body["password"])
	loginLimiter := a.loginLimiter
	requestIP := clientIP(r)
	if retryAfter, allowed := loginLimiter.allow(requestIP, username); !allowed {
		w.Header().Set("Retry-After", loginRetryAfterSeconds(retryAfter))
		util.WriteError(w, http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试")
		return
	}
	identity, token, err := a.auth.LoginAdminPassword(username, password)
	if err != nil {
		if a.writeAuthPersistenceError(w, err) {
			return
		}
		newAPIKeys := a.relayTokenReader()
		if strings.EqualFold(username, a.config.AdminUsername()) || newAPIKeys == nil {
			loginLimiter.recordFailure(requestIP, username)
			util.WriteError(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		newAPIUser, newAPIErr := newAPIKeys.AuthenticatePassword(r.Context(), username, password)
		if newAPIErr != nil {
			loginLimiter.recordFailure(requestIP, username)
			util.WriteError(w, http.StatusUnauthorized, newAPIErr.Error())
			return
		}
		identity, token, err = a.auth.UpsertNewAPISession(newAPIUser)
		if err != nil {
			if !a.writeAuthPersistenceError(w, err) {
				util.WriteError(w, http.StatusInternalServerError, "登录会话保存失败")
			}
			return
		}
	}
	loginLimiter.recordSuccess(username)
	setAuthSessionCookie(w, r, token)
	a.writeLoginResponse(w, *identity)
}

func (a *App) handleSession(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if token := requestAuthCookieToken(r); token != "" {
		setAuthSessionCookie(w, r, token)
	}
	a.writeLoginResponse(w, identity)
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, err := a.auth.RevokeSessions(requestAuthCookieToken(r)); err != nil {
		if !a.writeAuthPersistenceError(w, err) {
			util.WriteError(w, http.StatusInternalServerError, "failed to revoke session")
		}
		return
	}
	clearAuthSessionCookie(w, r)
	util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) writeLoginResponse(w http.ResponseWriter, identity service.Identity) {
	permissions := a.identityPermissions(identity)
	payload := map[string]any{
		"ok":                        true,
		"role":                      identity.Role,
		"role_id":                   identity.RoleID,
		"role_name":                 identity.RoleName,
		"subject_id":                identity.ID,
		"username":                  identity.Username,
		"name":                      identity.Name,
		"provider":                  identity.Provider,
		"credential_id":             identity.CredentialID,
		"credential_name":           identity.CredentialName,
		"creation_concurrent_limit": a.identityCreationConcurrentLimit(identity),
		"creation_rpm_limit":        a.identityCreationRPMLimit(identity),
		"menu_paths":                permissions.MenuPaths,
		"api_permissions":           permissions.APIPermissions,
		"menus":                     service.FilterMenuPermissions(permissions.MenuPaths),
	}
	util.WriteJSON(w, http.StatusOK, payload)
}

func (a *App) identityCreationConcurrentLimit(identity service.Identity) int {
	if identity.Role != service.AuthRoleUser {
		return 0
	}
	return a.config.UserDefaultConcurrentLimit()
}

func (a *App) identityCreationRPMLimit(identity service.Identity) int {
	if identity.Role != service.AuthRoleUser {
		return 0
	}
	return a.config.UserDefaultRPMLimit()
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"config": a.settingsConfig(r.Context(), identity.Role == service.AuthRoleAdmin)})
	case http.MethodPost:
		a.settingsMu.Lock()
		defer a.settingsMu.Unlock()
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if identity.Role != service.AuthRoleAdmin {
			for key := range body {
				if strings.HasPrefix(key, "relay_database_") || isObjectStorageCredentialKey(key) {
					util.WriteError(w, http.StatusForbidden, "仅管理员可以配置数据库或存储凭据")
					return
				}
			}
		}
		var nextRelayTokenReader *service.NewAPITokenReader
		if _, hasURL := body["relay_database_url"]; hasURL || body["relay_database_type"] != nil || body["relay_database_driver"] != nil || body["relay_database_host"] != nil || body["relay_database_name"] != nil {
			databaseURL := a.config.RelayDatabaseConnectionURLWithUpdate(body)
			databaseType := a.config.RelayDatabaseType()
			if value, ok := body["relay_database_type"]; ok {
				databaseType = strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
			}
			nextRelayTokenReader, err = service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{
				DatabaseURL: databaseURL, DatabaseType: databaseType,
			})
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("数据库连接配置无效: %v", err))
				return
			}
			if err := nextRelayTokenReader.ValidateConnection(r.Context()); err != nil {
				_ = nextRelayTokenReader.Close()
				util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("数据库连接失败: %v", err))
				return
			}
		}
		updated, err := a.config.Update(body)
		if err != nil {
			if nextRelayTokenReader != nil {
				_ = nextRelayTokenReader.Close()
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.storageFiles.RefreshCapacityScheduler(a.ctx); err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to refresh storage capacity scheduler")
			return
		}
		if nextRelayTokenReader != nil {
			a.swapRelayTokenReader(nextRelayTokenReader)
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) relayTokenReader() *service.NewAPITokenReader {
	if a == nil {
		return nil
	}
	a.newAPIKeysMu.RLock()
	defer a.newAPIKeysMu.RUnlock()
	return a.newAPIKeys
}

func (a *App) swapRelayTokenReader(reader *service.NewAPITokenReader) {
	a.newAPIKeysMu.Lock()
	if a.newAPIKeys != nil {
		a.retiredNewAPIKeys = append(a.retiredNewAPIKeys, a.newAPIKeys)
	}
	a.newAPIKeys = reader
	a.newAPIKeysMu.Unlock()
}

func (a *App) closeRelayTokenReaders() {
	a.newAPIKeysMu.Lock()
	readers := append(a.retiredNewAPIKeys, a.newAPIKeys)
	a.retiredNewAPIKeys = nil
	a.newAPIKeys = nil
	a.newAPIKeysMu.Unlock()
	for _, reader := range readers {
		if reader != nil {
			_ = reader.Close()
		}
	}
}

func isObjectStorageCredentialKey(key string) bool {
	return key == "storage"
}

func (a *App) settingsConfig(ctx context.Context, includeDatabaseCredentials bool) map[string]any {
	config := a.config.Get()
	if !includeDatabaseCredentials {
		for key := range config {
			if strings.HasPrefix(key, "relay_database_") && key != "relay_database_configured" {
				delete(config, key)
			}
		}
	}
	return config
}

func (a *App) handleModelConfig(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": a.modelConfig()})
}

func (a *App) modelConfig() map[string]any {
	imageModels := a.configuredImageModels()
	return map[string]any{
		"image_models":        imageModels,
		"default_image_model": a.defaultImageModel(),
		"video_models":        a.config.VideoModels(),
		"default_video_model": firstString(a.config.VideoModels(), defaultVideoModel),
		"text_models":         a.config.TextModels(),
		"default_text_model":  a.config.DefaultTextModel(),
		"audio_models":        a.config.AudioModels(),
		"default_audio_model": a.config.DefaultAudioModel(),
		"relay_base_url":      a.relayBaseURL(),
	}
}

func (a *App) configuredImageModels() []string {
	if a != nil && a.config != nil {
		return a.config.ImageModels()
	}
	return []string{util.ImageModelGPT}
}

func (a *App) configuredChatModels() []string {
	if a != nil && a.config != nil {
		return a.config.ChatModels()
	}
	return []string{util.ImageModelGPT55, util.ImageModelGPT54}
}

func (a *App) defaultImageModel() string {
	if a != nil && a.config != nil {
		for _, model := range a.config.ImageModels() {
			model = strings.TrimSpace(model)
			if model != "" && !strings.EqualFold(model, util.ImageModelAuto) {
				return model
			}
		}
	}
	return util.ImageModelGPT
}

func (a *App) defaultChatModel() string {
	if a != nil && a.config != nil {
		return a.config.DefaultChatModel()
	}
	return util.ImageModelGPT55
}

func (a *App) applyDefaultImageModel(body map[string]any) string {
	model := util.Clean(body["model"])
	if model == "" || strings.EqualFold(model, util.ImageModelAuto) {
		model = a.defaultImageModel()
		body["model"] = model
	}
	return model
}

func (a *App) handleAppMeta(w http.ResponseWriter, r *http.Request) {
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"app_title":                   a.config.AppTitle(),
		"project_name":                a.config.ProjectName(),
		"site_icon_url":               a.config.SiteIconURL(),
		"login_page_image_url":        a.config.LoginPageImageURL(),
		"login_page_image_mode":       a.config.LoginPageImageMode(),
		"login_page_image_zoom":       a.config.LoginPageImageZoom(),
		"login_page_image_position_x": a.config.LoginPageImagePositionX(),
		"login_page_image_position_y": a.config.LoginPageImagePositionY(),
	})
}

func (a *App) handleSiteIconSettings(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(maxSiteIconSize + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	currentIconURL := a.config.SiteIconURL()
	nextIconURL := currentIconURL
	uploadedIconURL := ""
	switch strings.ToLower(strings.TrimSpace(r.FormValue("site_icon_action"))) {
	case "remove":
		nextIconURL = ""
	case "replace":
		fileHeader := firstMultipartFile(r.MultipartForm, "site_icon_file")
		if fileHeader == nil {
			util.WriteError(w, http.StatusBadRequest, "site icon file is required")
			return
		}
		storedURL, err := a.storeSiteIcon(fileHeader)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		nextIconURL = storedURL
		uploadedIconURL = storedURL
	case "keep", "":
	default:
		util.WriteError(w, http.StatusBadRequest, "invalid site icon action")
		return
	}

	updated, err := a.config.Update(map[string]any{"site_icon_url": nextIconURL})
	if err != nil {
		if uploadedIconURL != "" {
			a.deleteLocalSiteIcon(uploadedIconURL)
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if currentIconURL != "" && currentIconURL != nextIconURL {
		a.deleteLocalSiteIcon(currentIconURL)
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
}

func (a *App) storeSiteIcon(header *multipart.FileHeader) (string, error) {
	data, ext, err := readSiteIconFile(header)
	if err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%d-site-icon%s", time.Now().UnixNano(), ext)
	target := filepath.Join(a.config.SiteIconsDir(), filename)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	return "/site-icons/" + filename, nil
}

func readSiteIconFile(header *multipart.FileHeader) ([]byte, string, error) {
	if header == nil {
		return nil, "", fmt.Errorf("site icon file is required")
	}
	if header.Size > maxSiteIconSize {
		return nil, "", fmt.Errorf("site icon cannot exceed 2MB")
	}
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSiteIconSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", fmt.Errorf("site icon file is empty")
	}
	if len(data) > maxSiteIconSize {
		return nil, "", fmt.Errorf("site icon cannot exceed 2MB")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return nil, "", fmt.Errorf("unsupported site icon file")
	}
	switch info.ContentType {
	case "image/jpeg":
		return data, ".jpg", nil
	case "image/gif":
		return data, ".gif", nil
	case "image/webp":
		return data, ".webp", nil
	case "image/png":
		return data, ".png", nil
	default:
		return nil, "", fmt.Errorf("site icon must be PNG, JPEG, WebP, or GIF")
	}
}

func (a *App) deleteLocalSiteIcon(iconURL string) {
	iconPath, ok := localUploadedFilePath(a.config.SiteIconsDir(), iconURL, "/site-icons/")
	if ok {
		_ = os.Remove(iconPath)
	}
}

func localUploadedFilePath(rootDir, fileURL, urlPrefix string) (string, bool) {
	cleanURL := strings.TrimSpace(fileURL)
	if !strings.HasPrefix(cleanURL, urlPrefix) {
		return "", false
	}
	rel := strings.TrimPrefix(path.Clean(cleanURL), urlPrefix)
	if rel == "." || rel == "" || strings.Contains(rel, "..") {
		return "", false
	}
	root, err := filepath.Abs(rootDir)
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return "", false
	}
	return target, true
}

func (a *App) handleLoginPageImageFile(w http.ResponseWriter, r *http.Request) {
	a.serveUploadedRasterFile(w, r, a.config.LoginPageImagesDir(), "/login-page-images/")
}

func (a *App) handleSiteIconFile(w http.ResponseWriter, r *http.Request) {
	a.serveUploadedRasterFile(w, r, a.config.SiteIconsDir(), "/site-icons/")
}

func (a *App) serveUploadedRasterFile(w http.ResponseWriter, r *http.Request, rootDir, urlPrefix string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	filePath, ok := localUploadedFilePath(rootDir, r.URL.Path, urlPrefix)
	if !ok || strings.EqualFold(filepath.Ext(filePath), ".svg") {
		http.NotFound(w, r)
		return
	}
	info, err := os.Lstat(filePath)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeFile(w, r, filePath)
}

func (a *App) handlePermissionCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	util.WriteJSON(w, http.StatusOK, a.auth.PermissionCatalog())
}

func (a *App) handleLoginPageImageSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(maxLoginPageImageSize + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	currentImageURL := a.config.LoginPageImageURL()
	nextImageURL := strings.TrimSpace(r.FormValue("login_page_image_url"))
	uploadedImageURL := ""
	switch strings.ToLower(strings.TrimSpace(r.FormValue("login_page_image_action"))) {
	case "remove":
		nextImageURL = ""
	case "replace":
		fileHeader := firstMultipartFile(r.MultipartForm, "login_page_image_file")
		if fileHeader == nil {
			util.WriteError(w, http.StatusBadRequest, "login page image file is required")
			return
		}
		storedURL, err := a.storeLoginPageImage(fileHeader)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		nextImageURL = storedURL
		uploadedImageURL = storedURL
	}

	updated, err := a.config.Update(map[string]any{
		"login_page_image_url":        nextImageURL,
		"login_page_image_mode":       strings.TrimSpace(r.FormValue("login_page_image_mode")),
		"login_page_image_zoom":       strings.TrimSpace(r.FormValue("login_page_image_zoom")),
		"login_page_image_position_x": strings.TrimSpace(r.FormValue("login_page_image_position_x")),
		"login_page_image_position_y": strings.TrimSpace(r.FormValue("login_page_image_position_y")),
	})
	if err != nil {
		if uploadedImageURL != "" {
			a.deleteLocalLoginPageImage(uploadedImageURL)
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if currentImageURL != "" && currentImageURL != nextImageURL {
		a.deleteLocalLoginPageImage(currentImageURL)
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
}

func (a *App) storeLoginPageImage(header *multipart.FileHeader) (string, error) {
	data, ext, err := readLoginPageImageFile(header)
	if err != nil {
		return "", err
	}
	stem := safeUploadStem(header.Filename)
	if stem == "" {
		stem = "login-page"
	}
	filename := fmt.Sprintf("%d-%s%s", time.Now().UnixNano(), stem, ext)
	target := filepath.Join(a.config.LoginPageImagesDir(), filename)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	return "/login-page-images/" + filename, nil
}

func readLoginPageImageFile(header *multipart.FileHeader) ([]byte, string, error) {
	if header == nil {
		return nil, "", fmt.Errorf("image file is required")
	}
	if header.Size > maxLoginPageImageSize {
		return nil, "", fmt.Errorf("login page image cannot exceed 10MB")
	}
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxLoginPageImageSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", fmt.Errorf("image file is empty")
	}
	if len(data) > maxLoginPageImageSize {
		return nil, "", fmt.Errorf("login page image cannot exceed 10MB")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return nil, "", fmt.Errorf("unsupported image file")
	}
	switch info.ContentType {
	case "image/jpeg":
		return data, ".jpg", nil
	case "image/gif":
		return data, ".gif", nil
	case "image/webp":
		return data, ".webp", nil
	default:
		return data, ".png", nil
	}
}

func (a *App) deleteLocalLoginPageImage(imageURL string) {
	imagePath, ok := a.localLoginPageImagePath(imageURL)
	if ok {
		_ = os.Remove(imagePath)
	}
}

func (a *App) localLoginPageImagePath(imageURL string) (string, bool) {
	return localUploadedFilePath(a.config.LoginPageImagesDir(), imageURL, "/login-page-images/")
}

func firstMultipartFile(form *multipart.Form, key string) *multipart.FileHeader {
	if form == nil || len(form.File[key]) == 0 {
		return nil
	}
	return form.File[key][0]
}

func safeUploadStem(filename string) string {
	name := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	name = strings.ToLower(strings.TrimSpace(name))
	var builder strings.Builder
	for _, char := range name {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char)
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '-' || char == '_':
			builder.WriteRune(char)
		case char == ' ' || char == '.':
			builder.WriteRune('-')
		}
	}
	return strings.Trim(builder.String(), "-_")
}

func (a *App) handleImages(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		scope, status, message := imageListAccessScope(identity, r.URL.Query().Get("scope"))
		if status != 0 {
			util.WriteError(w, status, message)
			return
		}
		payload := a.images.ListImages(a.resolveImageBaseURL(r), strings.TrimSpace(r.URL.Query().Get("start_date")), strings.TrimSpace(r.URL.Query().Get("end_date")), scope)
		a.decorateImageList(payload)
		util.WriteJSON(w, http.StatusOK, payload)
	case http.MethodDelete:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		scope := service.ImageAccessScope{OwnerID: identityScope(identity)}
		if identity.Role == service.AuthRoleAdmin {
			scope = service.ImageAccessScope{All: true}
		}
		result, err := a.images.DeleteImages(util.AsStringSlice(body["paths"]), scope)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, result)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleImageVisibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	body, err := readJSONMap(r)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	path := util.Clean(body["path"])
	if path == "" {
		util.WriteError(w, http.StatusBadRequest, "path is required")
		return
	}
	visibility := util.Clean(body["visibility"])
	if _, err := service.NormalizeImageVisibility(visibility); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if isAbsoluteHTTPURL(path) && !isManagedImageVisibilityPath(path) {
		util.WriteError(w, http.StatusBadRequest, "external image URLs cannot be imported")
		return
	}
	if a.shouldImportVisibilityImage(path) {
		localURL, _, _, importErr := a.localizeRelayImageItem(r.Context(), identityScope(identity), identityDisplayName(identity), map[string]any{"url": path}, nil)
		if importErr != nil || localURL == "" {
			if importErr == nil {
				importErr = errors.New("image import failed")
			}
			util.WriteError(w, http.StatusBadRequest, "同步图片到图库失败: "+importErr.Error())
			return
		}
		path = localURL
		a.images.EnsureThumbnails([]string{localURL})
	}
	sharePromptParams := util.ToBool(body["share_prompt_parameters"])
	shareReferences := sharePromptParams && util.ToBool(body["share_reference_images"])
	scope := service.ImageAccessScope{OwnerID: identityScope(identity)}
	if identity.Role == service.AuthRoleAdmin {
		scope = service.ImageAccessScope{All: true}
	}
	item, err := a.images.UpdateImageVisibility(path, visibility, scope, service.ImageVisibilityUpdateOptions{
		SharePromptParams: sharePromptParams,
		ShareReferences:   shareReferences,
	})
	if err != nil {
		status := http.StatusBadRequest
		if err.Error() == "image not found" {
			status = http.StatusNotFound
		}
		util.WriteError(w, status, err.Error())
		return
	}
	a.decorateImageItem(item, a.imageOwnerDisplayNames())
	util.WriteJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) handleImageFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rel, err := imageFileRequestPath(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ref, ok := a.authorizeImageFileRequest(w, r, rel)
	if !ok {
		return
	}
	setRasterResponseSecurityHeaders(w)
	http.ServeFile(w, r, ref.Path)
}

func (a *App) handleVideoFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/videos/")
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.videoDir, name)
	if filepath.Dir(path) != filepath.Clean(a.videoDir) {
		http.NotFound(w, r)
		return
	}
	contentType := "video/mp4"
	if strings.EqualFold(filepath.Ext(name), ".webm") {
		contentType = "video/webm"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, path)
}

func (a *App) handleImageReferenceFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rel, err := imageReferenceFileRequestPath(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ref, err := a.images.ImageReferenceFileAccess(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	setRasterResponseSecurityHeaders(w)
	if ref.Visibility == service.ImageVisibilityPublic && ref.Shared {
		if ref.ContentType != "" {
			w.Header().Set("Content-Type", ref.ContentType)
		}
		http.ServeFile(w, r, ref.Path)
		return
	}
	identity, ok := a.imageRequestIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin && (ref.OwnerID == "" || ref.OwnerID != identityScope(identity)) {
		http.NotFound(w, r)
		return
	}
	if ref.ContentType != "" {
		w.Header().Set("Content-Type", ref.ContentType)
	}
	http.ServeFile(w, r, ref.Path)
}

func setRasterResponseSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
}

func (a *App) authorizeImageFileRequest(w http.ResponseWriter, r *http.Request, rel string) (service.ImageFileAccess, bool) {
	ref, err := a.images.ImageFileAccess(rel, service.ImageAccessScope{All: true})
	if err != nil {
		http.NotFound(w, r)
		return service.ImageFileAccess{}, false
	}
	if ref.Visibility == service.ImageVisibilityPublic {
		return ref, true
	}
	identity, ok := a.imageRequestIdentity(w, r)
	if !ok {
		return service.ImageFileAccess{}, false
	}
	if identity.Role == service.AuthRoleAdmin || (ref.OwnerID != "" && ref.OwnerID == identityScope(identity)) {
		return ref, true
	}
	http.NotFound(w, r)
	return service.ImageFileAccess{}, false
}

func (a *App) handleImageThumbnail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	thumbnailRel, err := imageThumbnailRequestPath(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	sourceRel, sourceErr := a.images.SourceImageRelativePathFromThumbnail(thumbnailRel)
	if sourceErr != nil {
		http.NotFound(w, r)
		return
	}
	if _, ok := a.authorizeImageFileRequest(w, r, sourceRel); !ok {
		return
	}
	_ = a.images.EnsureThumbnail(thumbnailRel)
	thumbPath := filepath.Join(a.config.ImageThumbnailsDir(), filepath.FromSlash(thumbnailRel))
	if info, err := os.Stat(thumbPath); err == nil && !info.IsDir() {
		w.Header().Set("Cache-Control", imageThumbnailCacheControl)
		http.ServeFile(w, r, thumbPath)
		return
	}
	if data, contentType, err := a.images.ImageBytes(sourceRel, service.ImageAccessScope{All: true}); err == nil {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
		return
	}
	http.NotFound(w, r)
}

func imageFileRequestPath(r *http.Request) (string, error) {
	raw := strings.TrimPrefix(r.URL.EscapedPath(), "/images/")
	if raw == "" || raw == r.URL.EscapedPath() {
		return "", errors.New("invalid image path")
	}
	rel, err := url.PathUnescape(raw)
	if err != nil {
		return "", err
	}
	return rel, nil
}

func imageReferenceFileRequestPath(r *http.Request) (string, error) {
	raw := strings.TrimPrefix(r.URL.EscapedPath(), "/image-references/")
	if raw == "" || raw == r.URL.EscapedPath() {
		return "", errors.New("invalid image path")
	}
	rel, err := url.PathUnescape(raw)
	if err != nil {
		return "", err
	}
	return rel, nil
}

func imageThumbnailRequestPath(r *http.Request) (string, error) {
	raw := strings.TrimPrefix(r.URL.EscapedPath(), "/image-thumbnails/")
	if raw == "" || raw == r.URL.EscapedPath() {
		return "", errors.New("invalid thumbnail path")
	}
	rel, err := url.PathUnescape(raw)
	if err != nil {
		return "", err
	}
	return rel, nil
}

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	query, err := parseLogQuery(r)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if query.View == "" {
		query.View = a.config.DefaultLogView()
	}
	query.View = service.NormalizeLogView(query.View, a.config.DefaultLogView())
	items := a.logs.Search(query)
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items), "page_size": normalizedHTTPLogPageSize(query.Limit), "view": query.View})
}

func (a *App) handleLogGovernance(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"governance": a.logs.GovernanceSummary()})
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		retentionDays := util.ToInt(body["retention_days"], a.config.LogRetentionDays())
		result, err := a.logs.CleanupOlderThan(retentionDays)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"cleanup":    result,
			"governance": a.logs.GovernanceSummary(),
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleImageStorageGovernance(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"governance": a.imageStorageGovernance(identity)})
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		action := strings.TrimSpace(util.Clean(body["action"]))
		options := service.ImageStorageCleanupOptions{
			IncludePublic: util.ToBool(body["include_public"]),
		}
		switch action {
		case "retention":
			options.RetentionDays = util.ToInt(body["retention_days"], a.config.ImageRetentionDays())
		case "quota":
			options.MaxBytes = imageCleanupMaxBytes(body["max_bytes"], body["max_mb"], a.config.ImageStorageLimitBytes())
		case "thumbnails":
			options.ClearThumbnails = true
		case "all":
			options.RetentionDays = util.ToInt(body["retention_days"], a.config.ImageRetentionDays())
			options.MaxBytes = imageCleanupMaxBytes(body["max_bytes"], body["max_mb"], a.config.ImageStorageLimitBytes())
			options.ClearThumbnails = util.ToBool(body["clear_thumbnails"])
		default:
			util.WriteError(w, http.StatusBadRequest, "action must be retention, quota, thumbnails, or all")
			return
		}
		result, err := a.cleanupImageStorageWithOptions(options)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"cleanup":    result,
			"governance": a.imageStorageGovernance(identity),
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func imageCleanupMaxBytes(rawBytes, rawMB any, fallback int64) int64 {
	if n := int64(util.ToInt(rawBytes, 0)); n > 0 {
		return n
	}
	if mb := util.ToInt(rawMB, 0); mb > 0 {
		return int64(mb) * 1024 * 1024
	}
	return fallback
}

func (a *App) cleanupImageStorageWithOptions(options service.ImageStorageCleanupOptions) (service.ImageStorageCleanupResult, error) {
	assetCleanup := service.ImageConversationAssetGovernance{}
	if a.conversationAssets != nil && options.RetentionDays > 0 {
		var err error
		assetCleanup, err = a.conversationAssets.CleanupExpired(options.RetentionDays)
		if err != nil {
			return service.ImageStorageCleanupResult{}, err
		}
	}

	galleryOptions := options
	if galleryOptions.MaxBytes > 0 && a.conversationAssets != nil {
		galleryOptions.MaxBytes = imageStorageLimitAvailableForGallery(galleryOptions.MaxBytes, a.conversationAssets.Governance().TotalBytes)
	}
	result, err := a.images.CleanupStorage(galleryOptions)
	if err != nil {
		return result, err
	}
	result.MaxBytes = options.MaxBytes

	if a.conversationAssets != nil && options.MaxBytes > 0 {
		assetAllowance := options.MaxBytes - result.RemainingBytes
		if assetAllowance < 0 {
			assetAllowance = 0
		}
		quotaCleanup, cleanupErr := a.conversationAssets.CleanupToMaxBytes(assetAllowance)
		if cleanupErr != nil {
			return result, cleanupErr
		}
		assetCleanup.DeletedBytes += quotaCleanup.DeletedBytes
		assetCleanup.DeletedCount += quotaCleanup.DeletedCount
	}
	assets := service.ImageConversationAssetGovernance{}
	if a.conversationAssets != nil {
		assets = a.conversationAssets.Governance()
	}
	result.DeletedConversationAssets = assetCleanup.DeletedCount
	result.DeletedBytes += assetCleanup.DeletedBytes
	result.RemainingBytes += assets.TotalBytes
	result.OverLimitBytes = 0
	if options.MaxBytes > 0 && result.RemainingBytes > options.MaxBytes {
		result.OverLimitBytes = result.RemainingBytes - options.MaxBytes
	}
	return result, nil
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
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	body, _ := readJSONMap(r)
	candidate := strings.TrimSpace(util.Clean(body["url"]))
	if candidate == "" {
		candidate = a.config.Proxy()
	}
	if candidate == "" {
		util.WriteError(w, http.StatusBadRequest, "proxy url is required")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"result": a.proxy.Test(candidate, 15*time.Second)})
}

func (a *App) requireIdentity(w http.ResponseWriter, r *http.Request) (service.Identity, bool) {
	token := requestAuthCookieToken(r)
	if identity := a.auth.Authenticate(token); identity != nil {
		if !a.identityCanAccessRequest(*identity, r) {
			util.WriteError(w, http.StatusForbidden, "permission denied")
			return service.Identity{}, false
		}
		*r = *r.WithContext(withRequestIdentity(r.Context(), *identity))
		return *identity, true
	}
	util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
	return service.Identity{}, false
}

func requestAuthCookieToken(r *http.Request) string {
	cookie, err := r.Cookie(authSessionCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func (a *App) imageRequestIdentity(w http.ResponseWriter, r *http.Request) (service.Identity, bool) {
	token := requestAuthCookieToken(r)
	if token == "" {
		util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
		return service.Identity{}, false
	}
	if identity := a.auth.Authenticate(token); identity != nil {
		return *identity, true
	}
	util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
	return service.Identity{}, false
}

func (a *App) identityPermissions(identity service.Identity) service.PermissionSet {
	if identity.Role == service.AuthRoleAdmin {
		return service.DefaultPermissionSetForRole(service.AuthRoleAdmin)
	}
	return service.PermissionSet{
		MenuPaths:      service.NormalizeMenuPermissions(identity.MenuPaths),
		APIPermissions: service.NormalizeAPIPermissions(identity.APIPermissions),
	}
}

func (a *App) identityCanAccessRequest(identity service.Identity, r *http.Request) bool {
	if identity.Role == service.AuthRoleAdmin || isPermissionCheckSkipped(r.Method, r.URL.Path) {
		return true
	}
	return a.identityCanAccessAPI(identity, r.Method, r.URL.Path)
}

func (a *App) identityCanAccessAPI(identity service.Identity, method, path string) bool {
	if identity.Role == service.AuthRoleAdmin {
		return true
	}
	return service.HasAPIPermission(a.identityPermissions(identity), method, path)
}

func isPermissionCheckSkipped(method, path string) bool {
	switch path {
	case "/auth/login":
		return true
	case "/auth/logout":
		return true
	case "/auth/session":
		return true
	case "/api/profile/relay-key":
		return true
	case "/api/profile/balance":
		return true
	case "/api/model-config":
		return true
	case "/api/storage/config":
		return true
	case "/api/announcements":
		return true
	case "/api/profile/announcement-preferences":
		return true
	case "/api/profile/image-generation-preferences":
		return true
	case "/api/profile/storage-provider":
		return true
	case "/api/profile/storage-provider/measure":
		return true
	case "/api/profile/upstream-models":
		return true
	case "/api/profile/prompt-favorites":
		return true
	case "/api/profile/assets":
		return true
	case "/api/profile/image-conversations":
		return true
	default:
		return strings.HasPrefix(path, "/api/profile/prompt-favorites/") ||
			strings.HasPrefix(path, "/api/profile/image-conversations/") ||
			(method == http.MethodGet || method == http.MethodHead) && strings.HasPrefix(path, "/api/files/")
	}
}

func isHTTPSRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")))
	return proto == "https"
}

func setAuthSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	token = strings.TrimSpace(token)
	if token == "" {
		return
	}
	setAuthSessionCookieValue(w, r, token, int(service.AuthSessionLifetime/time.Second))
}

func setAuthSessionCookieValue(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	cookie := &http.Cookie{
		Name:     authSessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		SameSite: http.SameSiteLaxMode,
	}
	http.SetCookie(w, cookie)
}

func clearAuthSessionCookie(w http.ResponseWriter, r *http.Request) {
	setAuthSessionCookieValue(w, r, "", -1)
}

func (a *App) resolveImageBaseURL(_ *http.Request) string {
	return a.config.BaseURL()
}

func readJSONMap(r *http.Request) (map[string]any, error) {
	var body map[string]any
	err := util.DecodeJSON(r.Body, &body)
	if body == nil {
		body = map[string]any{}
	}
	return body, err
}

func readMultipartImageBody(w http.ResponseWriter, r *http.Request) (map[string]any, []protocol.UploadedImage, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayImageEditRequestBytes)
	if err := r.ParseMultipartForm(maxRelayImageMultipartMemory); err != nil {
		return nil, nil, err
	}
	defer r.MultipartForm.RemoveAll()
	body := map[string]any{
		"client_task_id":          firstForm(r.MultipartForm, "client_task_id"),
		"prompt":                  firstForm(r.MultipartForm, "prompt"),
		"model":                   firstForm(r.MultipartForm, "model"),
		"n":                       firstForm(r.MultipartForm, "n"),
		"size":                    firstForm(r.MultipartForm, "size"),
		"requested_size":          firstForm(r.MultipartForm, "requested_size"),
		"image_resolution":        firstForm(r.MultipartForm, "image_resolution"),
		"quality":                 firstForm(r.MultipartForm, "quality"),
		"moderation":              firstForm(r.MultipartForm, "moderation"),
		"input_image_mask":        firstForm(r.MultipartForm, "input_image_mask"),
		"output_format":           firstForm(r.MultipartForm, "output_format"),
		"output_compression":      firstForm(r.MultipartForm, "output_compression"),
		"stream":                  firstForm(r.MultipartForm, "stream"),
		"partial_images":          firstForm(r.MultipartForm, "partial_images"),
		"share_prompt_parameters": firstForm(r.MultipartForm, "share_prompt_parameters"),
		"share_reference_images":  firstForm(r.MultipartForm, "share_reference_images"),
		"visibility":              firstForm(r.MultipartForm, "visibility"),
		"token_group":             firstForm(r.MultipartForm, "token_group"),
		"token_name":              firstForm(r.MultipartForm, "token_name"),
		"api_key":                 firstForm(r.MultipartForm, "api_key"),
		"response_format":         firstForm(r.MultipartForm, "response_format"),
	}
	maskHeaders := r.MultipartForm.File["mask"]
	if len(maskHeaders) > 1 {
		return nil, nil, errTooManyRelayMasks
	}
	if len(maskHeaders) == 1 {
		if strings.TrimSpace(util.Clean(body["input_image_mask"])) != "" {
			return nil, nil, errors.New("provide either mask or input_image_mask, not both")
		}
		mask, err := readUpload(maskHeaders[0])
		if err != nil {
			return nil, nil, err
		}
		body["input_image_mask"] = uploadedImageDataURL(mask)
	}
	if rawFallback := strings.TrimSpace(firstForm(r.MultipartForm, "fallback_reference_image")); rawFallback != "" {
		var fallback any
		if err := json.Unmarshal([]byte(rawFallback), &fallback); err != nil {
			return nil, nil, fmt.Errorf("invalid fallback_reference_image")
		}
		body["fallback_reference_image"] = fallback
	}
	if rawContext := strings.TrimSpace(firstForm(r.MultipartForm, "workflow_context")); rawContext != "" {
		var workflowContext map[string]any
		if err := json.Unmarshal([]byte(rawContext), &workflowContext); err != nil {
			return nil, nil, fmt.Errorf("invalid workflow_context")
		}
		body["workflow_context"] = workflowContext
	}
	headers := multipartImageFileHeaders(r.MultipartForm)
	images := make([]protocol.UploadedImage, 0, len(headers))
	for _, header := range headers {
		image, err := readUpload(header)
		if err != nil {
			return nil, nil, err
		}
		if len(image.Data) == 0 {
			return nil, nil, fmt.Errorf("image file is empty")
		}
		images = append(images, image)
	}
	return body, images, nil
}

func uploadedImageDataURL(image protocol.UploadedImage) string {
	if len(image.Data) == 0 {
		return ""
	}
	contentType := normalizeUploadedImageContentType(image.ContentType)
	if contentType == "" {
		contentType = "image/png"
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(image.Data)
}

func multipartImageFileHeaders(form *multipart.Form) []*multipart.FileHeader {
	if form == nil {
		return nil
	}
	headers := make([]*multipart.FileHeader, 0)
	for _, field := range []string{"image", "image[]"} {
		headers = append(headers, form.File[field]...)
	}
	return headers
}

func firstForm(form *multipart.Form, key string) string {
	if form == nil || len(form.Value[key]) == 0 {
		return ""
	}
	return form.Value[key][0]
}

func readUpload(header *multipart.FileHeader) (protocol.UploadedImage, error) {
	file, err := header.Open()
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	defer file.Close()
	data, err := readLimitedUploadData(file, maxRelayImageBytes)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	contentType, err := uploadedImageContentType(data)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	filename := header.Filename
	if filename == "" {
		filename = "image.png"
	}
	return protocol.UploadedImage{Data: data, Filename: filename, ContentType: contentType}, nil
}

func readLimitedUploadData(reader io.Reader, maxBytes int64) ([]byte, error) {
	if reader == nil || maxBytes < 1 {
		return nil, errUnsupportedRelayImage
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errRelayImageTooLarge
	}
	return data, nil
}

func uploadedImageContentType(data []byte) (string, error) {
	if len(data) == 0 {
		return "", fmt.Errorf("image file is empty")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return "", errUnsupportedRelayImage
	}
	return info.ContentType, nil
}

func writeMultipartImageBodyError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) || errors.Is(err, errRelayImageTooLarge) {
		status = http.StatusRequestEntityTooLarge
	}
	util.WriteError(w, status, err.Error())
}

func normalizeUploadedImageContentType(contentType string) string {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return contentType
	default:
		return ""
	}
}

func jsonString(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func openAIErrorForStream(err error) map[string]any {
	var imageErr *protocol.ImageGenerationError
	if errors.As(err, &imageErr) {
		return imageErr.OpenAIError()
	}
	return map[string]any{"error": map[string]any{"message": err.Error(), "type": fmt.Sprintf("%T", err)}}
}

func (a *App) logCall(ctx context.Context, identity service.Identity, summary, method, endpoint, model string, started time.Time, outcome string, status int, errText string, urls []string, requestCapture auditRequestCapture) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if status <= 0 {
		status = http.StatusOK
		if outcome == "failed" {
			status = http.StatusInternalServerError
		}
	}
	ended := time.Now()
	detail := map[string]any{
		"method":         method,
		"path":           endpoint,
		"endpoint":       endpoint,
		"module":         inferAuditModule(endpoint),
		"model":          model,
		"started_at":     started.Format("2006-01-02 15:04:05"),
		"ended_at":       ended.Format("2006-01-02 15:04:05"),
		"duration_ms":    ended.Sub(started).Milliseconds(),
		"status":         status,
		"outcome":        outcome,
		"operation_type": operationTypeForMethod(method),
		"log_level":      logLevelForStatus(status),
	}
	addIdentityLogDetail(detail, identity)
	if name := identityDisplayName(identity); name != "" {
		detail["username"] = name
	}
	if usedAccounts := protocol.AccountUsageFromContext(ctx); len(usedAccounts) > 0 {
		detail["upstream_accounts"] = usedAccounts
		if len(usedAccounts) == 1 {
			detail["upstream_account_id"] = usedAccounts[0]["account_id"]
			detail["upstream_token_preview"] = usedAccounts[0]["token_preview"]
		}
	}
	if errText != "" {
		detail["error"] = errText
	}
	if len(urls) > 0 {
		detail["urls"] = dedupe(urls)
	}
	addAuditRequestDetail(detail, requestCapture)
	suffix := "调用完成"
	if outcome == "failed" {
		suffix = "调用失败"
	}
	a.logs.Add(summary+suffix, detail)
}

func addIdentityLogDetail(detail map[string]any, identity service.Identity) {
	kind := util.Clean(identity.Kind)
	if kind != "" {
		detail["auth_kind"] = kind
	}
	credentialName := util.Clean(identity.CredentialName)
	if identity.Kind == service.AuthKindSession {
		if credentialName != "" {
			detail["session_name"] = credentialName
		}
	} else if name := util.Clean(firstNonEmpty(identity.CredentialName, identity.Name)); name != "" {
		detail["key_name"] = name
	}
	if role := util.Clean(identity.Role); role != "" {
		detail["key_role"] = role
	}
	if id := util.Clean(firstNonEmpty(identity.CredentialID, identity.ID)); id != "" {
		detail["key_id"] = id
	}
	if id := util.Clean(identity.ID); id != "" && id != util.Clean(identity.CredentialID) {
		detail["subject_id"] = id
	}
	if provider := util.Clean(identity.Provider); provider != "" {
		detail["provider"] = provider
	}
}

func payloadAuditCapture(payload map[string]any) auditRequestCapture {
	args := cleanAuditPayloadMap(payload)
	if len(args) == 0 {
		return auditRequestCapture{}
	}
	return auditRequestCapture{args: service.SanitizeLogValue(args)}
}

func cleanAuditPayloadMap(payload map[string]any) map[string]any {
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		switch key {
		case "owner_id", "owner_name", "base_url":
			continue
		}
		if isInternalPayloadValue(value) {
			continue
		}
		out[key] = cleanAuditPayloadValue(value)
	}
	return out
}

func cleanAuditPayloadValue(value any) any {
	switch x := value.(type) {
	case []protocol.UploadedImage:
		items := make([]map[string]any, 0, len(x))
		for _, image := range x {
			items = append(items, map[string]any{
				"filename":     image.Filename,
				"content_type": image.ContentType,
				"size_bytes":   len(image.Data),
			})
		}
		return items
	case protocol.UploadedImage:
		return map[string]any{
			"filename":     x.Filename,
			"content_type": x.ContentType,
			"size_bytes":   len(x.Data),
		}
	default:
		return value
	}
}

func isInternalPayloadValue(value any) bool {
	if value == nil {
		return false
	}
	switch value.(type) {
	case func(context.Context, int) (func(), error), func([]map[string]any), func(string):
		return true
	default:
		return false
	}
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
	case "all":
		if identity.Role != service.AuthRoleAdmin {
			return service.ImageAccessScope{}, http.StatusForbidden, "admin permission required"
		}
		return service.ImageAccessScope{All: true}, 0, ""
	default:
		return service.ImageAccessScope{}, http.StatusBadRequest, "scope must be mine, public, or all"
	}
}

func (a *App) recordGeneratedImages(identity service.Identity, urls []string, visibility string) error {
	if len(urls) == 0 || a.images == nil {
		return nil
	}
	ownerID := identityScope(identity)
	err := a.images.RecordGeneratedImageMetadata(urls, ownerID, identityDisplayName(identity), visibility)
	a.scheduleImageStorageCleanup()
	return err
}

func (a *App) recordProtocolGeneratedImages(identity service.Identity, urls []string, visibility string, payloads ...map[string]any) error {
	if len(payloads) > 0 && payloads[0] != nil {
		return a.recordGeneratedImagesForPayload(identity, urls, visibility, payloads[0])
	}
	return a.recordGeneratedImages(identity, urls, visibility)
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

func (a *App) startImageStorageCleaner(ctx context.Context, interval time.Duration) {
	if a == nil || a.images == nil {
		return
	}
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
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
	a.imageCleanup.schedule(a.cleanupImageStorage)
}

func (a *App) closeImageStorageCleaner() {
	if a == nil {
		return
	}
	a.imageCleanup.close()
}

func (a *App) cleanupImageStorage() {
	if a == nil || a.images == nil || a.config == nil {
		return
	}
	_, _ = a.cleanupImageStorageWithOptions(service.ImageStorageCleanupOptions{
		RetentionDays: a.config.ImageRetentionDays(),
		MaxBytes:      a.config.ImageStorageLimitBytes(),
	})
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

func (a *App) runLoggedImageTask(ctx context.Context, identity service.Identity, payload map[string]any, endpoint, summary string, run func(context.Context, map[string]any) (map[string]any, error)) (map[string]any, error) {
	start := time.Now()
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	model := firstNonEmpty(util.Clean(payload["model"]), a.defaultImageModel())
	if util.Clean(payload["model"]) == "" {
		payload["model"] = model
	}
	if err := validateRelayImageRequest(endpoint, model, payload, uploadedImagesFromPayload(payload["images"])); err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, payloadAuditCapture(payload))
		return nil, err
	}
	if util.Clean(payload["api_mode"]) == "" || util.Clean(payload["api_mode"]) == "images" {
		normalizeImagePayloadForModel(payload)
	}
	requestCapture := payloadAuditCapture(payload)
	managedSlot := relayImageOutputSlotAcquirer(payload) != nil
	release, err := relayAcquireImageTaskSlot(ctx, payload)
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return nil, err
	}
	if managedSlot {
		payload[relayImageTaskSlotManagedPayloadKey] = relayImageTaskSlotManagedMarker{}
		payload[service.ImageOutputCompletionReleasePayloadKey] = release
		defer delete(payload, relayImageTaskSlotManagedPayloadKey)
	}
	result, err := run(ctx, payload)
	if result != nil {
		if localizeErr := a.localizeRelayImageResult(ctx, identity, result, payload); localizeErr != nil {
			if err == nil {
				err = localizeErr
			} else {
				err = errors.Join(err, localizeErr)
			}
		}
	}
	urls := collectURLs(result)
	if recordErr := a.recordGeneratedImagesForPayload(identity, urls, util.Clean(payload["visibility"]), payload); recordErr != nil {
		persistErr := imageMetadataPersistenceError(recordErr)
		if err == nil {
			err = persistErr
		} else {
			err = errors.Join(err, persistErr)
		}
	}
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, requestCapture)
		return result, err
	}
	if len(util.AsMapSlice(result["data"])) == 0 {
		message := firstNonEmpty(util.Clean(result["message"]), "图片任务没有返回图片数据，请检查上游返回、模型参数和日志详情")
		result["message"] = message
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", http.StatusBadGateway, message, urls, requestCapture)
		return result, protocol.HTTPError{Status: http.StatusBadGateway, Message: message}
	}
	a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "success", http.StatusOK, "", urls, requestCapture)
	return result, nil
}

func (a *App) localizeRelayImageResult(ctx context.Context, identity service.Identity, result map[string]any, payload map[string]any) error {
	if a == nil || a.engine == nil || result == nil {
		return nil
	}
	items := util.AsMapSlice(result["data"])
	if len(items) == 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	localizeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), relayImageLocalizationTimeout)
	defer cancel()
	ownerID := identityScope(identity)
	ownerName := identityDisplayName(identity)
	changed := false
	for _, item := range items {
		if item == nil {
			continue
		}
		localURL, outputFormat, qualityCheck, err := a.localizeRelayImageItem(localizeCtx, ownerID, ownerName, item, payload)
		if err != nil {
			return err
		}
		if localURL == "" {
			continue
		}
		item["url"] = localURL
		delete(item, "b64_json")
		if outputFormat != "" {
			item["output_format"] = outputFormat
		}
		for key, value := range qualityCheck {
			item[key] = value
		}
		changed = true
	}
	if changed {
		result["data"] = items
	}
	return nil
}

func (a *App) localizeRelayImageStream(ctx context.Context, payload map[string]any, stream *protocol.StreamResult) *protocol.StreamResult {
	if a == nil || stream == nil {
		return stream
	}
	items := make(chan map[string]any)
	errorsOut := make(chan error, 1)
	go func() {
		defer close(items)
		defer close(errorsOut)
		ownerID := strings.TrimSpace(util.Clean(payload["owner_id"]))
		ownerName := strings.TrimSpace(util.Clean(payload["owner_name"]))
	streamItems:
		for {
			var item map[string]any
			var ok bool
			select {
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errorsOut <- ctx.Err()
				return
			case item, ok = <-stream.Items:
				if !ok {
					break streamItems
				}
			}
			if err := ctx.Err(); err != nil {
				go drainProtocolStream(stream)
				errorsOut <- err
				return
			}
			if item == nil || !isRelayImageCompletedEvent(item) || isRelayImagePartialEvent(item) {
				select {
				case <-ctx.Done():
					go drainProtocolStream(stream)
					errorsOut <- ctx.Err()
					return
				case items <- item:
				}
				continue
			}
			localized, err := a.localizeRelayImageStreamItem(ctx, ownerID, ownerName, item, payload)
			if err != nil {
				errorsOut <- err
				go drainProtocolStream(stream)
				return
			}
			select {
			case <-ctx.Done():
				go drainProtocolStream(stream)
				errorsOut <- ctx.Err()
				return
			case items <- localized:
			}
		}
		select {
		case err := <-stream.Err:
			errorsOut <- err
		case <-ctx.Done():
			go drainProtocolStream(stream)
			errorsOut <- ctx.Err()
		}
	}()
	return &protocol.StreamResult{Items: items, Err: errorsOut, Kind: stream.Kind}
}

func (a *App) localizeRelayImageStreamItem(ctx context.Context, ownerID, ownerName string, event, payload map[string]any) (map[string]any, error) {
	data := relayImageStreamItemData(event)
	if len(data) == 0 {
		return event, nil
	}
	localized := make([]map[string]any, 0, len(data))
	for _, imageItem := range data {
		next := util.CopyMap(imageItem)
		localURL, outputFormat, qualityCheck, err := a.localizeRelayImageItem(ctx, ownerID, ownerName, next, payload)
		if err != nil {
			return nil, err
		}
		if localURL != "" {
			next["url"] = localURL
			delete(next, "b64_json")
		}
		if outputFormat != "" {
			next["output_format"] = outputFormat
		}
		for key, value := range qualityCheck {
			next[key] = value
		}
		localized = append(localized, next)
	}
	out := util.CopyMap(event)
	if _, exists := event["data"]; exists || len(localized) != 1 {
		out["data"] = localized
		delete(out, "url")
		delete(out, "b64_json")
		return out, nil
	}
	for _, key := range []string{"url", "b64_json", "revised_prompt", "output_format", "requested_size", "actual_size", "quality_warning"} {
		delete(out, key)
		if value, ok := localized[0][key]; ok {
			out[key] = value
		}
	}
	return out, nil
}

func drainProtocolStream(stream *protocol.StreamResult) {
	if stream == nil {
		return
	}
	for range stream.Items {
	}
	<-stream.Err
}

func (a *App) localizeRelayImageItem(ctx context.Context, ownerID, ownerName string, item map[string]any, payload map[string]any) (string, string, map[string]any, error) {
	if a.isLocalImageURL(util.Clean(item["url"])) {
		return "", "", nil, nil
	}
	data, contentType, err := relayImageItemBytes(ctx, a, item)
	if err != nil || len(data) == 0 {
		return "", "", nil, err
	}
	outputFormat := relayStoredImageFormat(item, payload, contentType, util.Clean(item["url"]), data)
	qualityCheck := relayImageQualityCheck(data, outputFormat, payload)
	url, err := a.engine.SaveImageBytesForOwnerWithFormatE(ctx, data, "", ownerID, ownerName, outputFormat)
	return url, outputFormat, qualityCheck, err
}

func relayImageItemBytes(ctx context.Context, app *App, item map[string]any) ([]byte, string, error) {
	if b64 := util.Clean(item["b64_json"]); b64 != "" {
		if len(b64) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
			return nil, "", errors.New("image is too large")
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
		if err != nil {
			if decoded, fallbackErr := util.B64Decode(b64); fallbackErr == nil {
				info, inspectErr := util.InspectRasterImage(decoded, "image/png", "image/jpeg", "image/webp")
				if inspectErr != nil {
					return nil, "", inspectErr
				}
				return decoded, info.ContentType, nil
			}
			return nil, "", err
		}
		info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
		if err != nil {
			return nil, "", err
		}
		return data, info.ContentType, nil
	}
	imageURL := util.Clean(item["url"])
	if imageURL == "" {
		return nil, "", errors.New("image url is empty")
	}
	if isImageDataURL(imageURL) {
		return imageDataURLBytes(imageURL)
	}
	parsed, err := url.Parse(imageURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, "", errors.New("image url is not absolute")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "", errors.New("image url scheme is not supported")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "image/*")
	resp, err := app.relayHTTPClient().Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("image download failed: %s", resp.Status)
	}
	limited := io.LimitReader(resp.Body, maxRelayImageBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxRelayImageBytes {
		return nil, "", errors.New("image is too large")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return nil, "", err
	}
	declaredType := strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	if declaredType != "" && !strings.EqualFold(declaredType, "application/octet-stream") && !strings.EqualFold(declaredType, info.ContentType) {
		return nil, "", util.ErrRasterImageTypeMismatch
	}
	return data, info.ContentType, nil
}

func imageDataURLBytes(value string) ([]byte, string, error) {
	header, dataPart, ok := strings.Cut(strings.TrimSpace(value), ",")
	if !ok || !strings.HasPrefix(strings.ToLower(header), "data:") {
		return nil, "", errors.New("image data url is invalid")
	}
	contentType := strings.TrimSpace(strings.TrimPrefix(strings.Split(header, ";")[0], "data:"))
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil, "", errors.New("image data url is not an image")
	}
	if !strings.Contains(strings.ToLower(header), ";base64") {
		return nil, "", errors.New("image data url must be base64")
	}
	if len(dataPart) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
		return nil, "", errors.New("image is too large")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataPart))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", errors.New("image data is empty")
	}
	if len(data) > maxRelayImageBytes {
		return nil, "", errors.New("image is too large")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		return nil, "", err
	}
	if !strings.EqualFold(contentType, info.ContentType) {
		return nil, "", util.ErrRasterImageTypeMismatch
	}
	return data, info.ContentType, nil
}

func (a *App) isLocalImageURL(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if strings.HasPrefix(text, "/images/") {
		return true
	}
	if a == nil || a.config == nil || a.config.BaseURL() == "" {
		return false
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	base, err := url.Parse(a.config.BaseURL())
	if err != nil || base.Scheme == "" || base.Host == "" {
		return false
	}
	return parsed.Scheme == base.Scheme && parsed.Host == base.Host && strings.HasPrefix(parsed.EscapedPath(), "/images/")
}

func (a *App) shouldImportVisibilityImage(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" || a.isLocalImageURL(text) || isManagedImageVisibilityPath(text) {
		return false
	}
	return isImageDataURL(text)
}

func isAbsoluteHTTPURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return false
	}
	return parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func isImageDataURL(value string) bool {
	text := strings.TrimSpace(value)
	return strings.HasPrefix(strings.ToLower(text), "data:image/") && strings.Contains(strings.ToLower(text), ";base64,")
}

func isManagedImageVisibilityPath(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		return strings.Contains(pathValue, "/images/") || strings.Contains(pathValue, "/image-thumbnails/")
	}
	return strings.Contains(text, "/images/") || strings.Contains(text, "/image-thumbnails/")
}

func relayStoredImageFormat(item, payload map[string]any, contentType, imageURL string, data []byte) string {
	if info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp"); err == nil {
		return info.Format
	}
	for _, value := range []string{util.Clean(item["output_format"]), util.Clean(payload["output_format"])} {
		if format, ok := normalizeRelayImageOutputFormat(value); ok {
			return format
		}
	}
	switch strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])) {
	case "image/jpeg", "image/jpg":
		return "jpeg"
	case "image/webp":
		return "webp"
	case "image/png":
		return "png"
	}
	if parsed, err := url.Parse(imageURL); err == nil {
		switch strings.ToLower(filepath.Ext(parsed.Path)) {
		case ".jpg", ".jpeg":
			return "jpeg"
		case ".webp":
			return "webp"
		case ".png":
			return "png"
		}
	}
	switch http.DetectContentType(data) {
	case "image/jpeg":
		return "jpeg"
	case "image/webp":
		return "webp"
	default:
		return "png"
	}
}

func relayImageQualityCheck(data []byte, outputFormat string, payload map[string]any) map[string]any {
	check := map[string]any{}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	actualFormat := ""
	if err == nil {
		actualFormat = info.Format
		actualSize := fmt.Sprintf("%dx%d", info.Width, info.Height)
		check["width"] = info.Width
		check["height"] = info.Height
		check["resolution"] = actualSize
		check["actual_size"] = actualSize
	}
	actualOutputFormat := normalizeActualImageFormat(firstNonEmpty(actualFormat, outputFormat))
	if actualOutputFormat != "" {
		check["actual_output_format"] = actualOutputFormat
	}

	requestedSize := requestedRelayImageSize(payload)
	requestedOutputFormat := requestedRelayImageOutputFormat(payload)
	warnings := []string{}
	qualityCheck := map[string]any{
		"requested_size":          requestedSize,
		"actual_size":             util.Clean(check["actual_size"]),
		"requested_output_format": requestedOutputFormat,
		"actual_output_format":    actualOutputFormat,
	}
	if requestedWidth, requestedHeight, ok := parseImageQualityDimensions(requestedSize); ok {
		actualWidth := util.ToInt(check["width"], 0)
		actualHeight := util.ToInt(check["height"], 0)
		sizeMatched := actualWidth == requestedWidth && actualHeight == requestedHeight
		qualityCheck["size_matched"] = sizeMatched
		if !sizeMatched && actualWidth > 0 && actualHeight > 0 {
			warnings = append(warnings, fmt.Sprintf("请求尺寸 %dx%d，实际尺寸 %dx%d", requestedWidth, requestedHeight, actualWidth, actualHeight))
		}
	} else if requestedSize != "" && requestedSize != "auto" {
		warnings = append(warnings, "请求尺寸不是精确宽高，已记录实际尺寸供人工核对")
	}
	if requestedOutputFormat != "" && actualOutputFormat != "" {
		formatMatched := requestedOutputFormat == actualOutputFormat
		qualityCheck["output_format_matched"] = formatMatched
		if !formatMatched {
			warnings = append(warnings, fmt.Sprintf("请求格式 %s，实际格式 %s", requestedOutputFormat, actualOutputFormat))
		}
	}
	qualityCheck["warnings"] = warnings
	check["quality_check"] = qualityCheck
	return check
}

func requestedRelayImageSize(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if requestedSize := util.Clean(payload["requested_size"]); requestedSize != "" {
		if normalized, ok := normalizeRelayImageSize(requestedSize); ok && normalized != "" {
			return normalized
		}
		return requestedSize
	}
	size := util.Clean(payload["size"])
	if normalized, ok := normalizeRelayImageSize(size); ok && normalized != "" {
		return normalized
	}
	return size
}

func requestedRelayImageOutputFormat(payload map[string]any) string {
	if payload != nil {
		if format, ok := normalizeRelayImageOutputFormat(util.Clean(payload["output_format"])); ok {
			return format
		}
	}
	return ""
}

func normalizeActualImageFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpg", "jpeg":
		return "jpeg"
	case "png":
		return "png"
	case "webp":
		return "webp"
	default:
		return ""
	}
}

func parseImageQualityDimensions(value string) (int, int, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, " ", "")
	normalized = strings.ReplaceAll(normalized, "×", "x")
	parts := strings.Split(normalized, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width := util.ToInt(parts[0], 0)
	height := util.ToInt(parts[1], 0)
	return width, height, width > 0 && height > 0
}

func (a *App) runLoggedChatTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	return a.runLoggedChatTaskWithContext(ctx, identity, payload, "/api/creation-tasks/chat-completions", "文本生成")
}

func (a *App) runLoggedChatTaskWithContext(ctx context.Context, identity service.Identity, payload map[string]any, endpoint, summary string) (map[string]any, error) {
	ctx, _ = protocol.WithAccountUsageTracker(ctx)
	start := time.Now()
	requestCapture := payloadAuditCapture(payload)
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	if len(util.AsMapSlice(payload["tools"])) > 0 {
		payload["stream"] = false
	} else {
		payload["stream"] = true
	}
	model := firstNonEmpty(util.Clean(payload["model"]), a.defaultChatModel())
	if err := a.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return nil, err
	}
	result, stream, err := a.relayChatCompletions(ctx, payload)
	if stream != nil {
		result, err = collectRelayChatTaskStream(payload, stream)
	}
	if err != nil {
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return result, err
	}
	data := chatCompletionTaskData(result)
	if util.Clean(data["text_response"]) == "" && len(util.AsMapSlice(data["tool_calls"])) == 0 {
		err = errors.New("模型没有返回文本内容或工具调用")
		a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "failed", http.StatusBadGateway, err.Error(), nil, requestCapture)
		return result, err
	}
	a.logCall(ctx, identity, summary, http.MethodPost, endpoint, model, start, "success", http.StatusOK, "", nil, requestCapture)
	return map[string]any{
		"created":     result["created"],
		"output_type": "text",
		"data":        []map[string]any{data},
	}, nil
}

func chatCompletionTaskData(result map[string]any) map[string]any {
	for _, item := range util.AsMapSlice(result["data"]) {
		data := map[string]any{}
		if text, ok := item["text_response"].(string); ok && text != "" {
			data["text_response"] = text
		}
		if reasoning, ok := item["reasoning_content"].(string); ok {
			data["reasoning_content"] = reasoning
		}
		if calls := util.AsMapSlice(item["tool_calls"]); len(calls) > 0 {
			data["tool_calls"] = calls
		}
		if len(data) > 0 {
			return data
		}
	}
	for _, choice := range util.AsMapSlice(result["choices"]) {
		message := util.StringMap(choice["message"])
		data := map[string]any{}
		if text := chatCompletionContentRawText(message["content"]); text != "" {
			data["text_response"] = text
		}
		if reasoning, ok := message["reasoning_content"].(string); ok {
			data["reasoning_content"] = reasoning
		}
		if calls := util.AsMapSlice(message["tool_calls"]); len(calls) > 0 {
			data["tool_calls"] = calls
		}
		if len(data) > 0 {
			return data
		}
	}
	return map[string]any{}
}

func collectRelayChatTaskStream(payload map[string]any, stream *protocol.StreamResult) (map[string]any, error) {
	created := time.Now().Unix()
	model := ""
	var text strings.Builder
	var reasoning strings.Builder
	toolCalls := map[int]*chatCompletionToolCallParts{}
	onProgress := relayTextTaskProgressCallback(payload)

	for item := range stream.Items {
		if item == nil {
			continue
		}
		if value := util.ToInt(item["created"], 0); value > 0 {
			created = int64(value)
		}
		if model == "" {
			model = util.Clean(item["model"])
		}
		if delta := chatCompletionStreamTextDelta(item); delta != "" {
			text.WriteString(delta)
			if onProgress != nil {
				onProgress(text.String())
			}
		}
		for _, choice := range util.AsMapSlice(item["choices"]) {
			delta := util.StringMap(choice["delta"])
			if value, ok := delta["reasoning_content"].(string); ok {
				reasoning.WriteString(value)
			}
			appendChatCompletionToolCallParts(toolCalls, delta["tool_calls"], false)
			message := util.StringMap(choice["message"])
			if value, ok := message["reasoning_content"].(string); ok && reasoning.Len() == 0 {
				reasoning.WriteString(value)
			}
			appendChatCompletionToolCallParts(toolCalls, message["tool_calls"], true)
		}
	}
	if err := <-stream.Err; err != nil {
		return nil, err
	}
	content := text.String()
	data := map[string]any{}
	if content != "" {
		data["text_response"] = content
	}
	if reasoning.Len() > 0 {
		data["reasoning_content"] = reasoning.String()
	}
	if calls := completedChatCompletionToolCalls(toolCalls); len(calls) > 0 {
		data["tool_calls"] = calls
	}
	if strings.TrimSpace(content) == "" && len(util.AsMapSlice(data["tool_calls"])) == 0 {
		return nil, errors.New("模型没有返回文本内容或工具调用")
	}
	return map[string]any{
		"created":     created,
		"model":       model,
		"output_type": "text",
		"data":        []map[string]any{data},
	}, nil
}

type chatCompletionToolCallParts struct {
	id        string
	typeName  string
	name      string
	arguments strings.Builder
}

func appendChatCompletionToolCallParts(target map[int]*chatCompletionToolCallParts, value any, replace bool) {
	for fallbackIndex, raw := range util.AsMapSlice(value) {
		index := util.ToInt(raw["index"], fallbackIndex)
		parts := target[index]
		if parts == nil {
			parts = &chatCompletionToolCallParts{}
			target[index] = parts
		}
		if id := util.Clean(raw["id"]); id != "" {
			parts.id = id
		}
		if typeName := util.Clean(raw["type"]); typeName != "" {
			parts.typeName = typeName
		}
		function := util.StringMap(raw["function"])
		if name := util.Clean(function["name"]); name != "" {
			parts.name = name
		}
		if arguments, ok := function["arguments"].(string); ok {
			if replace {
				parts.arguments.Reset()
			}
			parts.arguments.WriteString(arguments)
		}
	}
}

func completedChatCompletionToolCalls(parts map[int]*chatCompletionToolCallParts) []map[string]any {
	if len(parts) == 0 {
		return nil
	}
	indexes := make([]int, 0, len(parts))
	for index := range parts {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	calls := make([]map[string]any, 0, len(indexes))
	for _, index := range indexes {
		item := parts[index]
		if item == nil || strings.TrimSpace(item.name) == "" {
			continue
		}
		id := item.id
		if id == "" {
			id = fmt.Sprintf("tool-call-%d", index)
		}
		typeName := item.typeName
		if typeName == "" {
			typeName = "function"
		}
		calls = append(calls, map[string]any{
			"id":   id,
			"type": typeName,
			"function": map[string]any{
				"name":      item.name,
				"arguments": item.arguments.String(),
			},
		})
	}
	return calls
}

func relayTextTaskProgressCallback(payload map[string]any) func(string) {
	if callback, ok := payload[service.TextOutputCallbackPayloadKey].(func(string)); ok {
		return callback
	}
	return nil
}

func chatCompletionStreamTextDelta(item map[string]any) string {
	var parts []string
	for _, choice := range util.AsMapSlice(item["choices"]) {
		delta := util.StringMap(choice["delta"])
		if text := chatCompletionContentRawText(delta["content"]); text != "" {
			parts = append(parts, text)
		}
		if text := util.Clean(delta["text"]); text != "" {
			parts = append(parts, text)
		}
		message := util.StringMap(choice["message"])
		if text := chatCompletionContentRawText(message["content"]); text != "" {
			parts = append(parts, text)
		}
		if text := util.Clean(choice["text"]); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

func chatCompletionContentRawText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	var parts []string
	for _, item := range anyList(content) {
		block := util.StringMap(item)
		if text, ok := block["text"].(string); ok {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
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

func normalizedProtocolImageCount(value any, model string) int {
	n, ok := util.StrictInt(value)
	if !ok || n < 1 {
		return 1
	}
	limit := util.MaxImageOutputCount(model)
	if n > limit {
		return limit
	}
	return n
}

func validProtocolImageCount(value any, model string) bool {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return true
	}
	n, ok := util.StrictInt(value)
	return ok && n >= 1 && n <= util.MaxImageOutputCount(model)
}

func protocolImageCountRangeMessage(model string) string {
	return fmt.Sprintf("n must be between 1 and %d", util.MaxImageOutputCount(model))
}

func normalizedRelayImageStreamOutputLimit(value int) int {
	if value < 1 {
		return 1
	}
	limit := util.MaxImageOutputCount(util.ImageModelGPT)
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

func (a *App) serveWeb(w http.ResponseWriter, r *http.Request) {
	frontend.Handler().ServeHTTP(w, r)
}
