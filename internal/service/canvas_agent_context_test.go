package service

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func canvasAgentTestVideoModels() []CanvasAgentVideoModel {
	return []CanvasAgentVideoModel{
		{Model: "minimax-h3-768p", Capabilities: map[string]any{"contractConfigured": true, "audioControl": "always", "sizes": []string{"16:9"}, "resolutions": []string{"768p"}}, Defaults: map[string]any{"videoSize": "16:9", "videoQuality": "768p", "videoSeconds": 5, "videoGenerateAudio": true}},
		{Model: "unknown-video", Capabilities: map[string]any{"contractConfigured": false, "audioControl": "unknown"}},
		{Model: "seedance2.0-A", Capabilities: map[string]any{"contractConfigured": true, "audioControl": "none", "sizes": []string{"16:9"}, "resolutions": []string{"1080p"}}},
	}
}

func TestCanvasAgentVideoConfigUsesServerContractAndReportsUnknown(t *testing.T) {
	w := memoryWorker(t, nil)
	w.service.SetVideoModels(canvasAgentTestVideoModels)
	w.req.Generation["videoModel"] = "minimax-h3-768p"
	w.req.Generation["videoSupportsAudio"] = false
	w.req.Generation["capabilities"].(map[string]any)["video"] = map[string]any{"audioControl": "none"}
	config, err := w.tool(map[string]any{"name": "get_generation_config"})
	generation := agentMap(config["generation"])
	video := agentMap(agentMap(generation["capabilities"])["video"])
	if err != nil || generation["videoSupportsAudio"] != true || generation["videoGenerateAudio"] != true || video["audioControl"] != "always" || video["contractConfigured"] != true {
		t.Fatalf("server fixed-audio contract did not override stale client claims: %v %v", config, err)
	}
	listed, err := w.tool(map[string]any{"name": "list_video_models"})
	models := util.AsMapSlice(listed["models"])
	if err != nil || len(models) != 3 || models[0]["model"] != "minimax-h3-768p" || agentMap(models[1]["capabilities"])["audioControl"] != "unknown" || agentMap(models[2]["capabilities"])["audioControl"] != "none" {
		t.Fatalf("missing known and unknown model capabilities: %v %v", listed, err)
	}
	w.req.Generation["videoModel"] = "unknown-video"
	config, err = w.tool(map[string]any{"name": "get_generation_config"})
	generation = agentMap(config["generation"])
	if err != nil || generation["videoSupportsAudio"] != nil || agentMap(agentMap(generation["capabilities"])["video"])["audioControl"] != "unknown" {
		t.Fatalf("unknown audio was declared unsupported: %v %v", config, err)
	}
}

func TestCanvasAgentVideoModelSwitchIsScopedAndRejectsUnavailableModels(t *testing.T) {
	w := memoryWorker(t, nil)
	w.service.SetVideoModels(canvasAgentTestVideoModels)
	w.doc.AgentConfig = json.RawMessage(`{"videoModel":"old-video","imageModel":"keep-image","autoGenerateMedia":false}`)
	w.doc.Nodes = []CanvasNode{{ID: "existing", Type: "video", Width: 320, Height: 180, ScaleX: 1, ScaleY: 1, GenerationVideoModel: "old-video", GenerationVideoSize: "16:9", GenerationVideoSeconds: 5, TaskID: "existing-task"}}
	before := cloneCanvasAgentDocument(w.doc)
	for model, code := range map[string]string{"not-configured": "video_model_unavailable", "unknown-video": "video_contract_missing"} {
		result, err := w.tool(map[string]any{"name": "set_video_model", "arguments": map[string]any{"model": model}})
		if err != nil || result["code"] != code || string(w.doc.AgentConfig) != string(before.AgentConfig) {
			t.Fatalf("invalid switch modified canvas: %v %v", result, err)
		}
	}
	result, err := w.tool(map[string]any{"name": "set_video_model", "arguments": map[string]any{"model": "minimax-h3-768p"}})
	if err != nil || result["ok"] != true || result["submitted"] != false || result["scope"] != "canvas" || !reflect.DeepEqual(w.doc.Nodes, before.Nodes) {
		t.Fatalf("switch changed existing media or failed: %v %v", result, err)
	}
	if err = w.save(); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	config := map[string]any{}
	_ = json.Unmarshal(saved.AgentConfig, &config)
	if err != nil || config["videoModel"] != "minimax-h3-768p" || config["imageModel"] != "keep-image" || config["autoGenerateMedia"] != false {
		t.Fatalf("canvas selection or other preferences were lost: %v %v", config, err)
	}
}

