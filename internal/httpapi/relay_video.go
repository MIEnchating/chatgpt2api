package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func videoContractSnapshot(payload map[string]any, model string) (protocol.VideoModelContract, error) {
	raw, ok := payload[protocol.VideoContractSnapshotPayloadKey]
	if !ok || raw == nil {
		return protocol.VideoModelContract{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频任务缺少模型契约快照"}
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return protocol.VideoModelContract{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频模型契约快照无效"}
	}
	var contract protocol.VideoModelContract
	if err := json.Unmarshal(data, &contract); err != nil {
		return protocol.VideoModelContract{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频模型契约快照无效"}
	}
	contract, err = protocol.NormalizeVideoModelContract(contract)
	if err != nil {
		return protocol.VideoModelContract{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频模型契约快照无效: " + err.Error()}
	}
	if !protocol.VideoContractMatchesModel(contract, model) {
		return protocol.VideoModelContract{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("视频模型 %q 与任务契约快照不匹配", model)}
	}
	return contract, nil
}

// relayVideoTask submits a contract-declared asynchronous video request to the
// configured relay and polls it using the same protocol driver snapshot.
func (a *App) relayVideoTask(ctx context.Context, payload map[string]any) (map[string]any, error) {
	ctx = relayContextForPayload(ctx, payload)
	if result, matched, err := a.relayTranslatedMedia(ctx, payload, nil, "video"); matched || err != nil {
		return result, err
	}
	model := strings.TrimSpace(util.Clean(payload["model"]))
	contract, err := videoContractSnapshot(payload, model)
	if err != nil {
		return nil, err
	}
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频任务缺少上游令牌"}
	}
	if util.Clean(payload["relay_protocol"]) == "autodl" || contract.Driver == protocol.VideoContractDriverAutoDL {
		return a.relayAutoDLTask(ctx, payload, "video", time.Duration(contract.Polling.TimeoutSeconds)*time.Second)
	}
	request := declaredCanonicalVideoContractRequestPayload(payload, contract)
	if util.Clean(payload["relay_protocol"]) == "ark" || contract.Driver == protocol.VideoContractDriverArk {
		contract = arkVideoPollingContract(contract)
		request, err = arkVideoRequest(payload, contract)
		if err != nil {
			return nil, err
		}
	}
	baseURL := a.relayBaseURLFromPayload(payload)
	createPath, queryPath, err := videoContractDriverPaths(contract, payload)
	if util.Clean(payload["relay_protocol"]) == "ark" {
		createPath, queryPath = "/contents/generations/tasks", "/contents/generations/tasks/{task_id}"
	}
	if err != nil {
		return nil, err
	}
	kind, _ := videoContractGenerationKind(payload, contract)
	if err := validateVideoReferencePayloadURLs(request, contract, kind); err != nil {
		return nil, err
	}
	if contract.Driver == protocol.VideoContractDriverVolcengine && util.Clean(payload["relay_protocol"]) != "ark" {
		request, err = newAPIDoubaoVideoRequest(request, payload, contract)
		if err != nil {
			return nil, err
		}
	}
	created, err := a.relayVideoSubmitAt(ctx, baseURL, apiKey, createPath, request, contract, kind)
	if a.logger != nil {
		a.logger.Debug("video upstream submit", "method", http.MethodPost, "path", createPath, "model", model, "request_fields", sortedMapKeys(request), "response_fields", sortedMapKeys(created), "error", errorText(err), "task_id", videoContractFirstString(created, contract.Polling.TaskIDFields))
	}
	if err != nil {
		return created, err
	}
	relayVideoTaskProgress(payload, created, contract)
	if videoRelayTaskStatusForContract(created, contract) == "failed" {
		return created, protocol.HTTPError{Status: http.StatusBadGateway, Message: videoContractErrorMessage(created, contract)}
	}
	taskID := videoContractFirstString(created, contract.Polling.TaskIDFields)
	if taskID == "" {
		return created, protocol.HTTPError{Status: http.StatusBadGateway, Message: "视频上游没有返回任务 ID"}
	}
	interval := time.Duration(contract.Polling.IntervalSeconds) * time.Second
	timeout := time.Duration(contract.Polling.TimeoutSeconds) * time.Second
	pollCtx, cancelPolling := context.WithTimeout(ctx, timeout)
	defer cancelPolling()
	pollingError := func(err error) error {
		if parentErr := ctx.Err(); parentErr != nil {
			return parentErr
		}
		if errors.Is(pollCtx.Err(), context.DeadlineExceeded) {
			return protocol.HTTPError{Status: http.StatusGatewayTimeout, Message: "视频生成超时，请稍后重试"}
		}
		return err
	}
	for {
		if err := pollCtx.Err(); err != nil {
			return nil, pollingError(err)
		}
		state, pollErr := a.relayJSONAt(pollCtx, baseURL, http.MethodGet, videoContractTaskPath(queryPath, taskID), apiKey, nil)
		if pollErr != nil {
			return state, pollingError(pollErr)
		}
		relayVideoTaskProgress(payload, state, contract)
		status := videoRelayTaskStatusForContract(state, contract)
		if status == "completed" {
			// New API can settle a charged xAI task as completed while exposing
			// an explicit error instead of a retrievable video artifact.
			if detail := util.StringMap(state["error"]); util.Clean(detail["code"]) != "" && util.Clean(detail["message"]) != "" {
				return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: util.Clean(detail["message"])}
			}
			videoURL, videoAuth, artifactErr := videoArtifactURLForContract(state, baseURL, taskID, contract)
			if artifactErr != nil {
				return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: artifactErr.Error()}
			}
			if videoURL == "" {
				return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: "视频已完成但上游没有返回视频地址"}
			}
			if videoAuth == "relay" {
				if callback, ok := payload[service.VideoTaskProgressCallbackPayloadKey].(func(service.VideoTaskProgressUpdate)); ok {
					callback(service.VideoTaskProgressUpdate{Status: service.TaskStatusRunning, UpstreamTaskID: taskID, Progress: 100, HasProgress: true, Recovery: &service.VideoContentRecovery{
						TaskID: taskID, URL: videoURL, BaseURL: baseURL, AllowedHosts: contract.Artifact.AllowedHosts,
						TokenName: selectedRelayTokenNameFromPayload(payload), TokenGroup: selectedRelayTokenGroupFromPayload(payload),
					}})
				}
				localURL, saveErr := a.downloadRelayVideo(
					ctx,
					videoURL,
					apiKey,
					util.Clean(payload["owner_id"]),
					util.Clean(payload["client_task_id"]),
					taskID,
					baseURL,
					contract.Artifact.AllowedHosts,
				)
				if saveErr != nil {
					return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: "视频已生成但保存失败: " + saveErr.Error()}
				}
				videoURL = localURL
			}
			return map[string]any{"created": state["created_at"], "data": []map[string]any{{"url": videoURL, "type": "video", "mime_type": "video/mp4", "video_url": videoURL}}, "output_type": "video", "model": payload["model"]}, nil
		}
		if status == "failed" {
			return state, protocol.HTTPError{Status: http.StatusBadGateway, Message: videoContractErrorMessage(state, contract)}
		}
		timer := time.NewTimer(interval)
		select {
		case <-pollCtx.Done():
			timer.Stop()
			return nil, pollingError(pollCtx.Err())
		case <-timer.C:
		}
	}
}

