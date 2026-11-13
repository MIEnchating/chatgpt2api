package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

type mediaBaseURLContextKey struct{}

// Request-scoped values keep concurrent sites and background runs independent.
func requestMediaBaseURL(r *http.Request) string {
	host := strings.TrimSpace(r.Host)
	if trustedProxyIP(remoteRequestIP(r.RemoteAddr)) {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); forwarded != "" {
			host = forwarded
		}
	}
	scheme := "http"
	if isHTTPSRequest(r) {
		scheme = "https"
	}
	base, err := url.Parse(scheme + "://" + host)
	if err != nil || base.Hostname() == "" || base.User != nil || base.Host != host || base.Path != "" || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" || strings.ContainsAny(host, ",\\ \t\r\n") {
		return ""
	}
	return base.String()
}

func (a *App) resolveImageBaseURL(ctx context.Context) string {
	if configured := a.config.BaseURL(); configured != "" {
		return configured
	}
	base, _ := ctx.Value(mediaBaseURLContextKey{}).(string)
	return base
}
