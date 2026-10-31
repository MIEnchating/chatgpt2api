package service

import (
	"net"
	"testing"
)

func TestIsBlockedMediaProxyIPCoversSpecialPurposeRanges(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		{"192.0.0.8", true},
		{"198.18.0.1", true},
		{"198.19.255.254", true},
		{"64:ff9b::7f00:1", true},
		{"64:ff9b::808:808", true},
		{"127.0.0.1", true},
		{"10.0.0.1", true},
		{"100.64.0.1", true},
		{"198.20.0.1", false},
		{"192.0.1.1", false},
		{"8.8.8.8", false},
		{"2606:4700:4700::1111", false},
	}
	for _, test := range tests {
		t.Run(test.ip, func(t *testing.T) {
			ip := net.ParseIP(test.ip)
			if ip == nil {
				t.Fatalf("invalid test address %q", test.ip)
			}
			if got := isBlockedMediaProxyIP(ip); got != test.blocked {
				t.Fatalf("isBlockedMediaProxyIP(%s) = %v, want %v", test.ip, got, test.blocked)
			}
		})
	}
}
