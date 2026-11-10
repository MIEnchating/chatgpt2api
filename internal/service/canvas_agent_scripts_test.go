package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"
)

func scriptAgentProject() map[string]any {
	return map[string]any{"step": 2, "confirmed": true,
		"assets": []any{map[string]any{"id": "hero", "kind": "character", "name": "Protagonist", "description": "Grey hoodie", "image_node_id": "reference"}},
		"shots": []any{
			map[string]any{"id": "shot-1", "seconds": 5, "description": "A knock at the door", "source_node_id": "old-shot", "image_node_id": "reference", "video_node_id": "completed", "asset_ids": []string{"hero"}},
			map[string]any{"id": "shot-2", "seconds": 5, "description": "He looks at the door", "source_node_id": "old-shot", "video_node_id": "pending", "asset_ids": []string{"hero"}},
		},
	}
}

func scriptAgentNodes() []CanvasNode {
	return []CanvasNode{
		{ID: "main", Type: "text", Title: "Approved script", Prompt: "Original story", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1, GenerationStatus: "success"},
		{ID: "old-shot", Type: "text", Title: "Original storyboard", Prompt: "Full original storyboard", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1},
		{ID: "reference", Type: "image", URL: "/images/reference.png", TaskID: "original-image-task", GenerationStatus: "success", Width: 360, Height: 240, ScaleX: 1, ScaleY: 1},
		{ID: "completed", Type: "video", URL: "/videos/completed.mp4", TaskID: "original-completed-task", Prompt: "Original video prompt", GenerationVideoModel: "original-model", GenerationVideoSeconds: 5, GenerationStatus: "success", Width: 240, Height: 360, ScaleX: 1, ScaleY: 1},
		{ID: "pending", Type: "video", TaskID: "original-pending-task", Prompt: "Original pending prompt", GenerationVideoModel: "original-model", GenerationVideoSeconds: 5, GenerationStatus: "loading", Width: 240, Height: 360, ScaleX: 1, ScaleY: 1},
	}
}

func TestCanvasAgentScriptCreationAndInPlaceImportPreserveMedia(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	w.doc.Connections = []CanvasConnection{{ID: "original-edge", FromNodeID: "old-shot", ToNodeID: "pending"}}
	original := cloneCanvasAgentDocument(w.doc)
	result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}})
	if err != nil || result["ok"] != true || w.node("main").Type != "script" || w.node("main").Prompt != "Original story" {
		t.Fatalf("import failed: %v %v", result, err)
	}
	if len(w.doc.Nodes) != len(original.Nodes) || !reflect.DeepEqual(w.doc.Nodes[1:], original.Nodes[1:]) || !reflect.DeepEqual(w.doc.Connections[:1], original.Connections) {
		t.Fatal("organizing script changed original storyboard, media, task IDs or unrelated connections")
	}
	if len(w.doc.Connections) != 2 || w.doc.Connections[1].FromNodeID != "reference" || w.doc.Connections[1].ToNodeID != "main" {
		t.Fatal("organizing script did not bind the asset as input")
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || !reflect.DeepEqual(saved.Nodes[0].ScriptProject, w.node("main").ScriptProject) {
		t.Fatalf("structured script did not survive persistence: %v", err)
	}
	// A later content edit must not silently detach media from stable shot IDs.
	project := scriptAgentProject()
	for _, value := range project["shots"].([]any) {
		shot := value.(map[string]any)
		delete(shot, "source_node_id")
		delete(shot, "image_node_id")
		delete(shot, "video_node_id")
	}
	delete(project["assets"].([]any)[0].(map[string]any), "image_node_id")
	result, err = w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": project}})
	got := w.node("main").ScriptProject
	if err != nil || result["ok"] != true || got.Shots[0].VideoNodeID != "completed" || got.Shots[1].VideoNodeID != "pending" || got.Assets[0].ImageNodeID != "reference" {
		t.Fatalf("editing detached existing media: %v %v", result, err)
	}
	w.doc.AgentAutoTitlePending = true
	created, err := w.tool(map[string]any{"name": "create_primary_script_node", "arguments": map[string]any{"title": "New script", "content": "Story", "projectTitle": "New project"}})
	node := w.node(created["nodeId"].(string))
	if err != nil || node.Type != "script" || node.ScriptProject == nil || w.doc.Title != "New project" {
		t.Fatalf("new primary script was not native: %v %v", created, err)
	}
}

func TestCanvasAgentScriptRejectsInvalidReferencesWithoutMutation(t *testing.T) {
	for _, invalid := range []string{"other-project-node", "main", "old-shot"} {
		t.Run(invalid, func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			before := agentJSON(w.doc)
			project := scriptAgentProject()
			project["shots"].([]any)[0].(map[string]any)["video_node_id"] = invalid
			result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": project}})
			if err != nil || result["ok"] != false || agentJSON(w.doc) != before {
				t.Fatalf("invalid reference mutated canvas: %v %v", result, err)
			}
		})
	}
}

