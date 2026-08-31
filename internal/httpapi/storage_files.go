package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

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
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "permission denied")
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
		if err := a.storageFiles.Delete(r.Context(), identity.ID, identity.Role == service.AuthRoleAdmin, id, request.Provider); err != nil {
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
	file, header, err := r.FormFile("file")
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		a.writeStorageServiceError(w, err)
		return
	}
	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			util.WriteError(w, http.StatusBadRequest, "storage provider payload is invalid")
			return
		}
		provider = &parsed
	}
	object, err := a.storageFiles.Upload(r.Context(), identity.ID, identity.Role == service.AuthRoleAdmin, header.Filename, contentType, data, provider)
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
	w.Header().Set("Content-Type", download.Object.MIMEType)
	w.Header().Set("Cache-Control", "private, no-store")
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

func (a *App) writeStorageServiceError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, storage.ErrStorageObjectNotFound):
		status = http.StatusNotFound
	case errors.Is(err, service.ErrLocalStorageCapacityExceeded):
		status = http.StatusInsufficientStorage
	case strings.Contains(strings.ToLower(err.Error()), "permission"):
		status = http.StatusForbidden
	case strings.Contains(strings.ToLower(err.Error()), "no storage provider"):
		status = http.StatusServiceUnavailable
	}
	util.WriteError(w, status, err.Error())
}
