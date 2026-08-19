package service

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

type recoveringSessionBackend struct {
	loadFailures int
	document     any
}

func (b *recoveringSessionBackend) LoadAccounts() ([]map[string]any, error) { return nil, nil }
func (b *recoveringSessionBackend) SaveAccounts([]map[string]any) error     { return nil }
func (b *recoveringSessionBackend) LoadAuthKeys() ([]map[string]any, error) { return nil, nil }
func (b *recoveringSessionBackend) SaveAuthKeys([]map[string]any) error     { return nil }
func (b *recoveringSessionBackend) HealthCheck() map[string]any             { return map[string]any{} }
func (b *recoveringSessionBackend) Info() map[string]any                    { return map[string]any{} }

func (b *recoveringSessionBackend) LoadJSONDocument(string) (any, error) {
	if b.loadFailures > 0 {
		b.loadFailures--
		return nil, errors.New("temporary database failure")
	}
	return b.document, nil
}

func (b *recoveringSessionBackend) SaveJSONDocument(_ string, value any) error {
	b.document = value
	return nil
}

func (b *recoveringSessionBackend) DeleteJSONDocument(string) error {
	b.document = nil
	return nil
}

func newImageConversationSessionTestBackend(t *testing.T) storage.Backend {
	t.Helper()
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "test.db")))
	if err != nil {
		t.Fatalf("NewDatabaseBackend() error = %v", err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func TestImageConversationSessionServiceScopesBindings(t *testing.T) {
	backend := newImageConversationSessionTestBackend(t)
	svc := NewImageConversationSessionService(filepath.Join(t.TempDir(), "image_conversation_sessions.json"), backend)

	if _, ok := svc.Get("owner-a", "frontend-1"); ok {
		t.Fatal("Get() found binding before Bind()")
	}

	first := ImageConversationSession{
		OwnerID:                 "owner-a",
		FrontendConversationID:  "frontend-1",
		AccessToken:             "token-a",
		UpstreamConversationID:  "conv-a",
		UpstreamParentMessageID: "msg-a",
	}
	svc.Bind(first)

	if _, ok := svc.Get("owner-b", "frontend-1"); ok {
		t.Fatal("Get() leaked binding across owners")
	}
	got, ok := svc.Get("owner-a", "frontend-1")
	if !ok {
		t.Fatal("Get() did not find owner binding")
	}
	if got.AccessToken != "token-a" || got.UpstreamConversationID != "conv-a" || got.UpstreamParentMessageID != "msg-a" || got.Status != ImageConversationSessionActive {
		t.Fatalf("binding = %#v", got)
	}
}

func TestImageConversationSessionServiceMergesConcurrentDatabaseUpdates(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-sessions.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	serviceA := NewImageConversationSessionService("", backendA)
	serviceB := NewImageConversationSessionService("", backendB)
	if err := serviceA.Bind(ImageConversationSession{OwnerID: "owner-a", FrontendConversationID: "front-a", AccessToken: "token-a", UpstreamConversationID: "conv-a", UpstreamParentMessageID: "msg-a"}); err != nil {
		t.Fatalf("service A Bind() error = %v", err)
	}
	if err := serviceB.Bind(ImageConversationSession{OwnerID: "owner-b", FrontendConversationID: "front-b", AccessToken: "token-b", UpstreamConversationID: "conv-b", UpstreamParentMessageID: "msg-b"}); err != nil {
		t.Fatalf("service B Bind() error = %v", err)
	}

	backendC, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(C) error = %v", err)
	}
	t.Cleanup(func() { _ = backendC.Close() })
	reloaded := NewImageConversationSessionService("", backendC)
	if _, ok := reloaded.Get("owner-a", "front-a"); !ok {
		t.Fatal("concurrent session update lost service A binding")
	}
	if _, ok := reloaded.Get("owner-b", "front-b"); !ok {
		t.Fatal("concurrent session update lost service B binding")
	}
}

func TestImageConversationSessionServiceRetriesInitialLoadFailure(t *testing.T) {
	backend := &recoveringSessionBackend{loadFailures: 1}
	svc := NewImageConversationSessionService("", backend)
	binding := ImageConversationSession{
		OwnerID:                 "owner",
		FrontendConversationID:  "frontend",
		AccessToken:             "token",
		UpstreamConversationID:  "conversation",
		UpstreamParentMessageID: "message",
	}

	if err := svc.Bind(binding); err != nil {
		t.Fatalf("Bind() after database recovery error = %v", err)
	}
	got, ok := svc.Get("owner", "frontend")
	if !ok || got.UpstreamConversationID != "conversation" {
		t.Fatalf("Get() after database recovery = %#v, %v", got, ok)
	}
}

func TestImageConversationSessionServiceOverwriteInvalidateCleanupAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image_conversation_sessions.json")
	backend := newImageConversationSessionTestBackend(t)
	svc := NewImageConversationSessionService(path, backend)
	svc.Bind(ImageConversationSession{OwnerID: "owner", FrontendConversationID: "front", AccessToken: "old", UpstreamConversationID: "conv-old", UpstreamParentMessageID: "msg-old"})
	svc.Bind(ImageConversationSession{OwnerID: "owner", FrontendConversationID: "front", AccessToken: "new", UpstreamConversationID: "conv-new", UpstreamParentMessageID: "msg-new"})

	got, ok := svc.Get("owner", "front")
	if !ok || got.AccessToken != "new" || got.UpstreamConversationID != "conv-new" || got.UpstreamParentMessageID != "msg-new" {
		t.Fatalf("overwritten binding = %#v ok=%v", got, ok)
	}

	reloaded := NewImageConversationSessionService(path, backend)
	reloadedGot, ok := reloaded.Get("owner", "front")
	if !ok || reloadedGot.AccessToken != "new" || reloadedGot.UpstreamConversationID != "conv-new" || reloadedGot.UpstreamParentMessageID != "msg-new" {
		t.Fatalf("reloaded binding = %#v ok=%v", reloadedGot, ok)
	}

	reloaded.Invalidate("owner", "front")
	invalid, ok := reloaded.Get("owner", "front")
	if !ok || invalid.Status != ImageConversationSessionFailed {
		t.Fatalf("invalidated binding = %#v ok=%v", invalid, ok)
	}

	old := time.Now().Add(-48 * time.Hour)
	reloaded.Bind(ImageConversationSession{OwnerID: "owner", FrontendConversationID: "old", AccessToken: "token", UpstreamConversationID: "conv", UpstreamParentMessageID: "msg", LastUsedAt: old})
	removed, err := reloaded.Cleanup(24 * time.Hour)
	if err != nil || removed != 1 {
		t.Fatalf("Cleanup() = %d, %v; want 1", removed, err)
	}
	if _, ok := reloaded.Get("owner", "old"); ok {
		t.Fatal("Cleanup() kept expired binding")
	}
}
