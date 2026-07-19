package httpapi

import (
	"errors"
	"net/http"
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
			Action    string `json:"action"`
			ProjectID string `json:"project_id"`
			Title     string `json:"title"`
		}
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		workspace, err := a.canvas.UpdateProject(ownerID, input.Action, input.ProjectID, input.Title)
		if err != nil {
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
		document, err := a.canvas.Save(ownerID, input)
		if err != nil {
			if errors.Is(err, service.ErrInvalidCanvasDocument) {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to save canvas")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"document": document})
	case http.MethodDelete:
		document, err := a.canvas.Clear(ownerID)
		if err != nil {
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
	contentType := normalizeUploadedImageContentType(http.DetectContentType(upload.Data))
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/webp" {
		util.WriteError(w, http.StatusBadRequest, "unsupported image format")
		return
	}
	upload.ContentType = contentType
	format := strings.TrimPrefix(contentType, "image/")
	if format == "jpg" {
		format = "jpeg"
	}
	url := a.engine.SaveImageBytesForOwnerWithFormat(upload.Data, "", identityScope(identity), identityDisplayName(identity), format)
	if url == "" {
		util.WriteError(w, http.StatusInternalServerError, "failed to store image")
		return
	}
	a.images.RecordGeneratedImages([]string{url}, identityScope(identity), identityDisplayName(identity), service.ImageVisibilityPrivate)
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": upload.ContentType})
}
