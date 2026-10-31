package httpapi

import (
	"net"
	"net/http"
	"os"
	"strings"
)

const trustedProxiesEnv = "TRUSTED_PROXIES"

// trustedProxyIP reports whether a peer address may supply forwarded client
// information (X-Forwarded-For, X-Real-IP, X-Forwarded-Proto). When
// TRUSTED_PROXIES (comma-separated IPs or CIDRs) is set it is the only trust
// source; otherwise loopback, private and link-local peers are trusted.
func trustedProxyIP(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	if ip == nil {
		return false
	}
	if configured := strings.TrimSpace(os.Getenv(trustedProxiesEnv)); configured != "" {
		for _, entry := range strings.Split(configured, ",") {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			if _, network, err := net.ParseCIDR(entry); err == nil {
				if network.Contains(ip) {
					return true
				}
				continue
			}
			if single := net.ParseIP(entry); single != nil && single.Equal(ip) {
				return true
			}
		}
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// isHTTPSRequest trusts X-Forwarded-Proto only from a trusted proxy peer, using
// the same trust decision as clientIP.
func isHTTPSRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if !trustedProxyIP(remoteRequestIP(r.RemoteAddr)) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}