func sortedMapKeys(value map[string]any) []string {
	if len(value) == 0 {
		return nil
	}
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func videoContractDriverPaths(contract protocol.VideoModelContract, payload map[string]any) (string, string, error) {
	if contract.Transport.CreatePath != "" || contract.Transport.QueryPath != "" {
		if contract.Transport.CreatePath == "" || contract.Transport.QueryPath == "" {
			return "", "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频模型契约必须同时配置任务创建路径和查询路径"}
		}
		return contract.Transport.CreatePath, contract.Transport.QueryPath, nil
	}
	switch contract.Driver {
	case protocol.VideoContractDriverArk:
		return "/contents/generations/tasks", "/contents/generations/tasks/{task_id}", nil
	case protocol.VideoContractDriverAutoDL:
		return protocol.AutoDLTaskPath(util.Clean(payload["model"]), false), "/api/v1/comfyui/comfyui_workflow/result/{task_id}", nil
	case protocol.VideoContractDriverOpenAI,
		protocol.VideoContractDriverXAI,
		protocol.VideoContractDriverGeminiVeo,
		protocol.VideoContractDriverVertexVeo,
		protocol.VideoContractDriverDashScope,
		protocol.VideoContractDriverVolcengine,
		protocol.VideoContractDriverMiniMax,
		protocol.VideoContractDriverVidu,
		protocol.VideoContractDriverKIE,
		protocol.VideoContractDriverAPIMart:
		return "/v1/videos", "/v1/videos/{task_id}", nil
	case protocol.VideoContractDriverKling:
		kind, valid := videoContractGenerationKind(payload, contract)
		if !valid {
			return "", "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频生成模式与 Kling 契约不匹配"}
		}
		switch kind {
		case "text":
			return "/kling/v1/videos/text2video", "/kling/v1/videos/text2video/{task_id}", nil
		case "image":
			return "/kling/v1/videos/image2video", "/kling/v1/videos/image2video/{task_id}", nil
		default:
			return "", "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "kling-video 传输驱动仅支持文生视频和图生视频"}
		}
	default:
		return "", "", protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频模型契约使用了不支持的传输驱动"}
	}
}

