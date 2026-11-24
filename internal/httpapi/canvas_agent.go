package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func requireAgentJSON(w http.ResponseWriter, r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err == nil && mediaType == "application/json" {
		return true
	}
	util.WriteError(w, http.StatusUnsupportedMediaType, "Agent 接口仅接受 application/json 请求")
	return false
}

func (a *App) handleCanvasAgentCompaction(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok || !requireAgentJSON(w, r) {
		return
	}
	if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") || !a.identityCanAccessAPI(identity, http.MethodPost, "/api/creation-tasks") {
		util.WriteError(w, http.StatusForbidden, "当前账号没有画布写入或生成权限")
		return
	}
	project := strings.TrimSpace(r.URL.Query().Get("project_id"))
	var request service.CanvasAgentCompactionRequest
	if project == "" || decodeStrictJSON(http.MaxBytesReader(w, r.Body, 16<<10), &request) != nil {
		util.WriteError(w, http.StatusBadRequest, "无效的上下文整理请求")
		return
	}
	if allowedPersonalModel(request.Model, a.config.TextModels()) == "" {
		util.WriteError(w, http.StatusBadRequest, "文本模型不可用")
		return
	}
	result, err := a.canvasAgent.Compact(r.Context(), identity, project, request)
	if err != nil {
		writeCanvasMutationError(w, err, "上下文整理失败，已保留已有记录")
		return
	}
	util.WriteJSON(w, http.StatusOK, result)
}

func (a *App) handleCanvasAgent(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	project := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if project == "" {
		util.WriteError(w, 400, "project_id is required")
		return
	}
	var doc service.CanvasDocument
	var err error
	switch r.Method {
	case http.MethodGet:
		w.Header().Add("Vary", "Accept")
		if r.Header.Get("Accept") == "text/event-stream" {
			a.streamCanvasAgent(w, r, identity, project)
			return
		}
		var workspace service.CanvasWorkspaceResult
		workspace, err = a.canvasAgent.Workspace(identity, project, r.URL.Query()["session_id"], service.CanvasHistoryScope(r.URL.Query().Get("history")))
		doc = workspace.Document
	case http.MethodPost:
		if !requireAgentJSON(w, r) {
			return
		}
		if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") || !a.identityCanAccessAPI(identity, http.MethodPost, "/api/creation-tasks") {
			util.WriteError(w, 403, "当前账号没有画布写入或生成权限")
			return
		}
		var req service.CanvasAgentRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&req); err != nil {
			util.WriteError(w, 400, "invalid agent request")
			return
		}
		if decoder.Decode(new(any)) != io.EOF {
			util.WriteError(w, 400, "invalid agent request")
			return
		}
		if allowedPersonalModel(req.Model, a.config.TextModels()) == "" {
			util.WriteError(w, 400, "文本模型不可用")
			return
		}
		req.MediaBaseURL = a.resolveImageBaseURL(r.Context())
		doc, err = a.canvasAgent.Start(identity, project, req)
	case http.MethodPatch:
		if !a.identityCanAccessAPI(identity, http.MethodPut, "/api/canvas") || !a.identityCanAccessAPI(identity, http.MethodPost, "/api/creation-tasks") {
			util.WriteError(w, http.StatusForbidden, "当前账号没有画布写入或生成权限")
			return
		}
		if !requireAgentJSON(w, r) {
			return
		}
		var update service.CanvasAgentQueueMutation
		if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 8<<20), &update); err != nil {
			util.WriteError(w, http.StatusBadRequest, "无效的队列请求")
			return
		}
		if update.Settings.Model != "" && allowedPersonalModel(update.Settings.Model, a.config.TextModels()) == "" {
			util.WriteError(w, http.StatusBadRequest, "文本模型不可用")
			return
		}
		update.Settings.MediaBaseURL = a.resolveImageBaseURL(r.Context())
		doc, err = a.canvasAgent.UpdateQueue(identity, project, update)
	case http.MethodDelete:
		err = a.canvasAgent.Stop(identity, project, r.URL.Query().Get("run_id"))
		if err == nil {
			doc, err = a.canvasAgent.Snapshot(identity, project)
		}
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		if errors.Is(err, service.ErrCanvasAgentBusy) {
			util.WriteError(w, 409, err.Error())
		} else {
			writeCanvasMutationError(w, err, "Agent 执行记录读写失败")
		}
		return
	}
	doc, err = canvasHistoryResponse(r, doc)
	if err != nil {
		writeCanvasMutationError(w, err, "Agent 执行记录读取失败")
		return
	}
	writeCanvasHistoryJSON(w, r, http.StatusOK, len(doc.AgentSessions), map[string]any{"document": doc})
}

