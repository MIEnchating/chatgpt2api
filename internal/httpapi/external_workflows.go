package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) cachedAutoDLWorkflows(ctx context.Context, client protocol.AutoDLClient, baseURL, id string) ([]model.AutoDLWorkflow, error) {
	normalized, err := protocol.AutoDLURL(baseURL, "")
	if err != nil {
		return nil, err
	}
	return a.autoDL.Workflows(ctx, client, normalized, id)
}

func (a *App) handleExternalWorkflowModels(w http.ResponseWriter, r *http.Request, credential relayCredential, started time.Time, identity service.Identity) bool {
	switch credential.Protocol {
	case "autodl":
		items, err := a.cachedAutoDLWorkflows(r.Context(), protocol.AutoDLClient{HTTP: a.relayHTTPClientForContext(r.Context())}, credential.BaseURL, "")
		models := make([]map[string]any, 0, len(items))
		for _, item := range items {
			models = append(models, map[string]any{"id": item.UUID, "object": "model", "name": item.Name, "kind": item.Kind})
		}
		a.writeUpstreamModelsResponse(w, r, map[string]any{"object": "list", "data": models}, err, started, identity)
		return true
	case "ark":
		result, err := a.relayJSONAt(r.Context(), credential.BaseURL, http.MethodGet, "/models", credential.APIKey, nil)
		var httpErr protocol.HTTPError
		if errors.As(err, &httpErr) && httpErr.Status == http.StatusNotFound && strings.Contains(credential.BaseURL, "/api/plan/") {
			err = protocol.HTTPError{Status: http.StatusBadRequest, Message: "方舟 Agent Plan 未提供 /models，请在模型配置中手动填写套餐支持的模型名"}
		}
		a.writeUpstreamModelsResponse(w, r, result, err, started, identity)
		return true
	}
	return false
}

func (a *App) handleAutoDLWorkflows(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	credential, err := a.relayCredentialForIdentitySelection(r.Context(), identity, r.URL.Query().Get("token_group"), r.URL.Query().Get("token_name"))
	if err != nil {
		a.writeCreationTaskSubmitError(w, err)
		return
	}
	if credential.Protocol != "autodl" {
		util.WriteError(w, http.StatusBadRequest, "请选择协议为 AutoDL 的自定义 API 配置")
		return
	}
	ctx := r.Context()
	if credential.Custom {
		ctx = withCustomRelayContext(ctx)
	}
	items, err := a.cachedAutoDLWorkflows(ctx, protocol.AutoDLClient{HTTP: a.relayHTTPClientForContext(ctx)}, credential.BaseURL, strings.TrimSpace(r.URL.Query().Get("workflow_id")))
	if err != nil {
		util.WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	if r.URL.Query().Get("draft") == "video" {
		if len(items) != 1 {
			util.WriteError(w, http.StatusBadRequest, "请先选择一个视频工作流")
			return
		}
		contract, err := protocol.AutoDLVideoContract(items[0])
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"contract": contract})
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func arkVideoRequest(payload map[string]any, contract protocol.VideoModelContract) (map[string]any, error) {
	request := declaredCanonicalVideoContractRequestPayload(payload, contract)
	refs := protocol.ArkVideoReferences{}
	refs.FirstFrame = util.Clean(videoJSONPathValue(request, contract.Request.FirstFrameField))
	refs.LastFrame = util.Clean(videoJSONPathValue(request, contract.Request.LastFrameField))
	refs.Images = util.AsStringSlice(videoJSONPathValue(request, contract.Request.ReferenceImagesField))
	refs.Videos = util.AsStringSlice(videoJSONPathValue(request, contract.Request.ReferenceVideosField))
	refs.Audio = util.AsStringSlice(videoJSONPathValue(request, contract.Request.ReferenceAudiosField))
	content, err := protocol.ArkVideoContent(util.Clean(payload["prompt"]), refs)
	if err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	for _, field := range []string{contract.Request.FirstFrameField, contract.Request.LastFrameField, contract.Request.ReferenceImagesField, contract.Request.ReferenceVideosField, contract.Request.ReferenceAudiosField, contract.Request.GenerationModeField} {
		if field != "" {
			videoDeleteObjectPath(request, field)
		}
	}
	result := map[string]any{"model": payload["model"], "content": content}
	for source, target := range map[string]string{"seconds": "duration", "size": "ratio", "resolution": "resolution", "generate_audio": "generate_audio", "watermark": "watermark"} {
		if value, ok := payload[source]; ok {
			result[target] = value
		}
	}
	return result, nil
}

func arkVideoPollingContract(contract protocol.VideoModelContract) protocol.VideoModelContract {
	contract.Transport = protocol.VideoModelContractTransport{LocalMaterial: "url", CreatePath: "/contents/generations/tasks", QueryPath: "/contents/generations/tasks/{task_id}"}
	contract.Polling.TaskIDFields = []string{"id"}
	contract.Polling.StatusFields = []string{"status"}
	contract.Polling.ErrorFields = []string{"error.message"}
	contract.Polling.QueuedStatuses = []string{"queued"}
	contract.Polling.RunningStatuses = []string{"running"}
	contract.Polling.SuccessStatuses = []string{"succeeded"}
	contract.Polling.FailureStatuses = []string{"failed", "cancelled", "expired"}
	contract.Polling.ResultFields = []string{"content.video_url"}
	contract.Artifact = protocol.VideoModelContractArtifact{Mode: "response_url", Auth: "none"}
	return contract
}

func (a *App) relayAutoDLTask(ctx context.Context, payload map[string]any, kind string, timeout time.Duration) (map[string]any, error) {
	ctx = relayContextForPayload(ctx, payload)
	client := protocol.AutoDLClient{HTTP: a.relayHTTPClientForContext(ctx)}
	baseURL := a.relayBaseURLFromPayload(payload)
	model := strings.TrimSpace(util.Clean(payload["model"]))
	items, err := a.cachedAutoDLWorkflows(ctx, client, baseURL, model)
	if err != nil {
		return nil, err
	}
	if len(items) != 1 || items[0].Kind != kind {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "AutoDL 工作流类型与生成任务不匹配"}
	}
	request, err := protocol.AutoDLRequest(items[0], payload)
	if err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	task, err := client.Task(ctx, baseURL, model, relayAPIKeyFromPayload(payload), request)
	if err != nil {
		return nil, err
	}
	for {
		switch strings.ToLower(task.Status) {
		case "success", "succeeded", "completed":
			uri, mime, outputErr := task.Output(kind)
			if outputErr != nil {
				return nil, outputErr
			}
			return map[string]any{"model": model, "output_type": kind, "data": []map[string]any{{"type": kind, "url": uri, kind + "_url": uri, "mime_type": mime}}}, nil
		case "failed", "error", "cancelled", "canceled":
			return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "AutoDL 工作流执行失败"}
		case "queued", "pending", "running", "processing", "in_progress":
		default:
			return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "AutoDL 返回未知任务状态"}
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, protocol.HTTPError{Status: http.StatusGatewayTimeout, Message: "AutoDL 工作流执行超时"}
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
		task, err = client.Task(ctx, baseURL, task.ID, relayAPIKeyFromPayload(payload), nil)
		if err != nil {
			return nil, err
		}
	}
}
