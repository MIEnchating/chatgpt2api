package service

import "testing"

func TestSanitizeLogFieldRedactsCredentialHeaders(t *testing.T) {
	for _, key := range []string{"Cookie", "Set-Cookie", "X-Api-Key", "api-key", "credential", "user_credentials", "apiKey"} {
		if got := sanitizeLogField(key, "secret"); got != redactedLogValue {
			t.Errorf("key %q was not redacted: %v", key, got)
		}
	}
}

func TestPreviewRelayKeyShowsOnlyTail(t *testing.T) {
	if got := previewRelayKey("sk-abcdefghijklmnop"); got != "...mnop" {
		t.Fatalf("preview = %q", got)
	}
	if got := previewRelayKey("ab"); got != "..." {
		t.Fatalf("short preview = %q", got)
	}
}
