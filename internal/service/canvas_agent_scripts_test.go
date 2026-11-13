package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
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
	if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == "reference" && edge.ToNodeID == "main" }) {
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
	if !reflect.DeepEqual(w.doc.Connections[:2], want) {
		t.Fatalf("asset must feed the script, preserving video outputs: %+v", w.doc.Connections)
	}
	for _, output := range []string{"completed", "pending"} {
		if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == "reference" && edge.ToNodeID == output }) {
			t.Fatalf("shot %s did not receive its material reference", output)
		}
	}
	before := agentJSON(w.doc.Connections)
	_, err = w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}})
	if err != nil || agentJSON(w.doc.Connections) != before {
		t.Fatal("repeated script edits duplicated asset inputs")
	}
}

func TestCanvasAgentScriptRemovingShotInvalidatesConfirmationAndItsEdges(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	initial := scriptAgentProject()
	result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": initial}})
	if err != nil || result["ok"] != true {
		t.Fatalf("initial script setup failed: %v %v", result, err)
	}
	w.doc.Connections = append(w.doc.Connections, CanvasConnection{ID: "storyboard-pending", FromNodeID: "old-shot", ToNodeID: "pending"})
	updated := scriptAgentProject()
	updated["shots"] = updated["shots"].([]any)[:1]
	result, err = w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": updated}})
	if err != nil || result["ok"] != true {
		t.Fatalf("shot removal failed: %v %v", result, err)
	}
	if w.node("main").ScriptProject.Confirmed {
		t.Fatal("removing a shot must invalidate script confirmation")
	}
	for _, edge := range w.doc.Connections {
		if edge.ToNodeID == "pending" && edge.FromNodeID == "main" {
			t.Fatalf("removed shot left a script output edge: %+v", edge)
		}
	}
	if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.ID == "storyboard-pending" }) {
		t.Fatal("removing a shot deleted an unrelated connection")
	}
	if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == "reference" && edge.ToNodeID == "pending" }) {
		t.Fatal("removing a shot changed the retained media's material inputs")
	}
}

func TestCanvasAgentScriptShotListChangesRequireConfirmation(t *testing.T) {
	for _, change := range []string{"unchanged", "reorder", "add"} {
		t.Run(change, func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()})
			if err != nil || result["ok"] != true {
				t.Fatalf("initial script setup failed: %v %v", result, err)
			}
			updated := scriptAgentProject()
			shots := updated["shots"].([]any)
			switch change {
			case "reorder":
				slices.Reverse(shots)
			case "add":
				updated["shots"] = append(shots, map[string]any{"id": "shot-3", "seconds": 5, "description": "He opens the door"})
			}
			result, err = w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": updated})
			if err != nil || result["ok"] != true {
				t.Fatalf("script edit failed: %v %v", result, err)
			}
			got := w.node("main").ScriptProject
			if got.Confirmed != (change == "unchanged") {
				t.Fatalf("unexpected confirmation after %s: %t", change, got.Confirmed)
			}
			for _, shot := range got.Shots {
				if shot.ImageOutdated || shot.VideoOutdated {
					t.Fatal("shot list edits must preserve unchanged shots' media freshness")
				}
			}
		})
	}
}

func TestCanvasAgentScriptConfirmsOnlyPersistedUnchangedDraft(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "main", Type: "script", Title: "Draft", Width: 550, Height: 600, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{}, Assets: []CanvasScriptAsset{}}}}
	input := map[string]any{"confirmed": true, "shots": []any{map[string]any{"id": "s1", "seconds": 15, "description": "A light turns on"}}, "assets": []any{}}
	update := func() {
		t.Helper()
		result, err := w.tool(map[string]any{"name": "update_script_node", "arguments": map[string]any{"nodeId": "main", "scriptProject": input}})
		if err != nil || result["ok"] != true {
			t.Fatalf("script update failed: %v %v", result, err)
		}
		if err := w.save(); err != nil {
			t.Fatal(err)
		}
	}
	update()
	if w.node("main").ScriptProject.Confirmed {
		t.Fatal("adding shots must invalidate confirmation even when the same update requests confirmation")
	}
	read, err := w.tool(map[string]any{"name": "get_node", "arguments": map[string]any{"nodeId": "main"}})
	if err != nil || agentMap(read["node"])["scriptProject"].(*CanvasScriptProject).Confirmed {
		t.Fatalf("reading the saved draft lost its unconfirmed state: %v %v", read, err)
	}
	update()
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || !saved.Nodes[0].ScriptProject.Confirmed || saved.Nodes[0].ScriptProject.Shots[0].QualityReview != nil || saved.Nodes[0].TaskID != "" || len(saved.Nodes) != 1 {
		t.Fatalf("confirmation must persist without creating media or approving quality: %v %v", saved, err)
	}
	input["shots"].([]any)[0].(map[string]any)["description"] = "A light turns off"
	update()
	if w.node("main").ScriptProject.Confirmed {
		t.Fatal("a later content edit must invalidate the saved confirmation")
	}
}

func TestCanvasAgentScriptConfirmationPreservesContentAndRejectsStaleReads(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "main", Type: "script", Title: "Draft", Prompt: "Full original story", Width: 550, Height: 600, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{{ID: "s1", Seconds: 15, Description: "Full action and staging", Sound: "Rain and quiet footsteps"}}, Assets: []CanvasScriptAsset{}}}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	before := cloneCanvasAgentDocument(w.doc)
	fingerprint := canvasScriptConfirmationFingerprint(*w.node("main"))
	args := map[string]any{"nodeId": "main", "confirmationFingerprint": fingerprint}
	result, err := w.tool(map[string]any{"name": "confirm_script_node", "arguments": args})
	if err != nil || result["ok"] != true || !w.node("main").ScriptProject.Confirmed {
		t.Fatalf("confirmation failed: %v %v", result, err)
	}
	before.Nodes[0].ScriptProject.Confirmed = true
	if !reflect.DeepEqual(before.Nodes, w.doc.Nodes) || w.node("main").ScriptProject.Shots[0].QualityReview != nil {
		t.Fatal("confirming changed authored content, media bindings or quality review")
	}
	w.node("main").ScriptProject.Shots[0].Description = "User changed the staging"
	w.node("main").ScriptProject.Confirmed = false
	before = cloneCanvasAgentDocument(w.doc)
	result, err = w.tool(map[string]any{"name": "confirm_script_node", "arguments": args})
	if err != nil || result["ok"] != false || !reflect.DeepEqual(before.Nodes, w.doc.Nodes) {
		t.Fatalf("stale confirmation changed the script: %v %v", result, err)
	}
}

