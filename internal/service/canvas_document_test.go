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
		ID: "text-1", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1, Prompt: "idea",
	}}}); err != nil {
		t.Fatalf("Save(valid) error = %v", err)
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
	cleared, err := service.Clear("owner")
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Title != "我的画布" || len(cleared.Nodes) != 0 {
		t.Fatalf("Clear() document = %#v", cleared)
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

func TestCanvasDocumentServiceStoresNodeGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	compression := 82
	stream := true
	document, err := service.Save("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-parameters", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationSize: "2048x2048", GenerationResolution: "2k", GenerationQuality: "high",
		GenerationCount: 3, GenerationOutputFormat: "webp", GenerationOutputCompression: &compression,
		GenerationStream: &stream, GenerationPartialImages: 2,
	}}})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationSize != "2048x2048" || node.GenerationCount != 3 || node.GenerationOutputCompression == nil || *node.GenerationOutputCompression != compression || node.GenerationStream == nil || !*node.GenerationStream {
		t.Fatalf("generation parameters = %#v", node)
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
