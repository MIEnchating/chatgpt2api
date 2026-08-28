package service

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"chatgpt2api/internal/storage"
)

func loadCanvas(service *CanvasDocumentService, ownerID string) (CanvasDocument, error) {
	workspace, err := service.Workspace(ownerID)
	return workspace.Document, err
}

func saveCanvas(service *CanvasDocumentService, ownerID string, input CanvasDocument) (CanvasDocument, error) {
	return service.save(ownerID, input, nil)
}

func clearCanvas(service *CanvasDocumentService, ownerID, projectID string) (CanvasDocument, error) {
	return service.clear(ownerID, projectID, nil)
}

func TestCanvasDocumentServiceStoresAgentSessions(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentSessions = json.RawMessage(`[{"id":"session-1","title":"广告创作","messages":[],"agentState":{"phase":"script","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]},"protocolMessages":[],"createdAt":"2026-08-26T00:00:00Z","updatedAt":"2026-08-26T00:00:00Z"}]`)
	document.ActiveAgentSessionID = "session-1"
	document.AgentConfig = json.RawMessage(`{"imageQuality":"high","videoSize":"16:9"}`)
	document.AgentPanel = &CanvasAgentPanel{Open: true, Width: 520}

	saved, err := service.SaveAtRevision("agent-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	if saved.ActiveAgentSessionID != "session-1" || !strings.Contains(string(saved.AgentSessions), `"session-1"`) || !strings.Contains(string(saved.AgentConfig), `"high"`) || saved.AgentPanel == nil || !saved.AgentPanel.Open || saved.AgentPanel.Width != 520 {
		t.Fatalf("saved agent data = %#v", saved)
	}
	reloaded, err := loadCanvas(service, "agent-owner")
	if err != nil {
		t.Fatalf("Load(reloaded) error = %v", err)
	}
	if reloaded.ActiveAgentSessionID != saved.ActiveAgentSessionID || !strings.Contains(string(reloaded.AgentSessions), `"session-1"`) || !strings.Contains(string(reloaded.AgentConfig), `"high"`) || reloaded.AgentPanel == nil || !reloaded.AgentPanel.Open || reloaded.AgentPanel.Width != 520 {
		t.Fatalf("reloaded agent data = %#v", reloaded)
	}
}

