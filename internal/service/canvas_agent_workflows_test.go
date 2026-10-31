package service

import (
	"slices"
	"strings"
	"testing"
)

func TestCanvasAgentWorkflowReviewApprovedAnswers(t *testing.T) {
	for answer, want := range map[string]bool{
		"确认":         true,
		" OK! ":      true,
		"yes":        true,
		"没问题，开始生成":   true,
		"提示词确认通过":    true,
		"":           false,
		"先别生成":       false,
		"不满意，还要改":    false,
		"确认后再说，暂缓":   false,
		"随便":         false,
		"继续":         false,
		"请继续执行提示词方案": true,
	} {
		if got := canvasAgentWorkflowReviewApproved(answer); got != want {
			t.Errorf("canvasAgentWorkflowReviewApproved(%q) = %v, want %v", answer, got, want)
		}
	}
}

func TestCanvasAgentWorkflowReviewApprovedRejectsNegations(t *testing.T) {
	for _, answer := range []string{"不可以生成", "还没确认，不要生成", "没通过审核", "不能确认生成", "提示词不行，别生成", "未确认", "no", "not ok", "don't generate, ok"} {
		if canvasAgentWorkflowReviewApproved(answer) {
			t.Errorf("canvasAgentWorkflowReviewApproved(%q) = true, want false", answer)
		}
	}
	for _, answer := range []string{"确认审核并生成", "没问题，开始生成", "没有问题，确认生成"} {
		if !canvasAgentWorkflowReviewApproved(answer) {
			t.Errorf("canvasAgentWorkflowReviewApproved(%q) = false, want true", answer)
		}
	}
}

func TestAgentWorkflowOrderSortsDependenciesAndDetectsCycles(t *testing.T) {
	nodes := []CanvasNode{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	connections := []CanvasConnection{{ID: "1", FromNodeID: "a", ToNodeID: "b"}, {ID: "2", FromNodeID: "b", ToNodeID: "c"}}
	order, err := agentWorkflowOrder([]string{"c"}, nodes, connections)
	if err != nil || !slices.Equal(order, []string{"a", "b", "c"}) {
		t.Fatalf("agentWorkflowOrder() = (%v, %v), want a b c", order, err)
	}
	order, err = agentWorkflowOrder([]string{"c", "b"}, nodes, connections)
	if err != nil || !slices.Equal(order, []string{"a", "b", "c"}) {
		t.Fatalf("agentWorkflowOrder(shared prefix) = (%v, %v), want each node once", order, err)
	}
	cycle := append(slices.Clone(connections), CanvasConnection{ID: "3", FromNodeID: "c", ToNodeID: "a"})
	if _, err := agentWorkflowOrder([]string{"c"}, nodes, cycle); err == nil {
		t.Fatal("cyclic workflow accepted")
	}
	if _, err := agentWorkflowOrder([]string{"missing"}, nodes, connections); err == nil {
		t.Fatal("unknown workflow node accepted")
	}
}

func TestCanvasAgentWorkflowFingerprintTracksReviewedContent(t *testing.T) {
	node := CanvasNode{ID: "n", Title: "t", Prompt: "p", GenerationModel: "m", GenerationSize: "1:1"}
	base := canvasAgentWorkflowFingerprint(node)
	if base != canvasAgentWorkflowFingerprint(node) {
		t.Fatal("fingerprint is not deterministic")
	}
	for name, mutate := range map[string]func(*CanvasNode){
		"prompt": func(n *CanvasNode) { n.Prompt = "changed" },
		"title":  func(n *CanvasNode) { n.Title = "changed" },
		"size":   func(n *CanvasNode) { n.GenerationSize = "16:9" },
		"model":  func(n *CanvasNode) { n.GenerationModel = "other" },
		"refs":   func(n *CanvasNode) { n.GenerationReferenceURLs = []string{"https://example.test/r.png"} },
	} {
		changed := node
		mutate(&changed)
		if canvasAgentWorkflowFingerprint(changed) == base {
			t.Errorf("%s change did not alter the fingerprint", name)
		}
	}
}

func TestCanvasAgentWorkflowReviewApprovalLifecycle(t *testing.T) {
	w := &canvasAgentWorker{doc: CanvasDocument{Nodes: []CanvasNode{{ID: "a", Prompt: "one"}, {ID: "b", Prompt: "two"}}}, state: map[string]any{"pendingWorkflowReview": map[string]any{"nodeIds": []string{"a", "b", "gone"}}}}
	if got := w.workflowReviewNodeIDs(); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("workflowReviewNodeIDs() = %v, want stale IDs pruned", got)
	}
	if got := w.workflowReviewUnapprovedIDs(); len(got) != 2 {
		t.Fatalf("unapproved = %v, want both nodes", got)
	}
	if got := w.approveWorkflowReview([]string{"a", "unrelated"}); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("approveWorkflowReview() = %v, want only pending IDs", got)
	}
	if !w.workflowReviewApproved("a") || w.workflowReviewApproved("b") {
		t.Fatal("approval state does not match the approved set")
	}
	w.node("a").Prompt = "edited after approval"
	if w.workflowReviewApproved("a") {
		t.Fatal("approval survived a prompt edit")
	}
	w.approveWorkflowReview([]string{"a"})
	w.clearWorkflowReview([]string{"a"})
	if got := w.workflowReviewNodeIDs(); !slices.Equal(got, []string{"b"}) {
		t.Fatalf("after clear workflowReviewNodeIDs() = %v, want b", got)
	}
	if _, kept := w.state["approvedWorkflowReviewPrompts"]; kept {
		t.Fatal("approval record was not cleared with the node")
	}
	w.clearWorkflowReview([]string{"b"})
	if _, kept := w.state["pendingWorkflowReview"]; kept {
		t.Fatal("pending review remained after every node was cleared")
	}
}

