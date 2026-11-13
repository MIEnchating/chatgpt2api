package httpapi

import (
	"context"
	"testing"
)

func TestAuthFailureContextUsesNonSensitiveReasons(t *testing.T) {
	for _, reason := range []string{"missing_cookie", "invalid_cookie"} {
		ctx := withAuthFailure(context.Background(), reason)
		if got := requestAuthFailure(ctx); got != reason {
			t.Fatalf("auth failure reason = %q, want %q", got, reason)
		}
	}
	if got := requestAuthFailure(context.Background()); got != "" {
		t.Fatalf("unexpected auth failure reason = %q", got)
	}
}
