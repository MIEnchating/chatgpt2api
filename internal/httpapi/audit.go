package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const (
	maxAuditRequestPayloadBytes  = 64 * 1024
	maxAuditResponsePayloadBytes = 8 * 1024
)

type requestIdentityContextKey struct{}
type auditRequestContextKey struct{}
type businessLogContextKey struct{}

type auditRequestCapture struct {
	args      any
	truncated bool
}

type auditBodyReadCloser struct {
	io.Reader
	closer io.Closer
}

func (r *auditBodyReadCloser) Close() error {
	if r == nil || r.closer == nil {
		return nil
	}
	return r.closer.Close()
}

type auditResponseWriter struct {
	http.ResponseWriter
	status        int
	body          bytes.Buffer
	bytesWritten  int64
	bodyTruncated bool
}

func (w *auditResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *auditResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytesWritten += int64(n)
	if n > 0 && auditTextualResponse(w.Header().Get("Content-Type"), data[:n]) {
		remaining := maxAuditResponsePayloadBytes - w.body.Len()
		if remaining > 0 {
			captured := n
			if captured > remaining {
				captured = remaining
			}
			_, _ = w.body.Write(data[:captured])
		}
		if n > remaining {
			w.bodyTruncated = true
		}
	}
	return n, err
}

func (w *auditResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if auditTextualResponse(w.Header().Get("Content-Type"), nil) {
		return io.Copy(struct{ io.Writer }{w}, reader)
	}
	var (
		n   int64
		err error
	)
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		n, err = readerFrom.ReadFrom(reader)
	} else {
		n, err = io.Copy(w.ResponseWriter, reader)
	}
	w.bytesWritten += n
	return n, err
}

func (w *auditResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *auditResponseWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *auditResponseWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (a *App) serveObservedHTTP(w http.ResponseWriter, r *http.Request, routes []appRoute) {
	if r.Method == http.MethodOptions || !isAPISpace(r.URL.Path) {
		a.serveHTTP(w, r, routes)
		return
	}

	requestCapture := captureAuditRequest(r)
	*r = *r.WithContext(withAuditRequestCapture(r.Context(), requestCapture))
	recorder := &auditResponseWriter{ResponseWriter: w}
	start := time.Now()
	a.serveHTTP(recorder, r, routes)
	duration := time.Since(start)
	status := recorder.statusCode()

	a.logHTTPRequest(r, status, duration)
	if shouldWriteAuditLog(r, status) {
		a.writeAuditLog(r, recorder, status, duration, requestCapture)
	}
}

func (a *App) logHTTPRequest(r *http.Request, status int, duration time.Duration) {
	if a.logger == nil {
		return
	}
	attrs := []any{
		"method", r.Method,
		"path", r.URL.Path,
		"status", status,
		"duration_ms", duration.Milliseconds(),
		"ip_address", clientIP(r),
	}
	switch {
	case status >= http.StatusInternalServerError:
		a.logger.Error("http request", attrs...)
	case status >= http.StatusBadRequest:
		a.logger.Warning("http request", attrs...)
	default:
		a.logger.Debug("http request", attrs...)
	}
}

func (a *App) writeAuditLog(r *http.Request, recorder *auditResponseWriter, status int, duration time.Duration, requestCapture auditRequestCapture) {
	if a.logs == nil {
		return
	}
	detail := map[string]any{
		"method":         r.Method,
		"path":           r.URL.Path,
		"module":         inferAuditModule(r.URL.Path),
		"status":         status,
		"duration_ms":    duration.Milliseconds(),
		"ip_address":     clientIP(r),
		"user_agent":     r.UserAgent(),
		"operation_type": operationTypeForMethod(r.Method),
		"log_level":      logLevelForStatus(status),
	}
	addAuditRequestDetail(detail, requestCapture)
	addAuditResponseDetail(detail, r, recorder, status)
	if identity, ok := requestIdentity(r.Context()); ok {
		addIdentityLogDetail(detail, identity)
		if name := identityDisplayName(identity); name != "" {
			detail["username"] = name
		}
	} else {
		detail["username"] = "anonymous"
	}

	if err := a.logs.Add(strings.TrimSpace(r.Method+" "+r.URL.Path), detail); err != nil && a.logger != nil {
		a.logger.Error("create audit log failed", "error", err, "path", r.URL.Path, "method", r.Method)
	}
}

func withRequestIdentity(ctx context.Context, identity service.Identity) context.Context {
	return context.WithValue(ctx, requestIdentityContextKey{}, identity)
}

func requestIdentity(ctx context.Context) (service.Identity, bool) {
	identity, ok := ctx.Value(requestIdentityContextKey{}).(service.Identity)
	return identity, ok
}

func withAuditRequestCapture(ctx context.Context, capture auditRequestCapture) context.Context {
	return context.WithValue(ctx, auditRequestContextKey{}, capture)
}

func requestAuditCapture(ctx context.Context) auditRequestCapture {
	capture, _ := ctx.Value(auditRequestContextKey{}).(auditRequestCapture)
	return capture
}

func markRequestBusinessLogged(r *http.Request) {
	if r == nil {
		return
	}
	*r = *r.WithContext(context.WithValue(r.Context(), businessLogContextKey{}, true))
}

func requestBusinessLogged(ctx context.Context) bool {
	value, _ := ctx.Value(businessLogContextKey{}).(bool)
	return value
}

func addAuditRequestDetail(detail map[string]any, capture auditRequestCapture) {
	if detail == nil {
		return
	}
	if capture.args != nil {
		detail["request_args"] = capture.args
	}
	if capture.truncated {
		detail["request_truncated"] = true
	}
}

func shouldWriteAuditLog(r *http.Request, status int) bool {
	if r == nil {
		return true
	}
	if requestBusinessLogged(r.Context()) {
		return false
	}
	if status >= http.StatusBadRequest {
		return true
	}
	return !isNoisySuccessfulAuditRequest(r)
}

func isNoisySuccessfulAuditRequest(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := r.URL.Path
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		switch {
		case path == "/api/logs",
			path == "/api/logs/governance",
			path == "/api/announcements",
			path == "/api/images/storage-governance",
			path == "/api/images",
			path == "/api/canvas",
			path == "/api/workflows",
			path == "/api/prompt-sources",
			path == "/api/creation-tasks",
			path == "/api/app-meta",
			path == "/api/admin/permissions",
			path == "/api/profile/announcement-preferences",
			path == "/api/profile/image-generation-preferences",
			path == "/api/profile/assets",
			path == "/api/profile/prompt-favorites",
			path == "/api/profile/storage-provider",
			path == "/api/profile/custom-relay-configs",
			path == "/api/profile/upstream-models",
			path == "/api/profile/relay-key",
			path == "/api/profile/balance",
			path == "/api/model-config",
			path == "/api/settings",
			path == "/auth/session":
			return true
		case strings.HasPrefix(path, "/api/profile/image-conversations"),
			strings.HasPrefix(path, "/api/files/") && strings.HasSuffix(path, "/content"):
			return true
		}
	}
	return false
}

