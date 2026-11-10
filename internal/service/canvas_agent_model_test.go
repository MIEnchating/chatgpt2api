package service

import (
	"context"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
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

func TestAgentNodeReadsStructuredScriptWithoutExpandingIndex(t *testing.T) {
	project := &CanvasScriptProject{Step: 2, Confirmed: true,
		Shots:  []CanvasScriptShot{{ID: "shot-1", Seconds: 5, Description: "A knock at the door"}},
		Assets: []CanvasScriptAsset{{ID: "hero", Kind: "character", Name: "Protagonist", ImageNodeID: "existing-reference"}},
	}
	node := CanvasNode{ID: "script-1", Type: "script", Prompt: "Approved production script", ScriptProject: project}
	if _, exists := agentNode(node, false)["scriptProject"]; exists {
		t.Fatal("node index expanded the complete script")
	}
	if full := agentNode(node, true); full["scriptProject"] != project || full["prompt"] != node.Prompt {
		t.Fatalf("script detail lost the structured storyboard or original script: %#v", full)
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

func TestCanvasAgentPromptKeepsLiveCanvasOutOfReusableInstructions(t *testing.T) {
	w := &canvasAgentWorker{doc: CanvasDocument{ID: "cache-project", Nodes: []CanvasNode{{ID: "changing-node", Type: "video", GenerationStatus: "loading"}}}, state: map[string]any{}, req: CanvasAgentRequest{UserText: "继续制作短剧"}}
	before := w.prompt()
	if strings.Contains(before, "changing-node") || strings.Contains(before, "cache-project") {
		t.Fatal("live canvas state changed the reusable instruction prefix")
	}
	w.doc.Nodes[0].GenerationStatus = "success"
	w.state["brief"] = "角色四视图、音频旁白和分镜整理"
	w.state["plan"] = []map[string]any{{"step": "generate", "status": "completed"}}
	if after := w.prompt(); after != before {
		t.Fatal("progress updates changed the instructions during the same run")
	}
	if agentJSON(w.canvasContext()) == "" || !strings.Contains(agentJSON(w.canvasContext()), "success") {
		t.Fatal("latest canvas progress was not available separately")
	}
}

func TestCanvasAgentSDKPlanProgressPreservesModelPrefix(t *testing.T) {
	var first []map[string]any
	var projectID string
	turns := 0
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		turns++
		if key := util.Clean(r.Metadata["prompt_cache_key"]); !strings.HasPrefix(key, "agent-") || len(key) != 54 {
			t.Errorf("stable prompt cache identity missing: %q", key)
		}
		if r.Messages[0]["role"] != "system" || strings.Contains(r.Messages[0]["content"].(string), "当前画布快照") {
			t.Error("live state moved into leading system instructions")
		}
		last := r.Messages[len(r.Messages)-1]
		if last["role"] != "user" || !strings.Contains(last["content"].(string), projectID) {
			t.Error("gateway did not receive the live canvas snapshot at the tail")
		}
		if turns == 1 {
			first = r.Messages
			return agentTurn(agentCall("cache-plan", "update_plan", map[string]any{"steps": []any{map[string]any{"id": "done", "title": "确认需求", "status": "completed"}}})), nil
		}
		if agentJSON(r.Messages[:len(first)]) != agentJSON(first) {
			t.Error("plan progress changed the previous model input prefix")
		}
		if !strings.Contains(last["content"].(string), `"status":"completed"`) {
			t.Error("live snapshot did not reflect the completed plan step")
		}
		return agentTurn(), nil
	}, nil)
	projectID = doc.ID
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns != 2 {
		t.Fatalf("run=%+v turns=%d", done.AgentRun, turns)
	}
}
