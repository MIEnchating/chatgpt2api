package protocol

import (
	"context"
	"testing"
)

func TestNewRelayBearerGetRequestSetsHeadersWithoutBody(t *testing.T) {
	req, err := NewRelayBearerGetRequest(context.Background(), "https://cdn.example.com/v/1.mp4?sig=x", " key ", "video/*")
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "GET" {
		t.Fatalf("method = %q", req.Method)
	}
	if got := req.URL.String(); got != "https://cdn.example.com/v/1.mp4?sig=x" {
		t.Fatalf("url = %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer key" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Accept"); got != "video/*" {
		t.Fatalf("Accept = %q", got)
	}
	if req.Body != nil {
		t.Fatal("a GET request must have no body")
	}
}

func TestNewRelayBearerGetRequestRejectsInvalidURL(t *testing.T) {
	if _, err := NewRelayBearerGetRequest(context.Background(), "http://[::1", "key", "*/*"); err == nil {
		t.Fatal("an invalid URL must be rejected")
	}
}