func TestCanvasDocumentServicePersistsAgentAutoTitleState(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "agent-title-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !document.AgentAutoTitlePending {
		t.Fatal("new canvas must allow the first primary script to set its title")
	}
	document.AgentAutoTitlePending = false
	saved, err := service.SaveAtRevision("agent-title-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	cleared, err := service.ClearAtRevision("agent-title-owner", saved.ID, saved.Revision)
	if err != nil {
		t.Fatalf("ClearAtRevision() error = %v", err)
	}
	if cleared.AgentAutoTitlePending {
		t.Fatal("clearing an established canvas must not re-enable Agent auto title")
	}
	renamed, err := service.UpdateProjectAtRevision("agent-title-owner", "rename", cleared.ID, "手动标题", cleared.Revision)
	if err != nil {
		t.Fatalf("UpdateProjectAtRevision(rename) error = %v", err)
	}
	if renamed.Document.AgentAutoTitlePending {
		t.Fatal("manual rename must disable Agent auto title")
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentSessions(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentSessions = json.RawMessage(`{"not":"an array"}`)
	if _, err := service.SaveAtRevision("invalid-agent-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentPanelWidth(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-agent-panel-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentPanel = &CanvasAgentPanel{Open: true, Width: 761}
	if _, err := service.SaveAtRevision("invalid-agent-panel-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServicePersistsPendingAgentRequest(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "pending-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.PendingAgentRequest = json.RawMessage(`{"prompt":"制作产品广告","assets":[{"nodeId":"image-1","payload":{"kind":"image"},"reference":{"id":"image-1"}}]}`)
	saved, err := service.SaveAtRevision("pending-agent-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	if !strings.Contains(string(saved.PendingAgentRequest), `"制作产品广告"`) {
		t.Fatalf("saved pending Agent request = %s", saved.PendingAgentRequest)
	}
	reloaded, err := loadCanvas(service, "pending-agent-owner")
	if err != nil {
		t.Fatalf("Load(reloaded) error = %v", err)
	}
	var savedRequest, reloadedRequest map[string]any
	if err := json.Unmarshal(saved.PendingAgentRequest, &savedRequest); err != nil {
		t.Fatalf("decode saved pending Agent request: %v", err)
	}
	if err := json.Unmarshal(reloaded.PendingAgentRequest, &reloadedRequest); err != nil {
		t.Fatalf("decode reloaded pending Agent request: %v", err)
	}
	if !reflect.DeepEqual(reloadedRequest, savedRequest) {
		t.Fatalf("reloaded pending Agent request = %v, want %v", reloadedRequest, savedRequest)
	}
	reloaded.PendingAgentRequest = nil
	cleared, err := service.SaveAtRevision("pending-agent-owner", reloaded)
	if err != nil {
		t.Fatalf("SaveAtRevision(clear pending request) error = %v", err)
	}
	if len(cleared.PendingAgentRequest) != 0 {
		t.Fatalf("cleared pending Agent request = %s", cleared.PendingAgentRequest)
	}
}

func TestCanvasDocumentServiceRejectsInvalidPendingAgentRequest(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-pending-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.PendingAgentRequest = json.RawMessage(`{"prompt":"","assets":[]}`)
	if _, err := service.SaveAtRevision("invalid-pending-agent-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

type countingCanvasDocumentBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
	saves     map[string]int
}

type canvasSaveBarrier struct {
	mu        sync.Mutex
	remaining int
	release   chan struct{}
}

func newCanvasSaveBarrier(participants int) *canvasSaveBarrier {
	return &canvasSaveBarrier{remaining: participants, release: make(chan struct{})}
}

func (b *canvasSaveBarrier) wait() {
	b.mu.Lock()
	b.remaining--
	if b.remaining == 0 {
		close(b.release)
	}
	b.mu.Unlock()
	<-b.release
}

type barrierCanvasDocumentBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
	barrier   *canvasSaveBarrier
	once      sync.Once
}

func (b *barrierCanvasDocumentBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *barrierCanvasDocumentBackend) SaveJSONDocument(name string, value any) error {
	if b.barrier != nil && strings.HasPrefix(name, canvasWorkspaceDir+"/") {
		b.once.Do(b.barrier.wait)
	}
	return b.documents.SaveJSONDocument(name, value)
}

func (b *barrierCanvasDocumentBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func newCountingCanvasDocumentBackend(t *testing.T) *countingCanvasDocumentBackend {
	t.Helper()
	backend := newTestStorageBackend(t)
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatal("test backend does not support JSON documents")
	}
	return &countingCanvasDocumentBackend{Backend: backend, documents: documents, saves: make(map[string]int)}
}

func (b *countingCanvasDocumentBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *countingCanvasDocumentBackend) SaveJSONDocument(name string, value any) error {
	b.saves[name]++
	return b.documents.SaveJSONDocument(name, value)
}

func (b *countingCanvasDocumentBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func TestCanvasDocumentServiceSavesAndIsolatesOwners(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner-a", CanvasDocument{
		Title:    "Campaign board",
		Viewport: CanvasViewport{Zoom: 1.25, X: 120, Y: -30},
		Nodes: []CanvasNode{{
			ID: "image-1", Type: "image", X: 40, Y: 50, Width: 512, Height: 512,
			ScaleX: 1, ScaleY: 1, URL: "/images/a.png", Prompt: "draw a city",
		}},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if document.Revision != 1 || document.UpdatedAt == "" || len(document.Nodes) != 1 {
		t.Fatalf("Save() document = %#v", document)
	}

	loaded, err := loadCanvas(service, "owner-a")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Title != "Campaign board" || loaded.Nodes[0].URL != "/images/a.png" {
		t.Fatalf("Load() document = %#v", loaded)
	}
	other, err := loadCanvas(service, "owner-b")
	if err != nil {
		t.Fatalf("Load(other) error = %v", err)
	}
	if other.Revision != 0 || len(other.Nodes) != 0 {
		t.Fatalf("other owner saw canvas = %#v", other)
	}
}

func TestCanvasDocumentServicePreservesCreativeTextWhitespace(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	composer := "  保留配置空白\n"
	document, err := saveCanvas(service, "creative-whitespace-owner", CanvasDocument{
		Title: "Creative whitespace",
		Nodes: []CanvasNode{
			{ID: "text-1", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "  第一行\n第二行  ", GenerationStatus: "loading", GenerationStartedAt: 12345, GenerationProgress: 42},
			{ID: "config-1", Type: "config", Width: 440, Height: 240, ScaleX: 1, ScaleY: 1, ComposerContent: &composer},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if document.Nodes[0].Prompt != "  第一行\n第二行  " || document.Nodes[0].GenerationStartedAt != 12345 || document.Nodes[0].GenerationProgress != 42 || document.Nodes[1].ComposerContent == nil || *document.Nodes[1].ComposerContent != composer {
		t.Fatalf("Save() changed creative text: %#v", document.Nodes)
	}

	loaded, err := loadCanvas(service, "creative-whitespace-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Nodes[0].Prompt != "  第一行\n第二行  " || loaded.Nodes[0].GenerationStartedAt != 12345 || loaded.Nodes[0].GenerationProgress != 42 || loaded.Nodes[1].ComposerContent == nil || *loaded.Nodes[1].ComposerContent != composer {
		t.Fatalf("Load() changed creative text: %#v", loaded.Nodes)
	}
}

func TestCanvasDocumentServiceRejectsStaleRevision(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(initial) error = %v", err)
	}
	first := initial
	first.Title = "第一台设备"
	first.Nodes = []CanvasNode{{ID: "first", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1}}
	saved, err := service.SaveAtRevision("owner", first)
	if err != nil {
		t.Fatalf("SaveAtRevision(first) error = %v", err)
	}

	stale := initial
	stale.Title = "第二台设备"
	if _, err := service.SaveAtRevision("owner", stale); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("SaveAtRevision(stale) error = %v, want ErrCanvasRevisionConflict", err)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(after conflict) error = %v", err)
	}
	if loaded.Title != saved.Title || loaded.Revision != saved.Revision || len(loaded.Nodes) != 1 {
		t.Fatalf("stale save changed document: loaded=%#v saved=%#v", loaded, saved)
	}

	loaded.Title = "基于最新版本"
	updated, err := service.SaveAtRevision("owner", loaded)
	if err != nil {
		t.Fatalf("SaveAtRevision(current) error = %v", err)
	}
	if updated.Revision != saved.Revision+1 || updated.Title != "基于最新版本" {
		t.Fatalf("updated document = %#v", updated)
	}
}

func TestCanvasDocumentServiceRenameAdvancesRevision(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(initial) error = %v", err)
	}

	renamed, err := service.UpdateProjectAtRevision("owner", "rename", initial.ID, "新名称", initial.Revision)
	if err != nil {
		t.Fatalf("UpdateProjectAtRevision(rename) error = %v", err)
	}
	if renamed.Document.Title != "新名称" || renamed.Document.Revision != initial.Revision+1 {
		t.Fatalf("renamed document = %#v", renamed.Document)
	}
	if _, err := service.SaveAtRevision("owner", initial); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("stale SaveAtRevision() error = %v, want ErrCanvasRevisionConflict", err)
	}
	if _, err := service.UpdateProjectAtRevision("owner", "delete", initial.ID, "", initial.Revision); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("stale delete error = %v, want ErrCanvasRevisionConflict", err)
	}
}

func TestCanvasDocumentServiceMergesConcurrentSavesToDifferentProjects(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-canvas.db"))
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

	seed := NewCanvasDocumentService(backendA)
	first, err := seed.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(initial) error = %v", err)
	}
	second, err := seed.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("UpdateProject(create) error = %v", err)
	}

	barrier := newCanvasSaveBarrier(2)
	wrap := func(backend storage.Backend) *barrierCanvasDocumentBackend {
		documents, ok := backend.(storage.JSONDocumentBackend)
		if !ok {
			t.Fatal("database backend does not support JSON documents")
		}
		return &barrierCanvasDocumentBackend{Backend: backend, documents: documents, barrier: barrier}
	}
	serviceA := NewCanvasDocumentService(wrap(backendA))
	serviceB := NewCanvasDocumentService(wrap(backendB))
	firstDocument := first.Document
	firstDocument.Nodes = []CanvasNode{{ID: "first-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}}
	secondDocument := second.Document
	secondDocument.Nodes = []CanvasNode{{ID: "second-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}}

	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.SaveAtRevision("owner", firstDocument)
		errorsCh <- saveErr
	}()
	go func() {
		_, saveErr := serviceB.SaveAtRevision("owner", secondDocument)
		errorsCh <- saveErr
	}()
	for range 2 {
		if saveErr := <-errorsCh; saveErr != nil {
			t.Fatalf("concurrent SaveAtRevision() error = %v", saveErr)
		}
	}

	firstResult, err := serviceA.UpdateProject("owner", "activate", firstDocument.ID, "")
	if err != nil {
		t.Fatalf("activate first error = %v", err)
	}
	secondResult, err := serviceA.UpdateProject("owner", "activate", secondDocument.ID, "")
	if err != nil {
		t.Fatalf("activate second error = %v", err)
	}
	if len(firstResult.Document.Nodes) != 1 || firstResult.Document.Nodes[0].ID != "first-node" {
		t.Fatalf("first project lost concurrent update: %#v", firstResult.Document)
	}
	if len(secondResult.Document.Nodes) != 1 || secondResult.Document.Nodes[0].ID != "second-node" {
		t.Fatalf("second project lost concurrent update: %#v", secondResult.Document)
	}
}

func TestCanvasDocumentServiceValidatesAndClears(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{ID: "bad", Type: "image", Width: 0, Height: 100}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save() error = %v, want ErrInvalidCanvasDocument", err)
	}

	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-1", Type: "text", Width: 320, Height: 160, FontSize: 18, ScaleX: 1, ScaleY: 1, Prompt: "idea",
	}}}); err != nil {
		t.Fatalf("Save(valid) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-invalid-font", Type: "text", Width: 320, Height: 160, FontSize: 40, ScaleX: 1, ScaleY: 1,
	}}}); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(invalid font size) error = %v, want ErrInvalidCanvasDocument", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-empty", Type: "image", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank image) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-empty", Type: "text", Width: 340, Height: 220, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank text) error = %v", err)
	}
	saved, err := saveCanvas(service, "owner", CanvasDocument{
		Title: "保留的画布", Background: "grid", Viewport: CanvasViewport{Zoom: 1.5, X: 240, Y: -80},
		Nodes: []CanvasNode{{ID: "config-empty", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}},
	})
	if err != nil {
		t.Fatalf("Save(config) error = %v", err)
	}
	cleared, err := clearCanvas(service, "owner", saved.ID)
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Title != "保留的画布" || cleared.Background != "grid" || cleared.Viewport != (CanvasViewport{Zoom: 1.5, X: 240, Y: -80}) || len(cleared.Nodes) != 0 || len(cleared.Connections) != 0 {
		t.Fatalf("Clear() document = %#v", cleared)
	}
}

