package service

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestMediaProxyBlocksNonPublicAddresses(t *testing.T) {
	blocked := []string{"0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1"}
	for _, value := range blocked {
		if !isBlockedMediaProxyIP(net.ParseIP(value)) {
			t.Fatalf("isBlockedMediaProxyIP(%q) = false", value)
		}
	}
	for _, value := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if isBlockedMediaProxyIP(net.ParseIP(value)) {
			t.Fatalf("isBlockedMediaProxyIP(%q) = true", value)
		}
	}
}

func TestMediaProxyDNSFailuresPreserveCauseAndOnlyRetryBeforeConnection(t *testing.T) {
	for _, temporary := range []bool{false, true} {
		calls := 0
		original := &net.DNSError{Err: "test resolver unavailable", Name: "media.example", IsTemporary: temporary, IsNotFound: !temporary}
		_, err := resolveMediaProxyHost(context.Background(), "media.example", func(context.Context, string) ([]net.IPAddr, error) { calls++; return nil, original })
		var stage *MediaConnectionError
		if !errors.As(err, &stage) || stage.Stage != "dns" || !errors.Is(err, original) {
			t.Fatalf("lost DNS evidence: %v", err)
		}
		want := 1
		if temporary {
			want = 2
		}
		if calls != want {
			t.Fatalf("DNS attempts %d, want %d", calls, want)
		}
	}
	calls := 0
	ips, err := resolveMediaProxyHost(context.Background(), "media.example", func(context.Context, string) ([]net.IPAddr, error) {
		calls++
		if calls == 1 {
			return nil, &net.DNSError{Err: "temporary", IsTemporary: true}
		}
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
	})
	if err != nil || len(ips) != 1 || calls != 2 {
		t.Fatalf("temporary DNS recovery: %v %v calls=%d", ips, err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = resolveMediaProxyHost(ctx, "media.example", func(context.Context, string) ([]net.IPAddr, error) { return nil, ctx.Err() })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
}

func TestMediaPreflightRejectsPrivateAndInvalidRoutes(t *testing.T) {
	for _, raw := range []string{"file:///tmp/media", "http://127.0.0.1/v1", "https://[::1]/v1", "https://user:password@media.example/v1"} {
		if err := PreflightMediaEndpoint(context.Background(), raw); err == nil {
			t.Fatalf("unsafe route accepted: %s", raw)
		}
	}
}