func TestCanvasAgentScriptConfirmationRejectsConcurrentContentChangesAtSave(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "main", Type: "script", Title: "Draft", Width: 550, Height: 600, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{{ID: "s1", Seconds: 15, Description: "Original staging"}}, Assets: []CanvasScriptAsset{}}}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	fingerprint := canvasScriptConfirmationFingerprint(*w.node("main"))
	current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Nodes[0].ScriptProject.Shots[0].Description = "Concurrent user staging"
	if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
		t.Fatal(err)
	}
	result, err := w.tool(map[string]any{"name": "confirm_script_node", "arguments": map[string]any{"nodeId": "main", "confirmationFingerprint": fingerprint}})
	if err != nil || result["ok"] != false {
		t.Fatalf("stale confirmation was accepted: %v %v", result, err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || saved.Nodes[0].ScriptProject.Confirmed || saved.Nodes[0].ScriptProject.Shots[0].Description != "Concurrent user staging" {
		t.Fatalf("save confirmed unseen content or lost the concurrent edit: %+v %v", saved.Nodes, err)
	}
}

func TestCanvasAgentScriptUnbindingOutputPreservesSharedReferences(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(fmt.Sprintf("shared-%t", shared), func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			project := scriptAgentProject()
			if shared {
				project["shots"].([]any)[1].(map[string]any)["video_node_id"] = "completed"
			}
			result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": project})
			if err != nil || result["ok"] != true {
				t.Fatalf("initial script setup failed: %v %v", result, err)
			}
			project["shots"].([]any)[0].(map[string]any)["video_node_id"] = ""
			result, err = w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": project})
			if err != nil || result["ok"] != true {
				t.Fatalf("unbinding output failed: %v %v", result, err)
			}
			connected := slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool {
				return edge.FromNodeID == "main" && edge.ToNodeID == "completed"
			})
			if connected != shared {
				t.Fatalf("output edge must follow remaining shot references: connected=%t shared=%t", connected, shared)
			}
			if w.node("completed").URL != "/videos/completed.mp4" || w.node("completed").TaskID != "original-completed-task" {
				t.Fatal("unbinding a shot must preserve the generated media")
			}
		})
	}
}

func TestCanvasAgentScriptSharedOutputKeepsAllMaterialInputs(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	var project CanvasScriptProject
	if err := json.Unmarshal([]byte(agentJSON(scriptAgentProject())), &project); err != nil {
		t.Fatal(err)
	}
	project.Assets = append(project.Assets, CanvasScriptAsset{ID: "room", Kind: "scene", Name: "Room", ImageNodeID: "room-reference"})
	project.Shots[0].VideoNodeID = "pending"
	project.Shots[1].VideoNodeID = "pending"
	project.Shots[1].AssetIDs = []string{"room"}
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "room-reference", Type: "image", URL: "/images/room.png"})
	w.doc.Nodes[0].Type, w.doc.Nodes[0].ScriptProject = "script", &project
	w.doc.Connections = []CanvasConnection{
		{ID: "script-output", FromNodeID: "main", ToNodeID: "pending"},
		{ID: "hero-input", FromNodeID: "reference", ToNodeID: "pending"},
		{ID: "room-input", FromNodeID: "room-reference", ToNodeID: "pending"},
	}

	args := scriptAgentProject()
	args["assets"] = append(args["assets"].([]any), map[string]any{"id": "room", "kind": "scene", "name": "Room", "image_node_id": "room-reference"})
	args["shots"].([]any)[0].(map[string]any)["video_node_id"] = "pending"
	args["shots"].([]any)[1].(map[string]any)["video_node_id"] = "pending"
	args["shots"].([]any)[1].(map[string]any)["asset_ids"] = []string{"room"}
	result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": args})
	if err != nil || result["ok"] != true {
		t.Fatalf("shared-output script update failed: %v %v", result, err)
	}
	for _, input := range []string{"reference", "room-reference"} {
		if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == input && edge.ToNodeID == "pending" }) {
			t.Fatalf("shared output lost material input %s: %+v", input, w.doc.Connections)
		}
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
			if !reflect.DeepEqual(w.doc.Connections[:len(want)], want) {
				t.Fatalf("stale asset edge or missing shot output: %+v", w.doc.Connections)
			}
			if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == "main" && edge.ToNodeID == "pending" }) {
				t.Fatal("pending video output was not connected to the script")
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
	}, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
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

func scriptGenerationWorker(t *testing.T) *canvasAgentWorker {
	t.Helper()
	w := memoryWorker(t, nil)
	w.req.Generation["autoGenerateMedia"] = false
	w.req.Generation["videoModel"] = "video-test"
	w.req.Generation["capabilities"].(map[string]any)["video"] = map[string]any{"sizes": []string{"16:9"}, "audioControl": "toggle"}
	w.doc.Nodes = []CanvasNode{{ID: "script", Type: "script", Width: 550, Height: 600, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Confirmed: true, Assets: []CanvasScriptAsset{{ID: "hero", Kind: "character", Name: "Hero"}},
			Shots: []CanvasScriptShot{{ID: "shot", Seconds: 5, Description: "Hero opens the door", AssetIDs: []string{"hero"}, Dialogue: []CanvasScriptDialogue{}}}}}}
	return w
}

