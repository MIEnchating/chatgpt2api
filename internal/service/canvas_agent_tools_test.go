package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func toolTestWorker(nodes ...CanvasNode) *canvasAgentWorker {
	return &canvasAgentWorker{doc: CanvasDocument{ID: "doc", Nodes: nodes}, state: map[string]any{}, req: CanvasAgentRequest{}}
}

func runToolTest(t *testing.T, w *canvasAgentWorker, name string, args map[string]any) map[string]any {
	t.Helper()
	result, err := w.tool(map[string]any{"id": "call-1", "name": name, "arguments": args})
	if err != nil {
		t.Fatalf("tool(%s) error = %v", name, err)
	}
	return result
}

func TestCanvasAgentToolRejectsUnsupportedTool(t *testing.T) {
	result := runToolTest(t, toolTestWorker(), "no_such_tool", map[string]any{})
	if result["ok"] == true || util.Clean(result["code"]) != "unsupported_tool" {
		t.Fatalf("unsupported tool result = %#v", result)
	}
}

func TestCanvasAgentToolReportsMissingNodeAsCanvasChange(t *testing.T) {
	result := runToolTest(t, toolTestWorker(CanvasNode{ID: "a", Type: "text"}), "get_node", map[string]any{"nodeId": "gone"})
	if result["ok"] == true {
		t.Fatalf("missing node reported success: %#v", result)
	}
}

func TestCanvasAgentFinishTaskAcceptsBoundedFollowUpActions(t *testing.T) {
	w := toolTestWorker()
	result := runToolTest(t, w, "finish_task", map[string]any{
		"text": "已完成",
		"followUpActions": []any{
			map[string]any{"title": "继续优化", "prompt": "继续优化这份方案"},
		},
	})
	actions, ok := result["followUpActions"].([]map[string]string)
	if result["ok"] != true || !ok || len(actions) != 1 {
		t.Fatalf("follow-up actions were not retained: %#v", result)
	}
	if got := runToolTest(t, toolTestWorker(), "finish_task", map[string]any{
		"text": "已完成",
		"followUpActions": []any{
			map[string]any{"title": "重复", "prompt": "继续"},
			map[string]any{"title": "重复", "prompt": "继续"},
		},
	})["code"]; got != "invalid_follow_up_actions" {
		t.Fatalf("duplicate follow-up prompt code = %v", got)
	}
}

func TestCanvasAgentHistorySearchToolReturnsSavedMatchesWithoutCurrentRequest(t *testing.T) {
	backend := newTestStorageBackend(t)
	canvas := NewCanvasDocumentService(backend)
	doc, err := loadCanvas(canvas, "history-tool-owner")
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions = json.RawMessage(`[{"id":"old","title":"旧方案","messages":[{"id":"old-user","role":"user","text":"制作蓝色海报"}]},{"id":"current","title":"当前方案","messages":[{"id":"current-user","role":"user","text":"制作蓝色海报"}]}]`)
	doc, err = canvas.SaveAtRevision("history-tool-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	w := &canvasAgentWorker{
		ctx:      context.Background(),
		service:  &CanvasAgentService{canvas: canvas},
		identity: Identity{ID: "history-tool-owner"},
		doc:      doc,
		req:      CanvasAgentRequest{SessionID: "current", UserMessageID: "current-user"},
	}
	result, err := w.tool(map[string]any{"name": "search_agent_history", "arguments": map[string]any{"query": "蓝色"}})
	if err != nil || result["ok"] != true {
		t.Fatalf("history search = %#v, error = %v", result, err)
	}
	matches := util.AsMapSlice(result["matches"])
	if len(matches) != 1 || matches[0]["sessionId"] != "old" || matches[0]["messageId"] != "old-user" || matches[0]["snippet"] != "制作蓝色海报" {
		t.Fatalf("history matches = %#v", matches)
	}
	filtered, err := w.tool(map[string]any{"name": "search_agent_history", "arguments": map[string]any{"query": "蓝色", "role": "assistant", "sessionId": "old"}})
	if err != nil || filtered["ok"] != true || len(util.AsMapSlice(filtered["matches"])) != 0 {
		t.Fatalf("history search ignored role filter: %#v, %v", filtered, err)
	}
	filtered, err = w.tool(map[string]any{"name": "search_agent_history", "arguments": map[string]any{"query": "蓝色", "role": "user", "sessionId": "current"}})
	if err != nil || filtered["ok"] != true || len(util.AsMapSlice(filtered["matches"])) != 0 {
		t.Fatalf("history search ignored session filter or included the current request: %#v, %v", filtered, err)
	}
	message, err := w.tool(map[string]any{"name": "get_agent_history_message", "arguments": map[string]any{"sessionId": "old", "messageId": "old-user"}})
	if err != nil || message["ok"] != true || agentMap(message["message"])["text"] != "制作蓝色海报" {
		t.Fatalf("history message = %#v, error = %v", message, err)
	}
	current, err := w.tool(map[string]any{"name": "get_agent_history_message", "arguments": map[string]any{"sessionId": "current", "messageId": "current-user"}})
	if err != nil || current["code"] != "history_message_unavailable" {
		t.Fatalf("current message result = %#v, error = %v", current, err)
	}
}