func videoContractTaskPath(template, taskID string) string {
	return strings.Replace(template, "{task_id}", url.PathEscape(taskID), 1)
}

func validateVideoReferencePayloadURLs(request map[string]any, contract protocol.VideoModelContract, kind string) error {
	allowLocalMaterial := contract.Transport.LocalMaterial == "multipart"
	fields := videoContractMaterialFields(contract, kind)
	seen := make(map[string]struct{}, len(fields))
	for _, material := range fields {
		field := strings.TrimSpace(material.name)
		if field == "" {
			continue
		}
		if _, exists := seen[field]; exists {
			continue
		}
		seen[field] = struct{}{}
		value := videoJSONPathValue(request, field)
		values := util.AsStringSlice(value)
		if len(values) == 0 {
			if scalar := strings.TrimSpace(util.Clean(value)); scalar != "" {
				values = []string{scalar}
			}
		}
		for _, value := range values {
			if isPublicReferenceURL(value) || allowLocalMaterial && isLocalVideoReferencePath(value) {
				continue
			}
			return protocol.HTTPError{Status: http.StatusBadRequest, Message: "视频参考素材必须使用公网可访问的 HTTP 或 HTTPS URL"}
		}
	}
	return nil
}
func (a *App) relayVideoSubmitAt(ctx context.Context, baseURL, apiKey, createPath string, request map[string]any, contract protocol.VideoModelContract, kind string) (map[string]any, error) {
	if contract.Transport.LocalMaterial == "multipart" {
		files, hasExternalURLs, err := a.extractContractLocalVideoMaterials(request, contract, kind)
		if err != nil {
			return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
		}
		if len(files) > 0 {
			if !contract.Transport.MultipartRepeatable {
				seenFields := map[string]bool{}
				for _, file := range files {
					field := firstNonEmpty(file.Field, contract.Transport.MultipartFileField)
					if seenFields[field] {
						return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "当前模型契约不允许同一字段提交多个本地素材"}
					}
					seenFields[field] = true
				}
			}
			if hasExternalURLs && !contract.Transport.MultipartMixedURLs {
				return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "当前模型契约不允许本地素材与公网 URL 混用"}
			}
			return a.relayVideoMultipart(ctx, baseURL, apiKey, createPath, request, contract.Transport.MultipartFileField, files)
		}
	}
	return a.relayJSONAt(ctx, baseURL, http.MethodPost, createPath, apiKey, request)
}

func (a *App) extractContractLocalVideoMaterials(request map[string]any, contract protocol.VideoModelContract, kind string) ([]videoMultipartFile, bool, error) {
	files := make([]videoMultipartFile, 0)
	hasExternalURLs := false
	fields := videoContractMaterialFields(contract, kind)
	seen := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if field.name == "" {
			continue
		}
		if _, exists := seen[field.name]; exists {
			continue
		}
		seen[field.name] = struct{}{}
		value := videoJSONPathValue(request, field.name)
		values := util.AsStringSlice(value)
		if len(values) == 0 {
			if scalar := strings.TrimSpace(util.Clean(value)); scalar != "" {
				values = []string{scalar}
			}
		}
		if len(values) == 0 {
			continue
		}
		external := make([]string, 0, len(values))
		for _, value := range values {
			file, local, err := a.localVideoReferenceFile(value)
			if err != nil {
				return nil, false, err
			}
			if local {
				file.Field = contract.Transport.MultipartFields[field.role]
				files = append(files, file)
				continue
			}
			external = append(external, value)
			hasExternalURLs = true
		}
		switch {
		case len(external) == 0:
			videoDeleteObjectPath(request, field.name)
		case field.scalar:
			videoSetObjectPath(request, field.name, external[0])
		default:
			videoSetObjectPath(request, field.name, external)
		}
	}
	return files, hasExternalURLs, nil
}

func (a *App) relayVideoMultipart(ctx context.Context, baseURL, apiKey, createPath string, payload map[string]any, fileField string, files []videoMultipartFile) (map[string]any, error) {
	req, err := relayVideoMultipartRequest(ctx, baseURL, apiKey, createPath, payload, fileField, files)
	if err != nil {
		return nil, err
	}
	resp, err := a.relayHTTPClientForContext(ctx).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return relayDecodeJSONResponse(resp)
}

