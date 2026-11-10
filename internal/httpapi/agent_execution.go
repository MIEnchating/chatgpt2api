package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
	"github.com/google/uuid"
)

type agentExecutionIDKey struct{}

func agentExecutionID(ctx context.Context) string {
	if id, _ := ctx.Value(agentExecutionIDKey{}).(string); id != "" {
		return id
	}
	return uuid.NewString()
}

func (a *App) handleAgentExecution(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.imageRequestIdentity(w, r)
	if !ok {
		return
	}
	id, domain := r.URL.Query().Get("id"), r.URL.Query().Get("domain")
	if id == "" && domain != "workflow" && domain != "video_contract" && domain != "studio" {
		util.WriteError(w, 400, "请选择 Agent 业务")
		return
	}
	run, err := a.agentExecutions.Snapshot(identity, id, domain)
	if err != nil {
		if errors.Is(err, service.ErrAgentExecutionNotFound) {
			util.WriteJSON(w, 200, map[string]any{"run": nil})
			return
		}
		util.WriteError(w, 500, "读取 Agent 进度失败")
		return
	}
	permissionMethod := http.MethodGet
	if r.Method != http.MethodGet {
		permissionMethod = http.MethodPost
	}
	if run.Domain == "video_contract" && identity.Role != service.AuthRoleAdmin || run.Domain == "workflow" && !a.identityCanAccessAPI(identity, permissionMethod, "/api/workflows/agent-draft") || run.Domain == "studio" && !a.identityCanAccessAPI(identity, permissionMethod, "/api/creation-tasks") || run.Domain != "workflow" && run.Domain != "video_contract" && run.Domain != "studio" {
		util.WriteError(w, 403, "没有访问此 Agent 任务的权限")
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		if run.Domain == "studio" && r.ContentLength != 0 {
			body, readErr := readJSONMapLimit(r, 16<<10)
			if readErr != nil {
				util.WriteError(w, 400, "无效的回答")
				return
			}
			if err = a.agentExecutions.AnswerQuestion(identity, run.ID, util.Clean(body["callId"]), util.Clean(body["answer"])); err != nil {
				util.WriteError(w, 409, err.Error())
				return
			}
		}
		run, err = a.agentExecutions.Resume(identity, run.ID)
	case http.MethodDelete:
		err = a.agentExecutions.Stop(identity, run.ID)
		if err == nil && run.Domain == "studio" {
			var state studioAgentState
			if json.Unmarshal([]byte(agentJSONValue(run.Result)), &state) == nil {
				for _, task := range state.Tasks {
					_, _ = a.tasks.CancelTask(identity, task.ID)
				}
			}
		}
		if err == nil {
			run, err = a.agentExecutions.Snapshot(identity, run.ID, "")
		}
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		util.WriteError(w, 400, err.Error())
		return
	}
	util.WriteJSON(w, 200, map[string]any{"run": run})
}