func TestCanvasAgentHistoryMessagePaginationPreservesTextAndVersion(t *testing.T) {
	const owner = "history-pagination-owner"
	canvas := NewCanvasDocumentService(newTestStorageBackend(t))
	doc, err := loadCanvas(canvas, owner)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "  " + strings.Repeat("片", 11997) + "🎬"
	suffix := "\n\n" + strings.Repeat("镜", 11999) + "  "
	source := map[string]any{"id": "message", "role": "assistant", "text": prefix + suffix}
	other := map[string]any{"id": "other", "role": "assistant", "text": prefix + suffix}
	session := map[string]any{"id": "old", "messages": []map[string]any{source, other}}
	doc.AgentSessions = json.RawMessage(agentJSON([]map[string]any{session}))
	doc, err = canvas.SaveAtRevision(owner, doc)
	if err != nil {
		t.Fatal(err)
	}
	w := &canvasAgentWorker{ctx: context.Background(), service: &CanvasAgentService{canvas: canvas}, identity: Identity{ID: owner}, doc: doc}
	args := map[string]any{"sessionId": "old", "messageId": "message"}
	read := func() map[string]any { return runToolTest(t, w, "get_agent_history_message", args) }
	first := read()
	cursor, _ := first["nextCursor"].(string)
	if cursor == "" || agentMap(first["message"])["text"] != prefix || first["remainingCharacters"] != 12003 {
		t.Fatal("first page cut or changed the original Unicode text")
	}
	args["cursor"] = cursor
	second := read()
	if agentMap(second["message"])["text"] != string([]rune(suffix)[:12000]) || second["remainingCharacters"] != 3 || second["nextCursor"] == nil {
		t.Fatal("middle page skipped or duplicated characters")
	}
	args["cursor"] = second["nextCursor"]
	last := read()
	if agentMap(last["message"])["text"] != string([]rune(suffix)[12000:]) || last["remainingCharacters"] != 0 || last["nextCursor"] != nil {
		t.Fatal("last page did not terminate with the full remaining text")
	}
	for _, invalid := range []any{"bad", 15, strings.Repeat("a", 97)} {
		args["cursor"] = invalid
		if got := read()["code"]; got != "invalid_history_cursor" {
			t.Fatalf("invalid cursor returned %v", got)
		}
	}
	args["cursor"], args["messageId"] = cursor, "other"
	if got := read()["code"]; got != "history_message_changed" {
		t.Fatalf("cursor worked for a different message: %v", got)
	}
	source["text"] = prefix + "changed" + suffix
	doc.AgentSessions = json.RawMessage(agentJSON([]map[string]any{session}))
	w.doc, err = canvas.SaveAtRevision(owner, doc)
	if err != nil {
		t.Fatal(err)
	}
	args["messageId"] = "message"
	if got := read()["code"]; got != "history_message_changed" {
		t.Fatalf("cursor worked after the body changed: %v", got)
	}
}

