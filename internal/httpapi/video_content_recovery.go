package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

// Error bodies may contain credentials or signed URLs; expose only known codes.
func videoContentResponseError(response *http.Response) error {
	var body struct {
		CloudflareError bool   `json:"cloudflare_error"`
		ErrorCode       int    `json:"error_code"`
		ErrorName       string `json:"error_name"`
		Zone            string `json:"zone"`
		Instance        string `json:"instance"`
		RetryAfter      int    `json:"retry_after"`
		Error           struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&body)
	if body.CloudflareError && body.ErrorCode == 502 && body.ErrorName == "origin_bad_gateway" {
		detail := ""
		if body.Zone != "" {
			detail = ", zone=" + body.Zone
		}
		if body.Instance != "" {
			detail += ", instance=" + body.Instance
		}
		if body.RetryAfter > 0 {
			detail += fmt.Sprintf(", retry_after=%ds", body.RetryAfter)
		}
		return fmt.Errorf("下载网关返回 HTTP 502：Cloudflare 收到源站无效或不完整的响应%s，视频生成已完成", detail)
	}
	if body.Error.Code == "artifact_request_rejected" {
		return fmt.Errorf("下载请求或跳转被 New API 拒绝，请检查插件下载策略（HTTP %d）", response.StatusCode)
	}
	if body.Error.Code == "artifact_upstream_auth_failed" {
		return fmt.Errorf("New API 获取成品时上游鉴权失败（HTTP %d）", response.StatusCode)
	}
	return fmt.Errorf("video content returned status %d", response.StatusCode)
}

func (a *App) handleVideoTaskRecovery(w http.ResponseWriter, r *http.Request, identity service.Identity, taskID string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	task, err := a.tasks.RecoverVideoTask(identity, taskID)
	if err != nil {
		if a.writeCreationTaskStorageError(w, err) {
			return
		}
		util.WriteError(w, http.StatusBadGateway, "原视频任务恢复未启动，未重新生成: "+err.Error())
		return
	}
	status := http.StatusAccepted
	if task["status"] == service.TaskStatusSuccess {
		status = http.StatusOK
	}
	util.WriteJSON(w, status, task)
}

func (a *App) runRecoveredVideoTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	recovery, ok := payload[service.VideoTaskRecoveryPayloadKey].(*service.VideoTaskRecovery)
	if !ok || recovery == nil {
		return nil, fmt.Errorf("视频任务缺少原查询信息")
	}
	credential, err := a.relayCredentialForIdentitySelection(ctx, identity, recovery.TokenGroup, recovery.TokenName)
	if err != nil {
		return nil, err
	}
	if strings.TrimRight(credential.BaseURL, "/") != strings.TrimRight(recovery.BaseURL, "/") {
		return nil, fmt.Errorf("原任务的 API 地址已更改，无法安全恢复视频")
	}
	if credential.Custom {
		ctx = withCustomRelayContext(ctx)
	}
	if recovery.URL != "" {
		if callback, ok := payload[service.VideoTaskProgressCallbackPayloadKey].(func(service.VideoTaskProgressUpdate)); ok {
			callback(service.VideoTaskProgressUpdate{Status: service.TaskStatusRunning, UpstreamTaskID: recovery.TaskID, UpstreamStatus: "completed", Progress: 100, HasProgress: true})
		}
		localURL, err := a.downloadRelayVideo(ctx, recovery.URL, credential.APIKey, identityScope(identity), util.Clean(payload["client_task_id"]), recovery.TaskID, recovery.BaseURL, recovery.AllowedHosts)
		if err != nil {
			if artifactURL := newAPIVideoArtifactRecoveryURL(recovery); artifactURL != "" {
				localURL, artifactErr := a.downloadRelayVideo(ctx, artifactURL, credential.APIKey, identityScope(identity), util.Clean(payload["client_task_id"]), recovery.TaskID, recovery.BaseURL, recovery.AllowedHosts)
				if artifactErr == nil {
					return map[string]any{"output_type": "video", "data": []map[string]any{{"url": localURL, "video_url": localURL, "type": "video", "mime_type": "video/mp4"}}}, nil
				}
				err = fmt.Errorf("%w（New API 制品接口也失败: %v）", err, artifactErr)
			}
		}
		if err != nil {
			return nil, fmt.Errorf("视频已生成但保存失败: %w", err)
		}
		return map[string]any{"output_type": "video", "data": []map[string]any{{"url": localURL, "video_url": localURL, "type": "video", "mime_type": "video/mp4"}}}, nil
	}
	contract, err := videoContractSnapshot(map[string]any{protocol.VideoContractSnapshotPayloadKey: recovery.Contract}, recovery.Model)
	if err != nil {
		return nil, err
	}
	if recovery.Model != util.Clean(payload["model"]) {
		return nil, fmt.Errorf("原任务的模型与恢复契约不一致")
	}
	return a.pollRelayVideoTask(ctx, payload, contract, recovery.BaseURL, credential.APIKey, recovery.QueryPath, recovery.TaskID, recovery)
}

func newAPIVideoArtifactRecoveryURL(recovery *service.VideoTaskRecovery) string {
	if recovery == nil || strings.TrimSpace(recovery.URL) == "" || strings.TrimSpace(recovery.BaseURL) == "" || strings.TrimSpace(recovery.TaskID) == "" {
		return ""
	}
	var contract protocol.VideoModelContract
	if json.Unmarshal(recovery.Contract, &contract) != nil || contract.Driver != protocol.VideoContractDriverOpenAI || contract.Artifact.Mode != "task_content" {
		return ""
	}
	if !strings.Contains(recovery.URL, "/v1/videos/") || !strings.HasSuffix(recovery.URL, "/content") {
		return ""
	}
	return strings.TrimRight(recovery.BaseURL, "/") + "/v1/tasks/" + url.PathEscape(recovery.TaskID) + "/artifacts/video/content"
}