func (a *App) executeWorkflowAgent(ctx context.Context, identity service.Identity, worker *service.AgentExecutionWorker) error {
	var input service.WorkflowAgentDraftRequest
	if err := worker.Input(&input); err != nil {
		return err
	}
	tools := []map[string]any{{"type": "function", "function": map[string]any{"name": "submit_workflow", "description": "提交完整工作流草稿，服务端校验成功后完成。", "parameters": map[string]any{"type": "object", "properties": map[string]any{"draft": map[string]any{"type": "object", "additionalProperties": true}}, "required": []string{"draft"}, "additionalProperties": false}}}}
	messages := service.WorkflowAgentMessages(input.Prompt, input.References)
	// The existing workflow schema remains authoritative; the SDK owns correction turns.
	instructions := service.WorkflowAgentSystemPrompt + "\n使用 submit_workflow 工具提交上述 JSON 对象，放在 draft 参数中。校验失败时修正后重新提交，不以普通文字结束任务。"
	config := map[string]any{"name": "Workflow Agent", "completionTool": "submit_workflow", "tools": tools, "inputProtocol": messages[1:], "maxTurns": 12}
	return worker.Run(ctx, config, func(method string, params map[string]any) (any, error) {
		switch method {
		case "context":
			return map[string]any{"instructions": instructions}, nil
		case "prepare":
			return prepareDomainAgentTurn(params, tools), nil
		case "model":
			return a.runDomainAgentModel(ctx, identity, worker, input.Model, input.ChannelID, tools, params, nil, "required")
		case "tool":
			if params["name"] != "submit_workflow" {
				return nil, errors.New("未知的工作流工具")
			}
			draft, warnings, err := service.NormalizeWorkflowAgentDraft(agentJSONValue(util.StringMap(params["arguments"])["draft"]), input.Scope)
			if err == nil && (strings.TrimSpace(util.Clean(draft["name"])) == "" || strings.TrimSpace(util.Clean(util.StringMap(draft["config"])["prompt_template"])) == "") {
				err = errors.New("工作流必须包含名称和完整的提示词模板")
			}
			if err != nil {
				return map[string]any{"result": map[string]any{"ok": false, "message": err.Error()}}, nil
			}
			worker.SetResult(service.WorkflowAgentDraftResponse{Draft: draft, Warnings: warnings, Model: input.Model})
			return map[string]any{"result": map[string]any{"ok": true, "text": "工作流草稿已生成，请审核后应用。"}}, nil
		}
		return nil, errors.New("不支持的 Agent 请求")
	})
}
func agentJSONValue(value any) string { data, _ := json.Marshal(value); return string(data) }
func prepareDomainAgentTurn(params map[string]any, tools []map[string]any) map[string]any {
	turn := util.StringMap(params["turn"])
	if turn["finish_reason"] == "length" || turn["finish_reason"] == "incomplete" {
		return map[string]any{"error": "模型输出不完整，请缩小本次工具输出并继续。"}
	}
	calls := util.AsMapSlice(turn["tool_calls"])
	if len(calls) != 1 {
		return map[string]any{"error": "每轮必须且只能调用一个业务工具，请纠正后继续。"}
	}
	call := calls[0]
	function := util.StringMap(call["function"])
	var arguments map[string]any
	if util.Clean(call["id"]) == "" || json.Unmarshal([]byte(util.Clean(function["arguments"])), &arguments) != nil || arguments == nil {
		return map[string]any{"error": "工具调用必须包含唯一 ID 和有效的 JSON 对象参数"}
	}
	for _, tool := range tools {
		if util.StringMap(tool["function"])["name"] == function["name"] {
			return map[string]any{}
		}
	}
	return map[string]any{"error": "未知业务工具，请使用已提供的工具"}
}
func (a *App) runDomainAgentModel(ctx context.Context, identity service.Identity, worker *service.AgentExecutionWorker, model, token string, tools []map[string]any, params map[string]any, onText func(string) error, toolChoice any) (map[string]any, error) {
	if allowedPersonalModel(model, a.config.TextModels()) == "" {
		return nil, errors.New("文本模型不可用")
	}
	metadata := map[string]any{"api_mode": "chat", "stream": true, "relay_token_name": token, "prompt_cache_key": params["promptCacheKey"]}
	if params["summary"] != true {
		metadata["tools"] = tools
		metadata["tool_choice"] = toolChoice
		metadata["parallel_tool_calls"] = false
	} else {
		metadata["max_output_tokens"] = 4000
	}
	if err := worker.Event(map[string]any{"stage": "generating", "message": "正在处理任务"}); err != nil {
		return nil, err
	}
	return a.runAgentModel(ctx, identity, service.AgentModelRequest{Model: model, Messages: util.AsMapSlice(params["messages"]), Metadata: metadata, OnText: onText})
}

func (a *App) waitAgentExecution(ctx context.Context, identity service.Identity, id string, report func(map[string]any)) (service.AgentExecution, error) {
	sequence := 0
	return service.WaitAgentExecution(ctx, a.agentExecutions, identity, id, func(run service.AgentExecution) {
		if report == nil {
			return
		}
		for _, event := range run.Events {
			next := util.ToInt(event["sequence"], 0)
			if next > sequence {
				report(event)
				sequence = next
			}
		}
	})
}

func requestAgentExecutionID(r *http.Request) string {
	id := strings.TrimSpace(r.Header.Get("X-Agent-Run-ID"))
	if id == "" {
		return uuid.NewString()
	}
	return id
}
