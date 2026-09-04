package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const storageMultipartMemoryBytes int64 = 1 << 20

func (a *App) handleStorageConfig(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": a.storageFiles.PublicConfig()})
}

func (a *App) handleProfileStorageProvider(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch {
	case r.URL.Path == "/api/profile/storage-provider" && r.Method == http.MethodGet:
		providers, err := a.storageFiles.UserProviders(identity.ID)
		if err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"provider": providers})
	case r.URL.Path == "/api/profile/storage-provider" && r.Method == http.MethodPost:
		var request struct {
			Provider service.UserStorageProviders `json:"provider"`
		}
		if err := util.DecodeJSON(r.Body, &request); err != nil {
			util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
			return
		}
		providers, err := a.storageFiles.SaveUserProviders(identity.ID, request.Provider)
		if err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"provider": providers})
	case r.URL.Path == "/api/profile/storage-provider/measure" && r.Method == http.MethodPost:
		var request struct {
			Provider service.StorageObjectProviderInput `json:"provider"`
		}
		if err := util.DecodeJSON(r.Body, &request); err != nil {
			util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
			return
		}
		result, err := a.storageFiles.MeasureUser(r.Context(), identity.ID, request.Provider)
		if err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"result": result})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleAdminStorageMeasure(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		Index    int                    `json:"index"`
		Provider *model.StorageProvider `json:"provider"`
	}
	if err := util.DecodeJSON(r.Body, &request); err != nil {
		util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
		return
	}
	result, err := a.storageFiles.MeasureAdmin(r.Context(), request.Index, request.Provider)
	if err != nil {
		a.writeStorageServiceError(w, err)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"result": result})
}

func (a *App) handleStorageFiles(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/files"), "/")
	if len(parts) == 1 && parts[0] == "" {
		a.handleStorageFileUpload(w, r, identity)
		return
	}
	id := ""
	if len(parts) > 1 {
		id = strings.TrimSpace(parts[1])
	}
	if id == "" {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 3 && parts[2] == "content" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		a.handleStorageFileContent(w, r, identity, id)
		return
	}
	if len(parts) == 3 && parts[2] == "record" && r.Method == http.MethodDelete {
		if err := a.storageFiles.DeleteDirectRecord(identity.ID, id); err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		object, err := a.storageFiles.InfoForIdentity(identity.ID, identity.Role == service.AuthRoleAdmin, id)
		if err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"object": object})
	case http.MethodDelete:
		var request struct {
			Provider *service.StorageObjectProviderInput `json:"provider"`
		}
		if r.Body != nil {
			if err := util.DecodeJSON(r.Body, &request); err != nil && !errors.Is(err, io.EOF) {
				util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
				return
			}
		}
		if err := a.myAssets.DeleteStorageObject(r.Context(), identity.ID, identity.Role == service.AuthRoleAdmin, id, request.Provider); err != nil {
			a.writeStorageServiceError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleStorageFileUpload(w http.ResponseWriter, r *http.Request, identity service.Identity) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if a.storageUploadSlots != nil {
		select {
		case a.storageUploadSlots <- struct{}{}:
			defer func() { <-a.storageUploadSlots }()
		case <-r.Context().Done():
			util.WriteError(w, http.StatusRequestTimeout, "upload was canceled")
			return
		}
	}
	if err := r.ParseMultipartForm(storageMultipartMemoryBytes); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()
	if header.Size < 1 {
		util.WriteError(w, http.StatusBadRequest, "file is empty")
		return
	}
	if header.Size > maxAPIRequestBodyBytes {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "file is too large")
		return
	}
	contentType := normalizedUploadedContentType(header.Header.Get("Content-Type"))
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
			return
		}
		provider = &parsed
	}
	object, err := a.storageFiles.UploadReader(r.Context(), identity.ID, identity.Role == service.AuthRoleAdmin, header.Filename, contentType, file, header.Size, provider)
	if err != nil {
		a.writeStorageServiceError(w, err)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"object": object})
}

func (a *App) handleStorageFileDirect(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var request service.DirectStorageObjectInput
	if err := util.DecodeJSON(r.Body, &request); err != nil {
		util.WriteError(w, http.StatusBadRequest, "storage object payload is invalid")
		return
	}
	object, err := a.storageFiles.RegisterDirect(identity.ID, request)
	if err != nil {
		a.writeStorageServiceError(w, err)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"object": object})
}

func (a *App) handleStorageFileContent(w http.ResponseWriter, r *http.Request, identity service.Identity, id string) {
	download, err := a.storageFiles.DownloadForIdentity(r.Context(), identity.ID, identity.Role == service.AuthRoleAdmin, id, r.Header.Get("Range"))
	if err != nil {
		a.writeStorageServiceError(w, err)
		return
	}
	defer download.Stream.Close()
	contentType := normalizedUploadedContentType(download.Object.MIMEType)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if !storageContentMayRenderInline(contentType) {
		filename := filepath.Base(download.Object.ObjectKey)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	}
	if download.AcceptRanges {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if download.ContentRange != "" {
		w.Header().Set("Content-Range", download.ContentRange)
	}
	if download.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(download.ContentLength, 10))
	}
	w.WriteHeader(download.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, download.Stream)
	}
}

func normalizedUploadedContentType(value string) string {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || mediaType == "" {
		return "application/octet-stream"
	}
	return strings.ToLower(mediaType)
}

func storageContentMayRenderInline(value string) bool {
	switch normalizedUploadedContentType(value) {
	case "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
		"video/mp4", "video/webm", "video/quicktime",
		"audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm", "audio/flac":
		return true
	default:
		return false
	}
}

func (a *App) writeStorageServiceError(w http.ResponseWriter, err error) {
	var validationErr service.StorageValidationError
	switch {
	case errors.Is(err, storage.ErrStorageObjectNotFound):
		util.WriteError(w, http.StatusNotFound, "素材文件不存在")
	case errors.Is(err, service.ErrStorageObjectInUse):
		util.WriteError(w, http.StatusConflict, "素材文件仍被使用，无法删除")
	case errors.Is(err, service.ErrInvalidStorageRange):
		util.WriteError(w, http.StatusRequestedRangeNotSatisfiable, "请求的文件范围无效")
	case errors.Is(err, service.ErrLocalStorageCapacityExceeded):
		util.WriteError(w, http.StatusInsufficientStorage, "服务器本机素材容量已达到上限")
	case errors.Is(err, service.ErrStorageObjectAccessDenied):
		util.WriteError(w, http.StatusForbidden, "无权访问该素材文件")
	case errors.Is(err, service.ErrUserStorageProviderDisabled):
		util.WriteError(w, http.StatusForbidden, "管理员未启用用户自定义素材存储")
	case errors.Is(err, service.ErrStorageProviderUnavailable):
		util.WriteError(w, http.StatusServiceUnavailable, "素材存储服务暂时不可用")
	case errors.As(err, &validationErr):
		util.WriteError(w, http.StatusBadRequest, validationErr.Error())
	default:
		if a != nil && a.logger != nil {
			a.logger.Error("storage file operation failed", "error", err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, "素材存储服务暂时不可用")
	}
}
