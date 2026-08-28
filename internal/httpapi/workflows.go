package httpapi

import (
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
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
	if remainder == "agent-draft" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
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
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, "", strings.TrimSpace(input.ChannelID)); err != nil {
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
		return
	}
	if remainder == "" {
		switch r.Method {
		case http.MethodGet:
			items, err := a.workflows.List(ownerID, identity.Role)
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load workflows")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost, http.MethodPut:
			var input service.CreativeWorkflow
			if err := util.DecodeJSON(r.Body, &input); err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			item, err := a.workflows.Save(ownerID, identity.Role, input)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
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
	if len(parts) == 1 && r.Method == http.MethodDelete {
		if err := a.workflows.Delete(ownerID, identity.Role, id); err != nil {
			util.WriteError(w, http.StatusForbidden, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.NotFound(w, r)
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
