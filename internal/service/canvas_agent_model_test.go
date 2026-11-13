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

func TestAgentNodeDetailsDistinguishMeasuredMediaFromRequestedGeneration(t *testing.T) {
	requestedAudio := true
	for _, audio := range []bool{true, false} {
		node := CanvasNode{ID: "video", Type: "video", GenerationVideoSeconds: 15, GenerationVideoAudio: &requestedAudio,
			MediaMetadata: &CanvasMediaMetadata{Width: 768, Height: 1376, DurationMS: 15083, HasAudio: &audio}, MediaSilentClips: 1}
		full := agentNode(node, true)
		if full["mediaMetadata"] != node.MediaMetadata || full["mediaSilentClips"] != 1 {
			t.Fatalf("node detail lost measured duration, dimensions, audio or silent input count: %#v", full)
		}
		if generation := full["generation"].(map[string]any); generation["seconds"] != 15 || generation["generateAudio"] != node.GenerationVideoAudio {
			t.Fatalf("measured media replaced requested generation parameters: %#v", generation)
		}
		if _, exists := agentNode(node, false)["mediaMetadata"]; exists {
			t.Fatal("compact index expanded media details")
		}
	}
	node := CanvasNode{ID: "unknown", Type: "video", GenerationVideoSeconds: 60, GenerationVideoAudio: &requestedAudio, MediaProbeError: "probe unavailable"}
	full := agentNode(node, true)
	if _, exists := full["mediaMetadata"]; exists {
		t.Fatal("request parameters were presented as measured media")
	}
	if full["mediaProbeError"] != node.MediaProbeError {
		t.Fatalf("node detail lost the actual probe error: %#v", full)
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
	if _, exists := agentNode(node, false)["confirmationFingerprint"]; exists {
		t.Fatal("compact node index should not compute script confirmation fingerprints")
	}
	if full := agentNode(node, true); full["scriptProject"] != project || full["prompt"] != node.Prompt {
		t.Fatalf("script detail lost the structured storyboard or original script: %#v", full)
	}
	if fingerprint, ok := agentNode(node, true)["confirmationFingerprint"].(string); !ok || len(fingerprint) != 64 {
		t.Fatal("full script reads must include the version required for confirmation")
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

func TestCanvasAgentPromptUsesStructuredShotsAndSingleFrameStoryboards(t *testing.T) {
	w := &canvasAgentWorker{state: map[string]any{}, req: CanvasAgentRequest{UserText: "完整制作60秒有声短剧，每镜一张分镜图，不要宫格"}}
	prompt := w.prompt()
	for _, rule := range []string{"镜头直接保存在 scriptProject.shots", "普通分镜默认每镜一张单幅画面", "只有用户明确要求宫格、拼图或多面板", "单幅分镜不是宫格", "用户明确委托自主创作并完整制作", "读取已保存的脚本", "内容未变时调用 confirm_script_node"} {
		if !strings.Contains(prompt, rule) {
			t.Errorf("missing production rule: %s", rule)
		}
	}
	for _, obsolete := range []string{"每个计划视频片段/镜头节点生成一张拼图", "必须包含当前镜头文本 nodeId", "退出：真实镜头文本节点已创建", "完整项目默认先建立真实镜头节点", "检测到分镜拼图标题或用户明确说分镜/宫格/storyboard 时"} {
		if strings.Contains(prompt, obsolete) {
			t.Errorf("contradictory production rule remains: %s", obsolete)
		}
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

func TestCanvasAgentPromptAvoidsRepeatedParameterAndTechnicalQuestions(t *testing.T) {
	w := &canvasAgentWorker{state: map[string]any{}, req: CanvasAgentRequest{UserText: "继续生成有声短剧，不创建音频节点"}}
	prompt := w.prompt()
	for _, forbidden := range []string{"缺失必须询问", "每次一个关键问题", "只问一个最阻塞的问题", "缺少必要参数必须提问", "不能用默认秒数代替用户确认", "交付比例、时长和声音需求缺失时必须询问", "用户未说明或未明确委托时必须询问", "必要条件缺失时必须询问", "每次通过 ask_user_question 询问一个最关键问题"} {
		if strings.Contains(prompt, forbidden) {
			t.Errorf("prompt still forces repeated questions: %s", forbidden)
		}
	}
	for _, required := range []string{"同阶段的必要缺口合并为一次提问", "每项用户请求最多发起一轮普通澄清", "后续阶段按合理默认直接执行", "不得再弹出“立即生成”授权问题", "技术错误或配置通知不得包装成问题卡", "已接受的限制不重复确认", "requiresUserReview=true", "不得因沉默、等待或超时自动选择推荐项"} {
		if !strings.Contains(prompt, required) {
			t.Errorf("prompt lost interaction contract: %s", required)
		}
	}
}

func TestCanvasAgentPromptExplainsVideoModesAndNativeAudio(t *testing.T) {
	for _, skills := range [][]AgentSkill{nil, {{ID: "custom", Name: "custom", Content: "custom workflow"}}} {
		w := &canvasAgentWorker{state: map[string]any{}, skills: skills, req: CanvasAgentRequest{UserText: "创作60秒短剧"}}
		prompt := w.prompt()
		for _, required := range []string{"defaultMode 只是默认模式", "referenceMaterials.modes", "独立音频模型不是原生有声视频的前置条件", "先生成所需参考图"} {
			if !strings.Contains(prompt, required) {
				t.Errorf("video capability interpretation missing: %s", required)
			}
		}
	}
}