func TestCanvasAgentWorkflowReferencePromptDescribesTemplates(t *testing.T) {
	templates := []WorkflowTemplateReference{{Name: "海报模板"}, {Name: "主图模板"}}
	withProduct := canvasAgentWorkflowReferencePrompt("base", templates, 2)
	for _, want := range []string{"base", "前 2 张", "海报模板、主图模板", "后 2 张"} {
		if !strings.Contains(withProduct, want) {
			t.Errorf("prompt is missing %q: %s", want, withProduct)
		}
	}
	if strings.Contains(canvasAgentWorkflowReferencePrompt("base", templates, 0), "后") {
		t.Fatal("product guidance emitted without product images")
	}
}

func TestFirstAgentStringPrefersFirstNonEmpty(t *testing.T) {
	if firstAgentString("a", "b") != "a" || firstAgentString("", "b") != "b" || firstAgentString("", "") != "" {
		t.Fatal("firstAgentString() returned the wrong value")
	}
}

func TestCanvasAgentCreateWorkflowRejectsInvalidGraphs(t *testing.T) {
	w := &canvasAgentWorker{doc: CanvasDocument{ID: "d"}, state: map[string]any{}, req: CanvasAgentRequest{}}
	text := func(key string, dependsOn ...string) map[string]any {
		return map[string]any{"key": key, "type": "text", "title": key, "prompt": key, "dependsOn": dependsOn}
	}
	for name, steps := range map[string][]map[string]any{
		"empty key":        {text("")},
		"duplicate key":    {text("a"), text("a")},
		"unknown dep":      {text("a", "missing")},
		"self dep":         {text("a", "a")},
		"duplicate dep":    {text("a"), text("b", "a", "a")},
		"cycle":            {text("a", "b"), text("b", "a")},
		"unsupported type": {{"key": "a", "type": "group", "dependsOn": []string{}}},
		"image no model":   {{"key": "a", "type": "image", "dependsOn": []string{}}},
	} {
		before := len(w.doc.Nodes)
		if _, err := w.createCanvasWorkflow(steps); err == nil {
			t.Errorf("%s: createCanvasWorkflow() accepted the graph", name)
		}
		if len(w.doc.Nodes) != before {
			t.Errorf("%s: a rejected graph modified the document", name)
		}
	}
}

func TestCanvasAgentCreateWorkflowDefaultsImageCountToOne(t *testing.T) {
	w := &canvasAgentWorker{doc: CanvasDocument{ID: "d"}, state: map[string]any{}, req: CanvasAgentRequest{Generation: map[string]any{"imageModel": "img"}}}
	step := map[string]any{"key": "a", "type": "image", "title": "a", "prompt": "p", "size": "1:1", "dependsOn": []string{}}
	// The worker has no persisted session, so the final save fails after every validation has passed.
	_, err := w.createCanvasWorkflow([]map[string]any{step})
	if err == nil || !strings.Contains(err.Error(), "会话记录无效") {
		t.Fatalf("createCanvasWorkflow() error = %v, want validation to pass and only the save to fail", err)
	}
}

func TestCanvasAgentWorkflowToolRequiresWorkflowService(t *testing.T) {
	w := &canvasAgentWorker{service: &CanvasAgentService{}, state: map[string]any{}}
	for _, name := range []string{"list_workflows", "save_workflow"} {
		if _, err := w.workflowTool(name, map[string]any{}); err == nil {
			t.Errorf("%s succeeded without a workflow service", name)
		}
	}
	if _, err := w.workflowTool("unknown", map[string]any{}); err == nil {
		t.Fatal("unknown workflow operation accepted")
	}
}
