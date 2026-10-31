package service

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

// SafeDownloadClient returns a client for fetching untrusted URLs. Without a
// configured proxy it dials through the validating transport, which checks the
// resolved IPs at dial time. With an administrator-configured proxy the target
// host is resolved and validated before every request (including redirects) and
// only then sent through the proxy.
func (s *ProxyService) SafeDownloadClient(timeout time.Duration) *http.Client {
	if s == nil || s.config == nil || normalizeProxy(s.config.Proxy()) == "" {
		return SafeOutboundHTTPClient(timeout)
	}
	client := s.HTTPClient(timeout)
	client.Transport = &validatingTransport{next: client.Transport}
	return client
}

type validatingTransport struct {
	next http.RoundTripper
}

func (t *validatingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := validateDownloadTarget(req.Context(), req.URL.Hostname()); err != nil {
		return nil, err
	}
	return t.next.RoundTrip(req)
}

func validateDownloadTarget(ctx context.Context, host string) error {
	if host == "" {
		return errors.New("download host is required")
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedMediaProxyIP(ip) {
			return errors.New("local and private download hosts are not allowed")
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return errors.New("unable to resolve download host")
	}
	for _, item := range ips {
		if isBlockedMediaProxyIP(item.IP) {
			return errors.New("local and private download hosts are not allowed")
		}
	}
	return nil
}
