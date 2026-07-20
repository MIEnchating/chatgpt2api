package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

type imageConversationAssetCleanupWorker struct {
	mu           sync.Mutex
	pending      map[string]struct{}
	delayed      map[string]*imageConversationAssetCleanupDelay
	running      bool
	stalled      bool
	closed       bool
	done         chan struct{}
	activeCancel context.CancelFunc
	timeout      time.Duration
}

type imageConversationAssetCleanupDelay struct {
	timer *time.Timer
}

type pendingImageConversationAssetUpload struct {
	filename  string
	validated *service.ValidatedImageConversationAsset
}

func (w *imageConversationAssetCleanupWorker) schedule(ownerID string, run func(context.Context, string)) {
	ownerID = strings.TrimSpace(ownerID)
	if w == nil || ownerID == "" || run == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if delayed := w.delayed[ownerID]; delayed != nil {
		if delayed.timer != nil {
			delayed.timer.Stop()
		}
		delete(w.delayed, ownerID)
	}
	start := w.enqueueLocked(ownerID)
	w.mu.Unlock()
	if start {
		go w.run(run)
	}
}

func (w *imageConversationAssetCleanupWorker) scheduleDebounced(ownerID string, delay time.Duration, run func(context.Context, string)) {
	ownerID = strings.TrimSpace(ownerID)
	if w == nil || ownerID == "" || run == nil {
		return
	}
	if delay <= 0 {
		w.schedule(ownerID, run)
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if _, pending := w.pending[ownerID]; pending {
		w.mu.Unlock()
		return
	}
	if w.delayed == nil {
		w.delayed = make(map[string]*imageConversationAssetCleanupDelay)
	}
	if w.delayed[ownerID] != nil {
		w.mu.Unlock()
		return
	}
	delayed := &imageConversationAssetCleanupDelay{}
	w.delayed[ownerID] = delayed
	delayed.timer = time.AfterFunc(delay, func() {
		w.mu.Lock()
		if w.closed || w.delayed[ownerID] != delayed {
			w.mu.Unlock()
			return
		}
		delete(w.delayed, ownerID)
		start := w.enqueueLocked(ownerID)
		w.mu.Unlock()
		if start {
			go w.run(run)
		}
	})
	w.mu.Unlock()
}

func (w *imageConversationAssetCleanupWorker) enqueueLocked(ownerID string) bool {
	if w.pending == nil {
		w.pending = make(map[string]struct{})
	}
	w.pending[ownerID] = struct{}{}
	if w.running || w.stalled {
		return false
	}
	w.running = true
	w.done = make(chan struct{})
	return true
}

func (w *imageConversationAssetCleanupWorker) run(run func(context.Context, string)) {
	for {
		w.mu.Lock()
		if w.closed {
			w.pending = nil
			w.running = false
			close(w.done)
			w.done = nil
			w.mu.Unlock()
			return
		}
		owner := ""
		for candidate := range w.pending {
			owner = candidate
			break
		}
		if owner == "" {
			w.running = false
			close(w.done)
			w.done = nil
			w.mu.Unlock()
			return
		}
		delete(w.pending, owner)
		timeout := w.timeout
		if timeout <= 0 {
			timeout = imageConversationAssetCleanupTimeout
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		w.activeCancel = cancel
		w.mu.Unlock()
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			run(ctx, owner)
		}()
		select {
		case <-finished:
			cancel()
			w.mu.Lock()
			w.activeCancel = nil
			w.mu.Unlock()
		case <-ctx.Done():
			cancel()
			w.mu.Lock()
			w.activeCancel = nil
			w.running = false
			w.stalled = true
			done := w.done
			w.done = nil
			if done != nil {
				close(done)
			}
			w.mu.Unlock()
			go w.resumeAfterStalledRun(finished, run)
			return
		}
	}
}

func (w *imageConversationAssetCleanupWorker) resumeAfterStalledRun(finished <-chan struct{}, run func(context.Context, string)) {
	<-finished
	w.mu.Lock()
	w.stalled = false
	if w.closed || len(w.pending) == 0 {
		if w.closed {
			w.pending = nil
		}
		w.mu.Unlock()
		return
	}
	w.running = true
	w.done = make(chan struct{})
	w.mu.Unlock()
	go w.run(run)
}

func (w *imageConversationAssetCleanupWorker) close() {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.closed = true
	w.pending = nil
	cancel := w.activeCancel
	for ownerID, delayed := range w.delayed {
		if delayed.timer != nil {
			delayed.timer.Stop()
		}
		delete(w.delayed, ownerID)
	}
	w.delayed = nil
	done := w.done
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

const (
	maxImageConversationAssetFiles        = 16
	maxImageConversationAssetRequestBytes = 80<<20 + 1<<20
	imageConversationHistoryCleanupDelay  = 45 * time.Second
	imageConversationAssetCleanupTimeout  = 15 * time.Minute
)

func (a *App) handleImageConversationAssetUpload(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	if a.conversationAssets == nil {
		util.WriteError(w, http.StatusServiceUnavailable, "conversation image assets are unavailable")
		return
	}
	release, acquired := a.acquireImageUpload(r.Context())
	if !acquired {
		util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
		return
	}
	defer release()
	r.Body = http.MaxBytesReader(w, r.Body, maxImageConversationAssetRequestBytes)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			util.WriteError(w, http.StatusRequestEntityTooLarge, "image upload is too large")
			return
		}
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	headers := imageConversationAssetFileHeaders(r.MultipartForm)
	if len(headers) == 0 {
		util.WriteError(w, http.StatusBadRequest, "image is required")
		return
	}
	if len(headers) > maxImageConversationAssetFiles {
		util.WriteError(w, http.StatusBadRequest, "too many image files")
		return
	}
	pending := make([]pendingImageConversationAssetUpload, 0, len(headers))
	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid image file")
			return
		}
		validated, err := a.conversationAssets.ReadValidatedReader(r.Context(), file)
		file.Close()
		if err != nil {
			switch {
			case errors.Is(err, service.ErrImageConversationAssetTooLarge):
				util.WriteError(w, http.StatusRequestEntityTooLarge, "image file is too large")
			case errors.Is(err, service.ErrImageConversationAssetStorageLimit):
				util.WriteError(w, http.StatusInsufficientStorage, "image storage limit exceeded")
			case errors.Is(err, service.ErrInvalidImageConversationAsset):
				util.WriteError(w, http.StatusBadRequest, err.Error())
			default:
				util.WriteError(w, http.StatusInternalServerError, "failed to store conversation image asset")
			}
			return
		}
		pending = append(pending, pendingImageConversationAssetUpload{filename: header.Filename, validated: validated})
	}
	filenames := make([]string, len(pending))
	validated := make([]*service.ValidatedImageConversationAsset, len(pending))
	for index, upload := range pending {
		filenames[index] = upload.filename
		validated[index] = upload.validated
	}
	storageStarted := len(pending) > 0
	defer func() {
		if storageStarted {
			a.scheduleImageConversationAssetCleanup(identityScope(identity))
		}
	}()
	items, err := a.conversationAssets.StoreValidatedBatchContext(r.Context(), identityScope(identity), filenames, validated)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrImageConversationAssetTooLarge):
			util.WriteError(w, http.StatusRequestEntityTooLarge, "image file is too large")
		case errors.Is(err, service.ErrImageConversationAssetStorageLimit):
			util.WriteError(w, http.StatusInsufficientStorage, "image storage limit exceeded")
		case errors.Is(err, service.ErrInvalidImageConversationAsset):
			util.WriteError(w, http.StatusBadRequest, err.Error())
		default:
			util.WriteError(w, http.StatusInternalServerError, "failed to store conversation image asset")
		}
		return
	}
	util.WriteJSON(w, http.StatusCreated, map[string]any{"items": items})
}