func TestCanvasAgentScriptReadIncludesOrderedProductionStateWithoutExtraNodeReads(t *testing.T) {
	hasAudio := true
	w := toolTestWorker(
		CanvasNode{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{
			{ID: "first", Seconds: 15, ImageNodeID: "frame", VideoNodeID: "b"},
			{ID: "second", Seconds: 15, VideoNodeID: "a"},
		}}},
		CanvasNode{ID: "a", Type: "video", URL: "/a.mp4", TaskID: "task-a", GenerationStatus: "success", MediaMetadata: &CanvasMediaMetadata{DurationMS: 15083, HasAudio: &hasAudio}},
		CanvasNode{ID: "frame", Type: "image", URL: "/frame.png", GenerationStatus: "success"},
		CanvasNode{ID: "b", Type: "video", URL: "/b.mp4", TaskID: "task-b", GenerationStatus: "success", MediaMetadata: &CanvasMediaMetadata{DurationMS: 15084}},
	)
	w.doc.AgentRun = &CanvasAgentRun{}
	before := agentJSON(w.doc)
	node := agentMap(runToolTest(t, w, "get_node", map[string]any{"nodeId": "script"})["node"])
	production := agentMap(node["production"])
	if production["canMerge"] != true || production["totalShots"] != 2 || production["plannedDurationSeconds"] != 30 || production["actualDurationMS"] != int64(30167) {
		t.Fatalf("script production state missing or duration guessed: %v", production)
	}
	shots, ok := production["shots"].([]map[string]any)
	if !ok || len(shots) != 2 || shots[0]["shotId"] != "first" || shots[1]["shotId"] != "second" {
		t.Fatalf("shot order differs from script: %v", production)
	}
	video := agentMap(shots[0]["video"])
	if video["nodeId"] != "b" || video["taskId"] != "task-b" || video["ready"] != true || video["outdated"] != false || shots[0]["qualityStatus"] != "unchecked" {
		t.Fatalf("current media state is incomplete: %v", shots[0])
	}
	if metadata, ok := video["mediaMetadata"].(*CanvasMediaMetadata); !ok || metadata.DurationMS != 15084 || metadata.HasAudio != nil {
		t.Fatalf("unknown audio was treated as known: %v", video)
	}
	if body := agentJSON(production); strings.Contains(body, "/a.mp4") || strings.Contains(body, "/b.mp4") || strings.Contains(body, "/frame.png") {
		t.Fatalf("production status repeated transport URLs: %s", body)
	}
	if before != agentJSON(w.doc) {
		t.Fatal("read changed the script, media, or review records")
	}
}