func TestCanvasAgentContextUsesBoundedIndexAndReadsFullDetailsByID(t *testing.T) {
	w := memoryWorker(t, nil)
	body := strings.Repeat("完整剧本", 10000)
	for i := 0; i < 150; i++ {
		w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: fmt.Sprintf("n%d", i), Type: "text", Title: "剧本", Prompt: body, GenerationStatus: "success"})
	}
	w.req.SelectedNodeIDs = []string{"n149"}
	w.state["completedTaskIds"] = []string{strings.Repeat("task", 10000)}
	w.state["pendingModelTaskId"] = "private-runtime-id"
	w.req.Generation["capabilities"] = map[string]any{"image": map[string]any{"sizes": []string{"1:1", "16:9"}}}
	context := w.canvasContext()
	if len(util.AsMapSlice(context["nodes"])) != 40 || context["omittedNodeCount"] != 110 || util.AsMapSlice(context["nodes"])[0]["id"] != "n149" {
		t.Fatal("index is not bounded or selected node lost priority")
	}
	if text := agentJSON(context); strings.Contains(text, "完整剧本") || strings.Contains(text, "completedTaskIds") || strings.Contains(text, "private-runtime-id") || strings.Contains(text, "capabilities") || len(text) > 12000 {
		t.Fatalf("context includes unrequested bodies or runtime metadata (%d bytes)", len(text))
	}
	result, err := w.tool(map[string]any{"name": "get_node", "arguments": map[string]any{"nodeId": "n149"}})
	if err != nil || agentMap(result["node"])["text"] != body || agentMap(result["node"])["prompt"] != nil {
		t.Fatal("explicit read lost or duplicated full text", err)
	}
	config, err := w.tool(map[string]any{"name": "get_generation_config", "arguments": map[string]any{}})
	if err != nil || agentMap(config["generation"])["capabilities"] == nil {
		t.Fatal("capabilities unavailable on demand", err)
	}
	status, err := w.tool(map[string]any{"name": "get_media_task_status", "arguments": map[string]any{"nodeId": "n149"}})
	if err != nil || status["status"] != "success" || strings.Contains(agentJSON(status), "完整剧本") {
		t.Fatal("status query expanded node body", err)
	}
	t.Logf("150 nodes with %d bytes of source text: default context %d bytes", 150*len(body), len(agentJSON(context)))
}

func TestCanvasAgentReferencesResolvePersistedIDsAndKeepBodiesOutOfInput(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "node", Type: "text", Title: "正文", Prompt: strings.Repeat("节点全文", 1000)}}
	w.session["messages"] = []map[string]any{
		{"role": "user", "references": []map[string]any{{"id": "attachment", "source": "attachment", "type": "text", "title": "附件", "text": "完整的附件要求"}}},
		{"role": "assistant", "references": []map[string]any{{"id": "invented", "source": "attachment", "text": "伪造引用"}}},
	}
	for _, ref := range []struct{ id, source string }{{"node", "node"}, {"attachment", "attachment"}} {
		resolved, err := canvasAgentReference(w.doc, w.session, ref.id, ref.source)
		if err != nil {
			t.Fatal(err)
		}
		w.req.References = append(w.req.References, resolved)
	}
	input := agentJSON(w.userContent())
	if strings.Contains(input, "节点全文") || strings.Contains(input, "完整的附件要求") || !strings.Contains(input, "attachment") || !strings.Contains(input, "node") {
		t.Fatal("references should contain IDs without source bodies")
	}
	result, err := w.tool(map[string]any{"name": "get_reference", "arguments": map[string]any{"referenceId": "attachment"}})
	if err != nil || agentMap(result["reference"])["text"] != "完整的附件要求" {
		t.Fatal("attachment body unavailable by ID", err)
	}
	for _, id := range []string{"invented", "another-users-attachment"} {
		if _, err := canvasAgentReference(w.doc, w.session, id, "attachment"); err == nil {
			t.Fatal("unknown reference accepted")
		}
	}
}

func TestCanvasAgentWriteResultsDoNotEchoLargeBodies(t *testing.T) {
	w := memoryWorker(t, nil)
	result, err := w.tool(map[string]any{"name": "create_text_node", "arguments": map[string]any{"title": "正文", "content": strings.Repeat("原始正文", 10000)}})
	if err != nil || result["nodeId"] == nil || len(agentJSON(result)) > 300 {
		t.Fatal("write echoed body", err)
	}
	if w.node(util.Clean(result["nodeId"])).Prompt != strings.Repeat("原始正文", 10000) {
		t.Fatal("stored content changed")
	}
}
