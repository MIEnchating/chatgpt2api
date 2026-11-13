package service

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCanvasShareStatusReadsOnlyOwnerManifestWithoutChangingHistory(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc, err := loadCanvas(svc, "share-status-owner")
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions = json.RawMessage(`[{"id":"retained","messages":[{"role":"user","text":"Complete private history"}],"protocolMessages":[{"role":"assistant","content":"Retained protocol"}]}]`)
	doc, err = svc.SaveAtRevision("share-status-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	share, err := svc.CanvasShare("share-status-owner", doc.ID, "create")
	if err != nil {
		t.Fatal(err)
	}
	before, err := backend.documents.LoadJSONDocument(canvasWorkspaceName("share-status-owner"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	backend.beforeLoad = func(name string) { names = append(names, name) }
	backend.failSave = func(string) error { return errors.New("share status must be read-only") }
	got, err := svc.CanvasShare("share-status-owner", doc.ID, "get")
	if err != nil || got != share {
		t.Fatal("share status changed", err)
	}
	if !reflect.DeepEqual(names, []string{canvasWorkspaceName("share-status-owner")}) {
		t.Fatalf("status loaded unrelated history or active-project state: %v", names)
	}
	if _, err := svc.CanvasShare("different-owner", doc.ID, "get"); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("unknown owner lookup must not create a workspace or disclose a token: %v", err)
	}
	encoded, err := json.Marshal(before)
	if err != nil {
		t.Fatal(err)
	}
	var manifest canvasWorkspace
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	hash := manifest.AgentHistories[doc.ID].Sessions[0].Block.Chunks[0]
	chunkName := canvasAgentHistoryChunkName("share-status-owner", doc.ID, hash)
	chunk, err := backend.documents.LoadJSONDocument(chunkName)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.documents.DeleteJSONDocument(chunkName); err != nil {
		t.Fatal(err)
	}
	if got, err := svc.CanvasShare("share-status-owner", doc.ID, "get"); err != nil || got != share {
		t.Fatal("private history availability blocked independent share status", err)
	}
	if _, _, err := svc.SharedCanvas(share.Token); err == nil {
		t.Fatal("status read bypassed full public-document integrity checks")
	}
	if _, err := backend.documents.LoadJSONDocument(chunkName); err != nil {
		t.Fatal(err)
	}
	if err := backend.documents.SaveJSONDocument(chunkName, chunk); err != nil {
		t.Fatal(err)
	}
	backend.failSave = nil
	backend.beforeLoad = nil
	stored, err := NewCanvasDocumentService(backend).Project("share-status-owner", doc.ID)
	if err != nil || string(stored.AgentSessions) != string(doc.AgentSessions) {
		t.Fatal("status read changed complete history", err)
	}
	after, err := backend.documents.LoadJSONDocument(canvasWorkspaceName("share-status-owner"))
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("status read changed the manifest", err)
	}
	if err := backend.SaveJSONDocument(canvasWorkspaceName("share-status-owner"), map[string]any{"projects": []any{}, "shares": map[string]string{doc.ID: share.Token}}); err != nil {
		t.Fatal(err)
	}
	if result, err := svc.CanvasShare("share-status-owner", doc.ID, "get"); !errors.Is(err, ErrCanvasShareNotFound) || result.Token != "" {
		t.Fatal("orphaned share metadata returned a token", err)
	}
	if err := backend.SaveJSONDocument(canvasWorkspaceName("share-status-owner"), map[string]any{"projects": "corrupt"}); err != nil {
		t.Fatal(err)
	}
	if result, err := svc.CanvasShare("share-status-owner", doc.ID, "get"); err == nil || result.Token != "" {
		t.Fatal("corrupt manifest returned a share status")
	}
}

func TestCanvasShareLifecycleAndIsolation(t *testing.T) {
	backend := newTestStorageBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc, err := loadCanvas(svc, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CanvasShare("bob", doc.ID, "create"); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("other owner: %v", err)
	}
	share, err := svc.CanvasShare("alice", doc.ID, "create")
	if err != nil || len(share.Token) != 64 {
		t.Fatalf("create: %#v %v", share, err)
	}
	again, err := svc.CanvasShare("alice", doc.ID, "create")
	if err != nil || again != share {
		t.Fatalf("idempotent create: %#v %v", again, err)
	}
	restarted := NewCanvasDocumentService(backend)
	shared, owner, err := restarted.SharedCanvas(share.Token)
	if err != nil || shared.ID != doc.ID || owner != "alice" {
		t.Fatalf("persistent share: %#v %q %v", shared, owner, err)
	}
	doc.Title = "Updated title"
	doc, err = svc.SaveAtRevision("alice", doc)
	if err != nil {
		t.Fatal(err)
	}
	shared, _, err = restarted.SharedCanvas(share.Token)
	if err != nil || shared.Title != doc.Title {
		t.Fatalf("live update: %#v %v", shared, err)
	}
	if _, err := svc.CanvasShare("bob", doc.ID, "revoke"); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("other owner revoke: %v", err)
	}
	if _, err := svc.CanvasShare("alice", doc.ID, "revoke"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := restarted.SharedCanvas(share.Token); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("revoked: %v", err)
	}
	replacement, err := svc.CanvasShare("alice", doc.ID, "create")
	if err != nil || replacement.Token == share.Token {
		t.Fatalf("replacement: %#v %v", replacement, err)
	}
	if _, _, err := svc.SharedCanvas(share.Token); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("old token revived: %v", err)
	}
	if _, err := svc.UpdateProjectAtRevision("alice", "delete", doc.ID, "", doc.Revision); err != nil {
		t.Fatal(err)
	}
	if _, _, err := restarted.SharedCanvas(replacement.Token); !errors.Is(err, ErrCanvasShareNotFound) {
		t.Fatalf("deleted project: %v", err)
	}
	for _, token := range []string{"", "../private", strings.Repeat("z", 64), strings.Repeat("0", 64)} {
		if _, _, err := svc.SharedCanvas(token); !errors.Is(err, ErrCanvasShareNotFound) {
			t.Fatalf("invalid token %q: %v", token, err)
		}
	}
}

func TestPublicCanvasDocumentExcludesPrivateFields(t *testing.T) {
	private := json.RawMessage(`{"secret":"private-marker"}`)
	document := CanvasDocument{ID: "project", Title: "Shared", AgentConfig: private, AgentSessions: private, PendingAgentRequest: private,
		AgentMessages: []CanvasAgentMessage{{Content: "private-marker"}}, RetainedStorageObjectIDs: []string{"private-marker"},
		Nodes: []CanvasNode{{ID: "node", Type: "image", Title: "Visible", URL: "https://example.test/private-marker", StorageKey: "private-marker", TaskID: "private-marker", GenerationWorkflowInputs: map[string]any{"key": "private-marker"}, DirectorProject: private}, {ID: "text", Type: "text", Prompt: "Visible text"}},
	}
	public := PublicCanvasDocument(document, "token")
	data, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "private-marker") {
		t.Fatalf("private fields exposed: %s", data)
	}
	if public.Nodes[0].URL != "/api/canvas-shares/token/media?node_id=node" || public.Nodes[1].Prompt != "Visible text" {
		t.Fatalf("public content: %s", data)
	}
	if document.Nodes[0].URL != "https://example.test/private-marker" {
		t.Fatal("projection mutated source document")
	}
}