func declaredVideoContractRequestPayload(payload map[string]any, contract protocol.VideoModelContract) map[string]any {
	ruleValues := videoContractRuleValues(payload, contract)
	protocol.ApplyVideoContractForcedValues(contract, ruleValues)
	return declaredVideoContractRequestPayloadFromRuleValues(payload, contract, ruleValues)
}

func declaredCanonicalVideoContractRequestPayload(payload map[string]any, contract protocol.VideoModelContract) map[string]any {
	return declaredVideoContractRequestPayloadFromRuleValues(payload, contract, videoContractRuleValues(payload, contract))
}

func declaredVideoContractRequestPayloadFromRuleValues(payload map[string]any, contract protocol.VideoModelContract, ruleValues map[string]any) map[string]any {
	request := map[string]any{
		"model":  strings.TrimSpace(util.Clean(payload["model"])),
		"prompt": payload["prompt"],
	}
	set := func(field string, value any) {
		if strings.TrimSpace(field) != "" && value != nil && strings.TrimSpace(util.Clean(value)) != "" {
			videoSetObjectPath(request, field, value)
		}
	}
	duration := util.ToInt(ruleValues["duration"], contract.Capability.DefaultSeconds)
	if contract.Request.DurationValueType == "string" {
		set(contract.Request.DurationField, strconv.Itoa(duration))
	} else {
		set(contract.Request.DurationField, duration)
	}
	set(contract.Request.AspectRatioField, firstNonEmpty(util.Clean(ruleValues["size"]), contract.Capability.DefaultSize))
	set(contract.Request.ResolutionField, firstNonEmpty(util.Clean(ruleValues["resolution"]), contract.Capability.DefaultResolution))
	if generateAudio, ok := ruleValues["generate_audio"].(bool); ok && contract.Capability.AudioControl != "none" && contract.Request.GenerateAudioField != "" {
		videoSetObjectPath(request, contract.Request.GenerateAudioField, generateAudio)
	}
	if watermark, ok := ruleValues["watermark"].(bool); ok && contract.Capability.Watermark && contract.Request.WatermarkField != "" {
		videoSetObjectPath(request, contract.Request.WatermarkField, watermark)
	}

	frameReferences := videoFrameAliases(payload)
	imageReferences := removeVideoFrameAliases(util.AsStringSlice(payload["reference_image_urls"]), frameReferences)
	videoReferences := util.AsStringSlice(payload["reference_video_urls"])
	audioReferences := util.AsStringSlice(payload["reference_audio_urls"])
	modeKind, validMode := videoContractGenerationKind(payload, contract)
	if !validMode {
		// Creation requests reject an unknown explicit value before they reach
		// this mapper. Keep direct internal callers deterministic as well.
		modeKind = inferredVideoContractGenerationKind(payload)
	}
	mode, hasMode := protocol.VideoContractModeForKind(contract, modeKind)
	modeValue := modeKind + "-to-video"
	if hasMode {
		modeValue = firstNonEmpty(mode.RequestValue, mode.ID)
	}
	set(contract.Request.GenerationModeField, modeValue)

	parameters, _ := payload["parameters"].(map[string]any)
	for _, parameter := range contract.Capability.Parameters {
		if !protocol.VideoParameterActive(parameter, modeKind) {
			continue
		}
		value, present := parameters[parameter.Name]
		if !present {
			value = parameter.Default
		}
		if value != nil {
			videoSetObjectPath(request, parameter.Field, value)
		}
	}
	if contract.Capability.Prompt != nil && !contract.Capability.Prompt.Required && util.Clean(payload["prompt"]) == "" {
		delete(request, "prompt")
	}
	setReference := func(field string, values []string) {
		if contract.Request.ReferenceValueType == "scalar" {
			videoSetObjectPath(request, field, values[0])
		} else {
			videoSetObjectPath(request, field, values)
		}
	}
	if modeKind == "reference" {
		if len(imageReferences) > 0 && contract.Request.ReferenceImagesField != "" {
			setReference(contract.Request.ReferenceImagesField, imageReferences)
		}
		if len(videoReferences) > 0 && contract.Request.ReferenceVideosField != "" {
			setReference(contract.Request.ReferenceVideosField, videoReferences)
		}
		if len(audioReferences) > 0 && contract.Request.ReferenceAudiosField != "" {
			setReference(contract.Request.ReferenceAudiosField, audioReferences)
		}
	} else if modeKind == "image" {
		firstFrame, lastFrame, _ := videoContractImageFrames(payload, imageReferences)
		set(contract.Request.FirstFrameField, firstFrame)
		set(contract.Request.LastFrameField, lastFrame)
	}
	return request
}