func TestCanvasDocumentServiceStoresAndValidatesGroups(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{
		{ID: "group-1", Type: "group", X: 10, Y: 20, Width: 760, Height: 480, ScaleX: 1, ScaleY: 1},
		{ID: "image-1", Type: "image", X: 34, Y: 44, Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: " group-1 "},
	}})
	if err != nil {
		t.Fatalf("Save(group) error = %v", err)
	}
	if document.Nodes[1].GroupID != "group-1" {
		t.Fatalf("group id = %q", document.Nodes[1].GroupID)
	}

	for _, nodes := range [][]CanvasNode{
		{{ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: "missing"}},
		{{ID: "group", Type: "group", Width: 760, Height: 480, ScaleX: 1, ScaleY: 1, GroupID: "group"}},
		{{ID: "text", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}, {ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: "text"}},
	} {
		if _, saveErr := saveCanvas(service, "owner", CanvasDocument{Nodes: nodes}); !errors.Is(saveErr, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid group) error = %v, want ErrInvalidCanvasDocument", saveErr)
		}
	}
}

func TestCanvasDocumentServiceValidatesGroupAndDirectorConnections(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	base := []CanvasNode{
		{ID: "group", Type: "group", Width: 760, Height: 480, ScaleX: 1, ScaleY: 1},
		{ID: "director", Type: "director", Width: 360, Height: 320, ScaleX: 1, ScaleY: 1},
		{ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
		{ID: "panorama", Type: "panorama", Width: 340, Height: 170, ScaleX: 1, ScaleY: 1, PanoramaProjection: "equirectangular"},
		{ID: "text", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{{ID: "image-director", FromNodeID: "image", ToNodeID: "director"}}}); err != nil {
		t.Fatalf("Save(image director connection) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{{ID: "panorama-director", FromNodeID: "panorama", ToNodeID: "director"}}}); err != nil {
		t.Fatalf("Save(panorama director connection) error = %v", err)
	}
	for _, connection := range []CanvasConnection{
		{ID: "group-image", FromNodeID: "group", ToNodeID: "image"},
		{ID: "text-director", FromNodeID: "text", ToNodeID: "director"},
	} {
		if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{connection}}); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid connection %#v) error = %v", connection, err)
		}
	}
}

