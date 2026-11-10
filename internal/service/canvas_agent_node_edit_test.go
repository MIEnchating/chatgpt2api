package service

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"chatgpt2api/internal/util"
)

func nodeEditWorker(t *testing.T) *canvasAgentWorker {
	t.Helper()
	w := memoryWorker(t, nil)
	audio := false
	w.req.Generation["videoModel"] = "video-test"
	w.req.Generation["capabilities"].(map[string]any)["video"] = map[string]any{"sizes": []string{"16:9", "9:16"}, "resolutions": []string{"480p"}, "audioControl": "optional"}
	w.doc.Nodes = []CanvasNode{
		{ID: "video", Type: "video", Title: "Original shot", Prompt: "Original prompt", TaskID: "original-task", GenerationStatus: "error", GenerationError: "original failure", GenerationVideoModel: "video-test", GenerationVideoSize: "16:9", GenerationVideoSeconds: 5, GenerationVideoAudio: &audio, GenerationVideoReferenceMode: "first-frame", GenerationVideoReferenceImages: []string{"/old.png"}},
		{ID: "hero", Type: "image", URL: "/hero.png"},
		{ID: "scene", Type: "image", URL: "/scene.png"},
		{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{{ID: "s1", Seconds: 5, VideoNodeID: "video"}}}},
	}
	for i := range w.doc.Nodes {
		w.doc.Nodes[i].Width, w.doc.Nodes[i].Height = 360, 360
		w.doc.Nodes[i].ScaleX, w.doc.Nodes[i].ScaleY = 1, 1
	}
	w.doc.Connections = []CanvasConnection{{ID: "hero-edge", FromNodeID: "hero", ToNodeID: "video"}, {ID: "scene-edge", FromNodeID: "scene", ToNodeID: "video"}, {ID: "outgoing", FromNodeID: "video", ToNodeID: "script"}}
	return w
}

func TestCanvasAgentEmptyMediaFramePreservesExistingMediaAndFreeResize(t *testing.T) {
	for _, tc := range []struct {
		name      string
		node      CanvasNode
		wantWidth float64
	}{
		{"image", CanvasNode{Type: "image", Width: 360, Height: 360, GenerationSize: "1024x1536"}, 240},
		{"video", CanvasNode{Type: "video", Width: 360, Height: 360, GenerationVideoSize: "9:16"}, 202.5},
		{"existing", CanvasNode{Type: "video", Width: 360, Height: 360, GenerationVideoSize: "9:16", URL: "/video"}, 360},
		{"free resize", CanvasNode{Type: "video", Width: 360, Height: 360, GenerationVideoSize: "9:16", FreeResize: true}, 360},
		{"unknown", CanvasNode{Type: "image", Width: 360, Height: 360, GenerationSize: "auto"}, 360},
	} {
		t.Run(tc.name, func(t *testing.T) {
			canvasAgentFitEmptyMediaFrame(&tc.node)
			if tc.node.Width != tc.wantWidth || tc.node.X+tc.node.Width/2 != 180 || tc.node.Y+tc.node.Height/2 != 180 {
				t.Fatalf("unexpected frame: %+v", tc.node)
			}
		})
	}
}

