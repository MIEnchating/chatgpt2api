package httpapi

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
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

func TestAudioReferenceFileTypeValidatesFileContent(t *testing.T) {
	validMP3 := []byte{0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0}
	validTaggedMP3 := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), validMP3...)
	tests := []struct {
		name        string
		data        []byte
		filename    string
		contentType string
		wantExt     string
		wantType    string
		wantOK      bool
	}{
		{name: "wav", data: testWAVReferenceBytes(), filename: "voice.wav", contentType: "audio/wav", wantExt: ".wav", wantType: "audio/wav", wantOK: true},
		{name: "wav without declared mime", data: testWAVReferenceBytes(), filename: "voice.wav", wantExt: ".wav", wantType: "audio/wav", wantOK: true},
		{name: "mp3 frame", data: validMP3, filename: "voice.mp3", contentType: "audio/mpeg", wantExt: ".mp3", wantType: "audio/mpeg", wantOK: true},
		{name: "mp3 id3", data: validTaggedMP3, filename: "voice.mp3", contentType: "audio/mpeg", wantExt: ".mp3", wantType: "audio/mpeg", wantOK: true},
		{name: "empty wav", filename: "voice.wav", contentType: "audio/wav"},
		{name: "spoofed mp3", data: []byte("not an mp3"), filename: "voice.mp3", contentType: "audio/mpeg"},
		{name: "id3 without frames", data: []byte("ID3\x04\x00\x00\x00\x00\x00\x00"), filename: "voice.mp3", contentType: "audio/mpeg"},
		{name: "wrong extension", data: testWAVReferenceBytes(), filename: "voice.mp3", contentType: "audio/wav"},
		{name: "non audio mime", data: testWAVReferenceBytes(), filename: "voice.wav", contentType: "application/octet-stream"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ext, contentType, ok := audioReferenceFileType(test.data, test.filename, test.contentType)
			if ext != test.wantExt || contentType != test.wantType || ok != test.wantOK {
				t.Fatalf("audioReferenceFileType() = %q, %q, %v; want %q, %q, %v", ext, contentType, ok, test.wantExt, test.wantType, test.wantOK)
			}
		})
	}
}

func TestReadReferenceUploadDataDistinguishesReadFailureFromSize(t *testing.T) {
	readFailure := errors.New("injected read failure")
	data, uploadErr := readReferenceUploadData(errorReader{err: readFailure}, "audio", 4)
	if data != nil || uploadErr == nil || uploadErr.status != http.StatusBadRequest || uploadErr.message != "failed to read audio file" {
		t.Fatalf("read failure = data %q error %#v", data, uploadErr)
	}

	data, uploadErr = readReferenceUploadData(strings.NewReader("12345"), "audio", 4)
	if data != nil || uploadErr == nil || uploadErr.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload = data %q error %#v", data, uploadErr)
	}
}

func TestAudioReferenceUploadRejectsSpoofedContent(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	request := newReferenceUploadRequest(t, "/api/creation-tasks/audio-reference-uploads", "audio", "voice.wav", "audio/wav", []byte("not audio"))
	setRequestAuthCookie(request, adminSessionToken(t, app))
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "音频参考仅支持 MP3 或 WAV 格式") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	entries, err := os.ReadDir(app.videoReferenceDir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", app.videoReferenceDir, err)
	}
	if len(entries) != 0 {
		t.Fatalf("invalid audio created files: %#v", entries)
	}
}

func TestAudioReferenceUploadStoresValidatedWAV(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	data := testWAVReferenceBytes()

	request := newReferenceUploadRequest(t, "/api/creation-tasks/audio-reference-uploads", "audio", "voice.wav", "audio/wav", data)
	setRequestAuthCookie(request, adminSessionToken(t, app))
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
		Size        int    `json:"size"`
		URL         string `json:"url"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Name != "voice.wav" || payload.ContentType != "audio/wav" || payload.Size != len(data) ||
		!strings.Contains(payload.URL, "/audio-references/reference-") || !strings.HasSuffix(payload.URL, ".wav") {
		t.Fatalf("payload = %#v", payload)
	}
	entries, err := os.ReadDir(app.videoReferenceDir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", app.videoReferenceDir, err)
	}
	if len(entries) != 1 {
		t.Fatalf("stored files = %#v", entries)
	}
	stored, err := os.ReadFile(filepath.Join(app.videoReferenceDir, entries[0].Name()))
	if err != nil {
		t.Fatalf("ReadFile(): %v", err)
	}
	if !bytes.Equal(stored, data) {
		t.Fatal("stored WAV differs from uploaded data")
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

type errorReader struct {
	err error
}

func (r errorReader) Read([]byte) (int, error) {
	return 0, r.err
}

func newReferenceUploadRequest(t *testing.T, path, field, filename, contentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="`+field+`"; filename="`+filename+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("CreatePart(): %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write upload: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func testWAVReferenceBytes() []byte {
	data := make([]byte, 46)
	copy(data[0:4], "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	copy(data[8:12], "WAVE")
	copy(data[12:16], "fmt ")
	binary.LittleEndian.PutUint32(data[16:20], 16)
	binary.LittleEndian.PutUint16(data[20:22], 1)
	binary.LittleEndian.PutUint16(data[22:24], 1)
	binary.LittleEndian.PutUint32(data[24:28], 8000)
	binary.LittleEndian.PutUint32(data[28:32], 8000)
	binary.LittleEndian.PutUint16(data[32:34], 1)
	binary.LittleEndian.PutUint16(data[34:36], 8)
	copy(data[36:40], "data")
	binary.LittleEndian.PutUint32(data[40:44], 1)
	data[44] = 128
	return data
}
