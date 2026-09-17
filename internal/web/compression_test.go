package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func compressedJavaScriptFixture(t *testing.T) (string, []byte) {
	t.Helper()
	assets, err := fs.Glob(staticFS, "assets/*.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range assets {
		data, err := fs.ReadFile(staticFS, name)
		if err == nil && len(data) > 4096 {
			return "/" + name, data
		}
	}
	t.Fatal("no JavaScript fixture available")
	return "", nil
}

func TestStaticAssetCompressionNegotiation(t *testing.T) {
	url, original := compressedJavaScriptFixture(t)
	for _, test := range []struct {
		accept     string
		compressed bool
	}{
		{"", false}, {"br, gzip, deflate", true}, {"gzip;q=0", false},
		{"gzip;q=0, *;q=1", false}, {"*;q=0.5", true},
		{"GZIP;q=0.5", true}, {"gzip;q=invalid", false},
	} {
		t.Run(test.accept, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, url, nil)
			req.Header.Set("Accept-Encoding", test.accept)
			res := httptest.NewRecorder()
			Handler().ServeHTTP(res, req)
			if res.Code != http.StatusOK || res.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatalf("unexpected response: %d %v", res.Code, res.Header())
			}
			if !strings.Contains(res.Header().Get("Content-Type"), "javascript") {
				t.Fatalf("invalid JavaScript content type: %v", res.Header())
			}
			body := res.Body.Bytes()
			if test.compressed {
				if res.Header().Get("Content-Encoding") != "gzip" || len(body) >= len(original) {
					t.Fatal("gzip did not reduce the transfer size")
				}
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				body, err = io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
			} else if res.Header().Get("Content-Encoding") != "" {
				t.Fatal("compressed a response without gzip acceptance")
			}
			if !bytes.Equal(body, original) {
				t.Fatal("asset content changed")
			}
		})
	}
}

func TestStaticAssetRevalidationAndHead(t *testing.T) {
	url, _ := compressedJavaScriptFixture(t)
	var identityETag string
	for _, encoding := range []string{"identity", "gzip"} {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Accept-Encoding", encoding)
		res := httptest.NewRecorder()
		Handler().ServeHTTP(res, req)
		etag := res.Header().Get("ETag")
		if etag == "" {
			t.Fatal("missing ETag")
		}
		if encoding == "identity" {
			identityETag = etag
		} else if etag == identityETag {
			t.Fatal("representations share a strong ETag")
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			conditional := httptest.NewRequest(method, url, nil)
			conditional.Header.Set("Accept-Encoding", encoding)
			conditional.Header.Set("If-None-Match", etag)
			result := httptest.NewRecorder()
			Handler().ServeHTTP(result, conditional)
			if result.Code != http.StatusNotModified || result.Body.Len() != 0 {
				t.Fatalf("conditional %s: %d, %d bytes", method, result.Code, result.Body.Len())
			}
		}
		head := httptest.NewRequest(http.MethodHead, url, nil)
		head.Header.Set("Accept-Encoding", encoding)
		headResult := httptest.NewRecorder()
		Handler().ServeHTTP(headResult, head)
		if headResult.Code != http.StatusOK || headResult.Body.Len() != 0 || headResult.Header().Get("Content-Encoding") != res.Header().Get("Content-Encoding") {
			t.Fatalf("invalid HEAD response: %d %v", headResult.Code, headResult.Header())
		}
	}
}

func TestStaticAssetRangeUsesOriginalBytes(t *testing.T) {
	url, original := compressedJavaScriptFixture(t)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-15")
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, req)
	if res.Code != http.StatusPartialContent || res.Header().Get("Content-Encoding") != "" || !bytes.Equal(res.Body.Bytes(), original[:16]) {
		t.Fatalf("invalid range response: %d %v", res.Code, res.Header())
	}
}

func TestStaticHTMLRevalidation(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/studio", nil)
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, req)
	req.Header.Set("If-None-Match", res.Header().Get("ETag"))
	revalidated := httptest.NewRecorder()
	Handler().ServeHTTP(revalidated, req)
	if revalidated.Code != http.StatusNotModified || revalidated.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("invalid SPA revalidation: %d %v", revalidated.Code, revalidated.Header())
	}
}

func TestStaticImagesAreNotRecompressed(t *testing.T) {
	url := "/presets/stellar-poster.webp"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Header().Get("Content-Encoding") != "" {
		t.Fatalf("invalid image response: %d %v", res.Code, res.Header())
	}
}
