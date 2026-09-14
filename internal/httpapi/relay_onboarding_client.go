package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
)

func ssoRelayGroupCreator(identity service.Identity) func(context.Context, string) error {
	return func(ctx context.Context, group string) error {
		cfg, err := loadSSOConfig()
		if err != nil || !slices.Contains(cfg.issuers, identity.SSOIssuer) {
			return errors.New("单点登录未正确配置，无法自动创建密钥")
		}
		rawID, ok := strings.CutPrefix(identity.OwnerID, service.AuthProviderNewAPI+":")
		userID, err := strconv.ParseInt(rawID, 10, 64)
		if !ok || err != nil || userID <= 0 {
			return errors.New("单点登录用户身份无效，无法自动创建密钥")
		}
		client, err := protocol.NewNewAPISSOTokenClient(identity.SSOIssuer, cfg.secret, identity.SSOReference, userID, nil)
		if err != nil {
			return err
		}
		return client.EnsureGroupToken(ctx, group, service.RelayCreationTokenName(group))
	}
}

// passwordRelayGroupCreator authenticates lazily, only when a group needs a key.
func passwordRelayGroupCreator(baseURL, provider string, user service.NewAPIUser, password string, httpClient *http.Client) func(context.Context, string) error {
	var client *protocol.RelayManagementClient
	var groups map[string]int64
	var loginErr error
	attemptedLogin := false
	return func(ctx context.Context, group string) error {
		if !attemptedLogin {
			attemptedLogin = true
			client, loginErr = protocol.NewRelayManagementClient(baseURL, provider, httpClient)
			if loginErr == nil {
				loginErr = client.Login(ctx, user.ID, user.Username, user.Email, password)
			}
			if loginErr == nil {
				groups, loginErr = client.Groups(ctx)
			}
		}
		if loginErr != nil {
			return loginErr
		}
		groupID, allowed := groups[group]
		if !allowed {
			return fmt.Errorf("当前用户无权使用分组“%s”，未创建 Key", group)
		}
		// Recheck the API before writing, in case a key appeared after the DB snapshot.
		tokens, err := client.Tokens(ctx)
		if err != nil {
			return err
		}
		for _, token := range tokens {
			if token.Usable(provider) && ((provider == "sub2api" && token.GroupID == groupID) || (provider == "newapi" && token.Group == group && strings.TrimSpace(token.GroupRouteConfig) == "")) {
				if strings.TrimSpace(token.Name) == "" {
					return fmt.Errorf("分组“%s”已有未命名 Key，请先在上游命名；未创建新 Key", group)
				}
				return nil
			}
		}
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s", provider, user.ID, group)))
		return client.CreateToken(ctx, service.RelayCreationTokenName(group), group, groupID, fmt.Sprintf("yunmian-group-%x", digest[:16]))
	}
}