func addAuditResponseDetail(detail map[string]any, r *http.Request, recorder *auditResponseWriter, status int) {
	if detail == nil || recorder == nil {
		return
	}
	if recorder.bytesWritten > 0 {
		detail["response_bytes"] = recorder.bytesWritten
	}
	if contentType := auditMediaType(recorder.Header().Get("Content-Type")); contentType != "" {
		detail["response_content_type"] = contentType
	}
	if recorder.bodyTruncated {
		detail["response_truncated"] = true
		return
	}
	if r != nil && status < http.StatusBadRequest && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		return
	}
	if responseBody := normalizeAuditPayload(recorder.body.Bytes()); responseBody != nil {
		detail["response_body"] = responseBody
	}
}

func auditTextualResponse(contentType string, data []byte) bool {
	mediaType := auditMediaType(contentType)
	if mediaType == "" && len(data) > 0 {
		mediaType = auditMediaType(http.DetectContentType(data))
	}
	if mediaType == "text/event-stream" {
		return false
	}
	return strings.HasPrefix(mediaType, "text/") || mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

func auditMediaType(contentType string) string {
	contentType = strings.TrimSpace(contentType)
	if contentType == "" {
		return ""
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	}
	return strings.ToLower(mediaType)
}

func captureAuditRequest(r *http.Request) auditRequestCapture {
	if r == nil {
		return auditRequestCapture{}
	}
	query := captureAuditQuery(r)
	if strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		return auditRequestCapture{args: combineAuditArgs(query, "[multipart/form-data]")}
	}
	if r.Method != http.MethodGet && r.Body != nil {
		body, truncated, ok := captureAuditBody(r)
		if ok {
			if bodyPayload := normalizeAuditRequestBody(r.Header.Get("Content-Type"), body); bodyPayload != nil {
				return auditRequestCapture{args: combineAuditArgs(query, bodyPayload), truncated: truncated}
			}
		}
	}
	return auditRequestCapture{args: query}
}

func captureAuditBody(r *http.Request) ([]byte, bool, bool) {
	if r == nil || r.Body == nil {
		return nil, false, true
	}
	captured, err := io.ReadAll(io.LimitReader(r.Body, int64(maxAuditRequestPayloadBytes)+1))
	r.Body = &auditBodyReadCloser{Reader: io.MultiReader(bytes.NewReader(captured), r.Body), closer: r.Body}
	if err != nil {
		return nil, false, false
	}
	if len(captured) > maxAuditRequestPayloadBytes {
		return captured[:maxAuditRequestPayloadBytes], true, true
	}
	return captured, false, true
}

