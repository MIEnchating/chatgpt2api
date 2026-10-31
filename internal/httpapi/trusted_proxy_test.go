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
