package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

var safeOutboundTransport = newSafeOutboundTransport()
var safeMediaProxyHTTPClient = SafeOutboundHTTPClient(5 * time.Minute)

func SafeMediaProxyHTTPClient() *http.Client {
	return safeMediaProxyHTTPClient
}

func SafeOutboundHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: safeOutboundTransport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			scheme := strings.ToLower(req.URL.Scheme)
			if scheme != "http" && scheme != "https" {
				return errors.New("invalid redirect URL")
			}
			return nil
		},
	}
}

func SafeOutboundTransport() http.RoundTripper {
	return safeOutboundTransport
}

func newSafeOutboundTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = safeMediaProxyDialContext
	return transport
}

func safeMediaProxyDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("unable to resolve media host")
	}
	for _, item := range ips {
		if isBlockedMediaProxyIP(item.IP) {
			return nil, errors.New("local and private media hosts are not allowed")
		}
	}
	dialer := net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	var lastErr error
	for _, item := range ips {
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(item.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	return nil, fmt.Errorf("unable to connect to media host: %w", lastErr)
}

func isBlockedMediaProxyIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, network := range blockedMediaProxyNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	return ipv4[0] == 0 || ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127
}

// Special-purpose ranges that net.IP helpers do not classify as private:
// IETF protocol assignments, benchmarking, and the NAT64 well-known prefix.
var blockedMediaProxyNetworks = mustParseMediaProxyCIDRs("192.0.0.0/24", "198.18.0.0/15", "64:ff9b::/96")

func mustParseMediaProxyCIDRs(values ...string) []*net.IPNet {
	networks := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}