func TestCanvasAgentScriptGenerationBindsBeforeSubmission(t *testing.T) {
	w := scriptGenerationWorker(t)
	result, err := w.tool(map[string]any{"name": "generate_image", "arguments": map[string]any{
		"prompt": "Hero reference", "size": "1:1", "count": 1, "scriptNodeId": "script", "assetId": "hero"}})
	if err != nil || result["ok"] != true {
		t.Fatalf("asset creation failed: %v %v", result, err)
	}
	id, _ := result["nodeId"].(string)
	if id == "" || w.node("script").ScriptProject.Assets[0].ImageNodeID != id {
		t.Fatalf("created image was not bound to script asset: %v", result)
	}
	if w.node("script").ScriptProject.Shots[0].ImageOutdated {
		t.Fatal("newly bound replacement image must clear the outdated state")
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || saved.Nodes[0].ScriptProject.Assets[0].ImageNodeID != id {
		t.Fatalf("asset binding was not saved with node: %v", err)
	}
	image := w.node(id)
	if image.X+image.Width >= w.node("script").X || image.Y != w.node("script").Y || image.URL != "" {
		t.Fatalf("pending material must be visible on the script input side: %+v", image)
	}
	if len(saved.Nodes) != 2 || saved.Nodes[1].X != image.X || len(saved.Connections) != 1 || saved.Connections[0].FromNodeID != id || saved.Connections[0].ToNodeID != "script" {
		t.Fatalf("pending material and its input edge were not saved before generation: %+v", saved)
	}
	before := agentJSON(w.doc)
	duplicate, err := w.tool(map[string]any{"name": "generate_image", "arguments": map[string]any{
		"prompt": "Hero reference", "size": "1:1", "count": 1, "scriptNodeId": "script", "assetId": "hero"}})
	if err != nil || duplicate["ok"] != false || agentJSON(w.doc) != before {
		t.Fatalf("duplicate asset silently replaced binding: %v %v", duplicate, err)
	}
	result, err = w.tool(map[string]any{"name": "generate_video", "arguments": map[string]any{
		"prompt": "Hero opens the door", "size": "16:9", "seconds": 5, "generateAudio": false, "scriptNodeId": "script", "shotId": "shot"}})
	if err != nil || result["ok"] != true {
		t.Fatalf("shot creation failed: %v %v", result, err)
	}
	shot := w.node("script").ScriptProject.Shots[0]
	if shot.VideoNodeID != result["nodeId"] || shot.VideoPrompt != "Hero opens the door" {
		t.Fatalf("shot binding or prompt missing: %+v", shot)
	}
	w.req.Generation["autoGenerateMedia"] = true
	job, blocked, err := w.prepareGeneration(shot.VideoNodeID)
	if err != nil || job != nil || blocked["code"] != "script_assets_not_ready" || w.node(shot.VideoNodeID).TaskID != "" {
		t.Fatalf("shot submitted without its reference: %v %v", blocked, err)
	}
	w.node(id).URL, w.node(id).GenerationStatus = "/images/hero.png", "success"
	job, blocked, err = w.prepareGeneration(shot.VideoNodeID)
	if err != nil || job == nil || len(job.node.GenerationVideoReferenceImages) != 1 || job.node.GenerationVideoReferenceImages[0] != "/images/hero.png" {
		t.Fatalf("ready asset was not used by video: %v %v", blocked, err)
	}
}

func TestCanvasAgentScriptReplacementMediaClearsOutdatedFlag(t *testing.T) {
	w := scriptGenerationWorker(t)
	shot := &w.node("script").ScriptProject.Shots[0]
	shot.VideoOutdated = true
	id := "replacement-video"
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: id, Type: "video", Width: 240, Height: 360, ScaleX: 1, ScaleY: 1})
	w.bindScriptNode(canvasAgentScriptBinding{ScriptNodeID: "script", ShotID: shot.ID}, *w.node(id))
	if got := w.node("script").ScriptProject.Shots[0]; got.VideoNodeID != id || got.VideoOutdated {
		t.Fatalf("replacement media retained stale state: %+v", got)
	}
}

func TestCanvasAgentScriptVideoUsesStoryboardBeforeMaterialImages(t *testing.T) {
	w := scriptGenerationWorker(t)
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "hero", Type: "image", URL: "/hero.png"}, CanvasNode{ID: "board", Type: "image", URL: "/board.png"}, CanvasNode{ID: "video", Type: "video"})
	project := w.node("script").ScriptProject
	project.Assets[0].ImageNodeID = "hero"
	project.Shots[0].ImageNodeID = "board"
	project.Shots[0].VideoNodeID = "video"
	w.node("video").GenerationVideoSize = "16:9"
	w.node("video").GenerationVideoSeconds = 5
	audio := false
	w.node("video").GenerationVideoAudio = &audio
	if result := w.prepareScriptGeneration("video"); result != nil {
		t.Fatalf("unexpected rejection: %v", result)
	}
	if !slices.Equal(w.node("video").GenerationVideoReferenceImages, []string{"/board.png", "/hero.png"}) {
		t.Fatalf("wrong reference order: %v", w.node("video").GenerationVideoReferenceImages)
	}
}

func TestCanvasAgentScriptGenerationRejectsInvalidBinding(t *testing.T) {
	for name, args := range map[string]map[string]any{
		"unknown asset":  {"scriptNodeId": "script", "assetId": "missing"},
		"unknown shot":   {"scriptNodeId": "script", "shotId": "missing"},
		"both":           {"scriptNodeId": "script", "assetId": "hero", "shotId": "shot"},
		"no script":      {"assetId": "hero"},
		"unbound source": {"sourceNodeIds": []string{"script"}},
	} {
		t.Run(name, func(t *testing.T) {
			w := scriptGenerationWorker(t)
			args["prompt"], args["size"], args["count"] = "Reference", "1:1", 1
			before := agentJSON(w.doc)
			result, err := w.tool(map[string]any{"name": "generate_image", "arguments": args})
			if err != nil || result["ok"] != false || agentJSON(w.doc) != before {
				t.Fatalf("invalid binding created orphan media: %v %v", result, err)
			}
		})
	}
}

