package service

import (
	"errors"
	"testing"
)

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

func TestCanvasDocumentServiceRejectsUnsupportedNodeType(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
	}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(unsupported type) error = %v, want ErrInvalidCanvasDocument", err)
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
		GenerationSize: "2048x2048", GenerationResolution: "2k", GenerationQuality: "high",
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
	if node.NaturalWidth != 2048 || node.NaturalHeight != 1536 || !node.FreeResize || node.ComposerContent == nil || *node.ComposerContent != composerContent || node.GenerationSize != "2048x2048" || node.GenerationCount != 3 || node.GenerationOutputCompression == nil || *node.GenerationOutputCompression != compression || node.GenerationStream == nil || !*node.GenerationStream || node.GenerationStatus != "error" || node.GenerationError != "request failed" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || len(node.BatchChildIDs) != 1 || node.BatchPrimaryID != "image-child" || node.BatchExpanded == nil || !*node.BatchExpanded || document.Nodes[1].BatchRootID != node.ID {
		t.Fatalf("generation parameters = %#v", node)
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
