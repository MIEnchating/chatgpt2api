package service

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type downloadTestProxyConfig string

func (c downloadTestProxyConfig) Proxy() string { return string(c) }

func TestSafeDownloadClientBlocksLoopbackWithoutProxy(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer target.Close()
	svc := NewProxyService(downloadTestProxyConfig(""))
	defer svc.Close()
	if resp, err := svc.SafeDownloadClient(5 * time.Second).Get(target.URL); err == nil {
		resp.Body.Close()
		t.Fatal("loopback download target must be rejected")
	}
	if resp, err := (*ProxyService)(nil).SafeDownloadClient(5 * time.Second).Get(target.URL); err == nil {
		resp.Body.Close()
		t.Fatal("nil proxy service must still use the validating client")
	}
}

func TestSafeDownloadClientValidatesTargetBeforeProxy(t *testing.T) {
	var hits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer proxy.Close()
	svc := NewProxyService(downloadTestProxyConfig(proxy.URL))
	defer svc.Close()
	client := svc.SafeDownloadClient(5 * time.Second)
	for _, target := range []string{"http://127.0.0.1:9/a", "http://10.0.0.5/a", "http://[::1]:9/a", "http://198.18.0.1/a"} {
		if resp, err := client.Get(target); err == nil {
			resp.Body.Close()
			t.Fatalf("%s must be rejected before reaching the proxy", target)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("proxy received %d requests for blocked targets", hits.Load())
	}
}
