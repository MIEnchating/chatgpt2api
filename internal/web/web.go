package web

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:dist
var dist embed.FS

var staticFS = mustSubFS(dist, "dist")

type assetRepresentation struct {
	data []byte
	etag string
}

type cachedAsset struct {
	contentType string
	identity    assetRepresentation
	gzip        assetRepresentation
}

var assetCache sync.Map

func loadAsset(name string) (*cachedAsset, error) {
	load, _ := assetCache.LoadOrStore(name, sync.OnceValues(func() (*cachedAsset, error) {
		data, err := fs.ReadFile(staticFS, name)
		if err != nil {
			return nil, err
		}
		asset := &cachedAsset{contentType: mime.TypeByExtension(path.Ext(name)), identity: representation(data)}
		if asset.contentType == "" {
			asset.contentType = http.DetectContentType(data)
		}
		if len(data) >= 1024 && compressibleAsset(name) {
			var buffer bytes.Buffer
			writer := gzip.NewWriter(&buffer)
			if _, err := writer.Write(data); err != nil {
				return nil, err
			}
			if err := writer.Close(); err != nil {
				return nil, err
			}
			if buffer.Len() < len(data) {
				asset.gzip = representation(buffer.Bytes())
			}
		}
		return asset, nil
	}))
	return load.(func() (*cachedAsset, error))()
}

func representation(data []byte) assetRepresentation {
	return assetRepresentation{data: data, etag: fmt.Sprintf(`"%x"`, sha256.Sum256(data))}
}

func compressibleAsset(name string) bool {
	switch path.Ext(name) {
	case ".html", ".js", ".css", ".svg", ".json", ".txt", ".wasm":
		return true
	}
	return false
}

func acceptsGzip(header string) bool {
	wildcard := false
	for _, entry := range strings.Split(header, ",") {
		encoding, params, err := mime.ParseMediaType(strings.TrimSpace(entry))
		if err != nil {
			continue
		}
		quality := 1.0
		if raw, exists := params["q"]; exists {
			quality, err = strconv.ParseFloat(raw, 64)
			if err != nil || quality < 0 || quality > 1 {
				quality = 0
			}
		}
		if encoding == "gzip" {
			return quality > 0
		}
		if encoding == "*" {
			wildcard = quality > 0
		}
	}
	return wildcard
}

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
			asset, err := loadAsset(candidate)
			if err != nil {
				http.Error(w, "Unable to read static asset", http.StatusInternalServerError)
				return true
			}
			if versionedBuildAsset.MatchString(candidate) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			selected := asset.identity
			if len(asset.gzip.data) > 0 {
				w.Header().Add("Vary", "Accept-Encoding")
				if r.Header.Get("Range") == "" && acceptsGzip(strings.Join(r.Header.Values("Accept-Encoding"), ",")) {
					selected = asset.gzip
					w.Header().Set("Content-Encoding", "gzip")
				}
			}
			w.Header().Set("Content-Type", asset.contentType)
			w.Header().Set("ETag", selected.etag)
			http.ServeContent(w, r, candidate, time.Time{}, bytes.NewReader(selected.data))
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
