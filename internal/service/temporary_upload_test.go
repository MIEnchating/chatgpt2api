package service

import (
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

type temporaryUploadTransport func(*http.Request) (*http.Response, error)

func (f temporaryUploadTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTemporaryMediaUploadForwardsOnlySelectedFile(t *testing.T) {
	client := &http.Client{Transport: temporaryUploadTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://tmpfile.link/api/upload" || r.Method != "POST" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Fatalf("request=%v", r)
		}
		_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		reader := multipart.NewReader(r.Body, params["boundary"])
		part, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(part)
		if part.FormName() != "file" || part.FileName() != "image.png" || string(data) != "image" {
			t.Fatalf("file=%s body=%q", part.FileName(), data)
		}
		if _, err := reader.NextPart(); err != io.EOF {
			t.Fatalf("extra multipart data: %v", err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"downloadLinkEncoded":"https://tmpfile.link/d/test%20file"}`)), Header: make(http.Header)}, nil
	})}
	link, err := UploadTemporaryMedia(context.Background(), client, "image.png", strings.NewReader("image"), 5)
	if err != nil || link != "https://tmpfile.link/d/test%20file" {
		t.Fatalf("link=%q err=%v", link, err)
	}
	for _, body := range []string{`{}`, `{"downloadLinkEncoded":"javascript:alert(1)"}`, `{"downloadLinkEncoded":"https://user:pass@example.test/file"}`, `not json`} {
		client.Transport = temporaryUploadTransport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})
		if _, err := UploadTemporaryMedia(context.Background(), client, "image.png", strings.NewReader("image"), 5); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}
