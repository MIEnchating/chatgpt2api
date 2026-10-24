package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

// Error bodies may contain credentials or signed URLs; expose only known codes.
func videoContentResponseError(response *http.Response) error {
	var body struct {
		CloudflareError bool   `json:"cloudflare_error"`
		ErrorCode       int    `json:"error_code"`
		ErrorName       string `json:"error_name"`
		Error           struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&body)
	if body.CloudflareError && body.ErrorCode == 502 && body.ErrorName == "origin_bad_gateway" {
		return fmt.Errorf("下载网关返回 HTTP 502：Cloudflare 收到源站无效或不完整的响应，视频生成已完成")
	}
	if body.Error.Code == "artifact_request_rejected" {
		return fmt.Errorf("下载请求或跳转被 New API 拒绝，请检查插件下载策略（HTTP %d）", response.StatusCode)
	}
	if body.Error.Code == "artifact_upstream_auth_failed" {
		return fmt.Errorf("New API 获取成品时上游鉴权失败（HTTP %d）", response.StatusCode)
	}
	return fmt.Errorf("video content returned status %d", response.StatusCode)
}

func (a *App) handleVideoContentRecovery(w http.ResponseWriter, r *http.Request, identity service.Identity, taskID string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	task, err := a.tasks.RecoverVideoContent(ctx, identity, taskID, func(ctx context.Context, recovery service.VideoContentRecovery) (string, error) {
		credential, err := a.relayCredentialForIdentitySelection(ctx, identity, recovery.TokenGroup, recovery.TokenName)
		if err != nil {
			return "", err
		}
		if strings.TrimRight(credential.BaseURL, "/") != strings.TrimRight(recovery.BaseURL, "/") {
			return "", fmt.Errorf("原任务的 API 地址已更改，无法安全恢复视频")
		}
		if credential.Custom {
			ctx = withCustomRelayContext(ctx)
		}
		return a.downloadRelayVideo(ctx, recovery.URL, credential.APIKey, identityScope(identity), taskID, recovery.TaskID, recovery.BaseURL, recovery.AllowedHosts)
	})
	if err != nil {
		if a.writeCreationTaskStorageError(w, err) {
			return
		}
		util.WriteError(w, http.StatusBadGateway, "视频保存仍未成功，未重新生成: "+err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, task)
}