func TestCanvasDocumentServiceStoresPanoramaGenerationMetadata(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "panorama-owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "panorama-1", Type: "panorama", Width: 340, Height: 170, ScaleX: 1, ScaleY: 1,
		GenerationModel: " gpt-image-1 ", GenerationSize: " 2:1 ", GenerationType: " EDIT ",
		GenerationReferenceURLs: []string{" https://cdn.example.com/reference.png "},
		GenerationStatus:        " SUCCESS ", GenerationStartedAt: 12345, GenerationProgress: 100,
		DurationMS: 3200, PanoramaSourcePrompt: " 环形大厅 ", PanoramaFinalPrompt: " 完整全景提示词 ",
		PanoramaProjection: " EQUIRECTANGULAR ",
	}}})
	if err != nil {
		t.Fatalf("Save(panorama) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationModel != "gpt-image-1" || node.GenerationSize != "2:1" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || node.GenerationReferenceURLs[0] != "https://cdn.example.com/reference.png" || node.GenerationStatus != "success" || node.GenerationStartedAt != 12345 || node.GenerationProgress != 100 || node.DurationMS != 3200 || node.PanoramaSourcePrompt != "环形大厅" || node.PanoramaFinalPrompt != "完整全景提示词" || node.PanoramaProjection != "equirectangular" {
		t.Fatalf("panorama generation metadata = %#v", node)
	}
	reloaded, err := loadCanvas(service, "panorama-owner")
	if err != nil {
		t.Fatalf("Load(panorama) error = %v", err)
	}
	if reloaded.Nodes[0].PanoramaProjection != "equirectangular" || reloaded.Nodes[0].DurationMS != 3200 || reloaded.Nodes[0].GenerationProgress != 100 {
		t.Fatalf("panorama metadata was not persisted: %#v", reloaded.Nodes[0])
	}
}

