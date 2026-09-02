package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestAnnouncementStorageFailuresReturnSanitizedServiceUnavailable(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)
	storageFailure := errors.New("announcement database unavailable at secret.internal.example")
	announcement := map[string]any{
		"id": "announcement-1", "title": "Maintenance", "content": "Planned maintenance",
		"enabled": true, "created_at": "2026-09-02T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
	}
	tests := []struct {
		name      string
		method    string
		path      string
		body      string
		loadValue any
		loadErr   error
		saveErr   error
	}{
		{name: "visible list", method: http.MethodGet, path: "/api/announcements", loadErr: storageFailure},
		{name: "admin list", method: http.MethodGet, path: "/api/admin/announcements", loadErr: storageFailure},
		{name: "preference read", method: http.MethodGet, path: "/api/profile/announcement-preferences", loadErr: storageFailure},
		{name: "create", method: http.MethodPost, path: "/api/admin/announcements", body: `{"content":"Maintenance"}`, loadValue: map[string]any{}, saveErr: storageFailure},
		{name: "update", method: http.MethodPost, path: "/api/admin/announcements/announcement-1", body: `{"content":"Postponed"}`, loadValue: map[string]any{"items": []any{announcement}}, saveErr: storageFailure},
		{name: "delete", method: http.MethodDelete, path: "/api/admin/announcements/announcement-1", loadValue: map[string]any{"items": []any{announcement}}, saveErr: storageFailure},
		{name: "preference write", method: http.MethodPost, path: "/api/profile/announcement-preferences", body: `{"version":"announcement-1:v1","action":"seen"}`, loadValue: map[string]any{}, saveErr: storageFailure},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app.announce = service.NewAnnouncementService(&profileDocumentErrorBackend{
				loadValue: test.loadValue,
				loadErr:   test.loadErr,
				saveErr:   test.saveErr,
			})
			response := authenticatedProfileRequest(app, adminToken, test.method, test.path, test.body)
			if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), storageFailure.Error()) {
				t.Fatalf("response = %d %s, want sanitized 503", response.Code, response.Body.String())
			}
		})
	}
}

func TestPromptFavoriteStorageFailuresReturnSanitizedServiceUnavailable(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner, token := createPasswordUserSession(t, app, "favorite-storage", "", "Favorite Storage")
	storageFailure := errors.New("prompt favorite database unavailable at secret.internal.example")
	payload := `{"prompt_id":"prompt-a","source":"banana-prompt-quicker","title":"Prompt","preview":"https://example.test/preview.png","prompt":"draw","author":"Alice"}`
	favoriteID := "pf_" + util.SHA256Hex("banana-prompt-quicker\nprompt-a")[:24]
	storedFavorite := map[string]any{
		"id": favoriteID, "prompt_id": "prompt-a", "source": "banana-prompt-quicker",
		"title": "Prompt", "preview": "https://example.test/preview.png", "prompt": "draw", "author": "Alice",
	}
	tests := []struct {
		name      string
		method    string
		path      string
		body      string
		loadValue any
		loadErr   error
		saveErr   error
	}{
		{name: "list", method: http.MethodGet, path: "/api/profile/prompt-favorites", loadErr: storageFailure},
		{name: "upsert", method: http.MethodPost, path: "/api/profile/prompt-favorites", body: payload, loadValue: map[string]any{}, saveErr: storageFailure},
		{name: "delete", method: http.MethodDelete, path: "/api/profile/prompt-favorites/" + favoriteID, loadValue: map[string]any{"items": []any{storedFavorite}}, saveErr: storageFailure},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app.prompts = service.NewPromptFavoriteService(&profileDocumentErrorBackend{
				loadValue: test.loadValue,
				loadErr:   test.loadErr,
				saveErr:   test.saveErr,
			})
			response := authenticatedProfileRequest(app, token, test.method, test.path, test.body)
			if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), storageFailure.Error()) {
				t.Fatalf("response = %d %s, want sanitized 503 for owner %s", response.Code, response.Body.String(), owner.ID)
			}
		})
	}
}

func TestAnnouncementAndPromptFavoriteConflictsRemainConflicts(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)
	app.announce = service.NewAnnouncementService(&profileDocumentErrorBackend{loadValue: map[string]any{}, saveErr: storage.ErrConcurrentRowUpdate})
	response := authenticatedProfileRequest(app, adminToken, http.MethodPost, "/api/admin/announcements", `{"content":"Maintenance"}`)
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), storage.ErrConcurrentRowUpdate.Error()) {
		t.Fatalf("announcement conflict = %d %s", response.Code, response.Body.String())
	}

	_, token := createPasswordUserSession(t, app, "favorite-conflict", "", "Favorite Conflict")
	app.prompts = service.NewPromptFavoriteService(&profileDocumentErrorBackend{loadValue: map[string]any{}, saveErr: storage.ErrConcurrentRowUpdate})
	response = authenticatedProfileRequest(app, token, http.MethodPost, "/api/profile/prompt-favorites", `{"prompt_id":"prompt-a","source":"banana-prompt-quicker","title":"Prompt","preview":"https://example.test/preview.png","prompt":"draw","author":"Alice"}`)
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), storage.ErrConcurrentRowUpdate.Error()) {
		t.Fatalf("prompt favorite conflict = %d %s", response.Code, response.Body.String())
	}
}

func TestAnnouncementAndPromptFavoriteValidationAndNotFoundSemanticsRemain(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)
	app.announce = service.NewAnnouncementService(&profileDocumentErrorBackend{loadValue: map[string]any{}})
	response := authenticatedProfileRequest(app, adminToken, http.MethodPost, "/api/admin/announcements", `{"content":""}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "content is required") {
		t.Fatalf("announcement validation = %d %s", response.Code, response.Body.String())
	}
	response = authenticatedProfileRequest(app, adminToken, http.MethodPost, "/api/admin/announcements/missing", `{"content":"Updated"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing announcement = %d %s", response.Code, response.Body.String())
	}

	_, token := createPasswordUserSession(t, app, "favorite-semantics", "", "Favorite Semantics")
	app.prompts = service.NewPromptFavoriteService(&profileDocumentErrorBackend{loadValue: map[string]any{}})
	response = authenticatedProfileRequest(app, token, http.MethodPost, "/api/profile/prompt-favorites", `{"source":"banana-prompt-quicker","title":"Prompt","preview":"https://example.test/preview.png","prompt":"draw","author":"Alice"}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "prompt_id is required") {
		t.Fatalf("prompt favorite validation = %d %s", response.Code, response.Body.String())
	}
	response = authenticatedProfileRequest(app, token, http.MethodDelete, "/api/profile/prompt-favorites/missing", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing prompt favorite = %d %s", response.Code, response.Body.String())
	}
}