func TestCanvasAgentScriptReadRejectsUnusableClipsAndDoesNotGuessMissingMeasurements(t *testing.T) {
	for _, state := range []string{"unbound", "missing", "wrong-type", "outdated", "loading", "error", "empty", "unmeasured"} {
		t.Run(state, func(t *testing.T) {
			shot := CanvasScriptShot{ID: "first", Seconds: 15, VideoNodeID: "clip", QualityReview: &CanvasScriptQualityReview{MediaURL: "/clip.mp4", Continuity: "passed", Dialogue: "passed", Speaker: "passed", LipSync: "passed"}}
			clip := CanvasNode{ID: "clip", Type: "video", URL: "/clip.mp4", GenerationStatus: "success", GenerationVideoSeconds: 15}
			switch state {
			case "unbound":
				shot.VideoNodeID = ""
			case "missing":
				clip.ID = "other"
			case "wrong-type":
				clip.Type = "image"
			case "outdated":
				shot.VideoOutdated = true
			case "loading", "error":
				clip.GenerationStatus = state
			case "empty":
				clip.URL = ""
			}
			w := toolTestWorker(CanvasNode{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Shots: []CanvasScriptShot{shot}}}, clip)
			w.doc.AgentRun = &CanvasAgentRun{}
			read := func() map[string]any {
				return agentMap(agentMap(runToolTest(t, w, "get_node", map[string]any{"nodeId": "script"})["node"])["production"])
			}
			production := read()
			if production["canMerge"] != (state == "unmeasured") || production["actualDurationMS"] != nil {
				t.Fatalf("unusable clip accepted or requested duration reported as measured: %v", production)
			}
			shots, ok := production["shots"].([]map[string]any)
			if !ok || len(shots) != 1 || state != "unmeasured" && shots[0]["qualityStatus"] != "unchecked" {
				t.Fatalf("stale review accepted: %v", production)
			}
			w.node("script").ScriptProject.Shots[0].VideoNodeID = clip.ID
			w.node("script").ScriptProject.Shots[0].VideoOutdated = false
			w.doc.Nodes[1].Type, w.doc.Nodes[1].GenerationStatus, w.doc.Nodes[1].URL = "video", "success", "/new.mp4"
			if current := read(); current["canMerge"] != true || current["shots"].([]map[string]any)[0]["qualityStatus"] != "unchecked" {
				t.Fatalf("read retained stale status or a review of the replaced clip: %v", current)
			}
		})
	}
	w := toolTestWorker(CanvasNode{ID: "plain", Type: "text"})
	w.doc.AgentRun = &CanvasAgentRun{}
	if node := agentMap(runToolTest(t, w, "get_node", map[string]any{"nodeId": "plain"})["node"]); node["production"] != nil {
		t.Fatalf("ordinary node gained script state: %v", node)
	}
}

func TestCanvasAgentToolUpdatePlanValidatesSteps(t *testing.T) {
	w := toolTestWorker()
	duplicate := map[string]any{"steps": []any{map[string]any{"id": "1", "status": "pending"}, map[string]any{"id": "1", "status": "pending"}}}
	if result := runToolTest(t, w, "update_plan", duplicate); util.Clean(result["code"]) != "invalid_plan" {
		t.Fatalf("duplicate plan result = %#v", result)
	}
	twoRunning := map[string]any{"steps": []any{map[string]any{"id": "1", "status": "in_progress"}, map[string]any{"id": "2", "status": "in_progress"}}}
	if result := runToolTest(t, w, "update_plan", twoRunning); util.Clean(result["code"]) != "invalid_plan" {
		t.Fatalf("two running steps result = %#v", result)
	}
	valid := map[string]any{"steps": []any{map[string]any{"id": "1", "status": "in_progress"}, map[string]any{"id": "2", "status": "pending"}}}
	if result := runToolTest(t, w, "update_plan", valid); result["ok"] != true || w.state["plan"] == nil {
		t.Fatalf("valid plan result = %#v, state = %#v", result, w.state)
	}
}

func TestCanvasAgentToolConnectionLifecycle(t *testing.T) {
	w := toolTestWorker(CanvasNode{ID: "a", Type: "text"}, CanvasNode{ID: "b", Type: "image"}, CanvasNode{ID: "g", Type: "group"})
	if result := runToolTest(t, w, "create_connection", map[string]any{"fromNodeId": "a", "toNodeId": "a"}); util.Clean(result["code"]) != "invalid_connection" {
		t.Fatalf("self connection result = %#v", result)
	}
	if result := runToolTest(t, w, "create_connection", map[string]any{"fromNodeId": "a", "toNodeId": "g"}); util.Clean(result["code"]) != "invalid_connection" {
		t.Fatalf("group connection result = %#v", result)
	}
	first := runToolTest(t, w, "create_connection", map[string]any{"fromNodeId": "a", "toNodeId": "b"})
	second := runToolTest(t, w, "create_connection", map[string]any{"fromNodeId": "a", "toNodeId": "b"})
	if first["ok"] != true || first["connectionId"] == "" || first["connectionId"] != second["connectionId"] || len(w.doc.Connections) != 1 {
		t.Fatalf("duplicate connection was not deduplicated: %#v %#v, connections = %d", first, second, len(w.doc.Connections))
	}
	if result := runToolTest(t, w, "delete_connection", map[string]any{"connectionId": "missing"}); util.Clean(result["code"]) != "connection_not_found" {
		t.Fatalf("missing connection result = %#v", result)
	}
	if result := runToolTest(t, w, "delete_connection", map[string]any{"connectionId": first["connectionId"]}); result["ok"] != true || len(w.doc.Connections) != 0 {
		t.Fatalf("delete result = %#v, connections = %d", result, len(w.doc.Connections))
	}
}

