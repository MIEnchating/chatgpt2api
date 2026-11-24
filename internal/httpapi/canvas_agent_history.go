package httpapi

import (
	"compress/gzip"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCanvasAgentTextTask(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	projectID, sessionID, taskID := query.Get("project_id"), query.Get("session_id"), query.Get("task_id")
	revision, err := strconv.Atoi(query.Get("revision"))
	if err != nil || revision < 1 || strings.TrimSpace(projectID) == "" || strings.TrimSpace(sessionID) == "" || strings.TrimSpace(taskID) == "" {
		util.WriteError(w, http.StatusBadRequest, "编辑任务标识或修订号无效")
		return
	}
	detail, err := a.canvas.AgentTextTaskDetail(identityScope(identity), projectID, sessionID, taskID, revision)
	if err != nil {
		if errors.Is(err, service.ErrCanvasRevisionConflict) {
			util.WriteError(w, http.StatusConflict, "编辑任务已更新，请刷新画布后查看")
			return
		}
		writeCanvasMutationError(w, err, "读取编辑任务详情失败")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	util.WriteJSON(w, http.StatusOK, detail)
}

func (a *App) handleCanvasAgentFeedback(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") {
		util.WriteError(w, http.StatusForbidden, "当前账号没有画布写入权限")
		return
	}
	if !requireAgentJSON(w, r) {
		return
	}
	var request service.CanvasAgentFeedbackRequest
	if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 64<<10), &request); err != nil {
		util.WriteError(w, http.StatusBadRequest, "无效的消息反馈请求")
		return
	}
	document, err := a.canvasAgent.SaveMessageFeedback(identity, strings.TrimSpace(r.URL.Query().Get("project_id")), request)
	conflict := errors.Is(err, service.ErrCanvasAgentFeedbackConflict)
	if err != nil && !conflict {
		writeCanvasMutationError(w, err, "保存消息反馈失败")
		return
	}
	document, err = service.CanvasAgentHistoryView(document, []string{request.SessionID})
	if err != nil {
		writeCanvasMutationError(w, err, "读取消息反馈失败")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	status := http.StatusOK
	payload := map[string]any{"document": document}
	if conflict {
		status = http.StatusConflict
		payload["error"] = map[string]string{"code": "feedback_version_conflict", "message": service.ErrCanvasAgentFeedbackConflict.Error()}
	}
	writeCanvasHistoryJSON(w, r, status, len(document.AgentSessions), payload)
}

type canvasGzipResponse struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w canvasGzipResponse) Write(data []byte) (int, error) {
	return w.writer.Write(data)
}

// Compress large, authenticated transcript responses without changing their JSON.
func writeCanvasHistoryJSON(w http.ResponseWriter, r *http.Request, status, historyBytes int, payload any) {
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
	util.WriteJSON(w, status, payload)
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
	if r.Method == http.MethodPost {
		if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") {
			util.WriteError(w, http.StatusForbidden, "当前账号没有画布写入权限")
			return
		}
		if !requireAgentJSON(w, r) {
			return
		}
		var request service.CanvasAgentHistoryBranchRequest
		if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 16<<10), &request); err != nil {
			util.WriteError(w, http.StatusBadRequest, "无效的分支请求")
			return
		}
		document, err := a.canvasAgent.BranchHistory(identity, projectID, request)
		if err == nil {
			document, err = service.CanvasAgentHistoryView(document, []string{request.BranchID})
		}
		if err != nil {
			writeCanvasMutationError(w, err, "创建对话分支失败")
			return
		}
		writeCanvasHistoryJSON(w, r, http.StatusOK, len(document.AgentSessions), map[string]any{"document": document})
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
		writeCanvasHistoryJSON(w, r, http.StatusOK, len(session), map[string]any{"session": session, "revision": revision})
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
	if r.URL.Query().Has("q") {
		query := r.URL.Query()
		page, err := a.canvas.SearchAgentHistory(r.Context(), ownerID, projectID, service.CanvasAgentHistorySearch{
			Query: query.Get("q"), Role: query.Get("role"), SessionID: query.Get("in_session"), Cursor: query.Get("cursor"), Limit: limit,
		})
		if err != nil {
			writeCanvasMutationError(w, err, "无法搜索历史对话")
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		util.WriteJSON(w, http.StatusOK, page)
		return
	}
	page, err := a.canvas.AgentHistoryPage(ownerID, projectID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeCanvasMutationError(w, err, "failed to load canvas history page")
		return
	}
	util.WriteJSON(w, http.StatusOK, page)
}
