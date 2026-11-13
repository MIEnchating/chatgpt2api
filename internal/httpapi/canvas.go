package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCanvasDocument(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	projectsOnly := r.URL.Query().Get("view") == "projects"
	switch r.Method {
	case http.MethodGet:
		if projectsOnly {
			projects, err := a.canvas.ProjectList(ownerID)
			if err != nil {
				writeCanvasMutationError(w, err, "failed to load canvas projects")
				return
			}
			util.WriteJSON(w, http.StatusOK, projects)
			return
		}
		workspace, err := a.canvasAgent.Workspace(identity, r.URL.Query().Get("project_id"), r.URL.Query()["session_id"], service.CanvasHistoryScope(r.URL.Query().Get("history")))
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas")
			return
		}
		workspace.Document, err = canvasHistoryResponse(r, workspace.Document)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas history")
			return
		}
		writeCanvasHistoryJSON(w, r, len(workspace.Document.AgentSessions), workspace)
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
		} else if action == "activate" {
			workspace, err = a.canvasAgent.ActivateWorkspace(identity, input.ProjectID, service.CanvasHistoryScope(r.URL.Query().Get("history")))
		} else if action == "rename" || action == "delete" {
			if input.Revision == nil || *input.Revision < 0 {
				util.WriteError(w, http.StatusBadRequest, "canvas revision is required")
				return
			}
			workspace, err = a.canvas.UpdateProjectAtRevision(ownerID, action, input.ProjectID, input.Title, a.settleCanvasAgentRevision(identity, input.ProjectID, *input.Revision))
		} else {
			workspace, err = a.canvas.UpdateProject(ownerID, action, input.ProjectID, input.Title)
		}
		if err != nil {
			writeCanvasMutationError(w, err, "failed to update canvas project")
			return
		}
		if projectsOnly {
			util.WriteJSON(w, http.StatusOK, service.CanvasProjectList{Projects: workspace.Projects, ActiveProjectID: workspace.ActiveProjectID})
			return
		}
		workspace.Document, err = canvasHistoryResponse(r, workspace.Document)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas history")
			return
		}
		writeCanvasHistoryJSON(w, r, len(workspace.Document.AgentSessions), workspace)
	case http.MethodPut:
		var input service.CanvasDocument
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		document, err := a.canvas.SaveAtRevision(ownerID, input)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to save canvas")
			return
		}
		document, err = canvasHistoryResponse(r, document)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas history")
			return
		}
		writeCanvasHistoryJSON(w, r, len(document.AgentSessions), map[string]any{"document": document})
	case http.MethodDelete:
		revision, parseErr := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("revision")), 10, 64)
		if parseErr != nil || revision < 0 {
			util.WriteError(w, http.StatusBadRequest, "canvas revision is required")
			return
		}
		document, err := a.canvas.ClearAtRevision(ownerID, r.URL.Query().Get("project_id"), a.settleCanvasAgentRevision(identity, r.URL.Query().Get("project_id"), revision))
		if err != nil {
			writeCanvasMutationError(w, err, "failed to clear canvas")
			return
		}
		document, err = canvasHistoryResponse(r, document)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas history")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"document": document})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func writeCanvasMutationError(w http.ResponseWriter, err error, internalMessage string) {
	switch {
	case errors.Is(err, service.ErrCanvasAgentBusy):
		util.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrCanvasRevisionConflict):
		util.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrInvalidCanvasDocument):
		util.WriteError(w, http.StatusBadRequest, err.Error())
	default:
		util.WriteError(w, http.StatusInternalServerError, internalMessage)
	}
}

func (a *App) handleCanvasImageUpload(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	release, acquired := a.acquireImageUpload(r.Context())
	if !acquired {
		util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
		return
	}
	defer release()
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayImageBytes+(1<<20))
	if err := r.ParseMultipartForm(maxRelayImageMultipartMemory); err != nil {
		writeMultipartImageBodyError(w, err)
		return
	}
	defer r.MultipartForm.RemoveAll()
	header := firstMultipartFile(r.MultipartForm, "image")
	if header == nil {
		util.WriteError(w, http.StatusBadRequest, "image is required")
		return
	}
	upload, err := readUpload(header)
	if err != nil {
		writeMultipartImageBodyError(w, err)
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
	upload.ContentType = info.ContentType
	url, err := a.images.SaveImageBytes(r.Context(), upload.Data, a.config.BaseURL(), identityScope(identity), identityDisplayName(identity))
	if err != nil || url == "" {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
			return
		}
		util.WriteError(w, http.StatusInternalServerError, "failed to store image")
		return
	}
	if r.Context().Err() != nil {
		util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
		return
	}
	a.images.EnsureThumbnails([]string{url})
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": upload.ContentType, "size": len(upload.Data), "width": info.Width, "height": info.Height})
}
