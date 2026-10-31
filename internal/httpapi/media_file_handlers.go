package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

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
		payload, err := a.images.ListImages(a.resolveImageBaseURL(), strings.TrimSpace(r.URL.Query().Get("start_date")), strings.TrimSpace(r.URL.Query().Get("end_date")), scope)
		if err != nil {
			a.writeImageStorageError(w, "list images", err)
			return
		}
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
	identity, ok := a.imageRequestIdentity(w, r)
	if !ok {
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
	if !a.authorizeGeneratedMediaFile(w, r, identity, "/videos/"+name) {
		return
	}
	contentType := "video/mp4"
	switch strings.ToLower(filepath.Ext(name)) {
	case ".webm":
		contentType = "video/webm"
	case ".mov":
		contentType = "video/quicktime"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, path)
}

func (a *App) authorizeGeneratedMediaFile(w http.ResponseWriter, r *http.Request, identity service.Identity, resultURL string) bool {
	if a.tasks == nil {
		util.WriteError(w, http.StatusServiceUnavailable, "creation task storage is unavailable")
		return false
	}
	allowed, err := a.tasks.CanAccessMediaResult(identity, resultURL)
	if err != nil {
		if a.logger != nil {
			a.logger.Error("generated media authorization failed", "error", err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, "creation task storage is unavailable")
		return false
	}
	if !allowed {
		http.NotFound(w, r)
		return false
	}
	return true
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
	// Visibility can change without changing the media URL.
	w.Header().Set("Cache-Control", "private, no-store")
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
	setRasterResponseSecurityHeaders(w)
	thumbnailErr := a.images.EnsureThumbnail(thumbnailRel)
	if thumbnailErr == nil {
		thumbPath := filepath.Join(a.config.ImageThumbnailsDir(), filepath.FromSlash(thumbnailRel))
		if service.IsMediaFile(thumbPath) {
			http.ServeFile(w, r, thumbPath)
			return
		}
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
	return relativeEscapedRequestPath(r, "/images/", "invalid image path")
}

func imageReferenceFileRequestPath(r *http.Request) (string, error) {
	return relativeEscapedRequestPath(r, "/image-references/", "invalid image path")
}

func imageThumbnailRequestPath(r *http.Request) (string, error) {
	return relativeEscapedRequestPath(r, "/image-thumbnails/", "invalid thumbnail path")
}

func relativeEscapedRequestPath(r *http.Request, prefix, invalidMessage string) (string, error) {
	escapedPath := r.URL.EscapedPath()
	raw := strings.TrimPrefix(escapedPath, prefix)
	if raw == "" || raw == escapedPath {
		return "", errors.New(invalidMessage)
	}
	rel, err := url.PathUnescape(raw)
	if err != nil {
		return "", err
	}
	return rel, nil
}