func TestCanvasAgentScriptWorkflowBindsAtomically(t *testing.T) {
	w := scriptGenerationWorker(t)
	steps := []map[string]any{
		{"key": "hero", "type": "image", "title": "Hero", "prompt": "Hero reference", "size": "1:1", "count": 1, "scriptNodeId": "script", "assetId": "hero"},
		{"key": "shot", "type": "video", "title": "Shot", "prompt": "Hero opens the door", "size": "16:9", "seconds": 5, "generateAudio": false, "dependsOn": []string{"hero"}, "scriptNodeId": "script", "shotId": "shot"},
	}
	steps[1]["shotId"] = "missing"
	before := agentJSON(w.doc)
	result, err := w.createCanvasWorkflow(steps)
	if err == nil && result["ok"] != false || agentJSON(w.doc) != before {
		t.Fatalf("invalid workflow left partial script bindings: %v %v", result, err)
	}
	steps[1]["shotId"] = "shot"
	result, err = w.createCanvasWorkflow(steps)
	if err != nil || result["ok"] != true {
		t.Fatalf("workflow creation failed: %v %v", result, err)
	}
	ids := agentStrings(result["nodeIds"])
	project := w.node("script").ScriptProject
	if project.Assets[0].ImageNodeID != ids[0] || project.Shots[0].VideoNodeID != ids[1] || project.Shots[0].VideoPrompt != "Hero opens the door" {
		t.Fatalf("workflow did not populate script: %+v", project)
	}
	image := w.node(ids[0])
	returned := result["nodes"].([]CanvasNode)
	if image.X+image.Width >= w.node("script").X || returned[0].X != image.X || returned[0].Y != image.Y {
		t.Fatalf("workflow material must be placed and returned on the input side: %+v", returned)
	}
}