func TestCanvasAgentScriptAssetsAreInputs(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	w.doc.Connections = []CanvasConnection{
		{ID: "wrong-direction", FromNodeID: "main", ToNodeID: "reference"},
		{ID: "video-output", FromNodeID: "main", ToNodeID: "completed"},
	}
	result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}})
	if err != nil || result["ok"] != true {
		t.Fatalf("script update failed: %v %v", result, err)
	}
	want := []CanvasConnection{
		{ID: "wrong-direction", FromNodeID: "reference", ToNodeID: "main"},
		{ID: "video-output", FromNodeID: "main", ToNodeID: "completed"},
	}
	if !reflect.DeepEqual(w.doc.Connections, want) {
		t.Fatalf("asset must feed the script, preserving video outputs: %+v", w.doc.Connections)
	}
	before := agentJSON(w.doc.Connections)
	_, err = w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}})
	if err != nil || agentJSON(w.doc.Connections) != before {
		t.Fatal("repeated script edits duplicated asset inputs")
	}
}

func TestCanvasAgentScriptAssetReplacementRemovesLegacyEdge(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(fmt.Sprintf("shared-shot-%t", shared), func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			project := scriptAgentProject()
			var previous CanvasScriptProject
			if err := json.Unmarshal([]byte(agentJSON(project)), &previous); err != nil {
				t.Fatal(err)
			}
			w.doc.Nodes[0].ScriptProject = &previous
			w.doc.Connections = []CanvasConnection{
				{ID: "legacy", FromNodeID: "main", ToNodeID: "reference"},
				{ID: "video", FromNodeID: "main", ToNodeID: "completed"},
			}
			project["assets"].([]any)[0].(map[string]any)["image_node_id"] = ""
			if !shared {
				project["shots"].([]any)[0].(map[string]any)["image_node_id"] = ""
			}
			result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": project}})
			if err != nil || result["ok"] != true {
				t.Fatalf("script update failed: %v %v", result, err)
			}
			want := []CanvasConnection{{ID: "video", FromNodeID: "main", ToNodeID: "completed"}}
			if shared {
				want = append([]CanvasConnection{{ID: "legacy", FromNodeID: "main", ToNodeID: "reference"}}, want...)
			}
			if !reflect.DeepEqual(w.doc.Connections, want) {
				t.Fatalf("stale asset edge or missing shot output: %+v", w.doc.Connections)
			}
		})
	}
}

func TestCanvasAgentSDKScriptImportResumesWithoutGeneratingMedia(t *testing.T) {
	var turns, media atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		switch turns.Add(1) {
		case 1:
			return agentTurn(agentCall("organize-script", "update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()})), nil
		case 2:
			return nil, errors.New("upstream rejected request: 400")
		case 3:
			return agentTurn(agentCall("read-imported-script", "get_node", map[string]any{"nodeId": "main"})), nil
		default:
			if !containsAny(agentJSON(r.Messages), "scriptProject") || !containsAny(agentJSON(r.Messages), "original-pending-task", "pending") {
				t.Error("resumed model did not receive imported script and media bindings")
			}
			return agentTurn(), nil
		}
	}, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
		media.Add(1)
		return nil, errors.New("organizing must never generate")
	})
	doc.Nodes = scriptAgentNodes()
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	originalMedia := append([]CanvasNode{}, doc.Nodes[2:]...)
	req.UserText, req.MediaChoice = "把已有分镜整理进脚本，我自己生成素材", "defer"
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	first := agentWait(t, svc, identity, doc.ID)
	if first.AgentRun.Status != "error" || first.Nodes[0].ScriptProject == nil {
		t.Fatalf("import checkpoint missing: %+v", first.AgentRun)
	}
	svc.Close()
	resumed := NewCanvasAgentService(context.Background(), svc.execution, svc.canvas, svc.skills, svc.model, svc.media)
	defer resumed.Close()
	req.ID, req.Resume = "resume-original-script", true
	if _, err = resumed.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	last := agentWait(t, resumed, identity, doc.ID)
	if last.AgentRun.Status != "success" || len(last.Nodes) != len(doc.Nodes) || media.Load() != 0 || !reflect.DeepEqual(last.Nodes[2:], originalMedia) {
		t.Fatalf("resume duplicated media or lost progress: run=%+v nodes=%d media calls=%d", last.AgentRun, len(last.Nodes), media.Load())
	}
	var public []map[string]any
	if err := json.Unmarshal(last.AgentSessions, &public); err != nil {
		t.Fatal(err)
	}
}
