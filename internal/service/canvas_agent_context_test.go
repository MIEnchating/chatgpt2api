package service

import (
	"fmt"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

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