func (a *App) streamCanvasAgent(w http.ResponseWriter, r *http.Request, identity service.Identity, project string) {
	runID := r.URL.Query().Get("run_id")
	if runID == "" || len(runID) > 128 {
		util.WriteError(w, http.StatusBadRequest, "请选择画布 Agent 任务")
		return
	}
	changed, stop := a.canvasAgent.WatchProgress(identity, project)
	defer stop()
	load := func() (service.CanvasDocument, error) {
		workspace, err := a.canvasAgent.Workspace(identity, project, nil, service.CanvasHistoryActive)
		return workspace.Document, err
	}
	document, err := load()
	if err != nil {
		writeCanvasMutationError(w, err, "读取画布 Agent 进度失败")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(frame string) error {
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.WriteString(w, frame); err != nil {
			return err
		}
		return controller.Flush()
	}
	writeError := func(status int, message string) {
		_ = write("data: " + agentJSONValue(map[string]any{"type": "error", "status": status, "message": message}) + "\n\n")
	}
	active := func() bool {
		return document.AgentRun != nil && document.AgentRun.ID == runID && document.AgentRun.Status == "running"
	}
	var baseline map[string]any
	var baseRevision int64
	publish := func() bool {
		encoded, err := json.Marshal(document)
		if err != nil {
			return false
		}
		var current map[string]any
		decoder := json.NewDecoder(bytes.NewReader(encoded))
		decoder.UseNumber()
		if err = decoder.Decode(&current); err != nil {
			return false
		}
		var data []byte
		if baseline == nil {
			data, err = json.Marshal(canvasProgressSnapshot{Type: "snapshot", Document: encoded})
		} else {
			ops := canvasProgressChanges([]canvasProgressOperation{}, nil, baseline, current)
			data, err = json.Marshal(canvasProgressDelta{Type: "delta", BaseRevision: baseRevision, Revision: document.Revision, Operations: ops})
		}
		baseline, baseRevision = current, document.Revision
		return err == nil && write("data: "+string(data)+"\n\n") == nil && active()
	}
	if !publish() {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		progress := false
		select {
		case <-r.Context().Done():
			return
		case <-changed:
			progress = true
		case <-heartbeat.C:
		}
		current, err := a.authenticateSession(r, requestAuthCookieToken(r))
		if err != nil {
			writeError(http.StatusServiceUnavailable, "读取登录会话失败")
			return
		}
		if current == nil {
			writeError(http.StatusUnauthorized, "登录会话已失效，请重新登录")
			return
		}
		if current.ID != identity.ID || current.OwnerID != identity.OwnerID || current.Role != identity.Role || !a.identityCanAccessRequest(*current, r) {
			writeError(http.StatusForbidden, "画布访问权限已更改，请刷新页面")
			return
		}
		if !progress {
			if write(": heartbeat\n\n") != nil {
				return
			}
			continue
		}
		revision := document.Revision
		previousStatus := document.AgentRun.Status
		document, err = load()
		if err != nil {
			writeError(http.StatusServiceUnavailable, "读取画布 Agent 进度失败")
			return
		}
		if active() && document.Revision <= revision && document.AgentRun.Status == previousStatus {
			continue
		}
		if !publish() {
			return
		}
	}
}

type agentModelDispatchKey struct{}

func (a *App) runAgentModel(ctx context.Context, identity service.Identity, req service.AgentModelRequest) (map[string]any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	messages, err := a.canvasAgentModelImages(ctx, identity, req.Messages)
	if err != nil {
		return nil, err
	}
	body := maps.Clone(req.Metadata)
	if body == nil {
		body = map[string]any{}
	}
	body["model"] = req.Model
	body["token_name"] = body["relay_token_name"]
	delete(body, "relay_token_name")
	if err := a.freezeRelayCredentialForTask(ctx, identity, body); err != nil {
		return nil, err
	}
	if err := a.tasks.CheckCreationRequestLimit(identity); err != nil {
		return nil, err
	}
	release, err := a.tasks.AcquireCreationUnit(ctx, identity)
	if err != nil {
		return nil, err
	}
	defer release()
	body["messages"] = messages
	if body["stream"] == true && body["api_mode"] != "responses" {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	modelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if req.BeforeDispatch != nil {
		modelCtx = context.WithValue(modelCtx, agentModelDispatchKey{}, req.BeforeDispatch)
	}
	var progressErr error
	if req.OnText != nil {
		body[service.TextOutputCallbackPayloadKey] = func(text string) {
			if progressErr != nil {
				return
			}
			progressErr = req.OnText(text)
			if progressErr != nil {
				cancel()
			}
		}
	}
	if req.OnReasoningSummary != nil {
		body[service.ReasoningSummaryCallbackPayloadKey] = func(id, text string, streaming bool) {
			if progressErr != nil {
				return
			}
			progressErr = req.OnReasoningSummary(id, text, streaming)
			if progressErr != nil {
				cancel()
			}
		}
	}
	args := map[string]any{"model": req.Model, "api_mode": body["api_mode"], "stream": body["stream"], "message_count": len(messages), "tool_count": len(util.AsMapSlice(body["tools"]))}
	if len(req.Diagnostic) > 0 {
		args["agent_run_id"] = req.RunID
		args["agent_model_attempt"] = req.Diagnostic
	}
	capture := auditRequestCapture{args: args}
	task, err := a.runLoggedChatTaskCaptured(modelCtx, identity, body, "/api/agent-model", "Agent 模型调用", capture)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if progressErr != nil {
		return nil, progressErr
	}
	if err != nil {
		return chatCompletionTaskData(task), err
	}
	data := util.AsMapSlice(task["data"])
	if len(data) == 0 {
		return nil, fmt.Errorf("模型没有返回内容")
	}
	return data[0], nil
}

func (a *App) runCanvasAgentMedia(ctx context.Context, identity service.Identity, n service.CanvasNode, metadata map[string]any, onProgress func(int) error) (map[string]any, error) {
	ctx = context.WithValue(ctx, mediaBaseURLContextKey{}, util.Clean(metadata["media_base_url"]))
	existing, err := a.tasks.ListTasksWithError(identity, []string{n.TaskID})
	if err != nil {
		return nil, err
	}
	if len(util.AsMapSlice(existing["items"])) > 0 {
		return a.waitCanvasAgentMedia(ctx, identity, n, onProgress)
	}
	body := map[string]any{"token_name": metadata["relay_token_name"], "prompt": n.Prompt, "client_task_id": n.TaskID}
	for k, v := range metadata {
		if k != "relay_token_name" && k != "media_base_url" {
			body[k] = v
		}
	}
	switch n.Type {
	case "image":
		body["model"] = n.GenerationModel
		body["size"] = n.GenerationSize
		body["quality"] = n.GenerationQuality
		body["n"] = n.GenerationCount
		body["image_resolution"] = n.GenerationResolution
		body["api_mode"] = normalizeImageTaskAPIMode("", n.GenerationModel)
		if allowedPersonalModel(n.GenerationModel, a.config.ImageModels()) == "" {
			return nil, fmt.Errorf("图片模型不可用")
		}
		a.attachImageModelDefinition(body)
		images := []protocol.UploadedImage{}
		for _, url := range n.GenerationReferenceURLs {
			image, loadErr := a.canvasAgentImage(ctx, identity, url)
			if loadErr != nil {
				return nil, loadErr
			}
			images = append(images, image)
		}
		endpoint := "/api/creation-tasks/image-generations"
		if len(images) > 0 {
			endpoint = "/api/creation-tasks/image-edits"
		}
		if err = validateRelayImageRequest(endpoint, n.GenerationModel, body, images); err != nil {
			return nil, err
		}
		if err = a.freezeRelayCredentialForTask(ctx, identity, body); err != nil {
			return nil, err
		}
		if frozen, ok := body[relayTaskCredentialKey].(frozenTaskCredential); ok && frozen.credential.Custom {
			if err := service.PreflightMediaEndpoint(ctx, frozen.credential.BaseURL); err != nil {
				return nil, fmt.Errorf("生成前路由预检失败，未提交上游任务: %w", err)
			}
		}
		if len(images) > 0 {
			_, err = a.tasks.SubmitEditWithOptions(ctx, identity, n.TaskID, n.Prompt, n.GenerationModel, n.GenerationSize, n.GenerationQuality, a.relayBaseURL(), images, n.GenerationCount, imageTaskRequestMetadata(body), service.ImageOutputOptions{Format: n.GenerationOutputFormat, Compression: n.GenerationOutputCompression}, service.ImageToolOptions{Options: n.GenerationImageOptions})
		} else {
			_, err = a.tasks.SubmitGenerationWithOptions(ctx, identity, n.TaskID, n.Prompt, n.GenerationModel, n.GenerationSize, n.GenerationQuality, a.relayBaseURL(), n.GenerationCount, imageTaskRequestMetadata(body), service.ImageOutputOptions{Format: n.GenerationOutputFormat, Compression: n.GenerationOutputCompression}, service.ImageToolOptions{Options: n.GenerationImageOptions})
		}
	case "video":
		model := n.GenerationVideoModel
		allowed := false
		for _, v := range a.configuredVideoModels() {
			if v == model {
				allowed = true
			}
		}
		if !allowed {
			return nil, fmt.Errorf("视频模型不可用")
		}
		contract, ok := protocol.VideoContractForModel(model)
		if !ok {
			return nil, fmt.Errorf("视频模型契约不存在")
		}
		body["model"] = model
		body["size"] = n.GenerationVideoSize
		body["seconds"] = n.GenerationVideoSeconds
		body["resolution"] = n.GenerationVideoResolution
		body["generate_audio"] = n.GenerationVideoAudio != nil && *n.GenerationVideoAudio
		body["watermark"] = n.GenerationVideoWatermark != nil && *n.GenerationVideoWatermark
		body["parameters"] = n.GenerationVideoParameters
		body["reference_mode"] = n.GenerationVideoReferenceMode
		body["reference_image_urls"] = n.GenerationVideoReferenceImages
		body["reference_video_urls"] = n.GenerationVideoReferenceURLs
		body["reference_audio_urls"] = n.GenerationVideoReferenceAudio
		if n.GenerationVideoReferenceMode != "reference" && n.GenerationVideoLastFrameURL != "" {
			lastFrame, referenceErr := a.canvasAgentVideoReference(ctx, identity, n.GenerationVideoLastFrameURL, "image", contract)
			if referenceErr != nil {
				return nil, referenceErr
			}
			body["last_frame_url"] = lastFrame
		}
		for field, kind := range map[string]string{"reference_image_urls": "image", "reference_video_urls": "video", "reference_audio_urls": "audio"} {
			refs := []string{}
			for _, raw := range util.AsStringSlice(body[field]) {
				ref, e := a.canvasAgentVideoReference(ctx, identity, raw, kind, contract)
				if e != nil {
					return nil, e
				}
				refs = append(refs, ref)
			}
			body[field] = refs
		}
		if err = normalizeVideoContractInput(body, contract); err != nil {
			return nil, err
		}
		if err = a.freezeRelayCredentialForTask(ctx, identity, body); err != nil {
			return nil, err
		}
		if frozen, ok := body[relayTaskCredentialKey].(frozenTaskCredential); ok && frozen.credential.Custom {
			if err := service.PreflightMediaEndpoint(ctx, frozen.credential.BaseURL); err != nil {
				return nil, fmt.Errorf("生成前路由预检失败，未提交上游任务: %w", err)
			}
		}
		ref, e := a.videoContracts.ReferenceForContract(contract, model)
		if e != nil {
			return nil, e
		}
		meta := videoTaskRequestMetadata(body, contract)
		meta["video_contract"] = ref
		_, err = a.tasks.SubmitVideo(ctx, identity, n.TaskID, n.Prompt, model, util.Clean(body["size"]), util.ToInt(body["seconds"], 0), util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), util.ToBool(body["watermark"]), util.Clean(body["reference_mode"]), util.AsStringSlice(body["reference_image_urls"]), util.AsStringSlice(body["reference_video_urls"]), util.AsStringSlice(body["reference_audio_urls"]), meta)
	case "audio":
		body["model"] = n.GenerationAudioModel
		body["input"] = n.Prompt
		body["voice"] = n.GenerationAudioVoice
		body["instructions"] = n.GenerationAudioInstructions
		body["response_format"] = n.GenerationAudioFormat
		body["speed"] = n.GenerationAudioSpeed
		if allowedPersonalModel(n.GenerationAudioModel, a.config.AudioModels()) == "" {
			return nil, fmt.Errorf("音频模型不可用")
		}
		if err = validateAudioGenerationPayload(body); err != nil {
			return nil, err
		}
		if err = a.freezeRelayCredentialForTask(ctx, identity, body); err != nil {
			return nil, err
		}
		if frozen, ok := body[relayTaskCredentialKey].(frozenTaskCredential); ok && frozen.credential.Custom {
			if err := service.PreflightMediaEndpoint(ctx, frozen.credential.BaseURL); err != nil {
				return nil, fmt.Errorf("生成前路由预检失败，未提交上游任务: %w", err)
			}
		}
		_, err = a.tasks.SubmitAudio(ctx, identity, n.TaskID, body, creationTaskRequestMetadata(body))
	default:
		return nil, fmt.Errorf("不支持的媒体类型")
	}
	if err != nil {
		return nil, err
	}
	return a.waitCanvasAgentMedia(ctx, identity, n, onProgress)
}
