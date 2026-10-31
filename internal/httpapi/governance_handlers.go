package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

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
	page, err := a.logs.SearchPage(query)
	if err != nil {
		if errors.Is(err, service.ErrInvalidLogCursor) {
			util.WriteError(w, http.StatusBadRequest, "cursor 参数无效")
			return
		}
		a.writeLogStorageError(w, "query logs", err)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"items":           page.Items,
		"total":           nil,
		"page_size":       normalizedHTTPLogPageSize(query.Limit),
		"view":            query.View,
		"has_more":        page.HasMore,
		"snapshot_cursor": page.SnapshotCursor,
		"next_cursor":     page.NextCursor,
	})
}

func (a *App) handleLogGovernance(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		summary, err := a.logs.GovernanceSummary()
		if err != nil {
			a.writeLogStorageError(w, "query log governance", err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"governance": summary})
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		retentionDays := util.ToInt(body["retention_days"], a.config.LogRetentionDays())
		result, err := a.logs.CleanupOlderThan(retentionDays)
		if err != nil {
			if errors.Is(err, service.ErrInvalidLogRetentionDays) {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			a.writeLogStorageError(w, "clean up logs", err)
			return
		}
		summary, err := a.logs.GovernanceSummary()
		if err != nil {
			a.logLogStorageError("query log governance after cleanup", err)
			summary = service.LogGovernanceSummary{Total: result.Remaining}
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"cleanup":    result,
			"governance": summary,
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) writeLogStorageError(w http.ResponseWriter, operation string, err error) {
	a.logLogStorageError(operation, err)
	util.WriteError(w, http.StatusServiceUnavailable, "日志数据库暂时不可用，请稍后重试")
}

func (a *App) logLogStorageError(operation string, err error) {
	if a.logger != nil {
		a.logger.Error("log storage operation failed", "operation", operation, "error", err)
	}
}

func (a *App) handleImageStorageGovernance(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		governance, err := a.imageStorageGovernance(identity)
		if err != nil {
			a.writeImageStorageError(w, "query image storage governance", err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"governance": governance})
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
			a.writeImageStorageError(w, "clean up image storage", err)
			return
		}
		governance, err := a.imageStorageGovernance(identity)
		if err != nil {
			a.logImageStorageError("query image storage governance after cleanup", err)
			governance = map[string]any{
				"total_bytes":      result.RemainingBytes,
				"over_limit_bytes": result.OverLimitBytes,
			}
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"cleanup":    result,
			"governance": governance,
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) writeImageStorageError(w http.ResponseWriter, operation string, err error) {
	a.logImageStorageError(operation, err)
	util.WriteError(w, http.StatusServiceUnavailable, "媒体存储暂时不可用，请稍后重试")
}

func (a *App) logImageStorageError(operation string, err error) {
	if a.logger != nil {
		a.logger.Error("image storage operation failed", "operation", operation, "error", err)
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
	return a.cleanupImageStorageWithOptionsContext(context.Background(), options)
}

func (a *App) cleanupImageStorageWithOptionsContext(ctx context.Context, options service.ImageStorageCleanupOptions) (service.ImageStorageCleanupResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return service.ImageStorageCleanupResult{}, err
	}
	assetCleanup := service.ImageConversationAssetGovernance{}
	assets := service.ImageConversationAssetGovernance{}
	if a.images == nil {
		return service.ImageStorageCleanupResult{}, errors.New("image storage is unavailable")
	}
	if _, err := a.images.StorageGovernance(); err != nil {
		return service.ImageStorageCleanupResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return service.ImageStorageCleanupResult{}, err
	}
	if a.conversationAssets != nil {
		var err error
		assets, err = a.conversationAssets.Governance()
		if err != nil {
			return service.ImageStorageCleanupResult{}, err
		}
		if options.RetentionDays > 0 {
			assetCleanup, err = a.conversationAssets.CleanupExpired(options.RetentionDays)
			if err != nil {
				return service.ImageStorageCleanupResult{}, err
			}
			assets = assetCleanup
		}
		if err := ctx.Err(); err != nil {
			return service.ImageStorageCleanupResult{}, err
		}
	}

	galleryOptions := options
	if galleryOptions.MaxBytes > 0 && a.conversationAssets != nil {
		galleryOptions.MaxBytes = imageStorageLimitAvailableForGallery(galleryOptions.MaxBytes, assets.TotalBytes)
	}
	result, err := a.images.CleanupStorage(galleryOptions)
	if err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
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
		if err := ctx.Err(); err != nil {
			return result, err
		}
		assetCleanup.DeletedBytes += quotaCleanup.DeletedBytes
		assetCleanup.DeletedCount += quotaCleanup.DeletedCount
		assets = quotaCleanup
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