func TestCanvasAgentToolUpdateTextNodeRejectsNonTextNodes(t *testing.T) {
	w := toolTestWorker(CanvasNode{ID: "t", Type: "text", Prompt: "old"}, CanvasNode{ID: "i", Type: "image"})
	if result := runToolTest(t, w, "update_text_node", map[string]any{"nodeId": "i", "content": "x"}); util.Clean(result["code"]) != "invalid_node_type" {
		t.Fatalf("non-text update result = %#v", result)
	}
	if result := runToolTest(t, w, "update_text_node", map[string]any{"nodeId": "t", "title": "new", "content": "body"}); result["ok"] != true {
		t.Fatalf("text update result = %#v", result)
	}
	if node := w.node("t"); node.Prompt != "body" || node.Title != "new" || node.GenerationStatus != "success" {
		t.Fatalf("text node after update = %#v", *node)
	}
}

func TestCanvasAgentToolCreateGroupValidatesMembers(t *testing.T) {
	w := toolTestWorker(CanvasNode{ID: "a", Type: "text", X: 10, Y: 20, Width: 100, Height: 50}, CanvasNode{ID: "b", Type: "text", X: 200, Y: 40, Width: 100, Height: 50})
	if result := runToolTest(t, w, "create_group", map[string]any{"title": "g", "nodeIds": []string{"a"}}); util.Clean(result["code"]) != "invalid_group" {
		t.Fatalf("single member group result = %#v", result)
	}
	if result := runToolTest(t, w, "create_group", map[string]any{"title": "g", "nodeIds": []string{"a", "a"}}); util.Clean(result["code"]) != "invalid_group" {
		t.Fatalf("duplicate member group result = %#v", result)
	}
	result := runToolTest(t, w, "create_group", map[string]any{"title": "g", "nodeIds": []string{"a", "b"}})
	groupID := util.Clean(result["groupId"])
	if result["ok"] != true || groupID == "" || w.node("a").GroupID != groupID || w.node("b").GroupID != groupID {
		t.Fatalf("group result = %#v", result)
	}
	group := w.node(groupID)
	if group.X != 10-24 || group.Y != 20-48 || group.Width != 290+48 {
		t.Fatalf("group bounds = (%v, %v, %v), want padded bounding box", group.X, group.Y, group.Width)
	}
	if result := runToolTest(t, w, "create_group", map[string]any{"title": "again", "nodeIds": []string{"a", "b"}}); util.Clean(result["code"]) != "invalid_group" {
		t.Fatalf("regrouping result = %#v", result)
	}
}