func videoSetObjectPath(target map[string]any, path string, value any) {
	segments, ok := parseVideoObjectPath(path)
	if !ok || len(segments) == 0 || segments[0].indexed {
		return
	}
	setVideoObjectPathValue(target, segments, value)
}

type videoObjectPathSegment struct {
	name    string
	index   int
	indexed bool
}

func parseVideoObjectPath(value string) ([]videoObjectPathSegment, bool) {
	value = strings.TrimSpace(value)
	segments := make([]videoObjectPathSegment, 0, 4)
	for position := 0; position < len(value); {
		start := position
		for position < len(value) && value[position] != '.' && value[position] != '[' {
			position++
		}
		if start == position {
			return nil, false
		}
		segments = append(segments, videoObjectPathSegment{name: value[start:position]})
		for position < len(value) && value[position] == '[' {
			end := strings.IndexByte(value[position:], ']')
			if end < 0 {
				return nil, false
			}
			end += position
			index, err := strconv.Atoi(value[position+1 : end])
			if err != nil || index < 0 {
				return nil, false
			}
			segments = append(segments, videoObjectPathSegment{index: index, indexed: true})
			position = end + 1
		}
		if position == len(value) {
			break
		}
		if value[position] != '.' {
			return nil, false
		}
		position++
	}
	return segments, len(segments) > 0
}

func setVideoObjectPathValue(current any, segments []videoObjectPathSegment, value any) any {
	if len(segments) == 0 {
		return value
	}
	segment := segments[0]
	if segment.indexed {
		items, _ := current.([]any)
		if len(items) <= segment.index {
			items = append(items, make([]any, segment.index-len(items)+1)...)
		}
		items[segment.index] = setVideoObjectPathValue(items[segment.index], segments[1:], value)
		return items
	}
	object, _ := current.(map[string]any)
	if object == nil {
		object = make(map[string]any)
	}
	object[segment.name] = setVideoObjectPathValue(object[segment.name], segments[1:], value)
	return object
}

func videoDeleteObjectPath(target map[string]any, path string) {
	segments, ok := parseVideoObjectPath(path)
	if !ok || len(segments) == 0 || segments[0].indexed {
		return
	}
	deleteVideoObjectPathValue(target, segments)
}

func deleteVideoObjectPathValue(current any, segments []videoObjectPathSegment) (any, bool) {
	if len(segments) == 0 {
		return nil, false
	}
	segment := segments[0]
	if segment.indexed {
		items, ok := current.([]any)
		if !ok || segment.index < 0 || segment.index >= len(items) {
			return current, true
		}
		child, keep := deleteVideoObjectPathValue(items[segment.index], segments[1:])
		if keep {
			items[segment.index] = child
		} else {
			items[segment.index] = nil
		}
		for len(items) > 0 && items[len(items)-1] == nil {
			items = items[:len(items)-1]
		}
		return items, len(items) > 0
	}
	object, ok := current.(map[string]any)
	if !ok {
		return current, true
	}
	child, exists := object[segment.name]
	if !exists {
		return object, true
	}
	child, keep := deleteVideoObjectPathValue(child, segments[1:])
	if keep {
		object[segment.name] = child
	} else {
		delete(object, segment.name)
	}
	return object, len(object) > 0
}

func videoContractGenerationKind(payload map[string]any, contract protocol.VideoModelContract) (string, bool) {
	explicitMode := strings.TrimSpace(util.Clean(payload["generation_mode"]))
	if explicitMode == "" {
		return inferredVideoContractGenerationKind(payload), true
	}
	for _, candidate := range contract.Generation.Modes {
		if strings.EqualFold(explicitMode, candidate.ID) || strings.EqualFold(explicitMode, candidate.RequestValue) {
			return candidate.Kind, true
		}
	}
	return "", false
}

func inferredVideoContractGenerationKind(payload map[string]any) string {
	frameReferences := videoFrameAliases(payload)
	imageReferences := removeVideoFrameAliases(util.AsStringSlice(payload["reference_image_urls"]), frameReferences)
	videoReferences := util.AsStringSlice(payload["reference_video_urls"])
	audioReferences := util.AsStringSlice(payload["reference_audio_urls"])
	referenceMode := normalizeVideoReferenceMode(util.Clean(payload["reference_mode"]))
	if referenceMode == "reference" || len(videoReferences)+len(audioReferences) > 0 {
		return "reference"
	}
	if len(frameReferences)+len(imageReferences) > 0 {
		return "image"
	}
	return "text"
}

