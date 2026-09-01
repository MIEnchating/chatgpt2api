package main

import (
	"errors"
	"net/http"
	"os"
	"testing"
)

func TestNewHTTPServerSetsDefensiveReadTimeouts(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	server := newHTTPServer(":0", handler)

	if server.Addr != ":0" || server.Handler == nil {
		t.Fatalf("server address/handler = %q/%v", server.Addr, server.Handler)
	}
	if server.ReadHeaderTimeout != httpReadHeaderTimeout {
		t.Fatalf("ReadHeaderTimeout = %v, want %v", server.ReadHeaderTimeout, httpReadHeaderTimeout)
	}
	if server.ReadTimeout != httpReadTimeout {
		t.Fatalf("ReadTimeout = %v, want %v", server.ReadTimeout, httpReadTimeout)
	}
	if server.IdleTimeout != httpIdleTimeout {
		t.Fatalf("IdleTimeout = %v, want %v", server.IdleTimeout, httpIdleTimeout)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %v, want streaming responses unrestricted", server.WriteTimeout)
	}
}

func TestWaitForServerEventReturnsListenFailure(t *testing.T) {
	server := newHTTPServer("127.0.0.1:-1", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	stoppedBySignal, err := waitForServerEvent(server, make(chan os.Signal))
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("waitForServerEvent() error = %v, want listen failure", err)
	}
	if stoppedBySignal {
		t.Fatal("waitForServerEvent() reported a signal for a listen failure")
	}
}