func TestCanvasDocumentServiceStoresAndValidatesDirectorProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	project := json.RawMessage(`{"version":1,"objects":[{"id":"actor-1","type":"character"}],"timeline":{"duration":8}}`)
	document, err := saveCanvas(service, "director-owner", CanvasDocument{Nodes: []CanvasNode{{
		ID:              "director-1",
		Type:            "director",
		Width:           360,
		Height:          320,
		ScaleX:          1,
		ScaleY:          1,
		DirectorProject: project,
	}}})
	if err != nil {
		t.Fatalf("Save(director project) error = %v", err)
	}
	var wantProject, savedProject map[string]any
	if err := json.Unmarshal(project, &wantProject); err != nil {
		t.Fatalf("Unmarshal(want director project) error = %v", err)
	}
	if err := json.Unmarshal(document.Nodes[0].DirectorProject, &savedProject); err != nil {
		t.Fatalf("Unmarshal(saved director project) error = %v", err)
	}
	if !reflect.DeepEqual(savedProject, wantProject) {
		t.Fatalf("saved director project = %#v, want %#v", savedProject, wantProject)
	}
	reloaded, err := loadCanvas(service, "director-owner")
	if err != nil {
		t.Fatalf("Load(director project) error = %v", err)
	}
	var reloadedProject map[string]any
	if err := json.Unmarshal(reloaded.Nodes[0].DirectorProject, &reloadedProject); err != nil {
		t.Fatalf("Unmarshal(reloaded director project) error = %v", err)
	}
	if !reflect.DeepEqual(reloadedProject, wantProject) {
		t.Fatalf("reloaded director project = %#v, want %#v", reloadedProject, wantProject)
	}

	for name, raw := range map[string]json.RawMessage{
		"invalid JSON": json.RawMessage(`{"objects":`),
		"too large":    json.RawMessage(`{"data":"` + strings.Repeat("x", (512<<10)+1) + `"}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, saveErr := saveCanvas(service, "invalid-director-"+name, CanvasDocument{Nodes: []CanvasNode{{
				ID:              "director-1",
				Type:            "director",
				Width:           360,
				Height:          320,
				ScaleX:          1,
				ScaleY:          1,
				DirectorProject: raw,
			}}})
			if !errors.Is(saveErr, ErrInvalidCanvasDocument) {
				t.Fatalf("Save(%s director project) error = %v, want ErrInvalidCanvasDocument", name, saveErr)
			}
		})
	}
}

func TestCanvasDocumentServiceClearsExplicitProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	first, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "first-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "first",
	}}})
	if err != nil {
		t.Fatalf("Save(first) error = %v", err)
	}
	secondWorkspace, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	second, err := saveCanvas(service, "owner", CanvasDocument{ID: secondWorkspace.Document.ID, Nodes: []CanvasNode{{
		ID: "second-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "second",
	}}})
	if err != nil {
		t.Fatalf("Save(second) error = %v", err)
	}

	cleared, err := clearCanvas(service, "owner", first.ID)
	if err != nil {
		t.Fatalf("Clear(first) error = %v", err)
	}
	if cleared.ID != first.ID || len(cleared.Nodes) != 0 {
		t.Fatalf("cleared document = %#v", cleared)
	}
	workspace, err := service.UpdateProject("owner", "activate", second.ID, "")
	if err != nil {
		t.Fatalf("Activate(second) error = %v", err)
	}
	if workspace.Document.ID != second.ID || len(workspace.Document.Nodes) != 1 || workspace.Document.Nodes[0].ID != "second-node" {
		t.Fatalf("second project changed while clearing first: %#v", workspace.Document)
	}
}

func TestCanvasDocumentServiceRejectsVideoWithoutGenerationModel(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
	}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(video without model) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceStoresVideoGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	audio := true
	watermark := false
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: " sora-2 ", GenerationVideoSize: " 1280X720 ",
		GenerationVideoSeconds: 8, GenerationVideoResolution: " 1080P ",
		GenerationVideoAudio: &audio, GenerationVideoWatermark: &watermark,
		GenerationVideoNegativePrompt: "  保留首尾空白  ",
	}}})
	if err != nil {
		t.Fatalf("Save(video) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationVideoModel != "sora-2" || node.GenerationVideoSize != "1280x720" || node.GenerationVideoSeconds != 8 || node.GenerationVideoResolution != "1080p" || node.GenerationVideoAudio == nil || !*node.GenerationVideoAudio || node.GenerationVideoWatermark == nil || *node.GenerationVideoWatermark || node.GenerationVideoNegativePrompt != "  保留首尾空白  " {
		t.Fatalf("video generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(video) error = %v", err)
	}
	if loaded.Nodes[0].GenerationVideoNegativePrompt != "  保留首尾空白  " {
		t.Fatalf("video negative prompt was changed after reload: %q", loaded.Nodes[0].GenerationVideoNegativePrompt)
	}
}

func TestCanvasDocumentServiceStoresAudioGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "audio-1", Type: "audio", Width: 420, Height: 160, ScaleX: 1, ScaleY: 1,
		GenerationAudioModel: " mimo-v2.5-tts-voicedesign ", GenerationAudioVoice: "alloy", GenerationAudioFormat: " MP3 ", GenerationAudioSpeed: 1.25,
		GenerationAudioInstructions: " calm ", GenerationAudioGrokVoice: " eve ", GenerationAudioGrokLanguage: "pt-BR", GenerationAudioGrokFormat: " WAV ", GenerationAudioGrokSpeed: 1.5,
		GenerationAudioGLMVoice: "chuichui", GenerationAudioGLMFormat: " PCM ", GenerationAudioGLMSpeed: 2,
		GenerationAudioMiMoVoice: "茉莉", GenerationAudioMiMoFormat: " MP3 ", GenerationAudioMiMoVoiceDesignPrompt: " young voice ", GenerationAudioMiMoVoiceCloneNodeID: " reference-audio ",
		GenerationAudioGeminiVoice: "Kore", AudioTaskID: " task-1 ", AudioTaskResultID: " result-1 ", MimeType: " AUDIO/MPEG ", DurationMS: 1500,
	}}})
	if err != nil {
		t.Fatalf("Save(audio) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationAudioModel != "mimo-v2.5-tts-voicedesign" || node.GenerationAudioFormat != "mp3" || node.GenerationAudioInstructions != "calm" || node.GenerationAudioGrokVoice != "eve" || node.GenerationAudioGrokFormat != "wav" || node.GenerationAudioGLMFormat != "pcm" || node.GenerationAudioMiMoFormat != "mp3" || node.GenerationAudioMiMoVoiceDesignPrompt != "young voice" || node.GenerationAudioMiMoVoiceCloneNodeID != "reference-audio" || node.GenerationAudioGeminiVoice != "Kore" || node.AudioTaskID != "task-1" || node.AudioTaskResultID != "result-1" || node.MimeType != "audio/mpeg" || node.DurationMS != 1500 {
		t.Fatalf("audio generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(audio) error = %v", err)
	}
	if loaded.Nodes[0].AudioTaskID != "task-1" || loaded.Nodes[0].GenerationAudioGrokLanguage != "pt-BR" {
		t.Fatalf("audio parameters were not persisted: %#v", loaded.Nodes[0])
	}
}

func TestCanvasDocumentServiceStoresTextConfigurationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "config-text", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationMode: " TEXT ", GenerationTextModel: " gpt-5-mini ",
	}}})
	if err != nil {
		t.Fatalf("Save(text config) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationMode != "text" || node.GenerationTextModel != "gpt-5-mini" {
		t.Fatalf("text configuration parameters = %#v", node)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "config-text", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationMode: "text",
	}}}); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(text config without model) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceValidatesAudioProviderParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	base := CanvasNode{ID: "audio-1", Type: "audio", Width: 420, Height: 160, ScaleX: 1, ScaleY: 1, GenerationAudioModel: "gpt-4o-mini-tts"}
	invalid := []CanvasNode{
		func() CanvasNode { node := base; node.GenerationAudioVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokLanguage = "xx"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokFormat = "flac"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokSpeed = 1.6; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMFormat = "mp3"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMSpeed = 2.1; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioMiMoVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioMiMoFormat = "flac"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGeminiVoice = "Unknown"; return node }(),
	}
	for _, node := range invalid {
		if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid audio node %#v) error = %v", node, err)
		}
	}
}

func TestCanvasDocumentServiceAllowsVideoWithoutIndependentResolution(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720",
		GenerationVideoSeconds: 4,
	}}})
	if err != nil {
		t.Fatalf("Save(Sora video without resolution) error = %v", err)
	}
}

func TestCanvasDocumentServiceAllowsHailuoVideoWithoutSize(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "MiniMax-Hailuo-2.3", GenerationVideoSeconds: 6,
	}}})
	if err != nil {
		t.Fatalf("Save(Hailuo video without size) error = %v", err)
	}
}

func TestCanvasDocumentServiceAllowsKlingV3ThreeSecondDuration(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "kling-v3", GenerationVideoSize: "16:9",
		GenerationVideoSeconds: 3, GenerationVideoResolution: "1080p",
	}}})
	if err != nil {
		t.Fatalf("Save(Kling V3 three-second video) error = %v", err)
	}
}

func TestCanvasDocumentServiceStoresCustomVideoDuration(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "future-video-model", GenerationVideoSize: "16:9",
		GenerationVideoSeconds: 7,
	}}})
	if err != nil || document.Nodes[0].GenerationVideoSeconds != 7 {
		t.Fatalf("Save(custom video duration) = %#v, error = %v", document.Nodes, err)
	}
}

func TestCanvasDocumentServiceStoresReferenceVideoSizes(t *testing.T) {
	for _, size := range []string{"3:2", "2:3", "800x600", "auto", "adaptive"} {
		t.Run(size, func(t *testing.T) {
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
				ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
				GenerationVideoModel: "future-video-model", GenerationVideoSize: size, GenerationVideoSeconds: 7,
			}}})
			if err != nil || document.Nodes[0].GenerationVideoSize != size {
				t.Fatalf("Save(video size %q) = %#v, error = %v", size, document.Nodes, err)
			}
		})
	}
}

func TestCanvasDocumentServiceStoresVideoNodeBindings(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720", GenerationVideoSeconds: 8, GenerationVideoResolution: "1080p",
		ExcludeUpstreamText: true, GenerationVideoFirstFrameNodeID: " first ", GenerationVideoLastFrameNodeID: " last ",
		GenerationVideoKlingImageNodeIDs: []string{" first ", " last "},
		GenerationVideoKlingMultiPrompt:  []map[string]any{{"text_node_id": " shot ", "duration": "3"}},
		GenerationVideoKlingElementList:  []map[string]any{{"name": " hero ", "description": " lead ", "node_ids": []string{" first ", "audio"}}},
	}}})
	if err != nil {
		t.Fatalf("Save(video bindings) error = %v", err)
	}
	node := document.Nodes[0]
	if !node.ExcludeUpstreamText || node.GenerationVideoFirstFrameNodeID != "first" || node.GenerationVideoLastFrameNodeID != "last" || len(node.GenerationVideoKlingImageNodeIDs) != 2 || node.GenerationVideoKlingImageNodeIDs[0] != "first" {
		t.Fatalf("frame bindings = %#v", node)
	}
	if node.GenerationVideoKlingMultiPrompt[0]["text_node_id"] != "shot" || node.GenerationVideoKlingMultiPrompt[0]["duration"] != "3" {
		t.Fatalf("multi prompt bindings = %#v", node.GenerationVideoKlingMultiPrompt)
	}
	if node.GenerationVideoKlingElementList[0]["name"] != "hero" || !reflect.DeepEqual(node.GenerationVideoKlingElementList[0]["node_ids"], []string{"first", "audio"}) {
		t.Fatalf("element bindings = %#v", node.GenerationVideoKlingElementList)
	}
}

func TestCanvasDocumentServiceRejectsMalformedVideoNodeBindings(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	base := CanvasNode{ID: "video", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1, GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720", GenerationVideoSeconds: 8, GenerationVideoResolution: "1080p"}
	invalid := []func(*CanvasNode){
		func(node *CanvasNode) { node.GenerationVideoKlingImageNodeIDs = []string{"a", "b", "c"} },
		func(node *CanvasNode) {
			node.GenerationVideoKlingMultiPrompt = []map[string]any{{"text_node_id": "shot", "duration": 3}}
		},
		func(node *CanvasNode) {
			node.GenerationVideoKlingElementList = []map[string]any{{"name": "hero", "description": "lead", "node_ids": "image"}}
		},
	}
	for _, mutate := range invalid {
		node := base
		mutate(&node)
		if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(malformed video bindings) error = %v, want ErrInvalidCanvasDocument", err)
		}
	}
}

func TestCanvasDocumentServiceRejectsInvalidVideoGenerationParameters(t *testing.T) {
	valid := CanvasNode{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720",
		GenerationVideoSeconds: 8, GenerationVideoResolution: "1080p",
	}
	tests := []struct {
		name   string
		mutate func(*CanvasNode)
	}{
		{name: "model too long", mutate: func(node *CanvasNode) { node.GenerationVideoModel = strings.Repeat("m", 257) }},
		{name: "unsupported size", mutate: func(node *CanvasNode) { node.GenerationVideoSize = "800-600" }},
		{name: "invalid duration", mutate: func(node *CanvasNode) { node.GenerationVideoSeconds = 0 }},
		{name: "unsupported resolution", mutate: func(node *CanvasNode) { node.GenerationVideoResolution = "2160p" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := valid
			test.mutate(&node)
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatalf("Save(invalid video) error = %v, want ErrInvalidCanvasDocument", err)
			}
		})
	}
}

func TestCanvasDocumentServiceStoresIndependentConnections(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{
		Nodes: []CanvasNode{
			{ID: "source-a", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1, Prompt: "a"},
			{ID: "source-b", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1, Prompt: "b"},
			{ID: "target", Type: "image", Width: 320, Height: 240, ScaleX: 1, ScaleY: 1},
		},
		Connections: []CanvasConnection{
			{ID: "connection-a", FromNodeID: "source-a", ToNodeID: "target"},
			{ID: "connection-b", FromNodeID: "source-b", ToNodeID: "target"},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if len(document.Connections) != 2 {
		t.Fatalf("connections = %#v", document.Connections)
	}
}

func TestCanvasDocumentServiceRejectsConnectionsBetweenConfigurationNodes(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{
		Nodes: []CanvasNode{
			{ID: "config-a", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
			{ID: "config-b", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
		},
		Connections: []CanvasConnection{{ID: "config-config", FromNodeID: "config-a", ToNodeID: "config-b"}},
	})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(config connection) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceStoresNodeGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	compression := 82
	stream := true
	snapToMultiple16 := false
	expanded := true
	composerContent := "使用 @[node:image-reference] 的构图"
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-parameters", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		ComposerContent: &composerContent,
		NaturalWidth:    2048, NaturalHeight: 1536, FreeResize: true,
		GenerationModel: " gemini-3.1-flash-image ",
		GenerationSize:  "2048x2048", GenerationResolution: "2k", GenerationQuality: "high",
		GenerationCount: 15, GenerationOutputFormat: "webp", GenerationOutputCompression: &compression,
		GenerationStream: &stream, GenerationPartialImages: 2, GenerationSnapToMultiple16: &snapToMultiple16, GenerationStatus: "error",
		GenerationError: "request failed", GenerationType: "edit", GenerationReferenceURLs: []string{"/images/reference.png"},
		BatchChildIDs: []string{"image-child"}, BatchPrimaryID: "image-child", BatchExpanded: &expanded,
	}, {
		ID: "image-child", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		BatchRootID: "image-parameters",
	}}})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	node := document.Nodes[0]
	if node.NaturalWidth != 2048 || node.NaturalHeight != 1536 || !node.FreeResize || node.ComposerContent == nil || *node.ComposerContent != composerContent || node.GenerationModel != "gemini-3.1-flash-image" || node.GenerationSize != "2048x2048" || node.GenerationCount != 15 || node.GenerationOutputCompression == nil || *node.GenerationOutputCompression != compression || node.GenerationStream == nil || !*node.GenerationStream || node.GenerationSnapToMultiple16 == nil || *node.GenerationSnapToMultiple16 || node.GenerationStatus != "error" || node.GenerationError != "request failed" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || len(node.BatchChildIDs) != 1 || node.BatchPrimaryID != "image-child" || node.BatchExpanded == nil || !*node.BatchExpanded || document.Nodes[1].BatchRootID != node.ID {
		t.Fatalf("generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Nodes[0].GenerationSnapToMultiple16 == nil || *loaded.Nodes[0].GenerationSnapToMultiple16 {
		t.Fatalf("snap-to-multiple setting was not persisted: %#v", loaded.Nodes[0].GenerationSnapToMultiple16)
	}
}

func TestCanvasDocumentServicePreservesGeminiReferenceImageLimit(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	referenceURLs := make([]string, canvasDocumentMaxGenerationReferenceImages)
	for index := range referenceURLs {
		referenceURLs[index] = "/images/reference.png"
	}
	document := CanvasDocument{Nodes: []CanvasNode{{
		ID: "gemini-edit", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationType: "edit", GenerationReferenceURLs: referenceURLs,
	}}}

	saved, err := saveCanvas(service, "owner", document)
	if err != nil {
		t.Fatalf("Save(14 references) error = %v", err)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(saved.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages || len(loaded.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages {
		t.Fatalf("reference URLs were not preserved: saved=%d loaded=%d", len(saved.Nodes[0].GenerationReferenceURLs), len(loaded.Nodes[0].GenerationReferenceURLs))
	}

	document.Nodes[0].GenerationReferenceURLs = append(referenceURLs, "/images/overflow.png")
	if _, err := saveCanvas(service, "owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(15 references) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceUsesReferenceImageGenerationType(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document := CanvasDocument{Nodes: []CanvasNode{{
		ID: "generated-image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationType: "generation",
	}}}

	saved, err := saveCanvas(service, "owner", document)
	if err != nil {
		t.Fatalf("Save(generation) error = %v", err)
	}
	if saved.Nodes[0].GenerationType != "generation" {
		t.Fatalf("generation type = %q, want generation", saved.Nodes[0].GenerationType)
	}

	document.Nodes[0].GenerationType = "generate"
	if _, err := saveCanvas(service, "owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(generate) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceRejectsBrokenBatchRelationships(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "batch-root", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		BatchChildIDs: []string{"missing-child"}, BatchPrimaryID: "missing-child",
	}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(broken batch) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceManagesProjects(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	if len(initial.Projects) != 1 || initial.Document.ID == "" {
		t.Fatalf("initial workspace = %#v", initial)
	}

	created, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create project error = %v", err)
	}
	if len(created.Projects) != 2 || created.Document.Title != "第二张画布" {
		t.Fatalf("created workspace = %#v", created)
	}
	secondID := created.Document.ID

	renamed, err := service.UpdateProject("owner", "rename", secondID, "产品海报")
	if err != nil {
		t.Fatalf("Rename project error = %v", err)
	}
	if renamed.Document.Title != "产品海报" {
		t.Fatalf("renamed workspace = %#v", renamed)
	}

	deleted, err := service.UpdateProject("owner", "delete", secondID, "")
	if err != nil {
		t.Fatalf("Delete project error = %v", err)
	}
	if len(deleted.Projects) != 1 || deleted.Document.ID == secondID {
		t.Fatalf("deleted workspace = %#v", deleted)
	}
}

func TestCanvasDocumentServiceActivatesProjectWithoutRewritingWorkspace(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	service := NewCanvasDocumentService(backend)
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	created, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create project error = %v", err)
	}
	workspaceName := canvasWorkspaceName("owner")
	workspaceSaves := backend.saves[workspaceName]

	activated, err := service.UpdateProject("owner", "activate", initial.Document.ID, "")
	if err != nil {
		t.Fatalf("Activate project error = %v", err)
	}
	if activated.Document.ID != initial.Document.ID {
		t.Fatalf("activated document = %q, want %q", activated.Document.ID, initial.Document.ID)
	}
	if backend.saves[workspaceName] != workspaceSaves {
		t.Fatalf("workspace saves = %d, want %d", backend.saves[workspaceName], workspaceSaves)
	}
	if backend.saves[canvasActiveProjectName("owner")] != 1 {
		t.Fatalf("active project pointer saves = %d, want 1", backend.saves[canvasActiveProjectName("owner")])
	}

	reloaded := NewCanvasDocumentService(backend)
	workspace, err := reloaded.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after reload) error = %v", err)
	}
	if workspace.Document.ID != initial.Document.ID || workspace.ActiveProjectID != initial.Document.ID {
		t.Fatalf("reloaded workspace = %#v", workspace)
	}
	if len(created.Projects) != len(workspace.Projects) {
		t.Fatalf("project count = %d, want %d", len(workspace.Projects), len(created.Projects))
	}
}

func TestCanvasDocumentServiceIgnoresStaleActiveProjectPointer(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	service := NewCanvasDocumentService(backend)
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	second, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create second project error = %v", err)
	}
	if _, err := service.UpdateProject("owner", "activate", initial.Document.ID, ""); err != nil {
		t.Fatalf("Activate first project error = %v", err)
	}
	third, err := service.UpdateProject("owner", "create", "", "第三张画布")
	if err != nil {
		t.Fatalf("Create third project error = %v", err)
	}
	if third.Document.Title != "第三张画布" || third.Document.ID == second.Document.ID {
		t.Fatalf("third workspace = %#v", third)
	}

	reloaded := NewCanvasDocumentService(backend)
	workspace, err := reloaded.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after create) error = %v", err)
	}
	if workspace.Document.ID != third.Document.ID {
		t.Fatalf("stale pointer selected %q, want %q", workspace.Document.ID, third.Document.ID)
	}
}

func TestCanvasDocumentServiceImportsAsNewProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	imported, err := service.Import("owner", CanvasDocument{
		ID:       initial.Document.ID,
		Revision: 99,
		Title:    "导入画布",
		Nodes: []CanvasNode{{
			ID: "text-imported", Type: "text", Width: 340, Height: 220, ScaleX: 1, ScaleY: 1, Prompt: "导入内容",
		}},
	})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if len(imported.Projects) != 2 || imported.Document.ID == initial.Document.ID || imported.Document.Revision != 0 || imported.Document.Title != "导入画布" || len(imported.Document.Nodes) != 1 {
		t.Fatalf("imported workspace = %#v", imported)
	}
}

func TestCanvasDocumentServiceRejectsImportWithoutChangingWorkspace(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	_, err = service.Import("owner", CanvasDocument{Title: "损坏画布", Nodes: []CanvasNode{{ID: "bad", Type: "image", Width: 0, Height: 100}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Import() error = %v, want ErrInvalidCanvasDocument", err)
	}
	after, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after import) error = %v", err)
	}
	if len(after.Projects) != 1 || after.Document.ID != initial.Document.ID {
		t.Fatalf("workspace changed after rejected import: %#v", after)
	}
}

func TestCanvasDocumentServicePersistsValidatedAgentMessages(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{
		Title: "Agent canvas",
		AgentMessages: []CanvasAgentMessage{
			{ID: "message-1", Role: "user", Content: "创建产品主视觉", CreatedAt: "2026-01-01T00:00:00Z"},
			{ID: "message-2", Role: "assistant", Content: "已创建", CreatedAt: "2026-01-01T00:00:01Z"},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if len(document.AgentMessages) != 2 || document.AgentMessages[1].Content != "已创建" {
		t.Fatalf("agent messages = %#v", document.AgentMessages)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(loaded.AgentMessages) != 2 || loaded.AgentMessages[0].Role != "user" {
		t.Fatalf("loaded agent messages = %#v", loaded.AgentMessages)
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentMessages(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{
		Title:         "Agent canvas",
		AgentMessages: []CanvasAgentMessage{{ID: "message-1", Role: "system", Content: "unsafe"}},
	})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save() error = %v, want ErrInvalidCanvasDocument", err)
	}
}
