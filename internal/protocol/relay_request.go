package protocol

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
)

// NewRelayJSONRequest builds an authenticated upstream request with an optional JSON body.
// The caller owns client selection and execution, so this package stays free of HTTP client policy.
func NewRelayJSONRequest(ctx context.Context, baseURL, method, pathValue, apiKey, accept string, data []byte) (*http.Request, error) {
	var body io.Reader
	if data != nil {
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(strings.TrimSpace(baseURL), "/")+pathValue, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", accept)
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}
