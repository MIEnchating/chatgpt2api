package service

import "testing"

func TestCanvasAgentMergePreservesUserEditsAndDeletedNodes(t *testing.T) {
	base := DefaultCanvasDocument()
	base.Nodes = []CanvasNode{{ID: "n", Type: "image", X: 0, Prompt: "original"}, {ID: "deleted", Type: "text"}}
	edited := cloneCanvasAgentDocument(base)
	edited.Nodes[0].URL = "/generated.png"
	edited.Nodes[0].Prompt = "worker edit"
	edited.Nodes = append(edited.Nodes, CanvasNode{ID: "created", Type: "text"})
	current := cloneCanvasAgentDocument(base)
	current.Nodes = current.Nodes[:1]
	current.Nodes[0].X = 200
	current.Nodes[0].Prompt = "user edit"
	current.Revision = 5
	merged := mergeCanvasAgentDocument(base, edited, current)
	if len(merged.Nodes) != 2 || merged.Nodes[0].X != 200 || merged.Nodes[0].Prompt != "user edit" || merged.Nodes[0].URL != "/generated.png" || merged.Nodes[1].ID != "created" || merged.Revision != 5 {
		t.Fatalf("lost concurrent changes: %+v", merged)
	}
}