func TestCanvasAgentUpdateNodeRepairsVideoInPlaceWithoutGenerating(t *testing.T) {
	w := nodeEditWorker(t)
	before := cloneCanvasAgentDocument(w.doc)
	result, err := w.tool(map[string]any{"name": "update_node", "arguments": map[string]any{"nodeId": "video", "prompt": "Updated shot", "generation": map[string]any{"size": "9:16", "referenceMode": "reference", "generateAudio": false}, "sourceNodeIds": []any{"hero", "scene"}}})
	if err != nil || result["ok"] != true || result["submitted"] != false {
		t.Fatalf("edit failed: %v %v", result, err)
	}
	n := w.node("video")
	if n.Width/n.Height != 9.0/16.0 {
		t.Fatalf("empty video frame does not match configured ratio: %v x %v", n.Width, n.Height)
	}
	if n.GenerationVideoSize != "9:16" || n.GenerationVideoReferenceMode != "reference" || n.Prompt != "Updated shot" || !reflect.DeepEqual(n.GenerationVideoReferenceImages, []string{"/hero.png", "/scene.png"}) {
		t.Fatalf("video configuration was not updated: %+v", n)
	}
	if n.TaskID != "original-task" || n.GenerationStatus != "error" || n.GenerationError != "original failure" || len(w.doc.Nodes) != len(before.Nodes) || !reflect.DeepEqual(w.doc.Connections, before.Connections) || !reflect.DeepEqual(w.doc.Nodes[3].ScriptProject, before.Nodes[3].ScriptProject) {
		t.Fatal("editing lost original identity, task, connections or script binding")
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil || saved.Nodes[0].GenerationVideoSize != "9:16" || saved.Nodes[0].TaskID != "original-task" {
		t.Fatalf("edit did not survive saving: %v", err)
	}
	w.req.Resume = true
	result, err = w.generateNode("video")
	if err != nil || result["code"] != "media_retry_requires_confirmation" {
		t.Fatalf("edit bypassed paid retry confirmation: %v %v", result, err)
	}
	var submissions int
	w.service.media = func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any) (map[string]any, error) {
		submissions++
		if node.ID != "video" || node.TaskID == "original-task" || node.GenerationVideoSize != "9:16" || node.GenerationVideoReferenceMode != "reference" {
			t.Fatalf("retry did not use edited original node: %+v", node)
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/generated.mp4"}}}, nil
	}
	w.req.MediaChoice = "generate"
	result, err = w.generateNode("video")
	if err != nil || result["ok"] != true || submissions != 1 || len(w.doc.Nodes) != len(before.Nodes) {
		t.Fatalf("confirmed retry failed: %v %v submissions=%d", result, err, submissions)
	}
}

func TestCanvasAgentUpdateNodeRejectsBusyInvalidAndProtectedEditsAtomically(t *testing.T) {
	for _, test := range []struct {
		name string
		args map[string]any
		busy bool
	}{
		{"busy", map[string]any{"prompt": "changed"}, true},
		{"wrong-kind-field", map[string]any{"generation": map[string]any{"voice": "alloy"}}, false},
		{"invalid-size", map[string]any{"title": "changed", "generation": map[string]any{"size": "invalid"}}, false},
		{"self-reference", map[string]any{"sourceNodeIds": []any{"video"}}, false},
		{"missing-reference", map[string]any{"sourceNodeIds": []any{"another-project"}}, false},
		{"invalid-attachment", map[string]any{"title": "changed", "attachmentIds": []any{"missing"}}, false},
		{"no-fields", map[string]any{}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := nodeEditWorker(t)
			if test.busy {
				w.doc.Nodes[0].GenerationStatus = "loading"
			}
			test.args["nodeId"] = "video"
			before := agentJSON(w.doc)
			result, err := w.tool(map[string]any{"name": "update_node", "arguments": test.args})
			if err != nil || result["ok"] != false || agentJSON(w.doc) != before {
				t.Fatalf("invalid edit mutated canvas: %v %v", result, err)
			}
		})
	}
	for _, field := range []string{"taskId", "status", "url", "generation_status", "owner_id"} {
		for _, definition := range agentTools {
			if agentMap(definition["function"])["name"] != "update_node" {
				continue
			}
			args := map[string]any{"nodeId": "video", field: "forged"}
			if err := validateAgentValue(args, agentMap(agentMap(definition["function"])["parameters"]), "update_node"); err == nil {
				t.Errorf("tool contract permits protected field %s", field)
			}
		}
	}
}

func TestCanvasAgentUpdateNodePreservesExplicitFalseAndClearsReferences(t *testing.T) {
	w := nodeEditWorker(t)
	result, err := w.tool(map[string]any{"name": "update_node", "arguments": map[string]any{"nodeId": "video", "generation": map[string]any{"generateAudio": false}, "sourceNodeIds": []any{}}})
	if err != nil || result["ok"] != true || w.doc.Nodes[0].GenerationVideoAudio == nil || *w.doc.Nodes[0].GenerationVideoAudio || len(w.doc.Nodes[0].GenerationVideoReferenceImages) != 0 || len(w.doc.Connections) != 1 || w.doc.Connections[0].ID != "outgoing" {
		t.Fatalf("explicit false or empty sources lost: %v %v", result, err)
	}
	if util.Clean(agentMap(agentNode(w.doc.Nodes[0], true)["generation"])["referenceMode"]) != "first-frame" {
		t.Fatal("get_node does not expose the actual video mode")
	}
}

