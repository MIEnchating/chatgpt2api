package httpapi

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
)

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
