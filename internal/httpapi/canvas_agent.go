package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

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
		doc, err = a.canvasAgent.Snapshot(identity, project)
	case http.MethodPost:
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
		doc, err = a.canvasAgent.Start(identity, project, req)
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
	util.WriteJSON(w, 200, map[string]any{"document": doc})
}

func (a *App) runCanvasAgentModel(ctx context.Context, identity service.Identity, req service.CanvasAgentModelRequest) (map[string]any, error) {
	messages, err := a.canvasAgentModelImages(ctx, identity, req.Messages)
	if err != nil {
		return nil, err
	}
	body := req.Metadata
	body["model"] = req.Model
	body["token_name"] = body["relay_token_name"]
	delete(body, "relay_token_name")
	if err := a.freezeRelayCredentialForTask(ctx, identity, body); err != nil {
		return nil, err
	}
	if _, err := a.tasks.SubmitChatWithMetadata(ctx, identity, req.TaskID, req.Prompt, req.Model, messages, chatTaskRequestMetadata(body)); err != nil {
		return nil, err
	}
	task, err := service.WaitCanvasAgentTask(ctx, a.tasks, identity, req.TaskID, req.OnText)
	if err != nil {
		if ctx.Err() != nil {
			_, _ = a.tasks.CancelTask(identity, req.TaskID)
		}
		return nil, err
	}
	data := util.AsMapSlice(task["data"])
	if len(data) == 0 {
		return nil, fmt.Errorf("模型没有返回内容")
	}
	return data[0], nil
}

func (a *App) runCanvasAgentMedia(ctx context.Context, identity service.Identity, n service.CanvasNode, metadata map[string]any) (map[string]any, error) {
	existing, err := a.tasks.ListTasksWithError(identity, []string{n.TaskID})
	if err != nil {
		return nil, err
	}
	if len(util.AsMapSlice(existing["items"])) > 0 {
		return service.WaitCanvasAgentTask(ctx, a.tasks, identity, n.TaskID, nil)
	}
	body := map[string]any{"token_name": metadata["relay_token_name"], "prompt": n.Prompt, "client_task_id": n.TaskID}
	for k, v := range metadata {
		if k != "relay_token_name" {
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
		if len(images) > 0 {
			_, err = a.tasks.SubmitEditWithOptions(ctx, identity, n.TaskID, n.Prompt, n.GenerationModel, n.GenerationSize, n.GenerationQuality, a.relayBaseURL(), images, n.GenerationCount, imageTaskRequestMetadata(body), service.ImageOutputOptions{Format: n.GenerationOutputFormat, Compression: n.GenerationOutputCompression}, service.ImageToolOptions{})
		} else {
			_, err = a.tasks.SubmitGenerationWithOptions(ctx, identity, n.TaskID, n.Prompt, n.GenerationModel, n.GenerationSize, n.GenerationQuality, a.relayBaseURL(), n.GenerationCount, imageTaskRequestMetadata(body), service.ImageOutputOptions{Format: n.GenerationOutputFormat, Compression: n.GenerationOutputCompression}, service.ImageToolOptions{})
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
		body["reference_mode"] = n.GenerationVideoReferenceMode
		body["reference_image_urls"] = n.GenerationVideoReferenceImages
		body["reference_video_urls"] = n.GenerationVideoReferenceURLs
		body["reference_audio_urls"] = n.GenerationVideoReferenceAudio
		for field, kind := range map[string]string{"reference_image_urls": "image", "reference_video_urls": "video", "reference_audio_urls": "audio"} {
			refs := []string{}
			for _, raw := range util.AsStringSlice(body[field]) {
				ref, e := a.canvasAgentVideoReference(ctx, identity, raw, kind)
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
		ref, e := a.videoContracts.ReferenceForContract(contract, model)
		if e != nil {
			return nil, e
		}
		meta := videoTaskRequestMetadata(body, contract)
		meta["video_contract"] = ref
		_, err = a.tasks.SubmitVideo(ctx, identity, n.TaskID, n.Prompt, model, util.Clean(body["size"]), util.ToInt(body["seconds"], 0), util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), false, util.Clean(body["reference_mode"]), util.AsStringSlice(body["reference_image_urls"]), util.AsStringSlice(body["reference_video_urls"]), util.AsStringSlice(body["reference_audio_urls"]), meta)
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
		_, err = a.tasks.SubmitAudio(ctx, identity, n.TaskID, body, creationTaskRequestMetadata(body))
	default:
		return nil, fmt.Errorf("不支持的媒体类型")
	}
	if err != nil {
		return nil, err
	}
	return service.WaitCanvasAgentTask(ctx, a.tasks, identity, n.TaskID, nil)
}
