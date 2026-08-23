package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"chatgpt2api/internal/util"
)

const maxVideoReferenceFileBytes int64 = 50 << 20

func (a *App) handleVideoReferenceUpload(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	if a == nil || strings.TrimSpace(a.videoReferenceDir) == "" {
		util.WriteError(w, http.StatusServiceUnavailable, "video reference storage is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxVideoReferenceFileBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			util.WriteError(w, http.StatusRequestEntityTooLarge, "video reference is too large")
			return
		}
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	header := firstMultipartFile(r.MultipartForm, "video")
	if header == nil {
		util.WriteError(w, http.StatusBadRequest, "video is required")
		return
	}
	file, err := header.Open()
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid video file")
		return
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxVideoReferenceFileBytes+1))
	_ = file.Close()
	if readErr != nil {
		util.WriteError(w, http.StatusBadRequest, "failed to read video file")
		return
	}
	if int64(len(data)) > maxVideoReferenceFileBytes {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "video reference cannot exceed 50 MiB")
		return
	}
	ext, contentType, ok := videoReferenceFileType(data, header.Filename)
	if !ok {
		util.WriteError(w, http.StatusBadRequest, "视频参考仅支持 MP4 或 MOV 格式")
		return
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to create video reference id")
		return
	}
	name := "reference-" + hex.EncodeToString(randomID[:]) + ext
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store video reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/video-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": contentType, "size": len(data)})
}

func (a *App) handleVideoReferenceFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/video-references/")
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.videoReferenceDir, name)
	if filepath.Dir(path) != filepath.Clean(a.videoReferenceDir) {
		http.NotFound(w, r)
		return
	}
	contentType := "video/mp4"
	if strings.EqualFold(filepath.Ext(name), ".mov") {
		contentType = "video/quicktime"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	http.ServeFile(w, r, path)
}

func videoReferenceFileType(data []byte, filename string) (string, string, bool) {
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	if ext != ".mp4" && ext != ".mov" {
		return "", "", false
	}
	// MP4 and MOV are ISO BMFF containers and carry an `ftyp` box near byte 4.
	if len(data) < 12 || string(data[4:8]) != "ftyp" {
		return "", "", false
	}
	if ext == ".mov" {
		return ext, "video/quicktime", true
	}
	return ext, "video/mp4", true
}
