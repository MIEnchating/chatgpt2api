package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCanvasShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	action := map[string]string{http.MethodGet: "get", http.MethodPost: "create", http.MethodDelete: "revoke"}[r.Method]
	if action == "" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	share, err := a.canvas.CanvasShare(identityScope(identity), r.URL.Query().Get("project_id"), action)
	if err != nil {
		writeCanvasShareError(w, err)
		return
	}
	util.WriteJSON(w, http.StatusOK, share)
}

func writeCanvasShareError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrCanvasShareNotFound) {
		util.WriteError(w, http.StatusNotFound, err.Error())
		return
	}
	writeCanvasMutationError(w, err, "无法读取画布分享")
}

func (a *App) handlePublicCanvasShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/canvas-shares/"), "/")
	if len(parts) != 1 && (len(parts) != 2 || parts[1] != "media") {
		http.NotFound(w, r)
		return
	}
	document, ownerID, err := a.canvas.SharedCanvas(parts[0])
	if err != nil {
		writeCanvasShareError(w, err)
		return
	}
	if len(parts) == 1 {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"document": service.PublicCanvasDocument(document, parts[0])})
		return
	}
	for _, node := range document.Nodes {
		if node.ID == r.URL.Query().Get("node_id") {
			a.serveCanvasShareMedia(w, r, ownerID, node)
			return
		}
	}
	http.NotFound(w, r)
}

func (a *App) serveCanvasShareMedia(w http.ResponseWriter, r *http.Request, ownerID string, node service.CanvasNode) {
	if objectID := service.CanvasShareStorageObjectID(node); objectID != "" {
		// Reading through the owner's identity also checks shared-library visibility.
		object, err := a.myAssets.ReadStorageObjectForIdentity(ownerID, false, objectID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		download, err := a.storageFiles.DownloadForIdentity(r.Context(), object.CreatedBy, false, object.ID, r.Header.Get("Range"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer download.Stream.Close()
		contentType := normalizedUploadedContentType(download.Object.MIMEType)
		if !storageContentMayRenderInline(contentType) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
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
		return
	}
	parsed, err := url.Parse(node.URL)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	path := parsed.Path
	base, _ := url.Parse(a.config.BaseURL())
	if parsed.IsAbs() && (base == nil || parsed.Host != base.Host) && service.CanvasShareRemoteURL(node.URL) {
		http.Redirect(w, r, node.URL, http.StatusTemporaryRedirect)
		return
	}
	if strings.HasPrefix(path, "/images/") {
		ref, err := a.images.ImageFileAccess(path, service.ImageAccessScope{OwnerID: ownerID, Visible: true})
		if err != nil {
			http.NotFound(w, r)
			return
		}
		setRasterResponseSecurityHeaders(w)
		http.ServeFile(w, r, ref.Path)
		return
	}
	for _, media := range []struct{ prefix, dir string }{{"/videos/", a.videoDir}, {"/audios/", a.audioDir}} {
		if !strings.HasPrefix(path, media.prefix) {
			continue
		}
		name := strings.TrimPrefix(path, media.prefix)
		if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if !a.authorizeGeneratedMediaFile(w, r, service.Identity{ID: ownerID, OwnerID: ownerID}, path) {
			return
		}
		http.ServeFile(w, r, filepath.Join(media.dir, name))
		return
	}
	http.NotFound(w, r)
}