func TestCanvasAgentScriptWorkflowWaitsForAssets(t *testing.T) {
	w := scriptGenerationWorker(t)
	// Script input edges must enforce dependencies even without a manual dependsOn.
	result, err := w.createCanvasWorkflow([]map[string]any{
		{"key": "hero", "type": "image", "title": "Hero", "prompt": "Hero reference", "size": "1:1", "count": 1, "scriptNodeId": "script", "assetId": "hero"},
		{"key": "shot", "type": "video", "title": "Shot", "prompt": "Hero opens the door", "size": "16:9", "seconds": 5, "generateAudio": false, "scriptNodeId": "script", "shotId": "shot"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := agentStrings(result["nodeIds"])
	var generated []string
	w.service.media = func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		if node.Type == "video" && (len(node.GenerationVideoReferenceImages) != 1 || node.GenerationVideoReferenceImages[0] != "/images/hero.png") {
			t.Error("video submitted before its asset image was ready")
		}
		generated = append(generated, node.Type)
		url := "/images/hero.png"
		if node.Type == "video" {
			url = "/videos/shot.mp4"
		}
		return map[string]any{"data": []any{map[string]any{"url": url}}}, nil
	}
	w.req.Generation["autoGenerateMedia"] = true
	result, err = w.runCanvasWorkflow(ids)
	if err != nil || result["ok"] != true || !reflect.DeepEqual(generated, []string{"image", "video"}) {
		t.Fatalf("script workflow failed: %v %v generated=%v", result, err, generated)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || saved.Nodes[0].ScriptProject.Assets[0].ImageNodeID != ids[0] || saved.Nodes[0].ScriptProject.Shots[0].VideoNodeID != ids[1] {
		t.Fatalf("completed script bindings were not persisted: %v", err)
	}
	result, err = w.runCanvasWorkflow(ids)
	if err != nil || result["ok"] != true || len(generated) != 2 {
		t.Fatalf("completed workflow regenerated media: %v %v", result, err)
	}
}

func TestCanvasAgentScriptGenerationChecksReadinessWithoutSubmitting(t *testing.T) {
	for _, status := range []string{"loading", "error", "unconfirmed", "unbound"} {
		t.Run(status, func(t *testing.T) {
			w := scriptGenerationWorker(t)
			project := w.node("script").ScriptProject
			project.Assets[0].ImageNodeID = "hero-image"
			project.Shots[0].VideoNodeID = "video"
			if status == "unconfirmed" {
				project.Confirmed = false
			}
			if status == "unbound" {
				project.Shots[0].VideoNodeID = ""
			}
			w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "hero-image", Type: "image", URL: "/images/hero.png", GenerationStatus: status},
				CanvasNode{ID: "video", Type: "video", GenerationVideoModel: "video-test"})
			w.doc.Connections = []CanvasConnection{{ID: "edge", FromNodeID: "script", ToNodeID: "video"}}
			w.req.Generation["autoGenerateMedia"] = true
			before := agentJSON(w.doc)
			job, result, err := w.prepareGeneration("video")
			if err != nil || job != nil || result["ok"] != false || agentJSON(w.doc) != before {
				t.Fatalf("invalid script readiness submitted media or changed task: %v %v", result, err)
			}
		})
	}
}

func TestCanvasAgentScriptPendingMaterialsAvoidExistingNodes(t *testing.T) {
	w := scriptGenerationWorker(t)
	script := w.node("script")
	script.X, script.Y = 600, 80
	script.ScriptProject.Assets = append(script.ScriptProject.Assets, CanvasScriptAsset{ID: "scene", Kind: "scene", Name: "Room"})
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "occupied", Type: "image", X: 120, Y: 80, Width: 360, Height: 480, ScaleX: 1, ScaleY: 1})
	result, err := w.createCanvasWorkflow([]map[string]any{
		{"key": "hero", "type": "image", "prompt": "Hero reference", "size": "1:1", "count": 1, "scriptNodeId": "script", "assetId": "hero"},
		{"key": "scene", "type": "image", "prompt": "Room reference", "size": "9:16", "count": 1, "scriptNodeId": "script", "assetId": "scene"},
	})
	if err != nil || result["ok"] != true {
		t.Fatalf("material workflow creation failed: %v %v", result, err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || len(saved.Nodes) != 4 {
		t.Fatalf("pending material nodes were not persisted: %+v %v", saved, err)
	}
	for _, id := range agentStrings(result["nodeIds"]) {
		material := w.node(id)
		if material.URL != "" || material.TaskID != "" || material.X+material.Width >= 600 {
			t.Fatalf("pending material is missing or placed as an output: %+v", material)
		}
		for _, other := range w.doc.Nodes {
			if other.ID == id || other.Type == "group" {
				continue
			}
			if material.X < other.X+other.Width && material.X+material.Width > other.X && material.Y < other.Y+other.Height && material.Y+material.Height > other.Y {
				t.Fatalf("%s overlaps %s", id, other.ID)
			}
		}
	}
}

func TestCanvasAgentScriptEditsInvalidateOnlyRetainedMedia(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	var project CanvasScriptProject
	if err := json.Unmarshal([]byte(agentJSON(scriptAgentProject())), &project); err != nil {
		t.Fatal(err)
	}
	w.doc.Nodes[0].Type, w.doc.Nodes[0].ScriptProject = "script", &project
	args := scriptAgentProject()
	args["shots"].([]any)[0].(map[string]any)["description"] = "Changed scene"
	result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": args})
	got := w.node("main").ScriptProject
	if err != nil || result["ok"] != true || got.Confirmed || !got.Shots[0].VideoOutdated || got.Shots[1].VideoOutdated || got.Shots[0].VideoNodeID != "completed" {
		t.Fatalf("content changes must retain and invalidate only the affected result: %+v %v %v", got, result, err)
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || !saved.Nodes[0].ScriptProject.Shots[0].VideoOutdated {
		t.Fatalf("outdated state did not survive save: %v", err)
	}
	if !reflect.DeepEqual(w.doc.Nodes[1:], scriptAgentNodes()[1:]) {
		t.Fatal("editing script changed saved media or tasks")
	}
}

func TestCanvasAgentScriptDialogueChangesUseContent(t *testing.T) {
	for _, change := range []string{"id", "text", "kind", "asset", "remove", "order"} {
		t.Run(change, func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			var project CanvasScriptProject
			if err := json.Unmarshal([]byte(agentJSON(scriptAgentProject())), &project); err != nil {
				t.Fatal(err)
			}
			project.Shots[0].Dialogue = []CanvasScriptDialogue{{ID: "line-1", Kind: "dialogue", AssetID: "hero", Text: "Hello"}, {ID: "line-2", Kind: "narration", Text: "He pauses"}}
			project.Shots[0].ImagePrompt, project.Shots[0].VideoPrompt = "Image", "Video"
			w.doc.Nodes[0].Type, w.doc.Nodes[0].ScriptProject = "script", &project
			updated := cloneCanvasAgentDocument(w.doc).Nodes[0].ScriptProject
			switch change {
			case "id":
				updated.Shots[0].Dialogue[0].ID = "new-line-id"
			case "text":
				updated.Shots[0].Dialogue[0].Text = "Goodbye"
			case "kind":
				updated.Shots[0].Dialogue[0].Kind = "narration"
			case "asset":
				updated.Shots[0].Dialogue[0].AssetID = ""
			case "remove":
				updated.Shots[0].Dialogue = nil
			case "order":
				slices.Reverse(updated.Shots[0].Dialogue)
			}
			var input map[string]any
			if err := json.Unmarshal([]byte(agentJSON(updated)), &input); err != nil {
				t.Fatal(err)
			}
			result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": input})
			if err != nil || result["ok"] != true {
				t.Fatalf("dialogue edit failed: %v %v", result, err)
			}
			got := w.node("main").ScriptProject
			identityOnly := change == "id"
			if got.Confirmed != identityOnly || got.Shots[0].VideoOutdated == identityOnly || got.Shots[0].VideoPrompt != "Video" || got.Shots[0].VideoPromptOutdated == identityOnly {
				t.Fatalf("dialogue freshness must follow content: %+v", got.Shots[0])
			}
			if got.Shots[1].VideoOutdated || got.Shots[0].VideoNodeID != "completed" {
				t.Fatal("dialogue edit changed unrelated media or detached the retained video")
			}
		})
	}
}

func TestCanvasAgentScriptReplacesMaterialReferences(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	var project CanvasScriptProject
	if err := json.Unmarshal([]byte(agentJSON(scriptAgentProject())), &project); err != nil {
		t.Fatal(err)
	}
	w.doc.Nodes[0].Type, w.doc.Nodes[0].ScriptProject = "script", &project
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "new-reference", Type: "image", URL: "/images/new.png"})
	w.doc.Connections = []CanvasConnection{{ID: "old", FromNodeID: "reference", ToNodeID: "pending"}}
	args := scriptAgentProject()
	args["assets"].([]any)[0].(map[string]any)["image_node_id"] = "new-reference"
	result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": args})
	if err != nil || result["ok"] != true {
		t.Fatalf("replacing material failed: %v %v", result, err)
	}
	var hasNew bool
	for _, edge := range w.doc.Connections {
		if edge.ToNodeID == "pending" {
			if edge.FromNodeID == "reference" {
				t.Fatal("old material still feeds the shot")
			}
			hasNew = hasNew || edge.FromNodeID == "new-reference"
		}
	}
	if !hasNew || !w.node("main").ScriptProject.Shots[1].VideoOutdated {
		t.Fatal("new material did not replace the old shot reference and invalidate its media")
	}
}

func TestCanvasAgentScriptDialogueReferencesRequireReadyMaterials(t *testing.T) {
	w := scriptGenerationWorker(t)
	shot := &w.node("script").ScriptProject.Shots[0]
	shot.AssetIDs = nil
	shot.Dialogue = []CanvasScriptDialogue{{ID: "line", Kind: "dialogue", AssetID: "hero", Text: "Hello"}}
	result, err := w.tool(map[string]any{"name": "generate_video", "arguments": map[string]any{"prompt": "Dialogue", "size": "16:9", "seconds": 5, "generateAudio": false, "scriptNodeId": "script", "shotId": "shot"}})
	if err != nil || result["ok"] != true {
		t.Fatalf("video creation failed: %v %v", result, err)
	}
	w.req.Generation["autoGenerateMedia"] = true
	job, blocked, err := w.prepareGeneration(result["nodeId"].(string))
	if err != nil || job != nil || blocked["code"] != "script_assets_not_ready" {
		t.Fatalf("dialogue-only reference submitted without material: %v %v", blocked, err)
	}
}

