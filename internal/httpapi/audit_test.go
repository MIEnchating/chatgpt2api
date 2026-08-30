package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuditResponseWriterSkipsBinaryAndTracksResponseSize(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("Content-Type", "video/mp4")
	recorder := &auditResponseWriter{ResponseWriter: response}
	payload := bytes.Repeat([]byte{0xff, 0x00, 0x7f}, 4096)
	if _, err := recorder.Write(payload); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if recorder.bytesWritten != int64(len(payload)) || recorder.body.Len() != 0 || recorder.bodyTruncated {
		t.Fatalf("binary capture = bytes %d body %d truncated %v", recorder.bytesWritten, recorder.body.Len(), recorder.bodyTruncated)
	}
	detail := map[string]any{}
	req := httptest.NewRequest(http.MethodGet, "/api/files/example/content", nil)
	addAuditResponseDetail(detail, req, recorder, http.StatusOK)
	if detail["response_bytes"] != int64(len(payload)) || detail["response_content_type"] != "video/mp4" {
		t.Fatalf("binary response detail = %#v", detail)
	}
	if _, exists := detail["response_body"]; exists {
		t.Fatalf("binary response body must be omitted: %#v", detail)
	}
}

func TestAuditResponseWriterOmitsSuccessfulReadsAndTruncatedJSON(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	recorder := &auditResponseWriter{ResponseWriter: response}
	payload := []byte(`{"items":["` + strings.Repeat("x", maxAuditResponsePayloadBytes) + `"]}`)
	if _, err := recorder.Write(payload); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if !recorder.bodyTruncated || recorder.body.Len() != maxAuditResponsePayloadBytes {
		t.Fatalf("JSON capture = body %d truncated %v", recorder.body.Len(), recorder.bodyTruncated)
	}
	detail := map[string]any{}
	req := httptest.NewRequest(http.MethodPost, "/api/example", nil)
	addAuditResponseDetail(detail, req, recorder, http.StatusOK)
	if detail["response_truncated"] != true {
		t.Fatalf("truncated response detail = %#v", detail)
	}
	if _, exists := detail["response_body"]; exists {
		t.Fatalf("partial JSON must not be stored: %#v", detail)
	}

	readResponse := httptest.NewRecorder()
	readResponse.Header().Set("Content-Type", "application/json")
	readRecorder := &auditResponseWriter{ResponseWriter: readResponse}
	_, _ = readRecorder.Write([]byte(`{"secret":"large read payload"}`))
	readDetail := map[string]any{}
	readRequest := httptest.NewRequest(http.MethodGet, "/api/example", nil)
	addAuditResponseDetail(readDetail, readRequest, readRecorder, http.StatusOK)
	if _, exists := readDetail["response_body"]; exists {
		t.Fatalf("successful read response body must be omitted: %#v", readDetail)
	}
}

func TestNoisySuccessfulAuditRequestsCoverAutomaticReads(t *testing.T) {
	for _, path := range []string{
		"/api/profile/announcement-preferences",
		"/api/profile/image-generation-preferences",
		"/api/profile/assets",
		"/api/profile/image-conversations/window",
		"/api/profile/image-conversations/conversation-id",
		"/api/files/object-id/content",
		"/api/canvas",
		"/api/workflows",
		"/api/model-config",
		"/api/settings",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if !isNoisySuccessfulAuditRequest(req) {
			t.Fatalf("%s should be treated as an automatic/noisy read", path)
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/profile/image-conversations", nil)
		if isNoisySuccessfulAuditRequest(req) {
			t.Fatalf("%s mutation must remain auditable", method)
		}
	}
}

func TestClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "203.0.113.10:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.7")
	req.Header.Set("X-Real-IP", "198.51.100.8")
	if got := clientIP(req); got != "203.0.113.10" {
		t.Fatalf("clientIP() = %q, want direct peer", got)
	}
}

func TestClientIPUsesRightmostForwardedAddressFromTrustedProxy(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "172.18.0.4:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.99, 203.0.113.20")
	if got := clientIP(req); got != "203.0.113.20" {
		t.Fatalf("clientIP() = %q, want proxy-appended address", got)
	}
}

func TestClientIPRejectsInvalidForwardedAddress(t *testing.T) {
	req := httptest.NewRequest("GET", "https://example.test/", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", "not-an-ip")
	req.Header.Set("X-Real-IP", "203.0.113.30")
	if got := clientIP(req); got != "203.0.113.30" {
		t.Fatalf("clientIP() = %q, want validated real IP", got)
	}
}
