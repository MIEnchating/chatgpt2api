package service

import (
	"encoding/json"
	"testing"
)

func TestCanvasAgentMergeVideoSelectionPreservesConcurrentPreferences(t *testing.T) {
	base := DefaultCanvasDocument()
	base.AgentConfig = json.RawMessage(`{"videoModel":"old","autoGenerateMedia":true}`)
	edited, current := cloneCanvasAgentDocument(base), cloneCanvasAgentDocument(base)
	edited.AgentConfig = json.RawMessage(`{"videoModel":"new","autoGenerateMedia":true}`)
	current.AgentConfig = json.RawMessage(`{"videoModel":"old","autoGenerateMedia":false}`)
	merged := mergeCanvasAgentDocument(base, edited, current)
	config := map[string]any{}
	_ = json.Unmarshal(merged.AgentConfig, &config)
	if config["videoModel"] != "new" || config["autoGenerateMedia"] != false {
		t.Fatal("switch lost concurrent preferences or failed to persist", config)
	}
	current.AgentConfig = json.RawMessage(`{"videoModel":"user-choice","autoGenerateMedia":false}`)
	merged = mergeCanvasAgentDocument(base, edited, current)
	_ = json.Unmarshal(merged.AgentConfig, &config)
	if config["videoModel"] != "user-choice" {
		t.Fatal("Agent overwrote user's concurrent model selection", config)
	}
	if !canvasAgentContentChanged(base, current) {
		t.Fatal("a concurrent model switch must invalidate stale generation decisions")
	}
	current.AgentConfig = json.RawMessage(`{"videoModel":"old","autoGenerateMedia":false}`)
	if canvasAgentContentChanged(base, current) {
		t.Fatal("unrelated preferences must not invalidate canvas content")
	}
}

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

func TestCanvasAgentMergesConcurrentShotEdits(t *testing.T) {
	w := scriptVideoMergeWorker(t)
	base := cloneCanvasAgentDocument(w.doc)
	edited, current := cloneCanvasAgentDocument(base), cloneCanvasAgentDocument(base)
	edited.Nodes[0].ScriptProject.Shots[0].Description = "Agent edit"
	current.Nodes[0].ScriptProject.Shots[1].Description = "Browser edit"
	current.Nodes[0].ScriptProject.Shots[1].VideoNodeID = "new-video"
	merged := mergeCanvasAgentDocument(base, edited, current)
	project := merged.Nodes[0].ScriptProject
	if project.Shots[0].Description != "Agent edit" || project.Shots[1].Description != "Browser edit" || project.Shots[1].VideoNodeID != "new-video" {
		t.Fatalf("lost concurrent shot edits: %+v", project)
	}
}
