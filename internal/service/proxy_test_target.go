package service

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

// ErrProxyTestTargetNotAllowed is returned when a proxy test would reach a
// loopback, private or otherwise internal address.
var ErrProxyTestTargetNotAllowed = errors.New("proxy target is not allowed")

// ValidateProxyTestTarget rejects proxy URLs whose host is, or resolves to, an
// address that the safe outbound policy blocks.
func ValidateProxyTestTarget(candidate string) error {
	parsed, err := url.Parse(strings.TrimSpace(candidate))
	if err != nil || parsed.Hostname() == "" {
		return ErrProxyTestTargetNotAllowed
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return ErrProxyTestTargetNotAllowed
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedMediaProxyIP(ip) {
			return ErrProxyTestTargetNotAllowed
		}
		return nil
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return ErrProxyTestTargetNotAllowed
	}
	for _, ip := range ips {
		if isBlockedMediaProxyIP(ip) {
			return ErrProxyTestTargetNotAllowed
		}
	}
	return nil
}
