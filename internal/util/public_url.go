package util

import (
	"net"
	"net/url"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

const maxPublicURLRunes = 2083

var nonPublicNetworks = mustParseCIDRs(
	"100.64.0.0/10",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"240.0.0.0/4",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"2001:db8::/32",
)

func mustParseCIDRs(values ...string) []*net.IPNet {
	blocks := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, block, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		blocks = append(blocks, block)
	}
	return blocks
}

// IsPublicHTTPURL reports whether value is an absolute HTTP(S) URL without
// credentials whose host is a publicly routable name or address. Browsers read
// shortened, octal, hexadecimal and integer hosts as IPv4, so any host whose
// final label is numeric is rejected instead of being guessed at.
func IsPublicHTTPURL(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > maxPublicURLRunes {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return false
	}
	host := strings.TrimSpace(parsed.Hostname())
	if strings.Contains(host, ":") {
		ip := net.ParseIP(host)
		return ip != nil && isPublicIP(ip)
	}
	host, err = idna.Lookup.ToASCII(host)
	if err != nil {
		return false
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".home.arpa") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPublicIP(ip)
	}
	lastLabel := host[strings.LastIndex(host, ".")+1:]
	if strings.Trim(lastLabel, "0123456789") == "" || strings.HasPrefix(lastLabel, "0x") && strings.Trim(lastLabel[2:], "0123456789abcdef") == "" {
		return false
	}
	return strings.Contains(host, ".")
}

func isPublicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, block := range nonPublicNetworks {
		if block.Contains(ip) {
			return false
		}
	}
	return true
}