func captureAuditQuery(r *http.Request) any {
	if r == nil || r.URL == nil {
		return nil
	}
	if strings.TrimSpace(r.URL.RawQuery) == "" {
		return nil
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "[invalid query]"
	}
	return sanitizeAuditValues(values)
}

func sanitizeAuditValues(values url.Values) any {
	payload := make(map[string]any, len(values))
	for key, items := range values {
		if len(items) == 1 {
			payload[key] = items[0]
			continue
		}
		payload[key] = items
	}
	return service.SanitizeLogValue(payload)
}

func normalizeAuditRequestBody(contentType string, raw []byte) any {
	mediaType := auditMediaType(contentType)
	if mediaType == "application/x-www-form-urlencoded" {
		values, err := url.ParseQuery(string(raw))
		if err != nil {
			return "[invalid form payload]"
		}
		return sanitizeAuditValues(values)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if !json.Valid(trimmed) {
		if mediaType == "application/json" || strings.HasSuffix(mediaType, "+json") {
			return "[invalid JSON payload]"
		}
		return "[unparseable request payload]"
	}
	return normalizeAuditPayload(trimmed)
}

func combineAuditArgs(query, body any) any {
	if query == nil {
		return body
	}
	if body == nil {
		return query
	}
	return map[string]any{"query": query, "body": body}
}

func normalizeAuditPayload(raw []byte) any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if len(trimmed) > maxAuditRequestPayloadBytes {
		trimmed = append([]byte(nil), trimmed[:maxAuditRequestPayloadBytes]...)
	}
	if json.Valid(trimmed) {
		var decoded any
		if err := json.Unmarshal(trimmed, &decoded); err == nil {
			return service.SanitizeLogValue(decoded)
		}
	}
	return service.SanitizeLogValue(string(trimmed))
}

func operationTypeForMethod(method string) string {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet:
		return "查询"
	case http.MethodPost:
		return "提交"
	case http.MethodPut, http.MethodPatch:
		return "更新"
	case http.MethodDelete:
		return "删除"
	default:
		return "操作"
	}
}

func logLevelForStatus(status int) string {
	switch {
	case status >= http.StatusInternalServerError:
		return "error"
	case status >= http.StatusBadRequest:
		return "warning"
	default:
		return "info"
	}
}

func inferAuditModule(path string) string {
	trimmed := strings.Trim(strings.TrimSpace(path), "/")
	if trimmed == "" {
		return "system"
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) >= 2 {
		return parts[1]
	}
	return parts[0]
}

func clientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	remoteIP := remoteRequestIP(r.RemoteAddr)
	if trustedProxyIP(remoteIP) {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
			parts := strings.Split(forwarded, ",")
			candidate := strings.TrimSpace(parts[len(parts)-1])
			if net.ParseIP(candidate) != nil {
				return candidate
			}
		}
		if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
			if net.ParseIP(realIP) != nil {
				return realIP
			}
		}
	}
	return remoteIP
}

func remoteRequestIP(remoteAddr string) string {
	value := strings.TrimSpace(remoteAddr)
	host, _, err := net.SplitHostPort(value)
	if err == nil {
		return host
	}
	return util.Clean(value)
}

func trustedProxyIP(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func parseLogQuery(r *http.Request) (service.LogQuery, error) {
	values := r.URL.Query()
	limit, err := parseLogPageSize(values.Get("page_size"))
	if err != nil {
		return service.LogQuery{}, err
	}
	return service.LogQuery{
		Username:      strings.TrimSpace(values.Get("username")),
		Module:        strings.TrimSpace(values.Get("module")),
		Method:        strings.TrimSpace(values.Get("method")),
		Summary:       strings.TrimSpace(values.Get("summary")),
		Status:        strings.TrimSpace(values.Get("status")),
		IPAddress:     strings.TrimSpace(values.Get("ip_address")),
		OperationType: strings.TrimSpace(values.Get("operation_type")),
		LogLevel:      strings.TrimSpace(values.Get("log_level")),
		StartDate:     strings.TrimSpace(values.Get("start_date")),
		EndDate:       strings.TrimSpace(values.Get("end_date")),
		StartTime:     strings.TrimSpace(values.Get("start_time")),
		EndTime:       strings.TrimSpace(values.Get("end_time")),
		View:          strings.TrimSpace(values.Get("view")),
		Limit:         limit,
		Cursor:        strings.TrimSpace(values.Get("cursor")),
	}, nil
}

func parseLogPageSize(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 200, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page_size 参数无效")
	}
	return normalizedHTTPLogPageSize(value), nil
}

func normalizedHTTPLogPageSize(limit int) int {
	if limit <= 0 {
		return 200
	}
	if limit > 500 {
		return 500
	}
	return limit
}
