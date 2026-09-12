package protocol

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// RelayManagementClient uses a user's dashboard credential, never a generation key.
// Credentials stay in memory for the duration of onboarding.
type RelayManagementClient struct {
	baseURL  string
	provider string
	client   *http.Client
	token    string
	userID   int64
}

type RelayManagedToken struct {
	ID             int64           `json:"id"`
	UserID         int64           `json:"user_id"`
	Name           string          `json:"name"`
	Group          string          `json:"group"`
	GroupID        int64           `json:"group_id"`
	Status         json.RawMessage `json:"status"`
	ExpiresAt      *time.Time      `json:"expires_at"`
	ExpiredTime    int64           `json:"expired_time"`
	UnlimitedQuota bool            `json:"unlimited_quota"`
	RemainQuota    float64         `json:"remain_quota"`
	Quota          float64         `json:"quota"`
	QuotaUsed      float64         `json:"quota_used"`
}

func (t RelayManagedToken) Usable(provider string) bool {
	if provider == "sub2api" {
		return string(t.Status) == `"active"` && (t.ExpiresAt == nil || t.ExpiresAt.After(time.Now())) && (t.Quota <= 0 || t.QuotaUsed < t.Quota)
	}
	return string(t.Status) == "1" && (t.ExpiredTime == -1 || t.ExpiredTime >= time.Now().Unix()) && (t.UnlimitedQuota || t.RemainQuota > 0)
}

// RelayManagementError deliberately excludes upstream response bodies and secrets.
type RelayManagementError struct {
	Operation string
	Status    int
	Rejected  bool
}

func (e *RelayManagementError) Error() string {
	return fmt.Sprintf("上游%s失败（HTTP %d），请检查上游配置及用户权限", e.Operation, e.Status)
}

func NewRelayManagementClient(baseURL, provider string, client *http.Client) (*RelayManagementClient, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("上游 API 地址无效")
	}
	if provider != "newapi" && provider != "sub2api" {
		return nil, errors.New("上游类型无效")
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	cloned := *client
	// Even same-origin redirects may replay a password to an unintended endpoint.
	cloned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &RelayManagementClient{baseURL: strings.TrimRight(parsed.String(), "/"), provider: provider, client: &cloned}, nil
}