func TestCanvasAgentToolArrangeRequiresUserRequest(t *testing.T) {
	if canvasAgentArrangeRequested("> 旧要求：整理画布") || !canvasAgentArrangeRequested("> 不要整理\n\n请整理画布") {
		t.Fatal("layout permission must follow the direct request")
	}
	for _, text := range []string{"随便聊聊", "不整理画布，只回答问题", "整理一下文案", "请整理对白", "请整理画布，但先不要执行", "请整理画布，但不要移动节点", "先不要执行；请整理画布", "不能整理画布", "不要整理画布，只回答问题", "别重新排列", "无需调整画布布局", "不用整理", "不需要整理", "请不要整理", "Do not arrange the canvas", "don't rearrange nodes", "No need to arrange nodes", "整理画布先不要做", "先保持布局不变",
		"解释一下整理画布功能", "把整理画布写进标题", "整理画布这几个字", "请整理画布功能", "请把整理画布写进标题", "请介绍整理画布", "整理画布是什么意思？", "请整理画布功能怎么用", "如何整理画布", "如果需要，请整理画布", "请不要移动任何节点，也不要在未经确认时自动整理画布",
		"他说‘请整理画布’", "把‘整理画布’写进标题", "节点内容：整理画布", "`整理画布`", "```\n整理画布\n```", "```\n整理画布", "引用：‘\n整理画布", "请把画布整理一下但不要执行", "Please explain how to arrange the canvas", "Can you arrange the canvas?", "If needed, arrange the canvas", "Do not move any existing nodes or automatically arrange the canvas"} {
		t.Run(text, func(t *testing.T) {
			w := toolTestWorker(CanvasNode{ID: "a", Type: "text", X: 999, Y: 888})
			w.req.UserText = text
			result := runToolTest(t, w, "arrange_nodes", map[string]any{})
			if util.Clean(result["code"]) != "action_not_requested" || w.node("a").X != 999 || w.node("a").Y != 888 {
				t.Fatalf("unrequested arrangement changed canvas: result=%#v position=(%v,%v)", result, w.node("a").X, w.node("a").Y)
			}
		})
	}
	for _, text := range []string{"请整理画布", "请对齐节点", "请重新排版", "Please ARRANGE the canvas", "整理画布", "帮我整理一下画布", "请把画布整理一下", "先读取节点，再对齐节点", "请重新摆放节点", "Rearrange the nodes", "Please align the nodes"} {
		t.Run(text, func(t *testing.T) {
			w := toolTestWorker(CanvasNode{ID: "a", Type: "text", X: 999, Y: 999}, CanvasNode{ID: "b", Type: "text", X: 5, Y: 5})
			w.req.UserText = text
			if result := runToolTest(t, w, "arrange_nodes", map[string]any{}); result["ok"] != true || w.node("a").X != 0 || w.node("b").X != 640 {
				t.Fatalf("arrange result = %#v, nodes = %#v %#v", result, *w.node("a"), *w.node("b"))
			}
		})
	}
}

func TestCanvasAgentToolQueryNodesFiltersAndPages(t *testing.T) {
	w := toolTestWorker(CanvasNode{ID: "a", Type: "text", Title: "Alpha"}, CanvasNode{ID: "b", Type: "image", Title: "Beta"}, CanvasNode{ID: "c", Type: "text", Title: "Gamma"})
	result := runToolTest(t, w, "query_canvas_nodes", map[string]any{"type": "text"})
	if result["total"] != 2 {
		t.Fatalf("type filter total = %v, want 2", result["total"])
	}
	result = runToolTest(t, w, "query_canvas_nodes", map[string]any{"keyword": "BETA"})
	if result["total"] != 1 {
		t.Fatalf("keyword filter total = %v, want 1", result["total"])
	}
	result = runToolTest(t, w, "query_canvas_nodes", map[string]any{"pageSize": 1, "page": 2})
	nodes := result["nodes"].([]map[string]any)
	if result["total"] != 3 || len(nodes) != 1 || nodes[0]["id"] != "b" {
		t.Fatalf("paged result = %#v", result)
	}
	w.req.SelectedNodeIDs = []string{"c"}
	result = runToolTest(t, w, "get_selected_nodes", map[string]any{})
	if result["total"] != 1 {
		t.Fatalf("selected total = %v, want 1", result["total"])
	}
}

