package web

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerServesEmbeddedSPA(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/settings", nil)
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("SPA route status = %d body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `<div id="root"></div>`) {
		t.Fatalf("SPA route body missing root element: %q", res.Body.String())
	}
	if got := res.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("SPA route Cache-Control = %q, want no-cache", got)
	}
}

func TestHandlerKeepsMissingAssetsOutOfSPA(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil)
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Cache-Control"); strings.Contains(got, "immutable") {
		t.Fatalf("missing asset must not be cached as immutable: %q", got)
	}
}

func TestHandlerCachesVersionedBuildAssets(t *testing.T) {
	assets, err := fs.Glob(staticFS, "assets/*.js")
	if err != nil || len(assets) == 0 {
		t.Fatalf("embedded JavaScript assets unavailable: %v", err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			res := httptest.NewRecorder()
			Handler().ServeHTTP(res, httptest.NewRequest(method, "/"+assets[0], nil))
			if res.Code != http.StatusOK {
				t.Fatalf("asset status = %d", res.Code)
			}
			if got := res.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
				t.Fatalf("versioned asset Cache-Control = %q", got)
			}
			if method == http.MethodHead && res.Body.Len() != 0 {
				t.Fatal("HEAD returned an asset body")
			}
		})
	}
}

func TestHandlerRevalidatesUnversionedPagesAndPublicAssets(t *testing.T) {
	for _, url := range []string{"/", "/settings", "/director/", "/logo-mark.svg"} {
		t.Run(url, func(t *testing.T) {
			res := httptest.NewRecorder()
			Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, url, nil))
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d", res.Code)
			}
			if got := res.Header().Get("Cache-Control"); got != "no-cache" {
				t.Fatalf("unversioned asset Cache-Control = %q", got)
			}
		})
	}
}