func videoContractRuleValues(payload map[string]any, contract protocol.VideoModelContract) map[string]any {
	kind, _ := videoContractGenerationKind(payload, contract)
	images := removeVideoFrameAliases(util.AsStringSlice(payload["reference_image_urls"]), videoFrameAliases(payload))
	counts := videoContractMaterialCounts(kind, payload, images, util.AsStringSlice(payload["reference_video_urls"]), util.AsStringSlice(payload["reference_audio_urls"]))
	values := map[string]any{
		"first_frame":     counts.FirstFrame,
		"last_frame":      counts.LastFrame,
		"reference_image": counts.Image,
		"reference_video": counts.Video,
		"reference_audio": counts.Audio,
	}
	for ruleField, requestFields := range map[string][]string{
		"generate_audio": {"generate_audio", "video_generate_audio"},
		"size":           {"size"},
		"resolution":     {"resolution"},
		"duration":       {"seconds", "duration"},
		"watermark":      {"watermark"},
	} {
		for _, requestField := range requestFields {
			value, exists := payload[requestField]
			if !exists || value == nil {
				continue
			}
			switch ruleField {
			case "generate_audio", "watermark":
				values[ruleField] = util.ToBool(value)
			case "duration":
				values[ruleField] = util.ToInt(value, 0)
			default:
				values[ruleField] = util.Clean(value)
			}
			break
		}
	}
	return values
}

func relayVideoMultipartRequest(ctx context.Context, baseURL, apiKey, createPath string, payload map[string]any, fileField string, files []videoMultipartFile) (*http.Request, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range payload {
		if value == nil {
			continue
		}
		fieldValue := strings.TrimSpace(util.Clean(value))
		switch value.(type) {
		case map[string]any, []any, []string:
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			fieldValue = string(encoded)
		}
		if fieldValue == "" {
			continue
		}
		if err := writer.WriteField(key, fieldValue); err != nil {
			return nil, err
		}
	}
	fileField = strings.TrimSpace(fileField)
	for _, file := range files {
		field := firstNonEmpty(file.Field, fileField)
		if field == "" {
			return nil, errors.New("video multipart file field is required")
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, escapeMultipartQuote(field), escapeMultipartQuote(file.Filename)))
		header.Set("Content-Type", file.ContentType)
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(file.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return protocol.NewRelayMultipartRequest(ctx, baseURL, createPath, apiKey, writer.FormDataContentType(), &body)
}

func (a *App) downloadRelayVideo(ctx context.Context, videoURL, apiKey, owner, clientTaskID, upstreamTaskID, baseURL string, allowedHosts []string) (string, error) {
	if a == nil || strings.TrimSpace(a.videoDir) == "" {
		return "", fmt.Errorf("video storage is unavailable")
	}
	clientTaskID = strings.TrimSpace(clientTaskID)
	upstreamTaskID = strings.TrimSpace(upstreamTaskID)
	if clientTaskID == "" {
		return "", fmt.Errorf("client task id is required for video storage")
	}
	if upstreamTaskID == "" {
		return "", fmt.Errorf("upstream task id is required for video storage")
	}
	if err := validateAuthenticatedVideoArtifactURL(videoURL, baseURL, allowedHosts); err != nil {
		return "", err
	}
	req, err := protocol.NewRelayBearerGetRequest(ctx, videoURL, apiKey, "video/*, application/octet-stream, application/json;q=0.9")
	if err != nil {
		return "", err
	}
	client := a.relayHTTPClientForContext(ctx)
	redirectPolicy := client.CheckRedirect
	clientCopy := *client
	clientCopy.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := validateAuthenticatedVideoArtifactURL(req.URL.String(), baseURL, allowedHosts); err != nil {
			return err
		}
		if redirectPolicy != nil {
			return redirectPolicy(req, via)
		}
		if len(via) >= 10 {
			return fmt.Errorf("视频产物重定向次数过多")
		}
		return nil
	}
	resp, err := clientCopy.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", videoContentResponseError(resp)
	}
	const maxVideoBytes int64 = 512 << 20
	if resp.ContentLength > maxVideoBytes {
		return "", fmt.Errorf("video content exceeds 512 MB")
	}
	storageIdentity := strconv.Quote(strings.TrimSpace(owner)) + ":" + strconv.Quote(clientTaskID) + ":" + strconv.Quote(upstreamTaskID)
	name := util.SHA1Short(storageIdentity, 24) + ".mp4"
	if err := storeRelayVideoStream(a.videoDir, name, resp.Body, maxVideoBytes); err != nil {
		return "", err
	}
	return "/videos/" + name, nil
}

