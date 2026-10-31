package protocol

import (
	"bytes"
	"context"
	"io"
	"testing"
)

func TestNewRelayMultipartRequestSetsURLAndHeaders(t *testing.T) {
	req, err := NewRelayMultipartRequest(context.Background(), " https://example.com/ ", "/v1/images/edits", " key ", "multipart/form-data; boundary=abc", bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "POST" {
		t.Fatalf("method = %q", req.Method)
	}
	if got := req.URL.String(); got != "https://example.com/v1/images/edits" {
		t.Fatalf("url = %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer key" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "multipart/form-data; boundary=abc" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := req.Header.Get("Accept"); got != "application/json" {
		t.Fatalf("Accept = %q", got)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil || string(body) != "payload" {
		t.Fatalf("body = %q, err = %v", body, err)
	}
}

func TestNewRelayMultipartRequestRejectsInvalidURL(t *testing.T) {
	if _, err := NewRelayMultipartRequest(context.Background(), "http://[::1", "/v1/x", "key", "multipart/form-data", nil); err == nil {
		t.Fatal("an invalid base URL must be rejected")
	}
}
