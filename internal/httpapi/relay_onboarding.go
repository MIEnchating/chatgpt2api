package httpapi

import (
	"context"
	"time"

	"chatgpt2api/internal/service"
)

// SSO and password sessions supply separate credentials for platform key creation.
// Reusing keys needs only the read-only database connection.
func (a *App) initializeRelayGroups(ctx context.Context, reader *service.NewAPITokenReader, identity service.Identity, user *service.NewAPIUser, password string) []string {
	mappings, err := a.imagePreferences.UnconfiguredRelayGroups(identityScope(identity), a.config.RelayCreationGroups())
	if err != nil {
		return []string{"读取默认 Key 配置失败，请稍后重试"}
	}
	if len(mappings) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var create func(context.Context, string) error
	if identity.Provider == service.AuthProviderNewAPI && identity.SSOReference != "" && !reader.IsSub2API() {
		create = ssoRelayGroupCreator(identity)
	} else if user != nil {
		create = passwordRelayGroupCreator(a.config.RelayBaseURL(), reader.Source(), *user, password, a.relayHTTPClient())
	}
	defaults, warnings := reader.EnsureCreationGroupTokens(ctx, identity, mappings, create)
	if err := a.imagePreferences.InitializeRelayTokens(identityScope(identity), defaults); err != nil {
		warnings = append(warnings, "默认 Key 选择保存失败，请稍后重新登录")
	}
	return warnings
}