func (a *App) acquireImageUpload(ctx context.Context) (func(), bool) {
	if a == nil || a.imageUploadSlots == nil {
		return func() {}, true
	}
	select {
	case a.imageUploadSlots <- struct{}{}:
		return func() { <-a.imageUploadSlots }, true
	case <-ctx.Done():
		return nil, false
	}
}

func (a *App) handleImageConversationAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	identity, ok := a.imageRequestIdentity(w, r)
	if !ok {
		return
	}
	if a.conversationAssets == nil {
		http.NotFound(w, r)
		return
	}
	access, err := a.conversationAssets.Access(r.URL.Path, identityScope(identity), identity.Role == service.AuthRoleAdmin)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Type", access.ContentType)
	w.Header().Set("ETag", `"sha256-`+access.ContentHash+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Add("Vary", "Authorization")
	w.Header().Add("Vary", "Cookie")
	http.ServeFile(w, r, access.Path)
}

func imageConversationAssetFileHeaders(form *multipart.Form) []*multipart.FileHeader {
	if form == nil {
		return nil
	}
	items := make([]*multipart.FileHeader, 0)
	for _, key := range []string{"image", "images"} {
		items = append(items, form.File[key]...)
	}
	return items
}

func (a *App) startImageConversationAssetCleaner(ctx context.Context, interval time.Duration) {
	if a == nil || a.conversationAssets == nil || a.history == nil {
		return
	}
	for _, ownerID := range a.conversationAssets.Owners() {
		a.scheduleImageConversationAssetCleanup(ownerID)
	}
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, ownerID := range a.conversationAssets.Owners() {
					a.scheduleImageConversationAssetCleanup(ownerID)
				}
			}
		}
	}()
}

