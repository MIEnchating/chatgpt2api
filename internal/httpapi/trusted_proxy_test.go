package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestTrustedProxyIPDefaultsToLocalNetworks(t *testing.T) {
	t.Setenv(trustedProxiesEnv, "")
	for ip, want := range map[string]bool{"127.0.0.1": true, "10.1.2.3": true, "172.18.0.4": true, "203.0.113.5": false, "not-an-ip": false} {
		if got := trustedProxyIP(ip); got != want {
			t.Fatalf("trustedProxyIP(%q) = %v, want %v", ip, got, want)
		}
	}
}

func TestTrustedProxyIPConfiguredListReplacesDefaults(t *testing.T) {
	t.Setenv(trustedProxiesEnv, "203.0.113.0/24, 198.51.100.7")
	for ip, want := range map[string]bool{"203.0.113.5": true, "198.51.100.7": true, "198.51.100.8": false, "10.1.2.3": false, "127.0.0.1": false} {
		if got := trustedProxyIP(ip); got != want {
			t.Fatalf("trustedProxyIP(%q) = %v, want %v", ip, got, want)
		}
	}
}

func TestClientIPAndHTTPSShareTrustDecision(t *testing.T) {
	t.Setenv(trustedProxiesEnv, "203.0.113.0/24")
	trusted := httptest.NewRequest("GET", "http://example.test/", nil)
	trusted.RemoteAddr = "203.0.113.5:4000"
	trusted.Header.Set("X-Forwarded-For", "198.51.100.9")
	trusted.Header.Set("X-Forwarded-Proto", "https")
	if got := clientIP(trusted); got != "198.51.100.9" || !isHTTPSRequest(trusted) {
		t.Fatalf("trusted peer: clientIP = %q https = %v", got, isHTTPSRequest(trusted))
	}
	untrusted := httptest.NewRequest("GET", "http://example.test/", nil)
	untrusted.RemoteAddr = "10.1.2.3:4000"
	untrusted.Header.Set("X-Forwarded-For", "198.51.100.9")
	untrusted.Header.Set("X-Forwarded-Proto", "https")
	if got := clientIP(untrusted); got != "10.1.2.3" || isHTTPSRequest(untrusted) {
		t.Fatalf("untrusted peer: clientIP = %q https = %v", got, isHTTPSRequest(untrusted))
	}
}

func TestRequestMediaBaseURLHonorsProxyTrustAndValidatesHost(t *testing.T) {
	t.Setenv(trustedProxiesEnv, "127.0.0.1")
	for _, tc := range []struct{ name, peer, host, forwarded, want string }{
		{"direct", "203.0.113.1:2000", "canvas.example.test:8002", "", "http://canvas.example.test:8002"},
		{"trusted proxy", "127.0.0.1:2000", "backend:8090", "canvas.example.test", "https://canvas.example.test"},
		{"untrusted proxy", "203.0.113.1:2000", "canvas.example.test", "evil.example.test", "http://canvas.example.test"},
		{"invalid host", "127.0.0.1:2000", "backend:8090", "canvas.example.test/path", ""},
		{"credentials", "127.0.0.1:2000", "backend:8090", "user@canvas.example.test", ""},
		{"multiple hosts", "127.0.0.1:2000", "backend:8090", "canvas.example.test,evil.example.test", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://backend/", nil)
			r.RemoteAddr, r.Host = tc.peer, tc.host
			r.Header.Set("X-Forwarded-Host", tc.forwarded)
			r.Header.Set("X-Forwarded-Proto", "https")
			if got := requestMediaBaseURL(r); got != tc.want {
				t.Fatalf("base = %q, want %q", got, tc.want)
			}
		})
	}
}