func storeRelayVideoStream(directory, name string, source io.Reader, maxBytes int64) error {
	if maxBytes <= 0 {
		return fmt.Errorf("video content size limit is invalid")
	}
	_, err := service.StoreMediaFile(source, service.MediaFileWrite{
		Directory:   directory,
		Name:        name,
		TempPattern: ".video-*",
		MaxBytes:    maxBytes,
		Perm:        0o644,
	})
	switch {
	case errors.Is(err, service.ErrMediaFileEmpty):
		return fmt.Errorf("video content is empty")
	case errors.Is(err, service.ErrMediaFileTooLarge):
		return fmt.Errorf("video content exceeds 512 MB")
	}
	return err
}

func videoArtifactURLForContract(state map[string]any, baseURL, taskID string, contract protocol.VideoModelContract) (string, string, error) {
	if contract.Artifact.Mode == "task_content" {
		path := videoContractTaskPath(contract.Artifact.ContentPath, taskID)
		return absoluteRelayURL(baseURL, path), contract.Artifact.Auth, nil
	}
	videoURL := videoResultURLForContract(state, baseURL, contract)
	if videoURL == "" {
		return "", contract.Artifact.Auth, nil
	}
	if contract.Artifact.Auth == "relay" {
		if err := validateAuthenticatedVideoArtifactURL(videoURL, baseURL, contract.Artifact.AllowedHosts); err != nil {
			return "", "", err
		}
		return videoURL, "relay", nil
	}
	if !isPublicReferenceURL(videoURL) {
		return "", "", fmt.Errorf("视频产物地址不是公网 HTTP 或 HTTPS URL")
	}
	if !videoArtifactHostAllowed(videoURL, contract.Artifact.AllowedHosts) {
		return "", "", fmt.Errorf("视频产物地址不在契约允许域名中")
	}
	return videoURL, "none", nil
}

func validateAuthenticatedVideoArtifactURL(videoURL, baseURL string, allowedHosts []string) error {
	artifact, err := url.Parse(videoURL)
	if err != nil || artifact.Host == "" || artifact.User != nil || artifact.Scheme != "http" && artifact.Scheme != "https" {
		return fmt.Errorf("视频产物地址无效")
	}
	base, err := url.Parse(baseURL)
	if err != nil || base.Hostname() == "" || base.Scheme != "http" && base.Scheme != "https" {
		return fmt.Errorf("视频上游地址无效")
	}
	artifactHost := normalizedHTTPHostname(artifact.Hostname())
	baseHost := normalizedHTTPHostname(base.Hostname())
	if artifactHost == baseHost {
		if sameHTTPOrigin(artifact, base) {
			return nil
		}
		return fmt.Errorf("拒绝向跨协议或端口的视频产物地址发送鉴权")
	}
	if len(allowedHosts) > 0 && artifact.Scheme == "https" && effectiveHTTPPort(artifact) == "443" && videoArtifactHostAllowed(videoURL, allowedHosts) {
		return nil
	}
	return fmt.Errorf("拒绝向非上游域名发送视频产物鉴权")
}

func sameHTTPOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		normalizedHTTPHostname(left.Hostname()) == normalizedHTTPHostname(right.Hostname()) &&
		effectiveHTTPPort(left) == effectiveHTTPPort(right)
}

func normalizedHTTPHostname(host string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
}

func effectiveHTTPPort(value *url.URL) string {
	if port := value.Port(); port != "" {
		return port
	}
	if strings.EqualFold(value.Scheme, "https") {
		return "443"
	}
	return "80"
}

func videoArtifactHostAllowed(rawURL string, allowedHosts []string) bool {
	if len(allowedHosts) == 0 {
		return true
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	for _, pattern := range allowedHosts {
		pattern = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(pattern), "."))
		if strings.HasPrefix(pattern, "*.") {
			suffix := strings.TrimPrefix(pattern, "*")
			if strings.HasSuffix(host, suffix) && host != strings.TrimPrefix(suffix, ".") {
				return true
			}
			continue
		}
		if host == pattern {
			return true
		}
	}
	return false
}

func videoResultURLForContract(state map[string]any, baseURL string, contract protocol.VideoModelContract) string {
	for _, field := range contract.Polling.ResultFields {
		if value := videoJSONPathValue(state, field); value != nil {
			if result := videoContractResultURLValue(value); result != "" {
				return absoluteRelayURL(baseURL, result)
			}
		}
	}
	return ""
}

