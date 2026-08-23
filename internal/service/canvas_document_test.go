package service

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"chatgpt2api/internal/storage"
)

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
	document, err := service.Save("owner-a", CanvasDocument{
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

	loaded, err := service.Load("owner-a")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Title != "Campaign board" || loaded.Nodes[0].URL != "/images/a.png" {
		t.Fatalf("Load() document = %#v", loaded)
	}
	other, err := service.Load("owner-b")
	if err != nil {
		t.Fatalf("Load(other) error = %v", err)
	}
	if other.Revision != 0 || len(other.Nodes) != 0 {
		t.Fatalf("other owner saw canvas = %#v", other)
	}
}

func TestCanvasDocumentServiceRejectsStaleRevision(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Load("owner")
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
	loaded, err := service.Load("owner")
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
	initial, err := service.Load("owner")
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
	_, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{ID: "bad", Type: "image", Width: 0, Height: 100}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save() error = %v, want ErrInvalidCanvasDocument", err)
	}

	if _, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-1", Type: "text", Width: 320, Height: 160, FontSize: 18, ScaleX: 1, ScaleY: 1, Prompt: "idea",
	}}}); err != nil {
		t.Fatalf("Save(valid) error = %v", err)
	}
	if _, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-invalid-font", Type: "text", Width: 320, Height: 160, FontSize: 40, ScaleX: 1, ScaleY: 1,
	}}}); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(invalid font size) error = %v, want ErrInvalidCanvasDocument", err)
	}
	if _, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-empty", Type: "image", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank image) error = %v", err)
	}
	if _, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-empty", Type: "text", Width: 340, Height: 220, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank text) error = %v", err)
	}
	saved, err := service.Save("owner", CanvasDocument{
		Title: "保留的画布", Background: "grid", Viewport: CanvasViewport{Zoom: 1.5, X: 240, Y: -80},
		Nodes: []CanvasNode{{ID: "config-empty", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}},
	})
	if err != nil {
		t.Fatalf("Save(config) error = %v", err)
	}
	cleared, err := service.Clear("owner", saved.ID)
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Title != "保留的画布" || cleared.Background != "grid" || cleared.Viewport != (CanvasViewport{Zoom: 1.5, X: 240, Y: -80}) || len(cleared.Nodes) != 0 || len(cleared.Connections) != 0 {
		t.Fatalf("Clear() document = %#v", cleared)
	}
}

func TestCanvasDocumentServiceClearsExplicitProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	first, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "first-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "first",
	}}})
	if err != nil {
		t.Fatalf("Save(first) error = %v", err)
	}
	secondWorkspace, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	second, err := service.Save("owner", CanvasDocument{ID: secondWorkspace.Document.ID, Nodes: []CanvasNode{{
		ID: "second-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "second",
	}}})
	if err != nil {
		t.Fatalf("Save(second) error = %v", err)
	}

	cleared, err := service.Clear("owner", first.ID)
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
	_, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
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
	document, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: " sora-2 ", GenerationVideoSize: " 1280X720 ",
		GenerationVideoSeconds: 8, GenerationVideoResolution: " 1080P ",
		GenerationVideoAudio: &audio, GenerationVideoWatermark: &watermark,
	}}})
	if err != nil {
		t.Fatalf("Save(video) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationVideoModel != "sora-2" || node.GenerationVideoSize != "1280x720" || node.GenerationVideoSeconds != 8 || node.GenerationVideoResolution != "1080p" || node.GenerationVideoAudio == nil || !*node.GenerationVideoAudio || node.GenerationVideoWatermark == nil || *node.GenerationVideoWatermark {
		t.Fatalf("video generation parameters = %#v", node)
	}
}

func TestCanvasDocumentServiceAllowsVideoWithoutIndependentResolution(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720",
		GenerationVideoSeconds: 4,
	}}})
	if err != nil {
		t.Fatalf("Save(Sora video without resolution) error = %v", err)
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
		{name: "unsupported size", mutate: func(node *CanvasNode) { node.GenerationVideoSize = "800x600" }},
		{name: "unsupported duration", mutate: func(node *CanvasNode) { node.GenerationVideoSeconds = 7 }},
		{name: "unsupported resolution", mutate: func(node *CanvasNode) { node.GenerationVideoResolution = "2160p" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := valid
			test.mutate(&node)
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			if _, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatalf("Save(invalid video) error = %v, want ErrInvalidCanvasDocument", err)
			}
		})
	}
}

func TestCanvasDocumentServiceStoresIndependentConnections(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := service.Save("owner", CanvasDocument{
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
	_, err := service.Save("owner", CanvasDocument{
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
	expanded := true
	composerContent := "使用 @[node:image-reference] 的构图"
	document, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-parameters", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		ComposerContent: &composerContent,
		NaturalWidth:    2048, NaturalHeight: 1536, FreeResize: true,
		GenerationModel: " gemini-3.1-flash-image ",
		GenerationSize:  "2048x2048", GenerationResolution: "2k", GenerationQuality: "high",
		GenerationCount: 3, GenerationOutputFormat: "webp", GenerationOutputCompression: &compression,
		GenerationStream: &stream, GenerationPartialImages: 2, GenerationStatus: "error",
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
	if node.NaturalWidth != 2048 || node.NaturalHeight != 1536 || !node.FreeResize || node.ComposerContent == nil || *node.ComposerContent != composerContent || node.GenerationModel != "gemini-3.1-flash-image" || node.GenerationSize != "2048x2048" || node.GenerationCount != 3 || node.GenerationOutputCompression == nil || *node.GenerationOutputCompression != compression || node.GenerationStream == nil || !*node.GenerationStream || node.GenerationStatus != "error" || node.GenerationError != "request failed" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || len(node.BatchChildIDs) != 1 || node.BatchPrimaryID != "image-child" || node.BatchExpanded == nil || !*node.BatchExpanded || document.Nodes[1].BatchRootID != node.ID {
		t.Fatalf("generation parameters = %#v", node)
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

	saved, err := service.Save("owner", document)
	if err != nil {
		t.Fatalf("Save(14 references) error = %v", err)
	}
	loaded, err := service.Load("owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(saved.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages || len(loaded.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages {
		t.Fatalf("reference URLs were not preserved: saved=%d loaded=%d", len(saved.Nodes[0].GenerationReferenceURLs), len(loaded.Nodes[0].GenerationReferenceURLs))
	}

	document.Nodes[0].GenerationReferenceURLs = append(referenceURLs, "/images/overflow.png")
	if _, err := service.Save("owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(15 references) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceRejectsBrokenBatchRelationships(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
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
