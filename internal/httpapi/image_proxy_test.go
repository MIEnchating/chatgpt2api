package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

type imageProxyTestTransport struct {
	contentType string
	body        string
}

func (t imageProxyTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{t.contentType}},
		Body:       io.NopCloser(strings.NewReader(t.body)),
		Request:    r,
	}, nil
}

func TestImageProxySandboxesRemoteContent(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	client := service.SafeMediaProxyHTTPClient()
	original := client.Transport
	t.Cleanup(func() { client.Transport = original })
	for _, contentType := range []string{"image/svg+xml", "image/png"} {
		t.Run(contentType, func(t *testing.T) {
			body := `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`
			client.Transport = imageProxyTestTransport{contentType: contentType, body: body}
			request := httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=https%3A%2F%2Fmedia.example%2Fimage", nil)
			setRequestAuthCookie(request, token)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Body.String() != body {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if got := response.Header().Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
				t.Errorf("Content-Security-Policy = %q, want isolated remote content", got)
			}
		})
	}
}
