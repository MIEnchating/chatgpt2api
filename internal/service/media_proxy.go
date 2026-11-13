package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
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

// MediaConnectionError identifies failures that happened before an HTTP request was sent.
type MediaConnectionError struct {
	Stage string
	Host  string
	Err   error
}

func (e *MediaConnectionError) Error() string {
	return fmt.Sprintf("media %s failed for %s: %v", e.Stage, e.Host, e.Err)
}
func (e *MediaConnectionError) Unwrap() error { return e.Err }

// Retry only temporary DNS failures, before dialing or sending any paid request.
func resolveMediaProxyHost(ctx context.Context, host string, lookup func(context.Context, string) ([]net.IPAddr, error)) ([]net.IPAddr, error) {
	for attempt := 0; attempt < 2; attempt++ {
		ips, err := lookup(ctx, host)
		if err == nil && len(ips) > 0 {
			return ips, nil
		}
		if err == nil {
			err = errors.New("resolver returned no addresses")
		}
		var dns *net.DNSError
		if attempt != 0 || !errors.As(err, &dns) || !dns.IsTemporary || dns.IsNotFound || ctx.Err() != nil {
			return nil, &MediaConnectionError{Stage: "dns", Host: host, Err: err}
		}
		timer := time.NewTimer(150 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, &MediaConnectionError{Stage: "dns", Host: host, Err: ctx.Err()}
		case <-timer.C:
		}
	}
	panic("unreachable DNS retry state")
}

// Preflight checks the selected public route without sending an HTTP request.
func PreflightMediaEndpoint(ctx context.Context, raw string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Scheme != "https" && parsed.Scheme != "http" {
		return errors.New("invalid media route URL")
	}
	ips, err := resolveMediaProxyHost(ctx, parsed.Hostname(), net.DefaultResolver.LookupIPAddr)
	if err != nil {
		return err
	}
	for _, ip := range ips {
		if isBlockedMediaProxyIP(ip.IP) {
			return errors.New("local and private media hosts are not allowed")
		}
	}
	return nil
}

func safeMediaProxyDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := resolveMediaProxyHost(ctx, host, net.DefaultResolver.LookupIPAddr)
	if err != nil {
		return nil, err
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
	return nil, &MediaConnectionError{Stage: "connect", Host: host, Err: lastErr}
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
