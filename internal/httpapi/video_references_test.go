package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestVideoReferenceFileType(t *testing.T) {
	valid := append([]byte("....ftypisom"), make([]byte, 16)...)
	if ext, contentType, ok := videoReferenceFileType(valid, "source.mp4"); !ok || ext != ".mp4" || contentType != "video/mp4" {
		t.Fatalf("mp4 type = %q, %q, %v", ext, contentType, ok)
	}
	if _, _, ok := videoReferenceFileType(valid, "source.webm"); ok {
		t.Fatal("webm was accepted as a video reference")
	}
	if _, _, ok := videoReferenceFileType([]byte("not a movie"), "source.mov"); ok {
		t.Fatal("invalid MOV container was accepted")
	}
}

func TestServeReferenceFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "reference.mp4"), []byte("video"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req := httptest.NewRequest(method, "/video-references/reference.mp4", nil)
		res := httptest.NewRecorder()
		serveReferenceFile(res, req, "/video-references/", root, func(string) string { return "video/mp4" })
		if res.Code != http.StatusOK || res.Header().Get("Content-Type") != "video/mp4" || res.Header().Get("Cache-Control") != "public, max-age=86400, immutable" {
			t.Fatalf("%s response = status %d headers %#v", method, res.Code, res.Header())
		}
		if method == http.MethodGet && res.Body.String() != "video" {
			t.Fatalf("GET body = %q", res.Body.String())
		}
		if method == http.MethodHead && res.Body.Len() != 0 {
			t.Fatalf("HEAD body length = %d", res.Body.Len())
		}
	}

	for _, target := range []string{
		"/video-references/",
		"/video-references/../reference.mp4",
		"/video-references/sub/reference.mp4",
		"/wrong/reference.mp4",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		res := httptest.NewRecorder()
		serveReferenceFile(res, req, "/video-references/", root, func(string) string { return "video/mp4" })
		if res.Code != http.StatusNotFound {
			t.Fatalf("GET %q status = %d, want 404", target, res.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/video-references/reference.mp4", nil)
	res := httptest.NewRecorder()
	serveReferenceFile(res, req, "/video-references/", root, func(string) string { return "video/mp4" })
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", res.Code)
	}
}
