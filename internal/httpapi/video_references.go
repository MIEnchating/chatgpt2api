package httpapi

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"chatgpt2api/internal/util"
)

const (
	maxVideoReferenceFileBytes      int64 = 50 << 20
	maxVideoImageReferenceFileBytes int64 = 30 << 20
	maxAudioReferenceFileBytes      int64 = 15 << 20
	referenceMultipartMemory        int64 = 1 << 20
	referenceMultipartOverhead      int64 = 1 << 20
)

type videoMultipartFile struct {
	Data        []byte
	Filename    string
	ContentType string
}

type referenceUpload struct {
	data                []byte
	filename            string
	declaredContentType string
}

type referenceUploadFailure struct {
	status  int
	message string
}

func readReferenceUpload(w http.ResponseWriter, r *http.Request, field string, maxBytes int64) (referenceUpload, *referenceUploadFailure) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+referenceMultipartOverhead)
	if err := r.ParseMultipartForm(referenceMultipartMemory); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || errors.Is(err, multipart.ErrMessageTooLarge) {
			return referenceUpload{}, referenceUploadTooLargeError(field, maxBytes)
		}
		return referenceUpload{}, &referenceUploadFailure{status: http.StatusBadRequest, message: "invalid multipart form"}
	}
	defer r.MultipartForm.RemoveAll()

	header := firstMultipartFile(r.MultipartForm, field)
	if header == nil {
		return referenceUpload{}, &referenceUploadFailure{status: http.StatusBadRequest, message: field + " is required"}
	}
	file, err := header.Open()
	if err != nil {
		return referenceUpload{}, &referenceUploadFailure{status: http.StatusBadRequest, message: "invalid " + field + " file"}
	}
	data, uploadErr := readReferenceUploadData(file, field, maxBytes)
	_ = file.Close()
	if uploadErr != nil {
		return referenceUpload{}, uploadErr
	}
	return referenceUpload{
		data:                data,
		filename:            header.Filename,
		declaredContentType: header.Header.Get("Content-Type"),
	}, nil
}

func readReferenceUploadData(reader io.Reader, field string, maxBytes int64) ([]byte, *referenceUploadFailure) {
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, &referenceUploadFailure{status: http.StatusBadRequest, message: "failed to read " + field + " file"}
	}
	if int64(len(data)) > maxBytes {
		return nil, referenceUploadTooLargeError(field, maxBytes)
	}
	return data, nil
}

func referenceUploadTooLargeError(field string, maxBytes int64) *referenceUploadFailure {
	return &referenceUploadFailure{
		status:  http.StatusRequestEntityTooLarge,
		message: fmt.Sprintf("%s reference cannot exceed %d MiB", field, maxBytes>>20),
	}
}

func writeReferenceUploadError(w http.ResponseWriter, err *referenceUploadFailure) {
	util.WriteError(w, err.status, err.message)
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
		maxBytes = maxAudioReferenceFileBytes
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
	upload, uploadErr := readReferenceUpload(w, r, "video", maxVideoReferenceFileBytes)
	if uploadErr != nil {
		writeReferenceUploadError(w, uploadErr)
		return
	}
	ext, contentType, ok := videoReferenceFileType(upload.data, upload.filename)
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
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), upload.data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store video reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/video-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": upload.filename, "content_type": contentType, "size": len(upload.data)})
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
	upload, uploadErr := readReferenceUpload(w, r, "audio", maxAudioReferenceFileBytes)
	if uploadErr != nil {
		writeReferenceUploadError(w, uploadErr)
		return
	}
	ext, contentType, ok := audioReferenceFileType(upload.data, upload.filename, upload.declaredContentType)
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
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), upload.data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store audio reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/audio-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": upload.filename, "content_type": contentType, "size": len(upload.data)})
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
	upload, uploadErr := readReferenceUpload(w, r, "image", maxVideoImageReferenceFileBytes)
	if uploadErr != nil {
		writeReferenceUploadError(w, uploadErr)
		return
	}
	info, inspectErr := util.InspectRasterImage(upload.data, "image/png", "image/jpeg", "image/webp")
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
	if err := os.WriteFile(filepath.Join(a.videoReferenceDir, name), upload.data, 0o644); err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to store image reference")
		return
	}
	url := strings.TrimRight(a.resolveImageBaseURL(r), "/") + "/video-image-references/" + name
	util.WriteJSON(w, http.StatusCreated, map[string]any{"url": url, "name": upload.filename, "content_type": contentType, "size": len(upload.data)})
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

func audioReferenceFileType(data []byte, filename, mime string) (string, string, bool) {
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	declaredType := strings.ToLower(strings.TrimSpace(mime))
	if declaredType != "" && !strings.HasPrefix(declaredType, "audio/") {
		return "", "", false
	}
	if ext == ".mp3" && validMP3Reference(data) {
		return ext, "audio/mpeg", true
	}
	if ext == ".wav" && validWAVReference(data) {
		return ext, "audio/wav", true
	}
	return "", "", false
}

func validMP3Reference(data []byte) bool {
	offset := 0
	if len(data) >= 10 && string(data[:3]) == "ID3" {
		if data[3] < 2 || data[3] > 4 || data[4] == 0xff {
			return false
		}
		for _, value := range data[6:10] {
			if value&0x80 != 0 {
				return false
			}
		}
		tagSize := int(data[6])<<21 | int(data[7])<<14 | int(data[8])<<7 | int(data[9])
		offset = 10 + tagSize
		if data[3] == 4 && data[5]&0x10 != 0 {
			offset += 10
		}
		if offset > len(data)-4 {
			return false
		}
	}
	limit := min(len(data)-4, offset+(64<<10))
	for index := offset; index <= limit; index++ {
		if validMPEGAudioFrameHeader(data[index : index+4]) {
			return true
		}
	}
	return false
}

func validMPEGAudioFrameHeader(header []byte) bool {
	if len(header) < 4 || header[0] != 0xff || header[1]&0xe0 != 0xe0 {
		return false
	}
	version := (header[1] >> 3) & 0x03
	layer := (header[1] >> 1) & 0x03
	bitrate := (header[2] >> 4) & 0x0f
	sampleRate := (header[2] >> 2) & 0x03
	emphasis := header[3] & 0x03
	return version != 0x01 && layer == 0x01 && bitrate != 0x0f && sampleRate != 0x03 && emphasis != 0x02
}

func validWAVReference(data []byte) bool {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return false
	}
	validFormat := false
	validAudioData := false
	for offset := 12; offset+8 <= len(data); {
		chunkSize := int64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		chunkStart := offset + 8
		chunkEnd := int64(chunkStart) + chunkSize
		if chunkEnd > int64(len(data)) {
			return false
		}
		switch string(data[offset : offset+4]) {
		case "fmt ":
			if chunkSize >= 16 {
				format := binary.LittleEndian.Uint16(data[chunkStart : chunkStart+2])
				channels := binary.LittleEndian.Uint16(data[chunkStart+2 : chunkStart+4])
				sampleRate := binary.LittleEndian.Uint32(data[chunkStart+4 : chunkStart+8])
				blockAlign := binary.LittleEndian.Uint16(data[chunkStart+12 : chunkStart+14])
				validFormat = validFormat || format != 0 && channels != 0 && sampleRate != 0 && blockAlign != 0
			}
		case "data":
			validAudioData = validAudioData || chunkSize > 0
		}
		offset = int(chunkEnd)
		if chunkSize&1 != 0 && offset < len(data) {
			offset++
		}
	}
	return validFormat && validAudioData
}