func (a *App) scheduleImageConversationAssetCleanup(ownerID string) {
	if a == nil {
		return
	}
	a.conversationAssetCleanup.schedule(ownerID, a.cleanupImageConversationAssetsForOwner)
}

func (a *App) scheduleImageConversationAssetCleanupDebounced(ownerID string) {
	if a == nil {
		return
	}
	a.conversationAssetCleanup.scheduleDebounced(ownerID, imageConversationHistoryCleanupDelay, a.cleanupImageConversationAssetsForOwner)
}

func (a *App) cleanupImageConversationAssetsForOwner(ctx context.Context, ownerID string) {
	if a == nil || a.conversationAssets == nil || a.history == nil {
		return
	}
	referenced, err := a.history.ConversationAssetReferencesContext(ctx, ownerID)
	if err != nil {
		return
	}
	if ctx.Err() != nil {
		return
	}
	limit := int64(0)
	if a.config != nil {
		limit = a.config.ImageStorageLimitBytes()
	}
	_, _ = a.conversationAssets.CleanupOrphansContext(ctx, ownerID, referenced, service.ImageConversationAssetOrphanGrace, limit)
}

func (a *App) closeImageConversationAssetCleaner() {
	if a != nil {
		a.conversationAssetCleanup.close()
	}
}

func (a *App) imageStorageGovernance() map[string]any {
	if a == nil || a.images == nil {
		return map[string]any{}
	}
	images := a.images.StorageGovernance()
	value := map[string]any{}
	if data, err := json.Marshal(images); err == nil {
		_ = json.Unmarshal(data, &value)
	}
	assets := service.ImageConversationAssetGovernance{}
	if a.conversationAssets != nil {
		assets = a.conversationAssets.Governance()
	}
	totalBytes := images.TotalBytes + assets.TotalBytes
	overLimitBytes := int64(0)
	if images.LimitBytes > 0 && totalBytes > images.LimitBytes {
		overLimitBytes = totalBytes - images.LimitBytes
	}
	value["image_storage_bytes"] = images.TotalBytes
	value["conversation_asset_bytes"] = assets.TotalBytes
	value["conversation_asset_count"] = assets.FileCount
	value["total_bytes"] = totalBytes
	value["over_limit_bytes"] = overLimitBytes
	return value
}

func imageStorageLimitAvailableForGallery(limitBytes, assetBytes int64) int64 {
	if limitBytes <= 0 {
		return limitBytes
	}
	if assetBytes >= limitBytes {
		return 1
	}
	return limitBytes - assetBytes
}
