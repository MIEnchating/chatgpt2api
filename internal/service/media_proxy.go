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

func newSafeMediaProxyHTTPClient() *http.Client {
	return SafeOutboundHTTPClient(5 * time.Minute)
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
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	return ipv4[0] == 0 || ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127
}
