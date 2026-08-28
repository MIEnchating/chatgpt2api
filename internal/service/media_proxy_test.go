package service

import (
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
