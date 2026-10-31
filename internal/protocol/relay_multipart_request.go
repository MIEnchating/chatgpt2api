package protocol

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// NewRelayMultipartRequest builds an authenticated upstream POST request around an already encoded multipart body.
// contentType must come from the multipart writer so the boundary matches the body.
func NewRelayMultipartRequest(ctx context.Context, baseURL, pathValue, apiKey, contentType string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(strings.TrimSpace(baseURL), "/")+pathValue, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	return req, nil
}