func (c *RelayManagementClient) request(ctx context.Context, method, path, operation string, body any, idempotencyKey string, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return &RelayManagementError{Operation: operation}
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	res, err := c.client.Do(req)
	if err != nil {
		return &RelayManagementError{Operation: operation}
	}
	defer res.Body.Close()
	failure := &RelayManagementError{Operation: operation, Status: res.StatusCode}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		failure.Rejected = res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != http.StatusRequestTimeout
		return failure
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 {
		return failure
	}
	var envelope struct {
		Success *bool           `json:"success"`
		Code    *int            `json:"code"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return failure
	}
	if c.provider == "newapi" {
		if envelope.Success == nil {
			return failure
		}
		if !*envelope.Success {
			failure.Rejected = true
			return failure
		}
	} else {
		if envelope.Code == nil {
			return failure
		}
		if *envelope.Code != 0 {
			failure.Rejected = true
			return failure
		}
	}
	if out != nil && json.Unmarshal(envelope.Data, out) != nil {
		return failure
	}
	return nil
}

// Login verifies the API identity against the identity read from the configured database.
func (c *RelayManagementClient) Login(ctx context.Context, userID int64, username, email, password string) error {
	path := "/api/v1/auth/login"
	body := map[string]any{"email": email, "password": password}
	if c.provider == "newapi" {
		path = "/api/user/login"
		body = map[string]any{"username": username, "password": password}
		var key struct {
			Enabled   bool   `json:"enabled"`
			ID        string `json:"kid"`
			PublicKey string `json:"public_key"`
		}
		if err := c.request(ctx, http.MethodGet, "/api/user/login/encryption-key", "登录加密配置读取", nil, "", &key); err != nil {
			return err
		}
		if key.Enabled {
			encrypted, err := encryptRelayPassword(password, key.ID, key.PublicKey)
			if err != nil {
				return errors.New("上游登录加密配置无效")
			}
			body = map[string]any{"username": username, "password_encrypted": encrypted, "encryption_key_id": key.ID}
		}
	}
	var result struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := c.request(ctx, http.MethodPost, path, "登录（可能需要验证码或二次验证）", body, "", &result); err != nil {
		return err
	}
	if result.AccessToken == "" {
		return errors.New("上游登录未完成，可能需要验证码或二次验证；本次未自动创建密钥")
	}
	if result.User.ID != userID || userID <= 0 {
		return errors.New("上游 API 与数据库用户身份不一致，已停止自动创建密钥")
	}
	c.token, c.userID = result.AccessToken, userID
	return nil
}

func encryptRelayPassword(password, keyID, publicKey string) (string, error) {
	block, _ := pem.Decode([]byte(publicKey))
	if block == nil || keyID == "" {
		return "", errors.New("invalid public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", err
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok || key.N.BitLen() < 2048 {
		return "", errors.New("invalid RSA public key")
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return "", err
	}
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, secret, []byte("password-v2"))
	if err != nil {
		return "", err
	}
	aesBlock, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(aesBlock)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	encrypted := gcm.Seal(nil, nonce, []byte(password), []byte("password-v2:"+keyID))
	return "v2." + base64.StdEncoding.EncodeToString(wrapped) + "." + base64.StdEncoding.EncodeToString(nonce) + "." + base64.StdEncoding.EncodeToString(encrypted), nil
}

func (c *RelayManagementClient) Groups(ctx context.Context) (map[string]int64, error) {
	groups := make(map[string]int64)
	if c.provider == "newapi" {
		var result map[string]json.RawMessage
		if err := c.request(ctx, http.MethodGet, "/api/user/self/groups", "可用分组读取", nil, "", &result); err != nil {
			return nil, err
		}
		for name := range result {
			groups[name] = 0
		}
	} else {
		var result []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		}
		if err := c.request(ctx, http.MethodGet, "/api/v1/groups/available", "可用分组读取", nil, "", &result); err != nil {
			return nil, err
		}
		for _, group := range result {
			if group.ID <= 0 {
				return nil, errors.New("上游返回了无效分组")
			}
			if _, exists := groups[group.Name]; exists {
				return nil, errors.New("上游存在重名分组，无法自动选择")
			}
			groups[group.Name] = group.ID
		}
	}
	return groups, nil
}

func (c *RelayManagementClient) Tokens(ctx context.Context) ([]RelayManagedToken, error) {
	tokens := []RelayManagedToken{}
	for page := 1; page <= 1000; page++ {
		path := "/api/token/?p=" + strconv.Itoa(page) + "&page_size=100"
		if c.provider == "sub2api" {
			path = "/api/v1/keys?page=" + strconv.Itoa(page) + "&page_size=100"
		}
		var result struct {
			Items []RelayManagedToken `json:"items"`
			Total *int                `json:"total"`
		}
		if err := c.request(ctx, http.MethodGet, path, "密钥列表读取", nil, "", &result); err != nil {
			return nil, err
		}
		if result.Total == nil || *result.Total < 0 {
			return nil, errors.New("上游密钥列表分页信息无效")
		}
		for _, token := range result.Items {
			if token.UserID != c.userID || token.ID <= 0 {
				return nil, errors.New("上游密钥列表用户身份不一致")
			}
		}
		tokens = append(tokens, result.Items...)
		if len(tokens) >= *result.Total {
			return tokens, nil
		}
		if len(result.Items) == 0 {
			return nil, errors.New("上游密钥列表不完整")
		}
	}
	return nil, errors.New("上游密钥列表超过读取上限")
}

func (c *RelayManagementClient) CreateToken(ctx context.Context, name, group string, groupID int64, idempotencyKey string) error {
	path := "/api/token/"
	body := map[string]any{"name": name, "group": group, "expired_time": -1, "unlimited_quota": true, "remain_quota": 0, "model_limits_enabled": false}
	if c.provider == "sub2api" {
		path = "/api/v1/keys"
		body = map[string]any{"name": name, "group_id": groupID, "quota": 0}
	}
	return c.request(ctx, http.MethodPost, path, "密钥创建", body, idempotencyKey, nil)
}