func TestCanvasAgentToolArrangeFitsLargeGroupsAndPreservesRequestedOrder(t *testing.T) {
	w := toolTestWorker(
		CanvasNode{ID: "a", Type: "text", Width: 1000, Height: 900},
		CanvasNode{ID: "b", Type: "text", Width: 300, Height: 300},
		CanvasNode{ID: "g", Type: "group", X: 800, Y: 900, Width: 1400, Height: 1000},
		CanvasNode{ID: "child", Type: "image", GroupID: "g", X: 824, Y: 948, Width: 300, Height: 300},
		CanvasNode{ID: "c", Type: "text", Width: 300, Height: 300},
		CanvasNode{ID: "d", Type: "text", Width: 300, Height: 300},
	)
	w.req.UserText = "请整理画布"
	result := runToolTest(t, w, "arrange_nodes", map[string]any{"nodeIds": []string{"g", "a", "b", "c", "d"}})
	if result["ok"] != true || w.node("g").X != 0 || w.node("a").X < w.node("g").Width+72 || w.node("b").X < w.node("a").X+w.node("a").Width+72 || w.node("d").Y < 1072 {
		t.Fatalf("large nodes overlap or requested order lost: %v %+v", result, w.doc.Nodes)
	}
	if child := w.node("child"); child.X != 24 || child.Y != 48 {
		t.Fatalf("group movement lost child offsets: %+v", child)
	}
}

func TestCanvasAgentToolRequiresReviewBeforeGeneration(t *testing.T) {
	w := toolTestWorker(CanvasNode{ID: "img", Type: "image", Prompt: "p"})
	w.state["pendingWorkflowReview"] = map[string]any{"nodeIds": []string{"img"}}
	result := runToolTest(t, w, "generate_node", map[string]any{"nodeId": "img"})
	if util.Clean(result["code"]) != "workflow_review_required" || result["submitted"] != false {
		t.Fatalf("unreviewed generate_node result = %#v", result)
	}
	result = runToolTest(t, w, "generate_image", map[string]any{"title": "new"})
	if util.Clean(result["code"]) != "workflow_review_required" {
		t.Fatalf("new media node bypassed review: %#v", result)
	}
}

func TestCanvasAgentResolveMediaReferencesRejectsDuplicatesAndGroupsByKind(t *testing.T) {
	w := toolTestWorker(
		CanvasNode{ID: "i", Type: "image", URL: "https://example.test/i.png"},
		CanvasNode{ID: "v", Type: "video", URL: "https://example.test/v.mp4"},
		CanvasNode{ID: "t", Type: "text", URL: ""},
	)
	refs, err := w.resolveMediaReferences([]string{"i", "v", "t"}, nil)
	if err != nil || len(refs.Images) != 1 || len(refs.Videos) != 1 || len(refs.Audios) != 0 || len(refs.NodeIDs) != 3 {
		t.Fatalf("resolveMediaReferences() = (%#v, %v)", refs, err)
	}
	if _, err := w.resolveMediaReferences([]string{"i", "i"}, nil); err == nil {
		t.Fatal("duplicate source node accepted")
	}
	if _, err := w.resolveMediaReferences([]string{"missing"}, nil); err == nil {
		t.Fatal("missing source node accepted")
	}
}

func TestCanvasAgentValidateMediaEnforcesCapabilities(t *testing.T) {
	w := toolTestWorker()
	w.req.Generation = map[string]any{"capabilities": map[string]any{"image": map[string]any{"maxCount": float64(2), "qualities": []any{"high"}, "resolutions": []any{"2k"}}}}
	base := CanvasNode{Type: "image", GenerationSize: "1:1", GenerationCount: 1}
	if err := w.validateMedia(base); err != nil {
		t.Fatalf("valid image rejected: %v", err)
	}
	for name, mutate := range map[string]func(*CanvasNode){
		"count too high":      func(n *CanvasNode) { n.GenerationCount = 3 },
		"count zero":          func(n *CanvasNode) { n.GenerationCount = 0 },
		"unsupported quality": func(n *CanvasNode) { n.GenerationQuality = "low" },
		"missing size":        func(n *CanvasNode) { n.GenerationSize = "" },
		"bad resolution":      func(n *CanvasNode) { n.GenerationResolution = "8k" },
	} {
		node := base
		mutate(&node)
		if err := w.validateMedia(node); err == nil {
			t.Errorf("%s: validateMedia() accepted the node", name)
		}
	}
}
