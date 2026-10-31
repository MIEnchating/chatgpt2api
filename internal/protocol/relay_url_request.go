package protocol

import (
	"context"
	"net/http"
	"strings"
)

// NewRelayBearerGetRequest builds an authenticated upstream GET request for an absolute URL.
// The caller must validate the URL before calling and owns redirect and client policy.
func NewRelayBearerGetRequest(ctx context.Context, rawURL, apiKey, accept string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", accept)
	return req, nil
}