func TestCanvasAgentScriptDeletionDetachesMedia(t *testing.T) {
	w := scriptGenerationWorker(t)
	script := w.node("script")
	script.ScriptProject.Shots[0].VideoNodeID = "video"
	script.ScriptProject.MergedVideoNodeID, script.ScriptProject.MergedVideoFingerprint = "video", "fingerprint"
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "video", Type: "video"})
	result := w.deleteNode("video")
	got := w.node("script").ScriptProject
	if result["ok"] != true || got.Shots[0].VideoNodeID != "" || got.MergedVideoNodeID != "" || got.MergedVideoFingerprint != "" {
		t.Fatalf("deletion left dangling references: %+v", got)
	}
}

func TestCanvasScriptDependenciesRetainPromptsAndReplaceFrameInput(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	if _, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}); err != nil {
		t.Fatal(err)
	}
	w.node("main").ScriptProject.Shots[0].ImagePrompt = "authored image"
	w.node("main").ScriptProject.Shots[0].VideoPrompt = "authored video"
	w.node("main").ScriptProject.MergedVideoNodeID = "movie"
	previous := cloneCanvasAgentDocument(w.doc)
	input := scriptAgentProject()
	input["shots"].([]any)[0].(map[string]any)["description"] = "New scene"
	if result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": input}); err != nil || result["ok"] != true {
		t.Fatalf("edit: %v %v", result, err)
	}
	project := w.node("main").ScriptProject
	if project.Shots[0].ImagePrompt != "authored image" || project.Shots[0].VideoPrompt != "authored video" || !project.Shots[0].VideoPromptOutdated || !project.MergedVideoOutdated {
		t.Fatalf("lost prompts or freshness: %+v", project)
	}
	next := cloneCanvasAgentDocument(previous)
	next.Nodes = append(next.Nodes, CanvasNode{ID: "new-frame", Type: "image", URL: "/new.png"})
	next.Nodes[0].ScriptProject.Shots[0].ImageNodeID = "new-frame"
	next.Nodes[0].ScriptProject.Shots[0].AssetIDs = nil
	reconcileCanvasScriptDependencies(previous, &next)
	if !next.Nodes[0].ScriptProject.Shots[0].VideoOutdated || !next.Nodes[0].ScriptProject.MergedVideoOutdated {
		t.Fatal("frame change left clip or movie fresh")
	}
	for _, edge := range next.Connections {
		if edge.FromNodeID == "reference" && edge.ToNodeID == "completed" {
			t.Fatal("stale frame reference retained")
		}
	}
	if !slices.ContainsFunc(next.Connections, func(e CanvasConnection) bool { return e.FromNodeID == "new-frame" && e.ToNodeID == "completed" }) {
		t.Fatal("new frame not connected")
	}
	first := agentJSON(next)
	reconcileCanvasScriptDependencies(next, &next)
	if agentJSON(next) != first {
		t.Fatal("dependency reconciliation is not idempotent")
	}
	if previous.Nodes[0].ScriptProject.Shots[0].VideoOutdated {
		t.Fatal("mutated source snapshot")
	}
}

func TestCanvasScriptReferencesFollowReplacements(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		for _, regenerate := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/regenerate=%t", kind, regenerate), func(t *testing.T) {
				shot := CanvasScriptShot{ID: "shot", AssetIDs: []string{"scene"}, ImageNodeID: "board", VideoNodeID: "clip"}
				previous := CanvasDocument{Nodes: []CanvasNode{
					{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Assets: []CanvasScriptAsset{{ID: "scene", ImageNodeID: "old-scene"}}, Shots: []CanvasScriptShot{shot}}},
					{ID: "old-scene", Type: "image", URL: "/old-scene.png"},
					{ID: "new-scene", Type: "image", URL: "/new-scene.png"},
					{ID: "board", Type: "image", URL: "/board.png", GenerationReferenceURLs: []string{"/old-scene.png", "/extra.png"}},
					{ID: "new-board", Type: "image", URL: "/new-board.png"},
					{ID: "clip", Type: "video", GenerationVideoReferenceImages: []string{"/board.png", "/old-scene.png", "/extra.png"}, GenerationVideoFirstFrameNodeID: "board"},
				}}
				next := cloneCanvasAgentDocument(previous)
				next.Nodes[0].ScriptProject.Assets[0].ImageNodeID = "new-scene"
				outputID := "board"
				if kind == "video" {
					outputID = "clip"
					next.Nodes[0].ScriptProject.Shots[0].ImageNodeID = "new-board"
				}
				if regenerate {
					for _, node := range next.Nodes {
						if node.ID == outputID {
							node.ID = "new-output"
							next.Nodes = append(next.Nodes, node)
							break
						}
					}
					if kind == "image" {
						next.Nodes[0].ScriptProject.Shots[0].ImageNodeID = "new-output"
					} else {
						next.Nodes[0].ScriptProject.Shots[0].VideoNodeID = "new-output"
					}
					outputID = "new-output"
				}
				reconcileCanvasScriptDependencies(previous, &next)
				node := next.Nodes[slices.IndexFunc(next.Nodes, func(n CanvasNode) bool { return n.ID == outputID })]
				if kind == "image" {
					if !slices.Equal(node.GenerationReferenceURLs, []string{"/new-scene.png", "/extra.png"}) {
						t.Fatalf("wrong image references: %v", node.GenerationReferenceURLs)
					}
				} else if !slices.Equal(node.GenerationVideoReferenceImages, []string{"/new-board.png", "/new-scene.png", "/extra.png"}) || node.GenerationVideoFirstFrameNodeID != "new-board" {
					t.Fatalf("wrong video references: %+v", node)
				}
				first := agentJSON(next)
				reconcileCanvasScriptDependencies(next, &next)
				if agentJSON(next) != first {
					t.Fatal("reference reconciliation is not idempotent")
				}
				if previous.Nodes[5].GenerationVideoFirstFrameNodeID != "board" {
					t.Fatal("mutated previous document")
				}
			})
		}
	}
}

