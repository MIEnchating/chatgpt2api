package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NewAPISSOTokenClient provisions keys using a platform-bound SSO session.
// The platform derives the user from the reference; no dashboard credential is used.
type NewAPISSOTokenClient struct {
	issuer    string
	secret    string
	reference string
	userID    int64
	client    *http.Client
}

func NewNewAPISSOTokenClient(issuer, secret, reference string, userID int64, client *http.Client) (*NewAPISSOTokenClient, error) {
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != issuer || len(secret) < 32 || reference == "" || userID <= 0 {
		return nil, errors.New("单点登录密钥创建配置无效")
	}
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	cloned := *client
	cloned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &NewAPISSOTokenClient{issuer: issuer, secret: secret, reference: reference, userID: userID, client: &cloned}, nil
}

func (c *NewAPISSOTokenClient) EnsureGroupToken(ctx context.Context, group, name string) error {
	if strings.TrimSpace(group) == "" || group == "auto" || strings.TrimSpace(name) == "" {
		return errors.New("自动创建密钥需要有效的具体分组和名称")
	}
	body, err := json.Marshal(struct {
		Issuer    string `json:"issuer"`
		Reference string `json:"reference"`
		Group     string `json:"group"`
		Name      string `json:"name"`
	}{c.issuer, c.reference, group, name})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.issuer+"/api/sso/chatgpt2api/tokens", bytes.NewReader(body))
	if err != nil {
		return errors.New("单点登录密钥创建请求失败")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.secret)
	res, err := c.client.Do(req)
	if err != nil {
		return errors.New("平台密钥初始化请求失败，请稍后重试")
	}
	defer res.Body.Close()
	var result struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
		Data    struct {
			UserID  int64  `json:"user_id"`
			ID      int64  `json:"id"`
			Name    string `json:"name"`
			Group   string `json:"group"`
			Created bool   `json:"created"`
		} `json:"data"`
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16385))
	if err != nil || len(raw) > 16384 || json.Unmarshal(raw, &result) != nil {
		return errors.New("平台密钥初始化响应无效，请联系管理员")
	}
	if res.StatusCode != http.StatusOK || !result.Success {
		// Never expose response messages, which may contain credentials or private data.
		switch result.Code {
		case "sso_invalid":
			return errors.New("单点登录已失效，请从平台重新进入")
		case "token_group_forbidden":
			return fmt.Errorf("当前用户无权使用分组“%s”，未创建 Key", group)
		case "token_name_conflict":
			return fmt.Errorf("分组“%s”的 Key 名称冲突，请在平台重命名后重试", group)
		case "token_limit_reached":
			return errors.New("平台密钥数量已达上限，请清理后重试")
		default:
			return fmt.Errorf("平台密钥初始化失败（HTTP %d），请联系管理员", res.StatusCode)
		}
	}
	if result.Data.UserID != c.userID || result.Data.ID <= 0 || result.Data.Group != group || strings.TrimSpace(result.Data.Name) == "" || (result.Data.Created && result.Data.Name != name) {
		return errors.New("平台返回的密钥身份或分组不一致，未保存默认选择")
	}
	return nil
}
