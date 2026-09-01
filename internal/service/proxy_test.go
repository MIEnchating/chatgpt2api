package service

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mutableProxyConfig struct {
	mu    sync.RWMutex
	proxy string
}

func (c *mutableProxyConfig) Proxy() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.proxy
}

func (c *mutableProxyConfig) setProxy(proxy string) {
	c.mu.Lock()
	c.proxy = proxy
	c.mu.Unlock()
}

func doProxyTestRequest(client *http.Client, target string) error {
	resp, err := client.Get(target)
	if err != nil {
		return err
	}
	_, readErr := io.Copy(io.Discard, resp.Body)
	closeErr := resp.Body.Close()
	if readErr != nil {
		return readErr
	}
	return closeErr
}

func waitForSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(message)
	}
}

func TestProxyServiceReusesTransportAcrossClientTimeouts(t *testing.T) {
	var connections atomic.Int32
	proxy := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	proxy.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	proxy.Start()
	defer proxy.Close()

	config := &mutableProxyConfig{proxy: "  " + proxy.URL + "  "}
	service := NewProxyService(config)
	defer service.Close()
	shortClient := service.HTTPClient(time.Second)
	longClient := service.HTTPClient(3 * time.Second)
	if shortClient == longClient {
		t.Fatal("HTTPClient() should return independent clients")
	}
	if shortClient.Transport != longClient.Transport {
		t.Fatal("clients for the same normalized proxy should share a transport")
	}
	if shortClient.Timeout != time.Second || longClient.Timeout != 3*time.Second {
		t.Fatalf("client timeouts = %s and %s", shortClient.Timeout, longClient.Timeout)
	}

	if err := doProxyTestRequest(shortClient, "http://upstream.invalid/first"); err != nil {
		t.Fatalf("first proxy request: %v", err)
	}
	if err := doProxyTestRequest(longClient, "http://upstream.invalid/second"); err != nil {
		t.Fatalf("second proxy request: %v", err)
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("proxy TCP connections = %d, want 1", got)
	}
}

func TestProxyServiceSwitchesProxyWithoutInterruptingActiveRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	oldClosed := make(chan struct{})
	var startedOnce sync.Once
	var releaseOnce sync.Once
	var closedOnce sync.Once
	releaseRequest := func() { releaseOnce.Do(func() { close(release) }) }
	oldProxy := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		startedOnce.Do(func() { close(started) })
		<-release
		_, _ = io.WriteString(w, "old")
	}))
	oldProxy.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closedOnce.Do(func() { close(oldClosed) })
		}
	}
	oldProxy.Start()
	defer oldProxy.Close()
	defer releaseRequest()

	newProxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "new")
	}))
	defer newProxy.Close()

	config := &mutableProxyConfig{proxy: oldProxy.URL}
	service := NewProxyService(config)
	defer service.Close()
	oldClient := service.HTTPClient(3 * time.Second)
	oldResult := make(chan error, 1)
	go func() {
		oldResult <- doProxyTestRequest(oldClient, "http://upstream.invalid/active")
	}()
	waitForSignal(t, started, "old proxy request did not start")

	config.setProxy(newProxy.URL)
	newClient := service.HTTPClient(3 * time.Second)
	if oldClient.Transport == newClient.Transport {
		t.Fatal("different proxies should not share a transport")
	}
	if err := doProxyTestRequest(newClient, "http://upstream.invalid/new"); err != nil {
		releaseRequest()
		t.Fatalf("new proxy request: %v", err)
	}
	releaseRequest()
	select {
	case err := <-oldResult:
		if err != nil {
			t.Fatalf("active request was interrupted by proxy switch: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("active request did not finish after proxy switch")
	}
	waitForSignal(t, oldClosed, "retired proxy connection was not closed after the active request")
}

func TestProxyServiceCloseReleasesConnectionsAndRejectsNewRequests(t *testing.T) {
	closed := make(chan struct{})
	var closedOnce sync.Once
	proxy := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	proxy.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closedOnce.Do(func() { close(closed) })
		}
	}
	proxy.Start()
	defer proxy.Close()

	service := NewProxyService(&mutableProxyConfig{proxy: proxy.URL})
	client := service.HTTPClient(time.Second)
	if err := doProxyTestRequest(client, "http://upstream.invalid/idle"); err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	service.Close()
	waitForSignal(t, closed, "ProxyService.Close() did not close its idle connection")

	_, err := client.Get("http://upstream.invalid/after-close")
	if err == nil || !strings.Contains(err.Error(), "proxy service is closed") {
		t.Fatalf("request after Close() error = %v", err)
	}
	service.Close()
}

func TestSOCKS5AddressModes(t *testing.T) {
	t.Run("socks5h keeps hostname for proxy-side DNS", func(t *testing.T) {
		got, err := socks5Address(context.Background(), "socks5h", "chatgpt.com:443")
		if err != nil {
			t.Fatalf("socks5Address() error = %v", err)
		}
		wantPrefix := []byte{0x03, byte(len("chatgpt.com"))}
		if string(got[:len(wantPrefix)]) != string(wantPrefix) {
			t.Fatalf("address prefix = %#v, want %#v", got[:len(wantPrefix)], wantPrefix)
		}
		if host := string(got[2 : 2+len("chatgpt.com")]); host != "chatgpt.com" {
			t.Fatalf("host = %q", host)
		}
		if got[len(got)-2] != 0x01 || got[len(got)-1] != 0xbb {
			t.Fatalf("port bytes = %#v", got[len(got)-2:])
		}
	})

	t.Run("socks5 sends numeric ip when target is ip literal", func(t *testing.T) {
		got, err := socks5Address(context.Background(), "socks5", net.JoinHostPort("127.0.0.1", "8080"))
		if err != nil {
			t.Fatalf("socks5Address() error = %v", err)
		}
		want := []byte{0x01, 127, 0, 0, 1, 0x1f, 0x90}
		if string(got) != string(want) {
			t.Fatalf("address = %#v, want %#v", got, want)
		}
	})
}

func TestBrowserHTTPClientKeepsSessionAndTimeout(t *testing.T) {
	client := browserHTTPClientForProfile("", "", 2*time.Second)
	if client == nil {
		t.Fatal("browserHTTPClient() returned nil")
	}
	if client.Jar == nil {
		t.Fatal("browserHTTPClient() should enable a cookie jar for browser-like sessions")
	}
	if client.Timeout != 2*time.Second {
		t.Fatalf("Timeout = %s, want %s", client.Timeout, 2*time.Second)
	}
}

func TestBrowserHTTPClientPreservesCallerAuthHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer token-1" {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("Origin"); got != "https://chatgpt.com" {
			t.Fatalf("Origin = %q", got)
		}
		if got := r.Header.Get("Referer"); got != "https://chatgpt.com/" {
			t.Fatalf("Referer = %q", got)
		}
		if got := r.Header.Get("User-Agent"); got == "" {
			t.Fatal("User-Agent should be populated by browser impersonation")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := browserHTTPClientForProfile("", "", 2*time.Second)
	req, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer token-1")
	req.Header.Set("Origin", "https://chatgpt.com")
	req.Header.Set("Referer", "https://chatgpt.com/")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}
