package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCanvasAgentTool(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") || !a.identityCanAccessAPI(identity, http.MethodPost, "/api/creation-tasks") {
		util.WriteError(w, 403, "当前账号没有画布写入或生成权限")
		return
	}
	project := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if project == "" {
		util.WriteError(w, 400, "project_id is required")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	decoder.DisallowUnknownFields()
	var doc service.CanvasDocument
	var err error
	if strings.HasSuffix(r.URL.Path, "/review-answers") {
		var input service.CanvasAgentWorkflowReviewAnswer
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
			util.WriteError(w, 400, "invalid review answer")
			return
		}
		doc, err = a.canvasAgent.AnswerWorkflowReview(identity, project, input)
	} else {
		var input service.CanvasAgentToolRequest
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
			util.WriteError(w, 400, "invalid tool request")
			return
		}
		doc, err = a.canvasAgent.StartTool(identity, project, input)
	}
	if err != nil {
		if errors.Is(err, service.ErrCanvasAgentBusy) {
			util.WriteError(w, 409, err.Error())
		} else {
			writeCanvasMutationError(w, err, "画布工具执行失败")
		}
		return
	}
	util.WriteJSON(w, 200, map[string]any{"document": doc})
}
