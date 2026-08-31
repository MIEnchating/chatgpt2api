package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"chatgpt2api/internal/util"
)

const maxVideoReferenceFileBytes int64 = 50 << 20
const maxVideoImageReferenceFileBytes int64 = 30 << 20

type videoMultipartFile struct {
	Data        []byte
	Filename    string
	ContentType string
}

func (a *App) localVideoReferenceFile(rawURL string) (videoMultipartFile, bool, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" || a == nil || strings.TrimSpace(a.videoReferenceDir) == "" {
		return videoMultipartFile{}, false, nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return videoMultipartFile{}, false, nil
	}
	referencePath := parsed.Path
	if parsed.IsAbs() {
		if a.config == nil || strings.TrimSpace(a.config.BaseURL()) == "" {
			return videoMultipartFile{}, false, nil
		}
		base, parseErr := url.Parse(a.config.BaseURL())
		if parseErr != nil || !strings.EqualFold(parsed.Scheme, base.Scheme) || !strings.EqualFold(parsed.Host, base.Host) {
			return videoMultipartFile{}, false, nil
		}
		basePath := strings.TrimRight(base.Path, "/")
		if basePath != "" && basePath != "/" {
			if !strings.HasPrefix(referencePath, basePath+"/") {
				return videoMultipartFile{}, false, nil
			}
			referencePath = strings.TrimPrefix(referencePath, basePath)
		}
	} else if !strings.HasPrefix(parsed.Path, "/") {
		return videoMultipartFile{}, false, nil
	}

	var (
		contentType string
		maxBytes    int64
	)
	name := ""
	switch {
	case strings.HasPrefix(referencePath, "/video-image-references/"):
		name = strings.TrimPrefix(referencePath, "/video-image-references/")
		maxBytes = maxVideoImageReferenceFileBytes
		switch strings.ToLower(filepath.Ext(name)) {
		case ".jpg", ".jpeg":
			contentType = "image/jpeg"
		case ".webp":
			contentType = "image/webp"
		case ".png":
			contentType = "image/png"
		}
	case strings.HasPrefix(referencePath, "/video-references/"):
		name = strings.TrimPrefix(referencePath, "/video-references/")
		maxBytes = maxVideoReferenceFileBytes
		switch strings.ToLower(filepath.Ext(name)) {
		case ".mov":
			contentType = "video/quicktime"
		case ".mp4":
			contentType = "video/mp4"
		}
	case strings.HasPrefix(referencePath, "/audio-references/"):
		name = strings.TrimPrefix(referencePath, "/audio-references/")
		maxBytes = 15 << 20
		switch strings.ToLower(filepath.Ext(name)) {
		case ".wav":
			contentType = "audio/wav"
		case ".mp3":
			contentType = "audio/mpeg"
		}
	default:
		return videoMultipartFile{}, false, nil
	}
	if contentType == "" || !validStoredVideoReferenceName(name) {
		return videoMultipartFile{}, false, nil
	}
	root := filepath.Clean(a.videoReferenceDir)
	filePath := filepath.Join(root, name)
	if filepath.Dir(filePath) != root {
		return videoMultipartFile{}, false, nil
	}
	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return videoMultipartFile{}, true, errors.New("平台暂存的视频素材已不存在，请重新上传")
		}
		return videoMultipartFile{}, true, fmt.Errorf("读取平台暂存的视频素材失败: %w", err)
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return videoMultipartFile{}, true, errors.New("平台暂存的视频素材大小无效，请重新上传")
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return videoMultipartFile{}, true, fmt.Errorf("读取平台暂存的视频素材失败: %w", err)
	}
	return videoMultipartFile{Data: data, Filename: name, ContentType: contentType}, true, nil
}

func validStoredVideoReferenceName(name string) bool {
	if strings.ContainsAny(name, "/\\") || !strings.HasPrefix(name, "reference-") {
		return false
	}
	stem := strings.TrimSuffix(strings.TrimPrefix(name, "reference-"), filepath.Ext(name))
	if len(stem) != 32 {
		return false
	}
	_, err := hex.DecodeString(stem)
	return err == nil
}

func isLocalVideoReferencePath(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.IsAbs() || parsed.Host != "" {
		return false
	}
	for _, prefix := range []string{"/video-image-references/", "/video-references/", "/audio-references/"} {
		if strings.HasPrefix(parsed.Path, prefix) {
			return validStoredVideoReferenceName(strings.TrimPrefix(parsed.Path, prefix))
		}
	}
	return false
}

func (a *App) handleVideoReferenceUpload(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r)
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
	if r.Context().Err() != nil {
		util.WriteError(w, http.StatusRequestTimeout, "video reference upload was canceled")
		return
	}
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store video reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/video-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": contentType, "size": len(data)})
}

