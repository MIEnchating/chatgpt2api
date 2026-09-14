package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatgpt2api/internal/util"
)

type auditFailingRequestBody struct {
	payload []byte
	reads   int
	closed  bool
}

func (b *auditFailingRequestBody) Read(data []byte) (int, error) {
	b.reads++
	if len(b.payload) == 0 {
		return 0, io.EOF
	}
	n := copy(data, b.payload)
	b.payload = b.payload[n:]
	if len(b.payload) == 0 {
		return n, io.ErrUnexpectedEOF
	}
	return n, nil
}

func (b *auditFailingRequestBody) Close() error {
	b.closed = true
	return nil
}

func TestAuditCapturePreservesRequestReadFailure(t *testing.T) {
	body := &auditFailingRequestBody{payload: []byte(`{"name":"partial request"}`)}
	request := httptest.NewRequest(http.MethodPost, "/api/example", nil)
	request.Body = body
	request.Header.Set("Content-Type", "application/json")
	capture := captureAuditRequest(request)
	if capture.args != nil {
		t.Fatalf("failed body must not be logged: %#v", capture.args)
	}
	var payload map[string]any
	if err := util.DecodeJSON(request.Body, &payload); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("downstream JSON decode error = %v, want original read failure", err)
	}
	if err := request.Body.Close(); err != nil || !body.closed {
		t.Fatalf("original body was not closed: %v", err)
	}
}

func TestObservedHTTPRejectsOversizedBodyWithoutReadingIt(t *testing.T) {
	body := &auditFailingRequestBody{payload: []byte(`{"name":"too large"}`)}
	request := httptest.NewRequest(http.MethodPost, "/api/example", nil)
	request.Body = body
	request.ContentLength = maxAPIRequestBodyBytes + 1
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app := &App{}
	app.serveObservedHTTP(response, request, []appRoute{exact(http.MethodPost, "/api/example", func(http.ResponseWriter, *http.Request) {
		t.Error("oversized request reached handler")
	})})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("response status = %d, want 413", response.Code)
	}
	if body.reads != 0 {
		t.Fatalf("rejected body was read %d times by audit capture", body.reads)
	}
}
