package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestPromptFavoriteMutationsDoNotRequirePostWriteReload(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner, token := createPasswordUserSession(t, app, "prompt-reload", "", "Prompt Reload")

	store, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "prompt-favorites.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer store.Close()
	backend := &promptFavoritePostWriteReloadBackend{DatabaseBackend: store}
	app.prompts = service.NewPromptFavoriteService(backend)

	seed, _, err := app.prompts.UpsertWithItems(owner.ID, promptFavoriteBoundaryPayload("seed"))
	if err != nil {
		t.Fatalf("seed prompt favorite: %v", err)
	}
	if seed["id"] == "" {
		t.Fatalf("seed prompt favorite = %#v", seed)
	}

	backend.arm()
	postBody, err := json.Marshal(promptFavoriteBoundaryPayload("created"))
	if err != nil {
		t.Fatal(err)
	}
	postRequest := httptest.NewRequest(http.MethodPost, "/api/profile/prompt-favorites", bytes.NewReader(postBody))
	setRequestAuthCookie(postRequest, token)
	postResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(postResponse, postRequest)
	if postResponse.Code != http.StatusOK {
		t.Fatalf("post status = %d, want %d; body = %s", postResponse.Code, http.StatusOK, postResponse.Body.String())
	}
	var postPayload struct {
		Item  map[string]any   `json:"item"`
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(postResponse.Body.Bytes(), &postPayload); err != nil {
		t.Fatalf("decode post response: %v", err)
	}
	if len(postPayload.Items) != 2 || postPayload.Item["id"] == "" {
		t.Fatalf("post response = %#v", postPayload)
	}

	backend.disarm()
	items, err := app.prompts.ListWithError(owner.ID)
	if err != nil || len(items) != 2 {
		t.Fatalf("persisted favorites after post = %#v, err = %v", items, err)
	}

	createdID := fmt.Sprint(postPayload.Item["id"])
	backend.arm()
	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/profile/prompt-favorites/"+createdID, nil)
	setRequestAuthCookie(deleteRequest, token)
	deleteResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d; body = %s", deleteResponse.Code, http.StatusOK, deleteResponse.Body.String())
	}
	var deletePayload struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(deleteResponse.Body.Bytes(), &deletePayload); err != nil {
		t.Fatalf("decode delete response: %v", err)
	}
	if len(deletePayload.Items) != 1 || fmt.Sprint(deletePayload.Items[0]["id"]) != fmt.Sprint(seed["id"]) {
		t.Fatalf("delete response = %#v", deletePayload)
	}

	backend.disarm()
	items, err = app.prompts.ListWithError(owner.ID)
	if err != nil || len(items) != 1 || fmt.Sprint(items[0]["id"]) != fmt.Sprint(seed["id"]) {
		t.Fatalf("persisted favorites after delete = %#v, err = %v", items, err)
	}
}

func TestCanceledReferenceUploadsDoNotCreateFiles(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		field       string
		filename    string
		contentType string
		data        func(*testing.T) []byte
	}{
		{
			name: "video", path: "/api/creation-tasks/video-reference-uploads", field: "video",
			filename: "reference.mp4", contentType: "video/mp4",
			data: func(*testing.T) []byte { return append([]byte("....ftypisom"), make([]byte, 16)...) },
		},
		{
			name: "audio", path: "/api/creation-tasks/audio-reference-uploads", field: "audio",
			filename: "reference.wav", contentType: "audio/wav",
			data: func(*testing.T) []byte { return []byte("RIFFtestWAVE") },
		},
		{
			name: "image", path: "/api/creation-tasks/video-image-reference-uploads", field: "image",
			filename: "reference.png", contentType: "image/png", data: httpTestPNGBytes,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := newTestApp(t)
			defer app.Close()
			request := newCanceledReferenceUploadRequest(t, test.path, test.field, test.filename, test.contentType, test.data(t))
			setRequestAuthCookie(request, adminSessionToken(t, app))
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusRequestTimeout {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusRequestTimeout, response.Body.String())
			}
			entries, err := os.ReadDir(app.videoReferenceDir)
			if err != nil {
				t.Fatalf("ReadDir(%s): %v", app.videoReferenceDir, err)
			}
			if len(entries) != 0 {
				t.Fatalf("canceled upload created files: %#v", entries)
			}
		})
	}
}

type promptFavoritePostWriteReloadBackend struct {
	*storage.DatabaseBackend

	mu    sync.Mutex
	armed bool
	saved bool
}

func (b *promptFavoritePostWriteReloadBackend) LoadJSONDocument(name string) (any, error) {
	b.mu.Lock()
	fail := b.armed && b.saved
	b.mu.Unlock()
	if fail {
		return nil, errors.New("injected post-write reload failure")
	}
	return b.DatabaseBackend.LoadJSONDocument(name)
}

func (b *promptFavoritePostWriteReloadBackend) SaveJSONDocument(name string, value any) error {
	if err := b.DatabaseBackend.SaveJSONDocument(name, value); err != nil {
		return err
	}
	b.mu.Lock()
	if b.armed {
		b.saved = true
	}
	b.mu.Unlock()
	return nil
}

func (b *promptFavoritePostWriteReloadBackend) arm() {
	b.mu.Lock()
	b.armed = true
	b.saved = false
	b.mu.Unlock()
}

func (b *promptFavoritePostWriteReloadBackend) disarm() {
	b.mu.Lock()
	b.armed = false
	b.saved = false
	b.mu.Unlock()
}

func promptFavoriteBoundaryPayload(id string) map[string]any {
	return map[string]any{
		"prompt_id": id,
		"source":    "banana-prompt-quicker",
		"title":     "Prompt " + id,
		"preview":   "https://example.test/" + id + ".png",
		"prompt":    "draw " + id,
		"author":    "Boundary Test",
		"mode":      "generate",
	}
}

func newCanceledReferenceUploadRequest(t *testing.T, path, field, filename, contentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("CreatePart(): %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart data: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	return request.WithContext(ctx)
}
