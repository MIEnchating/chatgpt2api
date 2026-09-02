package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func (a *App) handleWorkflows(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	base := "/api/workflows"
	remainder := strings.Trim(strings.TrimPrefix(r.URL.Path, base), "/")
	if remainder == "" {
		switch r.Method {
		case http.MethodGet:
			items, err := a.workflows.List(ownerID)
			if err != nil {
				a.writeWorkflowServiceError(w, "list workflows", err)
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost, http.MethodPut:
			var input service.CreativeWorkflow
			if err := util.DecodeJSON(r.Body, &input); err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			item, err := a.workflows.Save(ownerID, input)
			if err != nil {
				a.writeWorkflowServiceError(w, "save workflow", err)
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	parts := strings.Split(remainder, "/")
	id := strings.TrimSpace(parts[0])
	if id == "" {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "last-run" {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var input struct {
			LastRunAt string `json:"last_run_at"`
		}
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid workflow last run body")
			return
		}
		item, err := a.workflows.TouchLastRun(ownerID, id, input.LastRunAt)
		if err != nil {
			a.writeWorkflowServiceError(w, "update workflow last run", err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodDelete {
		if err := a.workflows.Delete(ownerID, id); err != nil {
			a.writeWorkflowServiceError(w, "delete workflow", err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.NotFound(w, r)
}

func (a *App) handleWorkflowInitialize(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	var input struct {
		Items []service.CreativeWorkflow `json:"items"`
	}
	if err := util.DecodeJSON(r.Body, &input); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid workflow initialization body")
		return
	}
	items, err := a.workflows.InitializeIfEmpty(identityScope(identity), input.Items)
	if err != nil {
		a.writeWorkflowServiceError(w, "initialize workflows", err)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) writeWorkflowServiceError(w http.ResponseWriter, operation string, err error) {
	var validationErr service.WorkflowValidationError
	var storageErr *service.WorkflowStorageError
	switch {
	case errors.Is(err, service.ErrWorkflowNotFound):
		util.WriteError(w, http.StatusNotFound, "工作流不存在")
	case errors.Is(err, service.ErrWorkflowAccessDenied):
		util.WriteError(w, http.StatusForbidden, "只能操作自己的工作流")
	case errors.Is(err, storage.ErrConcurrentRowUpdate):
		util.WriteError(w, http.StatusConflict, "工作流已被其他请求修改，请刷新后重试")
	case errors.As(err, &storageErr):
		if a != nil && a.logger != nil {
			a.logger.Error("workflow storage operation failed", "operation", operation, "error", err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, "工作流存储暂时不可用，请稍后重试")
	case errors.As(err, &validationErr):
		util.WriteError(w, http.StatusBadRequest, validationErr.Error())
	default:
		if a != nil && a.logger != nil {
			a.logger.Error("workflow storage operation failed", "operation", operation, "error", err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, "工作流存储暂时不可用，请稍后重试")
	}
}

func (a *App) handleWorkflowAgentDraft(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	var input service.WorkflowAgentDraftRequest
	if err := util.DecodeJSON(r.Body, &input); err != nil {
		util.WriteError(w, http.StatusBadRequest, "工作流需求格式错误")
		return
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" {
		util.WriteError(w, http.StatusBadRequest, "请输入工作流需求")
		return
	}
	model := firstNonEmpty(strings.TrimSpace(input.Model), a.config.DefaultTextModel(), firstString(a.config.TextModels(), a.defaultChatModel()))
	if allowedPersonalModel(model, a.config.TextModels()) == "" {
		util.WriteError(w, http.StatusBadRequest, "文本模型不可用")
		return
	}
	payload := workflowAgentPayload(input, model)
	if err := a.validateRelayCredentialForIdentitySelection(r.Context(), identity, "", strings.TrimSpace(input.ChannelID)); err != nil {
		a.writeCreationTaskSubmitError(w, err)
		return
	}
	result, err := a.runLoggedChatTaskWithContext(r.Context(), identity, payload, "/api/workflows/agent-draft", "工作流 Agent")
	if err != nil {
		a.writeCreationTaskSubmitError(w, err)
		return
	}
	content := ""
	for _, item := range util.AsMapSlice(result["data"]) {
		if content = strings.TrimSpace(util.Clean(item["text_response"])); content != "" {
			break
		}
	}
	draft, warnings, err := service.NormalizeWorkflowAgentDraft(content, input.Scope)
	if err != nil {
		util.WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, service.WorkflowAgentDraftResponse{Draft: draft, Warnings: warnings, Model: model})
}

func workflowAgentPayload(input service.WorkflowAgentDraftRequest, model string) map[string]any {
	payload := map[string]any{
		"model":       model,
		"messages":    service.WorkflowAgentMessages(input.Prompt, input.References),
		"temperature": 0.2,
	}
	if channelID := strings.TrimSpace(input.ChannelID); channelID != "" {
		payload["token_name"] = channelID
	}
	return payload
}