func TestCanvasAgentUpdateNodeSupportsImageAudioAndTextWithoutClearingOutputs(t *testing.T) {
	w := nodeEditWorker(t)
	w.doc.Nodes = append(w.doc.Nodes,
		CanvasNode{ID: "picture", Type: "image", Width: 360, Height: 360, URL: "/original.png", TaskID: "finished-picture", GenerationStatus: "success", GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1},
		CanvasNode{ID: "voice", Type: "audio", Width: 360, Height: 360, GenerationAudioModel: "audio-test", GenerationAudioVoice: "alloy"},
		CanvasNode{ID: "text", Type: "text", Width: 360, Height: 360, Prompt: "Original text"})
	for _, args := range []map[string]any{
		{"nodeId": "picture", "generation": map[string]any{"size": "9:16", "count": float64(2)}},
		{"nodeId": "voice", "generation": map[string]any{"voice": "echo", "speed": 0.75, "format": "mp3", "instructions": "Calm tone"}},
		{"nodeId": "text", "prompt": ""},
	} {
		result, err := w.tool(map[string]any{"name": "update_node", "arguments": args})
		if err != nil || result["ok"] != true {
			t.Fatalf("in-place edit failed: %v %v", result, err)
		}
	}
	if n := w.node("picture"); n.URL != "/original.png" || n.TaskID != "finished-picture" || n.GenerationCount != 2 || n.GenerationStatus != "success" {
		t.Fatalf("image output lost or new input not saved: %+v", n)
	}
	if n := w.node("voice"); n.GenerationAudioVoice != "echo" || n.GenerationAudioSpeed != 0.75 || n.GenerationAudioInstructions != "Calm tone" {
		t.Fatalf("audio settings lost: %+v", n)
	}
	if w.node("text").Prompt != "" {
		t.Fatal("explicit empty prompt was not saved")
	}
	result, err := w.generateNode("picture")
	if err != nil || result["code"] != "canvas_changed" || w.node("picture").URL != "/original.png" {
		t.Fatalf("changed image inputs silently reused an old result: %v %v", result, err)
	}
}

func TestCanvasAgentSDKNodeEditSurvivesRestartWithoutReplacementOrSubmission(t *testing.T) {
	turns := 0
	model := func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		turns++
		switch turns {
		case 1:
			return agentTurn(agentCall("repair-video", "update_node", map[string]any{"nodeId": "video", "generation": map[string]any{"size": "9:16", "referenceMode": "reference"}, "sourceNodeIds": []string{"hero", "scene"}})), nil
		case 2:
			return nil, errors.New("upstream 400 invalid parameter")
		case 3:
			return agentTurn(agentCall("verify-repair", "get_node", map[string]any{"nodeId": "video"})), nil
		default:
			if !containsAny(agentJSON(request.Messages), "referenceMode") || !containsAny(agentJSON(request.Messages), "original-task") {
				t.Error("resumed model did not receive updated settings and original task")
			}
			return agentTurn(), nil
		}
	}
	svc, identity, doc, req := agentFixture(t, model, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
		t.Error("editing must not submit paid media")
		return nil, errors.New("unexpected media submission")
	})
	fixture := nodeEditWorker(t)
	doc.Nodes, doc.Connections = fixture.doc.Nodes, fixture.doc.Connections
	req.Generation = fixture.req.Generation
	var err error
	if doc, err = svc.canvas.SaveAtRevision(identity.ID, doc); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "error" || done.Nodes[0].GenerationVideoSize != "9:16" || len(done.Nodes) != 4 {
		t.Fatalf("edit not persisted before interruption: %+v", done.AgentRun)
	}
	svc.Close()
	restarted := NewCanvasAgentService(context.Background(), svc.execution, svc.canvas, svc.skills, model, nil)
	t.Cleanup(restarted.Close)
	req.ID, req.Resume = "resume-node-edit", true
	if _, err = restarted.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done = agentWait(t, restarted, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns != 4 || len(done.Nodes) != 4 || done.Nodes[0].ID != "video" || done.Nodes[0].TaskID != "original-task" || done.Nodes[0].GenerationVideoReferenceMode != "reference" || !reflect.DeepEqual(done.Nodes[3].ScriptProject, fixture.doc.Nodes[3].ScriptProject) {
		t.Fatalf("resumed edit replaced original progress: %+v turns=%d", done.AgentRun, turns)
	}
}
