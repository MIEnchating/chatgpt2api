package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

func TestImageResponsesCannotBeCachedAcrossVisibilityChanges(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	rel := "2026/09/07/private-cache.png"
	filePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeHTTPTestPNG(filePath); err != nil {
		t.Fatal(err)
	}
	if err := app.images.RecordGeneratedImageMetadata([]string{"/images/" + rel}, "owner", "Owner", service.ImageVisibilityPrivate); err != nil {
		t.Fatal(err)
	}
	adminToken := adminSessionToken(t, app)
	for _, visibility := range []string{service.ImageVisibilityPrivate, service.ImageVisibilityPublic, service.ImageVisibilityPrivate} {
		if _, err := app.images.UpdateImageVisibility(rel, visibility, service.ImageAccessScope{All: true}); err != nil {
			t.Fatal(err)
		}
		for _, route := range []string{"/images/" + rel, "/image-thumbnails/" + rel + ".jpg"} {
			for _, authenticated := range []bool{true, false} {
				req := httptest.NewRequest(http.MethodGet, route, nil)
				if authenticated {
					setRequestAuthCookie(req, adminToken)
				}
				res := httptest.NewRecorder()
				app.Handler().ServeHTTP(res, req)
				if !authenticated && visibility == service.ImageVisibilityPrivate {
					if res.Code != http.StatusUnauthorized {
						t.Fatalf("private image was accessible anonymously: %d", res.Code)
					}
					continue
				}
				if res.Code != http.StatusOK {
					t.Fatalf("image status = %d", res.Code)
				}
				cache := res.Header().Get("Cache-Control")
				if !strings.Contains(cache, "no-store") || strings.Contains(cache, "public") {
					t.Errorf("%s (%s): cache policy permits reuse after revocation: %q", route, visibility, cache)
				}
			}
		}
	}
}
