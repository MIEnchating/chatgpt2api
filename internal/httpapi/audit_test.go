package httpapi

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
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

func TestAuditLogsRedactLoginAndCustomRelaySecrets(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	const loginPassword = "tiny"
	request := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"admin","password":"`+loginPassword+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("login status = %d body = %s", response.Code, response.Body.String())
	}

	loginLog := findHTTPAuditLogByPath(mustSearchAppLogs(t, app, service.LogQuery{View: service.LogViewAll, Limit: 10}), "/auth/login")
	if loginLog == nil {
		t.Fatal("login audit log was not stored")
	}
	loginDetail, _ := loginLog["detail"].(map[string]any)
	loginArgs, _ := loginDetail["request_args"].(map[string]any)
	if loginArgs["password"] != "[REDACTED]" || strings.Contains(fmt.Sprintf("%#v", loginDetail), loginPassword) {
		t.Fatalf("login audit detail leaked password: %#v", loginDetail)
	}

	const (
		firstFormPassword = "form-first"
		lastFormPassword  = "form-last"
	)
	request = httptest.NewRequest(
		http.MethodPost,
		"/auth/login",
		strings.NewReader("username=admin&password="+firstFormPassword+"&password="+lastFormPassword),
	)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("form login status = %d body = %s", response.Code, response.Body.String())
	}
	formLoginLog := findHTTPAuditLogByPath(mustSearchAppLogs(t, app, service.LogQuery{View: service.LogViewAll, Limit: 10}), "/auth/login")
	formLoginDetail, _ := formLoginLog["detail"].(map[string]any)
	formLoginArgs, _ := formLoginDetail["request_args"].(map[string]any)
	if formLoginArgs["password"] != "[REDACTED]" {
		t.Fatalf("form login audit args were not redacted: %#v", formLoginArgs)
	}
	serializedFormDetail := fmt.Sprintf("%#v", formLoginDetail)
	for _, password := range []string{firstFormPassword, lastFormPassword} {
		if strings.Contains(serializedFormDetail, password) {
			t.Fatalf("form login audit detail leaked %q: %#v", password, formLoginDetail)
		}
	}

	const (
		customAPIKey  = "z9q"
		firstQueryKey = "first"
		lastQueryKey  = "second"
	)
	request = httptest.NewRequest(
		http.MethodPost,
		"/api/profile/custom-relay-configs?api_key="+firstQueryKey+"&api_key="+lastQueryKey,
		strings.NewReader(`{"kind":"video","name":"test relay","base_url":"https://api.example.test","api_key":"`+customAPIKey+`"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, adminSessionToken(t, app))
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("custom relay status = %d body = %s", response.Code, response.Body.String())
	}

	relayLog := findHTTPAuditLogByPath(mustSearchAppLogs(t, app, service.LogQuery{View: service.LogViewAll, Limit: 10}), "/api/profile/custom-relay-configs")
	if relayLog == nil {
		t.Fatal("custom relay audit log was not stored")
	}
	relayDetail, _ := relayLog["detail"].(map[string]any)
	relayArgs, _ := relayDetail["request_args"].(map[string]any)
	queryArgs, _ := relayArgs["query"].(map[string]any)
	bodyArgs, _ := relayArgs["body"].(map[string]any)
	if queryArgs["api_key"] != "[REDACTED]" || bodyArgs["api_key"] != "[REDACTED]" {
		t.Fatalf("custom relay audit args were not redacted: %#v", relayArgs)
	}
	serializedDetail := fmt.Sprintf("%#v", relayDetail)
	for _, secret := range []string{customAPIKey, firstQueryKey, lastQueryKey} {
		if strings.Contains(serializedDetail, secret) {
			t.Fatalf("custom relay audit detail leaked %q: %#v", secret, relayDetail)
		}
	}
}

func TestCaptureAuditRequestOmitsUnparseableSecrets(t *testing.T) {
	const secret = "must-not-be-stored"
	tests := []struct {
		name        string
		target      string
		contentType string
		body        string
	}{
		{name: "query", target: "/api/example?password=" + secret + ";broken"},
		{name: "form", target: "/api/example", contentType: "application/x-www-form-urlencoded", body: "password=" + secret + ";broken"},
		{name: "json", target: "/api/example", contentType: "application/json", body: `{"password":"` + secret + `"`},
		{name: "missing content type", target: "/api/example", body: "password=" + secret},
		{name: "plain text", target: "/api/example", contentType: "text/plain", body: "password=" + secret},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.target, strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.contentType)
			capture := captureAuditRequest(request)
			if serialized := fmt.Sprintf("%#v", capture.args); strings.Contains(serialized, secret) {
				t.Fatalf("captureAuditRequest() leaked unparseable secret: %s", serialized)
			}
		})
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
