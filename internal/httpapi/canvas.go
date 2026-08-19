package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCanvasDocument(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		workspace, err := a.canvas.Workspace(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load canvas")
			return
		}
		util.WriteJSON(w, http.StatusOK, workspace)
	case http.MethodPost:
		var input struct {
			Action    string                  `json:"action"`
			ProjectID string                  `json:"project_id"`
			Title     string                  `json:"title"`
			Revision  *int64                  `json:"revision"`
			Document  *service.CanvasDocument `json:"document"`
		}
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var workspace service.CanvasWorkspaceResult
		var err error
		action := strings.ToLower(strings.TrimSpace(input.Action))
		if action == "import" {
			if input.Document == nil {
				util.WriteError(w, http.StatusBadRequest, "canvas document is required")
				return
			}
			workspace, err = a.canvas.Import(ownerID, *input.Document)
		} else if action == "rename" || action == "delete" {
			if input.Revision == nil || *input.Revision < 0 {
				util.WriteError(w, http.StatusBadRequest, "canvas revision is required")
				return
			}
			workspace, err = a.canvas.UpdateProjectAtRevision(ownerID, action, input.ProjectID, input.Title, *input.Revision)
		} else {
			workspace, err = a.canvas.UpdateProject(ownerID, action, input.ProjectID, input.Title)
		}
		if err != nil {
			if errors.Is(err, service.ErrCanvasRevisionConflict) {
				util.WriteError(w, http.StatusConflict, err.Error())
				return
			}
			if errors.Is(err, service.ErrInvalidCanvasDocument) {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to update canvas project")
			return
		}
		util.WriteJSON(w, http.StatusOK, workspace)
	case http.MethodPut:
		var input service.CanvasDocument
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		document, err := a.canvas.SaveAtRevision(ownerID, input)
		if err != nil {
			if errors.Is(err, service.ErrCanvasRevisionConflict) {
				util.WriteError(w, http.StatusConflict, err.Error())
				return
			}
			if errors.Is(err, service.ErrInvalidCanvasDocument) {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to save canvas")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"document": document})
	case http.MethodDelete:
		revision, parseErr := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("revision")), 10, 64)
		if parseErr != nil || revision < 0 {
			util.WriteError(w, http.StatusBadRequest, "canvas revision is required")
			return
		}
		document, err := a.canvas.ClearAtRevision(ownerID, r.URL.Query().Get("project_id"), revision)
		if err != nil {
			if errors.Is(err, service.ErrCanvasRevisionConflict) {
				util.WriteError(w, http.StatusConflict, err.Error())
				return
			}
			if errors.Is(err, service.ErrInvalidCanvasDocument) {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to clear canvas")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"document": document})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleCanvasImageUpload(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(maxRelayImageBytes + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	header := firstMultipartFile(r.MultipartForm, "image")
	if header == nil {
		util.WriteError(w, http.StatusBadRequest, "image is required")
		return
	}
	upload, err := readUpload(header)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(upload.Data) == 0 {
		util.WriteError(w, http.StatusBadRequest, "image file is empty")
		return
	}
	if len(upload.Data) > maxRelayImageBytes {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "image file is too large")
		return
	}
	info, err := util.InspectRasterImage(upload.Data, "image/png", "image/jpeg", "image/webp")
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "unsupported image format")
		return
	}
	contentType := info.ContentType
	upload.ContentType = contentType
	format := strings.TrimPrefix(contentType, "image/")
	if format == "jpg" {
		format = "jpeg"
	}
	url, err := a.engine.SaveImageBytesForOwnerWithFormatE(r.Context(), upload.Data, "", identityScope(identity), identityDisplayName(identity), format)
	if err != nil || url == "" {
		if err == nil {
			err = errors.New("image storage returned an empty URL")
		}
		util.WriteError(w, http.StatusInternalServerError, "failed to store image: "+err.Error())
		return
	}
	a.images.EnsureThumbnails([]string{url})
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": upload.ContentType})
}
