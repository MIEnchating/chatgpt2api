package main

import (
	"net/http"
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