func TestCanvasScriptSharedReferenceSlotsRetainRemainingRoles(t *testing.T) {
	previous := CanvasDocument{Nodes: []CanvasNode{
		{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Assets: []CanvasScriptAsset{{ID: "hero", ImageNodeID: "old"}, {ID: "scene", ImageNodeID: "old"}}, Shots: []CanvasScriptShot{{ID: "one", AssetIDs: []string{"hero"}, VideoNodeID: "video"}, {ID: "two", AssetIDs: []string{"scene"}, VideoNodeID: "video"}}}},
		{ID: "old", Type: "image", URL: "/old.png"}, {ID: "new", Type: "image", URL: "/new.png"},
		{ID: "video", Type: "video", GenerationVideoReferenceImages: []string{"/old.png", "/extra.png"}},
	}}
	next := cloneCanvasAgentDocument(previous)
	next.Nodes[0].ScriptProject.Assets[0].ImageNodeID = "new"
	reconcileCanvasScriptDependencies(previous, &next)
	if !slices.Equal(next.Nodes[3].GenerationVideoReferenceImages, []string{"/new.png", "/old.png", "/extra.png"}) {
		t.Fatalf("lost shared role: %v", next.Nodes[3].GenerationVideoReferenceImages)
	}
	next.Nodes[1].URL = "/replacement.png"
	old := cloneCanvasAgentDocument(next)
	old.Nodes[1].URL = "/old.png"
	reconcileCanvasScriptDependencies(old, &next)
	if !slices.Equal(next.Nodes[3].GenerationVideoReferenceImages, []string{"/new.png", "/replacement.png", "/extra.png"}) {
		t.Fatalf("lost in-place replacement: %v", next.Nodes[3].GenerationVideoReferenceImages)
	}
}

func TestCanvasScriptDependenciesInPlaceMediaReplacement(t *testing.T) {
	for _, change := range []string{"layout", "url", "prompt", "first-result"} {
		t.Run(change, func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			if _, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}); err != nil {
				t.Fatal(err)
			}
			w.node("main").ScriptProject.MergedVideoNodeID = "movie"
			if change == "first-result" {
				w.node("completed").URL = ""
				w.node("completed").TaskID = ""
				w.node("completed").GenerationStatus = "idle"
			}
			previous := cloneCanvasAgentDocument(w.doc)
			switch change {
			case "layout":
				w.node("reference").X += 100
			case "url", "first-result":
				w.node("reference").URL = "/replacement.png"
			case "prompt":
				w.node("reference").Prompt = "different costume"
			}
			reconcileCanvasScriptDependencies(previous, &w.doc)
			got := w.node("main").ScriptProject.Shots[0]
			want := change != "layout" && change != "first-result"
			if got.VideoOutdated != want {
				t.Fatalf("clip freshness after %s: %+v", change, got)
			}
		})
	}
}

func TestCanvasScriptEditingUnsubmittedMediaDoesNotRequireReplacement(t *testing.T) {
	for _, status := range []string{"idle", "loading", "error", "success"} {
		t.Run(status, func(t *testing.T) {
			project := &CanvasScriptProject{Confirmed: true, Shots: []CanvasScriptShot{{ID: "shot", Description: "Before", ImageNodeID: "frame", VideoNodeID: "clip", ImagePrompt: "Frame", VideoPrompt: "Clip"}}}
			previous := CanvasDocument{Nodes: []CanvasNode{{ID: "script", Type: "script", ScriptProject: project}, {ID: "frame", Type: "image", GenerationStatus: status}, {ID: "clip", Type: "video", GenerationStatus: status}}}
			if status == "error" {
				previous.Nodes[1].TaskID, previous.Nodes[2].TaskID = "image-task", "video-task"
			}
			next := cloneCanvasAgentDocument(previous)
			next.Nodes[0].ScriptProject.Shots[0].Description = "After"
			reconcileCanvasScriptDependencies(previous, &next)
			got := next.Nodes[0].ScriptProject.Shots[0]
			if got.ImageOutdated != (status != "idle") || got.VideoOutdated != (status != "idle") {
				t.Fatalf("media freshness after editing %s nodes: %+v", status, got)
			}
			if next.Nodes[0].ScriptProject.Confirmed || !got.ImagePromptOutdated || !got.VideoPromptOutdated {
				t.Fatal("editing must still require script and prompt review")
			}
		})
	}
}

func TestCanvasScriptSaveBoundaryInvalidatesDependenciesWithoutDiscardingMedia(t *testing.T) {
	for _, change := range []string{"layout", "url", "prompt"} {
		t.Run(change, func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.doc.Nodes = scriptAgentNodes()
			if result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}); err != nil || result["ok"] != true {
				t.Fatal(result, err)
			}
			w.node("main").ScriptProject.Shots[0].ImagePrompt = "Authored frame"
			w.node("main").ScriptProject.Shots[0].VideoPrompt = "Authored clip"
			w.node("main").ScriptProject.MergedVideoNodeID = "movie"
			movie := *w.node("completed")
			movie.ID, movie.TaskID, movie.URL = "movie", "", "/movie.mp4"
			w.doc.Nodes = append(w.doc.Nodes, movie)
			initial, err := w.service.canvas.SaveAtRevision(w.identity.ID, w.doc)
			if err != nil {
				t.Fatal(err)
			}
			w.doc = initial
			input := cloneCanvasAgentDocument(w.doc)
			for i := range input.Nodes {
				if input.Nodes[i].ID != "reference" {
					continue
				}
				switch change {
				case "layout":
					input.Nodes[i].X += 100
				case "url":
					input.Nodes[i].URL = "/replacement.png"
				case "prompt":
					input.Nodes[i].Prompt = "Different wardrobe"
				}
			}
			saved, err := w.service.canvas.SaveAtRevision(w.identity.ID, input)
			if err != nil {
				t.Fatal(err)
			}
			project := saved.Nodes[0].ScriptProject
			if project.Shots[0].VideoOutdated != (change != "layout") || project.MergedVideoOutdated != (change != "layout") {
				t.Fatalf("save lost dependency freshness after %s: %+v", change, project)
			}
			if project.Shots[0].ImagePrompt != "Authored frame" || project.Shots[0].VideoPrompt != "Authored clip" || saved.Nodes[3].URL != w.doc.Nodes[3].URL || saved.Nodes[3].TaskID != w.doc.Nodes[3].TaskID {
				t.Fatal("save discarded authored prompts or existing task results")
			}
		})
	}
}

