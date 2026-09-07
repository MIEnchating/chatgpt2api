package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"chatgpt2api/internal/model"
)

func TestUserStorageInputCannotSelectServerLocalDirectory(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"storage": model.StorageSetting{AllowUserProvider: true}}); err != nil {
		t.Fatal(err)
	}
	_, token := createPasswordUserSession(t, app, "local-provider-boundary", "Password123!", "Boundary")
	for _, operation := range []string{"upload", "measure"} {
		t.Run(operation, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "must-not-create")
			provider := map[string]any{"type": "local", "endpoint": target}
			var request *http.Request
			if operation == "upload" {
				var body bytes.Buffer
				writer := multipart.NewWriter(&body)
				encoded, err := json.Marshal(provider)
				if err != nil {
					t.Fatal(err)
				}
				if err := writer.WriteField("provider", string(encoded)); err != nil {
					t.Fatal(err)
				}
				file, err := writer.CreateFormFile("file", "probe.txt")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Write([]byte("local path probe")); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				request = httptest.NewRequest(http.MethodPost, "/api/files", &body)
				request.Header.Set("Content-Type", writer.FormDataContentType())
			} else {
				encoded, err := json.Marshal(map[string]any{"provider": provider})
				if err != nil {
					t.Fatal(err)
				}
				request = httptest.NewRequest(http.MethodPost, "/api/profile/storage-provider/measure", bytes.NewReader(encoded))
				request.Header.Set("Content-Type", "application/json")
			}
			setRequestAuthCookie(request, token)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s status = %d, want 400; body=%s", operation, response.Code, response.Body.String())
			}
			if _, err := os.Stat(target); !os.IsNotExist(err) {
				t.Fatalf("user input accessed local storage target: %v", err)
			}
		})
	}
}
