package protocol

import (
	"context"
	"io"
	"net/http"
	"testing"
)

func TestNewRelayJSONRequestSetsURLAndHeaders(t *testing.T) {
	req, err := NewRelayJSONRequest(context.Background(), " https://example.com/ ", http.MethodPost, "/v1/x", " key ", "text/event-stream", []byte(`{"a":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := req.URL.String(); got != "https://example.com/v1/x" {
		t.Fatalf("url = %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer key" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("Accept = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil || string(body) != `{"a":1}` {
		t.Fatalf("body = %q, err = %v", body, err)
	}
}

func TestNewRelayJSONRequestWithoutBodyOmitsContentType(t *testing.T) {
	req, err := NewRelayJSONRequest(context.Background(), "https://example.com", http.MethodGet, "/v1/models", "key", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if req.Body != nil {
		t.Fatal("a request without data must have no body")
	}
	if got := req.Header.Get("Content-Type"); got != "" {
		t.Fatalf("Content-Type = %q, want empty", got)
	}
	if got := req.URL.String(); got != "https://example.com/v1/models" {
		t.Fatalf("url = %q", got)
	}
}

func TestNewRelayJSONRequestRejectsInvalidMethod(t *testing.T) {
	if _, err := NewRelayJSONRequest(context.Background(), "https://example.com", "BAD METHOD", "/v1/x", "key", "application/json", nil); err == nil {
		t.Fatal("an invalid method must be rejected")
	}
}
