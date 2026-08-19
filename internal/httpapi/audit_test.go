package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "203.0.113.10:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.7")
	req.Header.Set("X-Real-IP", "198.51.100.8")
	if got := clientIP(req); got != "203.0.113.10" {
		t.Fatalf("clientIP() = %q, want direct peer", got)
	}
}

func TestClientIPUsesRightmostForwardedAddressFromTrustedProxy(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "172.18.0.4:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.99, 203.0.113.20")
	if got := clientIP(req); got != "203.0.113.20" {
		t.Fatalf("clientIP() = %q, want proxy-appended address", got)
	}
}

func TestClientIPRejectsInvalidForwardedAddress(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", "not-an-ip")
	req.Header.Set("X-Real-IP", "203.0.113.30")
	if got := clientIP(req); got != "203.0.113.30" {
		t.Fatalf("clientIP() = %q, want validated real IP", got)
	}
}