func (a *App) handleAudioReferenceUpload(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if a == nil || strings.TrimSpace(a.videoReferenceDir) == "" {
		util.WriteError(w, http.StatusServiceUnavailable, "audio reference storage is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 15<<20+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	header := firstMultipartFile(r.MultipartForm, "audio")
	if header == nil {
		util.WriteError(w, http.StatusBadRequest, "audio is required")
		return
	}
	file, err := header.Open()
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid audio file")
		return
	}
	data, readErr := io.ReadAll(io.LimitReader(file, 15<<20+1))
	_ = file.Close()
	if readErr != nil || int64(len(data)) > 15<<20 {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "audio reference cannot exceed 15 MiB")
		return
	}
	ext, contentType, ok := audioReferenceFileType(header.Filename, header.Header.Get("Content-Type"))
	if !ok {
		util.WriteError(w, http.StatusBadRequest, "音频参考仅支持 MP3 或 WAV 格式")
		return
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to create audio reference id")
		return
	}
	name := "reference-" + hex.EncodeToString(randomID[:]) + ext
	if r.Context().Err() != nil {
		util.WriteError(w, http.StatusRequestTimeout, "audio reference upload was canceled")
		return
	}
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store audio reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/audio-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": contentType, "size": len(data)})
}

func (a *App) handleVideoImageReferenceUpload(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if a == nil || strings.TrimSpace(a.videoReferenceDir) == "" {
		util.WriteError(w, http.StatusServiceUnavailable, "video reference storage is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxVideoImageReferenceFileBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	header := firstMultipartFile(r.MultipartForm, "image")
	if header == nil {
		util.WriteError(w, http.StatusBadRequest, "image is required")
		return
	}
	file, err := header.Open()
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid image file")
		return
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxVideoImageReferenceFileBytes+1))
	_ = file.Close()
	if readErr != nil {
		util.WriteError(w, http.StatusBadRequest, "failed to read image file")
		return
	}
	if int64(len(data)) > maxVideoImageReferenceFileBytes {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "image reference cannot exceed 30 MiB")
		return
	}
	info, inspectErr := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp")
	if inspectErr != nil {
		util.WriteError(w, http.StatusBadRequest, "视频参考图必须是有效的 PNG、JPEG 或 WebP 图片")
		return
	}
	ext := ".png"
	contentType := "image/png"
	if info.ContentType == "image/jpeg" {
		ext, contentType = ".jpg", "image/jpeg"
	} else if info.ContentType == "image/webp" {
		ext, contentType = ".webp", "image/webp"
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to create image reference id")
		return
	}
	name := "reference-" + hex.EncodeToString(randomID[:]) + ext
	if r.Context().Err() != nil {
		util.WriteError(w, http.StatusRequestTimeout, "image reference upload was canceled")
		return
	}
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store image reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/video-image-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": header.Filename, "content_type": contentType, "size": len(data)})
}

func (a *App) handleVideoReferenceFile(w http.ResponseWriter, r *http.Request) {
	serveReferenceFile(w, r, "/video-references/", a.videoReferenceDir, func(name string) string {
		if strings.EqualFold(filepath.Ext(name), ".mov") {
			return "video/quicktime"
		}
		return "video/mp4"
	})
}

func (a *App) handleAudioReferenceFile(w http.ResponseWriter, r *http.Request) {
	serveReferenceFile(w, r, "/audio-references/", a.videoReferenceDir, func(name string) string {
		if strings.EqualFold(filepath.Ext(name), ".wav") {
			return "audio/wav"
		}
		return "audio/mpeg"
	})
}

func (a *App) handleVideoImageReferenceFile(w http.ResponseWriter, r *http.Request) {
	serveReferenceFile(w, r, "/video-image-references/", a.videoReferenceDir, func(name string) string {
		switch strings.ToLower(filepath.Ext(name)) {
		case ".jpg", ".jpeg":
			return "image/jpeg"
		case ".webp":
			return "image/webp"
		default:
			return "image/png"
		}
	})
}

func serveReferenceFile(w http.ResponseWriter, r *http.Request, prefix, root string, contentType func(string) string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, prefix)
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	root = filepath.Clean(root)
	filePath := filepath.Join(root, name)
	if filepath.Dir(filePath) != root {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType(name))
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	http.ServeFile(w, r, filePath)
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

func audioReferenceFileType(filename, mime string) (string, string, bool) {
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	if ext == ".mp3" && (mime == "" || strings.HasPrefix(strings.ToLower(mime), "audio/")) {
		return ext, "audio/mpeg", true
	}
	if ext == ".wav" && (mime == "" || strings.HasPrefix(strings.ToLower(mime), "audio/")) {
		return ext, "audio/wav", true
	}
	return "", "", false
}
