package httpapi

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

type canvasGzipResponse struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w canvasGzipResponse) Write(data []byte) (int, error) {
	return w.writer.Write(data)
}

// Compress large, authenticated transcript responses without changing their JSON.
func writeCanvasHistoryJSON(w http.ResponseWriter, r *http.Request, historyBytes int, payload any) {
	if historyBytes >= 32<<10 {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Add("Vary", "Accept-Encoding")
		if util.AcceptsGzip(strings.Join(r.Header.Values("Accept-Encoding"), ",")) {
			w.Header().Set("Content-Encoding", "gzip")
			writer, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
			defer writer.Close()
			w = canvasGzipResponse{ResponseWriter: w, writer: writer}
		}
	}
	util.WriteJSON(w, http.StatusOK, payload)
}

func canvasHistoryResponse(r *http.Request, document service.CanvasDocument) (service.CanvasDocument, error) {
	if r.URL.Query().Get("history") != "active" || document.AgentHistoryPartial {
		return document, nil
	}
	return service.CanvasAgentHistoryView(document, r.URL.Query()["session_id"])
}

func (a *App) handleCanvasAgentHistory(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		util.WriteError(w, http.StatusBadRequest, "project_id is required")
		return
	}
	ownerID := identityScope(identity)
	if sessionID := r.URL.Query().Get("session_id"); sessionID != "" {
		revision, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
		if err != nil || revision < 0 {
			util.WriteError(w, http.StatusBadRequest, "history revision is required")
			return
		}
		session, err := a.canvas.AgentHistorySession(ownerID, projectID, sessionID, revision)
		if err != nil {
			writeCanvasMutationError(w, err, "failed to load canvas history session")
			return
		}
		writeCanvasHistoryJSON(w, r, len(session), map[string]any{"session": session, "revision": revision})
		return
	}
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid history page size")
			return
		}
		limit = value
	}
	page, err := a.canvas.AgentHistoryPage(ownerID, projectID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeCanvasMutationError(w, err, "failed to load canvas history page")
		return
	}
	util.WriteJSON(w, http.StatusOK, page)
}
