package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

//go:embed all:dist
var dist embed.FS

var staticFS = mustSubFS(dist, "dist")

// Vite emits content hashes in the names of generated build assets.
var versionedBuildAsset = regexp.MustCompile(`^assets/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$`)

func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.Trim(strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/"), "/")
		if serveAsset(w, r, clean) {
			return
		}
		last := path.Base(clean)
		if strings.HasPrefix(clean, "assets/") || strings.Contains(last, ".") {
			http.NotFound(w, r)
			return
		}
		if serveAsset(w, r, "index.html") {
			return
		}
		http.NotFound(w, r)
	})
}

func serveAsset(w http.ResponseWriter, r *http.Request, name string) bool {
	if name == "" {
		name = "index.html"
	}
	for _, candidate := range assetCandidates(name) {
		info, err := fs.Stat(staticFS, candidate)
		if err == nil && !info.IsDir() {
			if versionedBuildAsset.MatchString(candidate) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeFileFS(w, r, staticFS, candidate)
			return true
		}
	}
	return false
}

func assetCandidates(name string) []string {
	if name == "index.html" {
		return []string{name}
	}
	return []string{name, path.Join(name, "index.html"), name + ".html"}
}

func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(err)
	}
	return sub
}
