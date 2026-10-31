package service

import (
	"strings"
	"testing"
)

func TestAgentNodeIndexOmitsBodiesUnlessFull(t *testing.T) {
	node := CanvasNode{ID: "n1", Type: "text", Title: "title", Prompt: "secret body", URL: "https://example.test/a.png", GenerationStatus: "success", TaskID: "task-1", GroupID: "g1"}
	index := agentNode(node, false)
	if _, ok := index["text"]; ok {
		t.Fatal("index entry leaked the node body")
	}
	if _, ok := index["mediaUrl"]; ok {
		t.Fatal("index entry leaked the media URL")
	}
	if index["hasMedia"] != true || index["detailsOmitted"] != true || index["taskId"] != "task-1" || index["groupId"] != "g1" {
		t.Fatalf("unexpected index entry: %#v", index)
	}
	full := agentNode(node, true)
	if full["text"] != "secret body" || full["mediaUrl"] != node.URL || full["detailsOmitted"] != false {
		t.Fatalf("unexpected full entry: %#v", full)
	}
}

func TestAgentNodeIndexTruncatesLongTitles(t *testing.T) {
	node := CanvasNode{ID: "n1", Type: "image", Title: strings.Repeat("文", 300)}
	if got := []rune(agentNode(node, false)["title"].(string)); len(got) != 200 {
		t.Fatalf("index title has %d runes, want 200", len(got))
	}
	if got := []rune(agentNode(node, true)["title"].(string)); len(got) != 300 {
		t.Fatalf("full title has %d runes, want 300", len(got))
	}
}

func TestAgentNodeFullUsesTextOrPromptKey(t *testing.T) {
	text := agentNode(CanvasNode{ID: "t", Type: "text", Prompt: "body"}, true)
	if text["text"] != "body" || text["prompt"] != nil {
		t.Fatalf("text node entry = %#v", text)
	}
	image := agentNode(CanvasNode{ID: "i", Type: "image", Prompt: "body", GenerationError: "boom"}, true)
	if image["prompt"] != "body" || image["text"] != nil || image["error"] != "boom" {
		t.Fatalf("image node entry = %#v", image)
	}
}

func TestCanvasAgentAutoMediaPrefersDeferredState(t *testing.T) {
	w := &canvasAgentWorker{state: map[string]any{}, req: CanvasAgentRequest{Generation: map[string]any{"autoGenerateMedia": true}}}
	if !w.autoMedia() {
		t.Fatal("autoMedia() = false, want request setting")
	}
	w.state["mediaGenerationDeferred"] = true
	if w.autoMedia() {
		t.Fatal("autoMedia() = true, want deferred state to win")
	}
	w.state["mediaGenerationDeferred"] = false
	w.req.Generation["autoGenerateMedia"] = false
	if !w.autoMedia() {
		t.Fatal("autoMedia() = false, want explicit undeferred state to win")
	}
}

func TestCanvasAgentContextPrioritizesSelectedNodesAndCapsIndex(t *testing.T) {
	doc := CanvasDocument{ID: "doc-1", Title: "project"}
	for i := 0; i < 50; i++ {
		doc.Nodes = append(doc.Nodes, CanvasNode{ID: "node-" + string(rune('A'+i%26)) + string(rune('a'+i/26)), Type: "text"})
	}
	selected := doc.Nodes[49].ID
	w := &canvasAgentWorker{doc: doc, state: map[string]any{"phase": "plan", "internal": "hidden"}, req: CanvasAgentRequest{SelectedNodeIDs: []string{selected}}}
	context := w.canvasContext()
	nodes := context["nodes"].([]map[string]any)
	if len(nodes) != 40 || nodes[0]["id"] != selected {
		t.Fatalf("context nodes = %d, first = %v, want 40 starting with the selected node", len(nodes), nodes[0]["id"])
	}
	if context["omittedNodeCount"] != 10 {
		t.Fatalf("omittedNodeCount = %v, want 10", context["omittedNodeCount"])
	}
	state := context["agentState"].(map[string]any)
	if state["phase"] != "plan" {
		t.Fatalf("phase missing from agent state: %#v", state)
	}
	if _, leaked := state["internal"]; leaked {
		t.Fatal("unlisted state key leaked into the context")
	}
}

func TestCanvasAgentPromptSelectsSkillsFromIntent(t *testing.T) {
	if agentPrompts["WORKFLOW_SKILL"] == "" || agentPrompts["VIDEO_SKILL"] == "" {
		t.Fatal("embedded prompts are missing")
	}
	static := &canvasAgentWorker{doc: CanvasDocument{ID: "d"}, state: map[string]any{}, req: CanvasAgentRequest{UserText: "做一张海报"}}
	prompt := static.prompt()
	if strings.Contains(prompt, agentPrompts["WORKFLOW_SKILL"]) || strings.Contains(prompt, agentPrompts["VIDEO_SKILL"]) {
		t.Fatal("static ad request pulled in workflow or video skills")
	}
	video := &canvasAgentWorker{doc: CanvasDocument{ID: "d"}, state: map[string]any{}, req: CanvasAgentRequest{UserText: "做一个宣传片"}}
	prompt = video.prompt()
	if !strings.Contains(prompt, agentPrompts["WORKFLOW_SKILL"]) || !strings.Contains(prompt, agentPrompts["VIDEO_SKILL"]) {
		t.Fatal("video request did not include workflow and video skills")
	}
}

func TestCanvasAgentPromptUsesSelectedSkillsInsteadOfIntentRouting(t *testing.T) {
	w := &canvasAgentWorker{doc: CanvasDocument{ID: "d"}, state: map[string]any{}, req: CanvasAgentRequest{UserText: "做一个宣传片"}, skills: []AgentSkill{{ID: "skill-1", Name: "custom", Content: "custom body", Files: map[string]string{"a.md": "x"}}}}
	prompt := w.prompt()
	if !strings.Contains(prompt, "Skill custom (skill-1)") || !strings.Contains(prompt, "custom body") || !strings.Contains(prompt, "a.md") {
		t.Fatal("selected skill missing from prompt")
	}
	if strings.Contains(prompt, agentPrompts["VIDEO_SKILL"]) {
		t.Fatal("intent routing must not run when skills are selected")
	}
}
