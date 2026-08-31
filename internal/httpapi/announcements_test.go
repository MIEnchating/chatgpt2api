package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestAnnouncementMutationsDoNotRequirePostWriteReload(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)

	store, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "announcements.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	defer store.Close()
	backend := &announcementPostWriteReloadBackend{DatabaseBackend: store}
	app.announce = service.NewAnnouncementService(backend)

	backend.arm()
	createRequest := httptest.NewRequest(http.MethodPost, "/api/admin/announcements", strings.NewReader(`{"title":"Maintenance","content":"Planned maintenance","enabled":true}`))
	setRequestAuthCookie(createRequest, adminToken)
	createResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusOK {
		t.Fatalf("create status = %d, want %d; body = %s", createResponse.Code, http.StatusOK, createResponse.Body.String())
	}
	var createPayload struct {
		Item  service.Announcement   `json:"item"`
		Items []service.Announcement `json:"items"`
	}
	if err := json.Unmarshal(createResponse.Body.Bytes(), &createPayload); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if createPayload.Item.ID == "" || len(createPayload.Items) != 1 || createPayload.Items[0].ID != createPayload.Item.ID {
		t.Fatalf("create response = %#v", createPayload)
	}
	requireAnnouncementPostWriteLoadFailure(t, app.announce)
	backend.disarm()
	persisted, err := app.announce.ListAll()
	if err != nil || len(persisted) != 1 || persisted[0].ID != createPayload.Item.ID {
		t.Fatalf("persisted announcements after create = %#v, error = %v", persisted, err)
	}

	backend.arm()
	updateRequest := httptest.NewRequest(http.MethodPost, "/api/admin/announcements/"+createPayload.Item.ID, strings.NewReader(`{"content":"Maintenance postponed"}`))
	setRequestAuthCookie(updateRequest, adminToken)
	updateResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(updateResponse, updateRequest)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, want %d; body = %s", updateResponse.Code, http.StatusOK, updateResponse.Body.String())
	}
	var updatePayload struct {
		Item  service.Announcement   `json:"item"`
		Items []service.Announcement `json:"items"`
	}
	if err := json.Unmarshal(updateResponse.Body.Bytes(), &updatePayload); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updatePayload.Item.Content != "Maintenance postponed" || len(updatePayload.Items) != 1 || updatePayload.Items[0].Content != updatePayload.Item.Content {
		t.Fatalf("update response = %#v", updatePayload)
	}
	requireAnnouncementPostWriteLoadFailure(t, app.announce)
	backend.disarm()

	backend.arm()
	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/admin/announcements/"+createPayload.Item.ID, nil)
	setRequestAuthCookie(deleteRequest, adminToken)
	deleteResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d; body = %s", deleteResponse.Code, http.StatusOK, deleteResponse.Body.String())
	}
	var deletePayload struct {
		Items []service.Announcement `json:"items"`
	}
	if err := json.Unmarshal(deleteResponse.Body.Bytes(), &deletePayload); err != nil {
		t.Fatalf("decode delete response: %v", err)
	}
	if deletePayload.Items == nil || len(deletePayload.Items) != 0 {
		t.Fatalf("delete response = %#v", deletePayload)
	}
	requireAnnouncementPostWriteLoadFailure(t, app.announce)
	backend.disarm()
	persisted, err = app.announce.ListAll()
	if err != nil || len(persisted) != 0 {
		t.Fatalf("persisted announcements after delete = %#v, error = %v", persisted, err)
	}
}

type announcementPostWriteReloadBackend struct {
	*storage.DatabaseBackend

	mu    sync.Mutex
	armed bool
	saved bool
}

func (b *announcementPostWriteReloadBackend) LoadJSONDocument(name string) (any, error) {
	b.mu.Lock()
	fail := b.armed && b.saved
	b.mu.Unlock()
	if fail {
		return nil, errors.New("injected post-write reload failure")
	}
	return b.DatabaseBackend.LoadJSONDocument(name)
}

func (b *announcementPostWriteReloadBackend) SaveJSONDocument(name string, value any) error {
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

func (b *announcementPostWriteReloadBackend) arm() {
	b.mu.Lock()
	b.armed = true
	b.saved = false
	b.mu.Unlock()
}

func (b *announcementPostWriteReloadBackend) disarm() {
	b.mu.Lock()
	b.armed = false
	b.saved = false
	b.mu.Unlock()
}

func requireAnnouncementPostWriteLoadFailure(t *testing.T, announcements *service.AnnouncementService) {
	t.Helper()
	if _, err := announcements.ListAll(); err == nil {
		t.Fatal("post-write load succeeded, want injected failure")
	}
}
