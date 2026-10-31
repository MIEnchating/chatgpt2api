package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) logCall(ctx context.Context, identity service.Identity, summary, method, endpoint, model string, started time.Time, outcome string, status int, errText string, urls []string, requestCapture auditRequestCapture) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if status <= 0 {
		status = http.StatusOK
		if outcome == "failed" {
			status = http.StatusInternalServerError
		}
	}
	ended := time.Now()
	detail := map[string]any{
		"method":         method,
		"path":           endpoint,
		"endpoint":       endpoint,
		"module":         inferAuditModule(endpoint),
		"model":          model,
		"started_at":     started.Format("2006-01-02 15:04:05"),
		"ended_at":       ended.Format("2006-01-02 15:04:05"),
		"duration_ms":    ended.Sub(started).Milliseconds(),
		"status":         status,
		"outcome":        outcome,
		"operation_type": operationTypeForMethod(method),
		"log_level":      logLevelForStatus(status),
	}
	addIdentityLogDetail(detail, identity)
	if name := identityDisplayName(identity); name != "" {
		detail["username"] = name
	}
	if usedAccounts := protocol.AccountUsageFromContext(ctx); len(usedAccounts) > 0 {
		detail["upstream_accounts"] = usedAccounts
		if len(usedAccounts) == 1 {
			detail["upstream_account_id"] = usedAccounts[0]["account_id"]
			detail["upstream_token_preview"] = usedAccounts[0]["token_preview"]
		}
	}
	if errText != "" {
		detail["error"] = errText
	}
	if len(urls) > 0 {
		detail["urls"] = dedupe(urls)
	}
	addAuditRequestDetail(detail, requestCapture)
	suffix := "调用完成"
	if outcome == "failed" {
		suffix = "调用失败"
	}
	if err := a.logs.Add(summary+suffix, detail); err != nil && a.logger != nil {
		a.logger.Error("create upstream call log failed", "error", err, "endpoint", endpoint, "method", method)
	}
}

func addIdentityLogDetail(detail map[string]any, identity service.Identity) {
	kind := util.Clean(identity.Kind)
	if kind != "" {
		detail["auth_kind"] = kind
	}
	credentialName := util.Clean(identity.CredentialName)
	if identity.Kind == service.AuthKindSession {
		if credentialName != "" {
			detail["session_name"] = credentialName
		}
	} else if name := util.Clean(firstNonEmpty(identity.CredentialName, identity.Name)); name != "" {
		detail["key_name"] = name
	}
	if role := util.Clean(identity.Role); role != "" {
		detail["key_role"] = role
	}
	if id := util.Clean(firstNonEmpty(identity.CredentialID, identity.ID)); id != "" {
		detail["key_id"] = id
	}
	if id := util.Clean(identity.ID); id != "" && id != util.Clean(identity.CredentialID) {
		detail["subject_id"] = id
	}
	if provider := util.Clean(identity.Provider); provider != "" {
		detail["provider"] = provider
	}
}

func payloadAuditCapture(payload map[string]any) auditRequestCapture {
	args := cleanAuditPayloadMap(payload)
	if len(args) == 0 {
		return auditRequestCapture{}
	}
	return auditRequestCapture{args: service.SanitizeLogValue(args)}
}

func cleanAuditPayloadMap(payload map[string]any) map[string]any {
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		switch key {
		case relayTaskCredentialKey, relayTranslationSourceKey, "owner_id", "owner_name", "base_url", "relay_base_url", relayCustomEndpointPayloadKey:
			continue
		}
		if isInternalPayloadValue(value) {
			continue
		}
		out[key] = cleanAuditPayloadValue(value)
	}
	return out
}

func cleanAuditPayloadValue(value any) any {
	switch x := value.(type) {
	case []protocol.UploadedImage:
		items := make([]map[string]any, 0, len(x))
		for _, image := range x {
			items = append(items, map[string]any{
				"filename":     image.Filename,
				"content_type": image.ContentType,
				"size_bytes":   len(image.Data),
			})
		}
		return items
	case protocol.UploadedImage:
		return map[string]any{
			"filename":     x.Filename,
			"content_type": x.ContentType,
			"size_bytes":   len(x.Data),
		}
	default:
		return value
	}
}

func isInternalPayloadValue(value any) bool {
	if value == nil {
		return false
	}
	switch value.(type) {
	case func(context.Context, int) (func(), error),
		func([]map[string]any),
		func(service.VideoTaskProgressUpdate),
		func(int),
		func(string):
		return true
	default:
		return false
	}
}
