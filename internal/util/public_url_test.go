package util

import (
	"strings"
	"testing"
)

func TestIsPublicHTTPURLAcceptsPublicHosts(t *testing.T) {
	for _, value := range []string{
		"https://example.com/a.png",
		"http://example.com:8080/x?y=1",
		"https://example.com./a",
		"https://8.8.8.8/x",
		"https://[2606:4700:4700::1111]/x",
		"https://bücher.example/a",
		"  https://cdn.example.org/v.mp4  ",
	} {
		if !IsPublicHTTPURL(value) {
			t.Errorf("rejected public URL %q", value)
		}
	}
}

func TestIsPublicHTTPURLRejectsNonPublicTargets(t *testing.T) {
	for _, value := range []string{
		"",
		"/relative/path",
		"ftp://example.com/a",
		"https:///a",
		"https://user:pw@example.com/a",
		"http://localhost/a",
		"http://a.localhost/a",
		"http://printer.local/a",
		"http://svc.internal/a",
		"http://router.home.arpa/a",
		"http://intranet/a",
		"http://127.0.0.1/a",
		"http://127.1/a",
		"http://2130706433/a",
		"http://0x7f.1/a",
		"http://0x7f.0.0.1/a",
		"http://0177.0.0.1/a",
		"http://10.0.0.1/a",
		"http://172.16.0.1/a",
		"http://192.168.1.1/a",
		"http://169.254.169.254/a",
		"http://100.64.0.1/a",
		"http://192.0.0.1/a",
		"http://192.0.2.1/a",
		"http://198.18.0.1/a",
		"http://198.19.255.254/a",
		"http://198.51.100.1/a",
		"http://203.0.113.1/a",
		"http://240.0.0.1/a",
		"http://0.0.0.0/a",
		"http://[::1]/a",
		"http://[::ffff:127.0.0.1]/a",
		"http://[fe80::1]/a",
		"http://[fd00::1]/a",
		"http://[2001:db8::1]/a",
		"http://[64:ff9b::7f00:1]/a",
		"http://[64:ff9b::808:808]/a",
		"https://" + strings.Repeat("a", 2100) + ".example.com/a",
	} {
		if IsPublicHTTPURL(value) {
			t.Errorf("accepted non-public URL %q", value)
		}
	}
}