func TestCanvasScriptAgentCannotAuthorHumanQualityReview(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	input := scriptAgentProject()
	forged := map[string]any{"media_url": "/videos/completed.mp4", "continuity": "passed", "dialogue": "passed", "speaker": "passed", "lip_sync": "passed", "text_on_screen": "passed", "notes": "Forged approval"}
	input["shots"].([]any)[0].(map[string]any)["quality_review"] = forged
	result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": input})
	if err != nil || result["ok"] != true || w.node("main").ScriptProject.Shots[0].QualityReview != nil {
		t.Fatal("agent authored a human quality approval", result, err)
	}
	review := &CanvasScriptQualityReview{MediaURL: "/videos/completed.mp4", Continuity: "needs_fix", Dialogue: "unchecked", Speaker: "unchecked", LipSync: "unchecked", Notes: "Wardrobe mismatch"}
	w.node("main").ScriptProject.Shots[0].QualityReview = review
	result, err = w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": input})
	if err != nil || result["ok"] != true || !reflect.DeepEqual(w.node("main").ScriptProject.Shots[0].QualityReview, review) {
		t.Fatal("agent replaced the existing human review", result, err)
	}
	invalid := *review
	invalid.TextOnScreen = "pretend_passed"
	w.node("main").ScriptProject.Shots[0].QualityReview = &invalid
	if err := validateCanvasScript(*w.node("main")); err == nil {
		t.Fatal("invalid quality status accepted")
	}
}

func TestCanvasScriptImportPreservesReviewMediaAndConversation(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = scriptAgentNodes()
	if result, err := w.scriptTool("update_script_node", map[string]any{"nodeId": "main", "scriptProject": scriptAgentProject()}); err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	project := w.node("main").ScriptProject
	project.Shots[0].ImagePromptOutdated = true
	project.Shots[0].QualityReview = &CanvasScriptQualityReview{MediaURL: "/videos/completed.mp4", Continuity: "needs_fix", Dialogue: "unchecked", Speaker: "unchecked", LipSync: "unchecked", TextOnScreen: "needs_fix", Notes: "Review retained"}
	audio := true
	w.node("completed").MediaMetadata = &CanvasMediaMetadata{Width: 768, Height: 1376, DurationMS: 5020, HasAudio: &audio}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(w.doc)
	if err != nil {
		t.Fatal(err)
	}
	var exported CanvasDocument
	if err := json.Unmarshal(data, &exported); err != nil {
		t.Fatal(err)
	}
	result, err := w.service.canvas.Import(w.identity.ID, exported)
	if err != nil {
		t.Fatal(err)
	}
	got := result.Document
	if got.ID == w.doc.ID || got.AgentRun != nil || !reflect.DeepEqual(got.Nodes[0].ScriptProject, w.doc.Nodes[0].ScriptProject) || !reflect.DeepEqual(got.Nodes[3].MediaMetadata, w.doc.Nodes[3].MediaMetadata) {
		t.Fatal("import lost freshness, review or actual media measurements")
	}
	if string(got.AgentSessions) != string(w.doc.AgentSessions) || got.ActiveAgentSessionID != w.doc.ActiveAgentSessionID {
		t.Fatal("import lost conversation history")
	}
}

func TestCanvasScriptProductionLayoutPairsShotsAndPreservesUnselectedNodes(t *testing.T) {
	script := &CanvasNode{ID: "script", Type: "script", Width: 550, Height: 600, ScriptProject: &CanvasScriptProject{Assets: []CanvasScriptAsset{{ImageNodeID: "hero"}}, Shots: []CanvasScriptShot{{ImageNodeID: "frame1", VideoNodeID: "video1"}, {ImageNodeID: "frame2", VideoNodeID: "video2"}}, MergedVideoNodeID: "movie"}}
	nodes := map[string]*CanvasNode{"script": script}
	eligible := map[string]bool{"script": true}
	for _, id := range []string{"hero", "frame1", "frame2", "video1", "video2", "movie"} {
		nodes[id] = &CanvasNode{ID: id, Width: 240, Height: 360}
		eligible[id] = true
	}
	nodes["unselected"] = &CanvasNode{ID: "unselected", X: 9000, Y: 9000, Width: 360, Height: 360}
	positions, _, _ := canvasScriptProductionLayout(script, nodes, eligible, 0, 0)
	if _, exists := positions["unselected"]; exists {
		t.Fatal("unselected node moved")
	}
	if positions["hero"][0] >= positions["script"][0] || positions["movie"][0] <= positions["video1"][0] {
		t.Fatal("production lane direction changed")
	}
	for _, pair := range [][2]string{{"frame1", "video1"}, {"frame2", "video2"}} {
		if positions[pair[0]][1] != positions[pair[1]][1] {
			t.Fatal("shot image and video separated")
		}
	}
	for a, point := range positions {
		for b, other := range positions {
			if a == b {
				continue
			}
			if point[0] < other[0]+nodes[b].Width && point[0]+nodes[a].Width > other[0] && point[1] < other[1]+nodes[b].Height && point[1]+nodes[a].Height > other[1] {
				t.Fatalf("%s overlaps %s", a, b)
			}
		}
	}
}
