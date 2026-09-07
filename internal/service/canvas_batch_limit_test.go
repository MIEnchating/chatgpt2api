package service

import (
	"errors"
	"fmt"
	"testing"
)

func TestCanvasDocumentPersistsFullImageGenerationBatch(t *testing.T) {
	s := NewCanvasDocumentService(newTestStorageBackend(t))
	workspace, err := s.Workspace("batch-owner")
	if err != nil {
		t.Fatal(err)
	}
	document := workspace.Document
	root := CanvasNode{ID: "root", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, GenerationCount: 15}
	document.Nodes = []CanvasNode{root}
	for index := 0; index < 15; index++ {
		childID := fmt.Sprintf("output-%d", index)
		document.Nodes[0].BatchChildIDs = append(document.Nodes[0].BatchChildIDs, childID)
		document.Nodes = append(document.Nodes, CanvasNode{ID: childID, Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, BatchRootID: root.ID})
	}
	saved, err := s.SaveAtRevision("batch-owner", document)
	if err != nil {
		t.Fatalf("save supported 15-image batch: %v", err)
	}
	reloaded, err := s.Project("batch-owner", saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Nodes) != 16 || len(reloaded.Nodes[0].BatchChildIDs) != 15 {
		t.Fatalf("batch lost outputs after reload: %#v", reloaded.Nodes)
	}
	reloaded.Nodes[0].BatchChildIDs = append(reloaded.Nodes[0].BatchChildIDs, "overflow")
	reloaded.Nodes = append(reloaded.Nodes, CanvasNode{ID: "overflow", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, BatchRootID: root.ID})
	if _, err := s.SaveAtRevision("batch-owner", reloaded); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("save oversized batch error = %v", err)
	}
}