func videoRelayTaskStatusForContract(state map[string]any, contract protocol.VideoModelContract) string {
	status := strings.ToLower(videoContractFirstString(state, contract.Polling.StatusFields))
	for _, queued := range contract.Polling.QueuedStatuses {
		if status == strings.ToLower(strings.TrimSpace(queued)) {
			return "queued"
		}
	}
	for _, running := range contract.Polling.RunningStatuses {
		if status == strings.ToLower(strings.TrimSpace(running)) {
			return "in_progress"
		}
	}
	for _, success := range contract.Polling.SuccessStatuses {
		if status == strings.ToLower(strings.TrimSpace(success)) {
			return "completed"
		}
	}
	for _, failure := range contract.Polling.FailureStatuses {
		if status == strings.ToLower(strings.TrimSpace(failure)) {
			return "failed"
		}
	}
	return "unknown"
}

func relayVideoTaskProgress(payload map[string]any, state map[string]any, contract protocol.VideoModelContract) {
	callback, ok := payload[service.VideoTaskProgressCallbackPayloadKey].(func(service.VideoTaskProgressUpdate))
	if !ok || callback == nil || state == nil {
		return
	}
	normalizedStatus := videoRelayTaskStatusForContract(state, contract)
	taskStatus := service.TaskStatusQueued
	if normalizedStatus == "in_progress" || normalizedStatus == "unknown" || normalizedStatus == "completed" {
		taskStatus = service.TaskStatusRunning
	}
	progress, hasProgress := videoContractProgressForContract(state, contract)
	callback(service.VideoTaskProgressUpdate{
		Status:         taskStatus,
		UpstreamStatus: strings.ToLower(videoContractFirstString(state, contract.Polling.StatusFields)),
		UpstreamTaskID: videoContractFirstString(state, contract.Polling.TaskIDFields),
		Progress:       progress,
		HasProgress:    hasProgress,
	})
}

func videoContractProgressForContract(state map[string]any, contract protocol.VideoModelContract) (int, bool) {
	for _, field := range contract.Polling.ProgressFields {
		value := videoJSONPathValue(state, field)
		if value == nil {
			continue
		}
		text := strings.TrimSpace(strings.TrimSuffix(util.Clean(value), "%"))
		if text == "" {
			continue
		}
		progress, err := strconv.ParseFloat(text, 64)
		if err != nil {
			continue
		}
		return int(math.Round(progress)), true
	}
	return 0, false
}

func videoContractFirstString(value any, paths []string) string {
	for _, path := range paths {
		if result, ok := videoJSONPathValue(value, path).(string); ok {
			if result = strings.TrimSpace(result); result != "" {
				return result
			}
		}
	}
	return ""
}

func videoContractErrorMessage(state map[string]any, contract protocol.VideoModelContract) string {
	if message := videoContractFirstString(state, contract.Polling.ErrorFields); message != "" {
		return message
	}
	return "视频生成失败，上游未提供具体原因，请稍后重试"
}

func videoContractResultURLValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []string:
		for _, item := range typed {
			if result := strings.TrimSpace(item); result != "" {
				return result
			}
		}
	case []any:
		for _, item := range typed {
			if result := videoContractResultURLValue(item); result != "" {
				return result
			}
		}
	}
	return ""
}

func videoJSONPathValue(value any, path string) any {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	current := value
	for position := 0; position < len(path); {
		if encoded, ok := current.(string); ok {
			var decoded any
			if err := json.Unmarshal([]byte(strings.TrimSpace(encoded)), &decoded); err != nil {
				return nil
			}
			current = decoded
		}
		start := position
		for position < len(path) && path[position] != '.' && path[position] != '[' {
			position++
		}
		if start == position {
			return nil
		}
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = object[path[start:position]]
		if !ok {
			return nil
		}
		for position < len(path) && path[position] == '[' {
			if encoded, ok := current.(string); ok {
				var decoded any
				if err := json.Unmarshal([]byte(strings.TrimSpace(encoded)), &decoded); err != nil {
					return nil
				}
				current = decoded
			}
			end := strings.IndexByte(path[position:], ']')
			if end < 0 {
				return nil
			}
			end += position
			index, err := strconv.Atoi(path[position+1 : end])
			if err != nil {
				return nil
			}
			items, ok := current.([]any)
			if !ok || index < 0 || index >= len(items) {
				return nil
			}
			current = items[index]
			position = end + 1
		}
		if position == len(path) {
			return current
		}
		if path[position] != '.' {
			return nil
		}
		position++
	}
	return current
}

func absoluteRelayURL(baseURL, value string) string {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "data:") {
		return value
	}
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(value, "/")
}
