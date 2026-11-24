package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentParallelReviewsUseCurrentNodeRevisions(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	var dispatched atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		if request.Diagnostic["purpose"] == "review" {
			dispatched.Add(1)
			id := util.Clean(request.Diagnostic["nodeId"])
			other := "second"
			if id == "second" {
				other = "first"
			}
			input := agentJSON(request.Messages)
			if request.Metadata["tools"] != nil || !strings.Contains(input, "body-"+id) || strings.Contains(input, "body-"+other) {
				t.Error("review received tools or another node's content")
			}
			started <- id
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return map[string]any{"text_response": "finding-" + id}, nil
			}
		}
		if dispatched.Load() != 0 {
			input := agentJSON(request.Messages)
			if !strings.Contains(input, "finding-second") || strings.Contains(input, "finding-first") || !strings.Contains(input, "sourceRevision") {
				t.Error("main Agent received a stale review or lost a current review")
			}
			return map[string]any{"text_response": "已汇总审阅"}, nil
		}
		return agentTurn(agentCall("review", "review_canvas_nodes", map[string]any{"nodeIds": []string{"first", "second"}, "question": "检查表述"})), nil
	}, nil)
	for _, id := range []string{"first", "second"} {
		doc.Nodes = append(doc.Nodes, CanvasNode{ID: id, Type: "text", Title: "草稿 " + id, Prompt: "body-" + id, Width: 320, Height: 120, ScaleX: 1, ScaleY: 1})
	}
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.ReadOnly, req.ModelRequestLimit = true, 4
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(10 * time.Second)
	for range doc.Nodes {
		select {
		case <-started:
		case <-timeout:
			t.Fatal("both reviewers must start before either finishes")
		}
	}
	current, err := svc.canvas.Project(identity.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Nodes[0].Prompt = "用户编辑后的正文"
	current.Nodes[1].X += 100
	if _, err := svc.canvas.SaveAtRevision(identity.ID, current); err != nil {
		t.Fatal(err)
	}
	close(release)
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	message := util.AsMapSlice(session["messages"])[1]
	trace := util.AsMapSlice(message["trace"])
	index := slices.IndexFunc(trace, func(entry map[string]any) bool { return entry["kind"] == "subagent" })
	if done.AgentRun.Status != "success" || index < 0 || dispatched.Load() != 2 || done.Nodes[0].Prompt != "用户编辑后的正文" {
		t.Fatalf("run=%+v traces=%v reviews=%d", done.AgentRun, trace, dispatched.Load())
	}
	members := util.AsMapSlice(agentMap(trace[index]["subagent"])["agents"])
	if len(members) != 2 || members[0]["status"] != "changed" || members[1]["status"] != "completed" {
		t.Fatalf("review statuses = %v", members)
	}
	attempts := util.AsMapSlice(message["modelAttempts"])
	if len(attempts) != 4 || attempts[1]["purpose"] != "review" || attempts[2]["purpose"] != "review" {
		t.Fatalf("child model calls missing from run diagnostics: %v", attempts)
	}
}

func TestCanvasAgentReviewAdmissionAndInterruption(t *testing.T) {
	started, stopped := make(chan struct{}, 1), make(chan struct{}, 1)
	w := memoryWorker(t, func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		return nil, ctx.Err()
	})
	w.doc.Nodes = []CanvasNode{{ID: "draft", Type: "text", Title: "草稿", Prompt: "正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	call := map[string]any{"id": "review", "name": "review_canvas_nodes", "arguments": map[string]any{"nodeIds": []string{"draft"}, "question": "检查草稿"}}
	w.req.ModelRequestLimit = 1
	if result, err := w.reviewCanvasNodes(call, nil); err != nil || result["code"] != "review_request_limit" || w.modelRequests != 0 {
		t.Fatalf("insufficient limit admitted review: %v, %v", result, err)
	}
	w.req.ModelRequestLimit = 2
	ctx, cancel := context.WithCancel(w.ctx)
	defer cancel()
	w.ctx = ctx
	ended := make(chan error, 1)
	go func() { _, err := w.reviewCanvasNodes(call, nil); ended <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("review did not start")
	}
	cancel()
	select {
	case err := <-ended:
		if !errors.Is(err, context.Canceled) || len(stopped) != 1 || w.modelRequests != 1 {
			t.Fatalf("review did not join the cancelled worker: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("review did not stop")
	}
	if err := w.finish("cancelled", "已停止"); err != nil {
		t.Fatal(err)
	}
	trace := util.AsMapSlice(w.assistant()["trace"])[0]
	member := util.AsMapSlice(agentMap(trace["subagent"])["agents"])[0]
	if member["status"] != "interrupted" {
		t.Fatalf("cancelled review still appears active: %v", member)
	}
}

func TestCanvasAgentDraftTimeoutPreservesCompletedSibling(t *testing.T) {
	w := memoryWorker(t, func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		if request.Diagnostic["nodeId"] == "slow" {
			<-ctx.Done()
			if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
				t.Error("slow model did not receive the child deadline")
			}
			return map[string]any{"text_response": `{"content":"late draft"}`}, nil
		}
		return map[string]any{"text_response": `{"content":"current draft"}`}, nil
	})
	for _, id := range []string{"slow", "fast"} {
		node := w.newNode("text", id, "original "+id)
		node.ID = id
		w.addNode(node, nil)
	}
	plans := []map[string]any{
		{"key": "slow", "nodeId": "slow", "question": "Revise the first draft"},
		{"key": "fast", "nodeId": "fast", "question": "Revise the second draft"},
	}
	tasks := util.AsMapSlice(w.planCanvasTextEditTasks(map[string]any{"tasks": plans})["tasks"])
	if len(tasks) != 2 {
		t.Fatalf("unexpected tasks: %v", tasks)
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	draft := map[string]any{"id": "mixed-draft", "name": "draft_canvas_text_tasks", "arguments": map[string]any{"tasks": []map[string]any{
		{"id": tasks[0]["id"], "expectedRevision": 1},
		{"id": tasks[1]["id"], "expectedRevision": 1},
	}}}
	var result any
	var err error
	synctest.Test(t, func(t *testing.T) {
		w.batchCalls = []map[string]any{draft}
		result, err = w.sdkTool(draft)
	})
	reviews := util.AsMapSlice(agentMap(result)["reviews"])
	if err != nil || len(reviews) != 2 || reviews[0]["code"] != "review_timeout" || reviews[0]["proposalId"] != nil ||
		reviews[1]["status"] != "completed" || reviews[1]["content"] != "current draft" || w.modelRequests != 2 || w.ctx.Err() != nil {
		t.Fatalf("unexpected draft result: %v, %v", result, err)
	}
	doc, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := agentSession(doc, w.req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	board := agentMap(session["textEditTasks"])
	if agentMap(board[util.Clean(tasks[0]["id"])])["status"] != "failed" || agentMap(board[util.Clean(tasks[1]["id"])])["status"] != "drafted" {
		t.Fatalf("unexpected saved task states: %v", board)
	}
	apply := map[string]any{"id": "apply-fast", "name": "apply_canvas_text_edits", "arguments": map[string]any{"proposalIds": []string{util.Clean(reviews[1]["proposalId"])}}}
	w.batchCalls = []map[string]any{apply}
	if result, err := w.sdkTool(apply); err != nil || agentMap(result)["ok"] != true || w.node("fast").Prompt != "current draft" || w.node("slow").Prompt != "original slow" {
		t.Fatalf("applying completed sibling failed: %v, %v", result, err)
	}
}

func TestCanvasAgentCompletedReviewReceiptRechecksEditedNode(t *testing.T) {
	w := memoryWorker(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		t.Fatal("a completed review was dispatched again")
		return nil, nil
	})
	w.doc.Nodes = []CanvasNode{{ID: "draft", Type: "text", Title: "草稿", Prompt: "旧正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1}}
	call := map[string]any{"id": "review", "name": "review_canvas_nodes", "arguments": map[string]any{"nodeIds": []string{"draft"}, "question": "检查草稿"}}
	result := map[string]any{"ok": true, "reviews": []map[string]any{{"nodeId": "draft", "status": "completed", "text": "旧结论", "sourceRevision": canvasAgentReviewRevision(canvasAgentReviewSnapshot(w.doc.Nodes[0]))}}}
	w.activeCall = call
	w.record(call, result)
	agentMap(agentMap(w.session["toolReceipts"])["review"])["done"] = true
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	current := cloneCanvasAgentDocument(w.doc)
	current.Nodes[0].Prompt = "新正文"
	if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
		t.Fatal(err)
	}
	got, err := w.sdkTool(call)
	if err != nil {
		t.Fatal(err)
	}
	reviews := util.AsMapSlice(agentMap(got)["reviews"])
	if len(reviews) != 1 || reviews[0]["status"] != "changed" || reviews[0]["text"] == "旧结论" || w.modelRequests != 0 {
		t.Fatalf("stale review receipt was reused: %v", got)
	}
}

func TestCanvasAgentDraftsAndAppliesTextEdits(t *testing.T) {
	var turns, drafts atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		if request.Diagnostic["purpose"] == "review" {
			drafts.Add(1)
			id := util.Clean(request.Diagnostic["nodeId"])
			return map[string]any{"text_response": agentJSON(map[string]any{"content": "edited-" + id, "notes": "已起草"})}, nil
		}
		switch turns.Add(1) {
		case 1:
			return agentTurn(agentCall("draft", "draft_canvas_text_edits", map[string]any{"nodeIds": []string{"first", "second"}, "question": "改写这两个文本"})), nil
		case 2:
			var proposals []string
			for _, message := range request.Messages {
				if message["name"] != "draft_canvas_text_edits" {
					continue
				}
				var result map[string]any
				_ = json.Unmarshal([]byte(util.Clean(message["content"])), &result)
				for _, review := range util.AsMapSlice(result["reviews"]) {
					proposals = append(proposals, util.Clean(review["proposalId"]))
				}
			}
			if len(proposals) != 2 || proposals[0] == "" || proposals[1] == "" {
				return nil, fmt.Errorf("missing proposals: %v", proposals)
			}
			return agentTurn(agentCall("apply", "apply_canvas_text_edits", map[string]any{"proposalIds": proposals})), nil
		default:
			return agentTurn(), nil
		}
	}, nil)
	for _, id := range []string{"first", "second"} {
		doc.Nodes = append(doc.Nodes, CanvasNode{ID: id, Type: "text", Title: id, Prompt: "original-" + id, Width: 320, Height: 120, ScaleX: 1, ScaleY: 1})
	}
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.UserText, req.ModelRequestLimit = "请改写这两个文本节点", 5
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || drafts.Load() != 2 || done.Nodes[0].Prompt != "edited-first" || done.Nodes[1].Prompt != "edited-second" {
		t.Fatalf("run=%+v drafts=%d nodes=%v", done.AgentRun, drafts.Load(), done.Nodes)
	}
}

func TestCanvasAgentTextEditBatchRejectsConcurrentChange(t *testing.T) {
	w := memoryWorker(t, nil)
	for _, id := range []string{"first", "second"} {
		w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: id, Type: "text", Title: id, Prompt: "original-" + id, Width: 320, Height: 120, ScaleX: 1, ScaleY: 1})
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	first := w.saveCanvasTextEditProposal("first", canvasTextEditRevision(w.doc.Nodes[0]), "draft", "edited-first")
	duplicate := w.saveCanvasTextEditProposal("first", canvasTextEditRevision(w.doc.Nodes[0]), "draft2", "overlapping edit")
	second := w.saveCanvasTextEditProposal("second", canvasTextEditRevision(w.doc.Nodes[1]), "draft", "edited-second")
	w.req.ID = "other-run"
	if result, _ := w.applyCanvasTextEdits(map[string]any{"proposalIds": []string{first}}); result["code"] != "text_edit_not_found" {
		t.Fatalf("accepted a proposal from another run: %v", result)
	}
	w.req.ID = w.doc.AgentRun.ID
	if result, _ := w.applyCanvasTextEdits(map[string]any{"proposalIds": []string{first, duplicate}}); result["code"] != "text_edit_overlap" {
		t.Fatalf("accepted overlapping proposals: %v", result)
	}
	current := cloneCanvasAgentDocument(w.doc)
	result, revisions := w.applyCanvasTextEdits(map[string]any{"proposalIds": []string{first, second}})
	if result["ok"] != true {
		t.Fatal(result)
	}
	current.Nodes[1].Title = "用户新标题"
	if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
		t.Fatal(err)
	}
	if err := w.saveWithNodeRevisions(revisions); !errors.Is(err, errCanvasTextEditStale) {
		t.Fatalf("wanted a rejected revision, got %v", err)
	}
	current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Nodes[0].Prompt != "original-first" || current.Nodes[1].Prompt != "original-second" || current.Nodes[1].Title != "用户新标题" {
		t.Fatalf("stale batch was partially written: %v", current.Nodes)
	}
}

func TestCanvasAgentTextEditPreservesUnrelatedConcurrentChanges(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{
		{ID: "draft", Type: "text", Title: "草稿", Prompt: "原始正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1},
		{ID: "notes", Type: "text", Title: "备注", Prompt: "原始备注", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1},
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	proposal := w.saveCanvasTextEditProposal("draft", canvasTextEditRevision(w.doc.Nodes[0]), "draft-call", "修改后的正文")
	current := cloneCanvasAgentDocument(w.doc)
	result, revisions := w.applyCanvasTextEdits(map[string]any{"proposalIds": []string{proposal}})
	if result["ok"] != true {
		t.Fatal(result)
	}
	current.Nodes[0].X = 200
	current.Nodes[1].Prompt = "用户的新备注"
	if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
		t.Fatal(err)
	}
	if err := w.saveWithNodeRevisions(revisions); err != nil {
		t.Fatal(err)
	}
	if w.doc.Nodes[0].Prompt != "修改后的正文" || w.doc.Nodes[0].X != 200 || w.doc.Nodes[1].Prompt != "用户的新备注" {
		t.Fatalf("proposal lost concurrent changes: %v", w.doc.Nodes)
	}
}

func TestCanvasAgentTextTasksResumeAcrossRunsAndCheckDependencies(t *testing.T) {
	var drafts atomic.Int32
	var serial int
	w := memoryWorker(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		id := util.Clean(request.Diagnostic["nodeId"])
		if id == "next" && !strings.Contains(agentJSON(request.Messages), "已提交的新上游正文") {
			t.Error("downstream did not receive committed upstream text")
		}
		drafts.Add(1)
		return map[string]any{"text_response": agentJSON(map[string]any{"content": "已提交的新上游正文", "notes": "已起草"})}, nil
	})
	w.doc.Nodes = []CanvasNode{
		{ID: "first", Type: "text", Title: "上游", Prompt: "旧上游正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1},
		{ID: "next", Type: "text", Title: "下游", Prompt: "旧下游正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1},
		{ID: "closing", Type: "text", Title: "收尾", Prompt: "旧收尾正文", Width: 320, Height: 120, ScaleX: 1, ScaleY: 1},
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	plans := []map[string]any{
		{"key": "first", "nodeId": "first", "question": "更新上游", "dependsOn": []string{"next"}},
		{"key": "next", "nodeId": "next", "question": "跟随上游", "dependsOn": []string{"first"}},
	}
	if result := w.planCanvasTextEditTasks(map[string]any{"tasks": plans}); result["code"] != "invalid_text_task_dependency" {
		t.Fatalf("cyclic plan accepted: %v", result)
	}
	plans[0]["dependsOn"] = []string{}
	firstPlan := w.planCanvasTextEditTasks(map[string]any{"tasks": plans[:1]})
	firstTasks := util.AsMapSlice(firstPlan["tasks"])
	if len(firstTasks) != 1 {
		t.Fatalf("first plan failed: %v", firstPlan)
	}
	firstID := util.Clean(firstTasks[0]["id"])
	newBatch := []map[string]any{
		plans[1],
		{"key": "closing", "nodeId": "closing", "question": "综合上游和下游", "dependsOn": []string{firstID, "next"}},
	}
	for _, deps := range [][]string{{"missing"}, {firstID, firstID}} {
		plans[1]["dependsOn"] = deps
		if result := w.planCanvasTextEditTasks(map[string]any{"tasks": []map[string]any{newBatch[1], newBatch[0]}}); result["code"] != "invalid_text_task_dependency" {
			t.Fatalf("invalid dependency accepted: %v", result)
		}
		if board := util.AsMapSlice(w.listCanvasTextEditTasks("")["tasks"]); len(board) != 1 {
			t.Fatalf("invalid plan changed the board: %v", board)
		}
	}
	plans[1]["dependsOn"] = []string{firstID}
	calls, err := agentCalls([]map[string]any{agentCall("plan-next", "plan_canvas_text_tasks", map[string]any{"tasks": newBatch})})
	if err != nil {
		t.Fatal(err)
	}
	w.batchCalls = calls
	result, err := w.sdkTool(calls[0])
	tasks := util.AsMapSlice(agentMap(result)["tasks"])
	if err != nil || len(tasks) != 2 || !slices.Equal(agentStrings(tasks[0]["dependsOn"]), []string{firstID}) ||
		!slices.Equal(agentStrings(tasks[1]["dependsOn"]), []string{firstID, util.Clean(tasks[0]["id"])}) {
		t.Fatalf("could not create a task with an existing dependency: %v, %v", result, err)
	}
	nextID, closingID := tasks[0]["id"], tasks[1]["id"]
	draft := func(id any, revision int) (map[string]any, error) {
		serial++
		call := map[string]any{"id": fmt.Sprintf("draft-%d", serial), "name": "draft_canvas_text_tasks", "arguments": map[string]any{"tasks": []map[string]any{{"id": id, "expectedRevision": revision}}}}
		w.batchCalls = []map[string]any{call}
		w.batchFailed = false
		result, err := w.sdkTool(call)
		return agentMap(result), err
	}
	if result, err := draft(nextID, 1); err != nil || result["code"] != "text_task_blocked" || drafts.Load() != 0 {
		t.Fatalf("blocked task dispatched: %v %v", result, err)
	}
	drafted, err := draft(firstID, 1)
	if err != nil || drafted["ok"] != true || drafts.Load() != 1 {
		t.Fatalf("draft failed: %v %v", drafted, err)
	}
	if result, err := draft(firstID, 2); err != nil || result["code"] != "stale_text_task_revision" || drafts.Load() != 1 {
		t.Fatalf("stale task dispatched: %v %v", result, err)
	}
	if err := w.finish("success", "已准备上游提案"); err != nil {
		t.Fatal(err)
	}
	w.doc.AgentRun.ID, w.doc.AgentRun.Status = "later-run", "running"
	w.doc, err = w.service.canvas.saveAgent(w.identity.ID, w.doc)
	if err != nil {
		t.Fatal(err)
	}
	_, w.session, _ = agentSession(w.doc, w.req.SessionID)
	w.req.ID = "later-run"
	w.persisted = cloneCanvasAgentDocument(w.doc)
	w.pruneCanvasTextEditProposals()
	first := util.AsMapSlice(w.listCanvasTextEditTasks(util.Clean(firstID))["tasks"])[0]
	if first["status"] != "drafted" || first["content"] != "已提交的新上游正文" {
		t.Fatalf("proposal missing after reload: %v", first)
	}
	apply := map[string]any{"id": "apply-first", "name": "apply_canvas_text_edits", "arguments": map[string]any{"proposalIds": []string{util.Clean(first["proposalId"])}}}
	w.batchCalls, w.batchFailed = []map[string]any{apply}, false
	if response, err := w.sdkTool(apply); err != nil || agentMap(response)["ok"] != true {
		t.Fatalf("apply after reload failed: %v %v", response, err)
	}
	drafted, err = draft(nextID, 1)
	if err != nil || drafted["ok"] != true || drafts.Load() != 2 {
		t.Fatalf("ready downstream task did not run: %v %v", drafted, err)
	}
	next := util.AsMapSlice(w.listCanvasTextEditTasks(util.Clean(nextID))["tasks"])[0]
	current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Nodes[0].Prompt = "更新的上游正文"
	if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
		t.Fatal(err)
	}
	apply = map[string]any{"id": "apply-next", "name": "apply_canvas_text_edits", "arguments": map[string]any{"proposalIds": []string{util.Clean(next["proposalId"])}}}
	w.batchCalls = []map[string]any{apply}
	if response, err := w.sdkTool(apply); err != nil || agentMap(response)["code"] != "canvas_changed" || w.doc.Nodes[1].Prompt != "旧下游正文" {
		t.Fatalf("stale downstream was applied: %v %v", response, err)
	}
	blocker := map[string]any{"id": firstID, "expectedRevision": 4}
	if result := w.removeCanvasTextTask(blocker); result["code"] != "text_task_has_dependents" {
		t.Fatalf("removed a dependency still in use: %v", result)
	}
	if result := w.discardCanvasTextTaskDraft(map[string]any{"id": nextID, "expectedRevision": 2}); result["code"] != "stale_text_task_revision" {
		t.Fatalf("stale caller could discard a newer draft: %v", result)
	}
	if result := w.discardCanvasTextTaskDraft(map[string]any{"id": nextID, "expectedRevision": 3}); result["ok"] != true {
		t.Fatalf("could not discard stale draft: %v", result)
	}
	if result := w.removeCanvasTextTask(map[string]any{"id": closingID, "expectedRevision": 1}); result["ok"] != true {
		t.Fatalf("could not remove final task: %v", result)
	}
	if result := w.removeCanvasTextTask(map[string]any{"id": nextID, "expectedRevision": 4}); result["ok"] != true {
		t.Fatalf("could not remove downstream task: %v", result)
	}
	if result := w.removeCanvasTextTask(blocker); result["ok"] != true || w.doc.Nodes[0].Prompt != "更新的上游正文" {
		t.Fatalf("could not remove completed task without modifying canvas: %v", result)
	}
	if result := w.removeCanvasTextTask(blocker); result["code"] != "text_task_deleted" {
		t.Fatalf("deleted task did not remain an explicit tombstone: %v", result)
	}
	if listed := w.listCanvasTextEditTasks(""); len(util.AsMapSlice(listed["tasks"])) != 0 {
		t.Fatalf("deleted task leaked into the active task list: %v", listed)
	}
}

func TestCanvasAgentReopenTextTaskInvalidatesDownstreamWork(t *testing.T) {
	w := memoryWorker(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		nodeID := util.Clean(request.Diagnostic["nodeId"])
		content := "updated " + nodeID
		if strings.Contains(agentJSON(request.Messages), "Try a different opening") {
			content = "reopened " + nodeID
		}
		return map[string]any{"text_response": agentJSON(map[string]any{"content": content})}, nil
	})
	plans := []map[string]any{}
	for _, key := range []string{"root", "middle", "leaf", "independent"} {
		node := w.newNode("text", key, "initial "+key)
		node.ID = key
		w.addNode(node, nil)
		plans = append(plans, map[string]any{"key": key, "nodeId": key, "question": "Revise " + key, "dependsOn": []string{}})
	}
	plans[1]["dependsOn"], plans[2]["dependsOn"] = []string{"root"}, []string{"middle"}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	var serial int
	runTool := func(call map[string]any) map[string]any {
		t.Helper()
		w.batchCalls, w.batchFailed = []map[string]any{call}, false
		result, err := w.sdkTool(call)
		if err != nil {
			t.Fatal(err)
		}
		return agentMap(result)
	}
	callTool := func(name string, args map[string]any) map[string]any {
		t.Helper()
		serial++
		calls, err := agentCalls([]map[string]any{agentCall(fmt.Sprintf("reopen-%d", serial), name, args)})
		if err != nil {
			t.Fatal(err)
		}
		return runTool(calls[0])
	}
	tasks := util.AsMapSlice(callTool("plan_canvas_text_tasks", map[string]any{"tasks": plans})["tasks"])
	if len(tasks) != 4 {
		t.Fatalf("plan returned %v", tasks)
	}
	draft := func(index, revision int) map[string]any {
		t.Helper()
		return callTool("draft_canvas_text_tasks", map[string]any{"tasks": []map[string]any{
			{"id": tasks[index]["id"], "expectedRevision": revision},
		}})
	}
	proposal := func(index, revision int) string {
		t.Helper()
		result := draft(index, revision)
		reviews := util.AsMapSlice(result["reviews"])
		if len(reviews) != 1 || util.Clean(reviews[0]["proposalId"]) == "" {
			t.Fatalf("draft returned %v", result)
		}
		return util.Clean(reviews[0]["proposalId"])
	}
	apply := func(id string) map[string]any {
		return callTool("apply_canvas_text_edits", map[string]any{"proposalIds": []string{id}})
	}
	for _, index := range []int{0, 1} {
		if result := apply(proposal(index, 1)); result["ok"] != true {
			t.Fatalf("apply returned %v", result)
		}
	}
	leaf := proposal(2, 1)
	independent := proposal(3, 1)
	reopen := func(revision int) map[string]any {
		return callTool("reopen_canvas_text_task", map[string]any{
			"id": tasks[0]["id"], "expectedRevision": revision, "question": "Try a different opening",
		})
	}
	if result := reopen(3); result["code"] != "stale_text_task_revision" {
		t.Fatalf("stale reopen returned %v", result)
	}
	competing := util.AsMapSlice(callTool("plan_canvas_text_tasks", map[string]any{"tasks": []map[string]any{
		{"key": "another-middle", "nodeId": "middle", "question": "Other edit", "dependsOn": []string{}},
	}})["tasks"])
	if len(competing) != 1 {
		t.Fatalf("competing task plan returned %v", competing)
	}
	if result := reopen(4); result["code"] != "text_task_overlap" {
		t.Fatalf("conflicting reopen returned %v", result)
	}
	if result := callTool("remove_canvas_text_task", map[string]any{"id": competing[0]["id"], "expectedRevision": 1}); result["ok"] != true {
		t.Fatalf("could not remove competing task: %v", result)
	}
	if result := reopen(4); result["ok"] != true || len(agentStrings(result["resetTaskIds"])) != 2 {
		t.Fatalf("reopen returned %v", result)
	}
	reopenCall := w.batchCalls[0]
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, w.session, err = agentSession(saved, w.req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	w.doc, w.persisted = saved, cloneCanvasAgentDocument(saved)
	w.state = agentMap(w.session["agentState"])
	if result := runTool(reopenCall); result["ok"] != true {
		t.Fatalf("reopen receipt replay returned %v", result)
	}
	for index, revision := range []int{5, 5, 4} {
		task := util.AsMapSlice(w.listCanvasTextEditTasks(util.Clean(tasks[index]["id"]))["tasks"])[0]
		if task["status"] != "pending" || util.ToInt(task["revision"], 0) != revision ||
			task["ready"] != (index == 0) || task["proposalId"] != nil {
			t.Fatalf("unexpected reset task: %v", task)
		}
	}
	if w.node("root").Prompt != "updated root" || w.node("middle").Prompt != "updated middle" || w.node("leaf").Prompt != "initial leaf" {
		t.Fatal("reopen changed canvas content")
	}
	if result := apply(leaf); result["code"] != "text_edit_not_found" {
		t.Fatalf("old downstream proposal applied: %v", result)
	}
	if result := draft(1, 5); result["code"] != "text_task_blocked" {
		t.Fatalf("middle task ran before root: %v", result)
	}
	for _, id := range []string{independent, proposal(0, 5)} {
		if result := apply(id); result["ok"] != true {
			t.Fatalf("ready proposal failed: %v", result)
		}
	}
	if w.node("root").Prompt != "reopened root" {
		t.Fatal("reopened draft did not use revised instructions")
	}
	if result := draft(1, 5); result["ok"] != true {
		t.Fatalf("middle task did not become ready: %v", result)
	}
}

func TestCanvasAgentReviseTextTaskChangesDependencyAcrossPlans(t *testing.T) {
	var upstreamSeen bool
	w := memoryWorker(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		nodeID := util.Clean(request.Diagnostic["nodeId"])
		if nodeID == "middle" && strings.Contains(agentJSON(request.Messages), "Use committed reference") {
			upstreamSeen = strings.Contains(agentJSON(request.Messages), "Updated source")
		}
		return map[string]any{"text_response": agentJSON(map[string]any{"content": "Updated " + nodeID})}, nil
	})
	for _, id := range []string{"middle", "leaf", "source"} {
		node := w.newNode("text", id, "Original "+id)
		node.ID = id
		w.addNode(node, nil)
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	var serial int
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		serial++
		calls, err := agentCalls([]map[string]any{agentCall(fmt.Sprintf("revise-%d", serial), name, args)})
		if err != nil {
			t.Fatal(err)
		}
		w.batchCalls, w.batchFailed = calls, false
		result, err := w.sdkTool(calls[0])
		if err != nil {
			t.Fatal(err)
		}
		return agentMap(result)
	}
	firstPlan := util.AsMapSlice(call("plan_canvas_text_tasks", map[string]any{"tasks": []map[string]any{
		{"key": "middle", "nodeId": "middle", "question": "Edit opening", "dependsOn": []string{}},
		{"key": "leaf", "nodeId": "leaf", "question": "Edit closing", "dependsOn": []string{"middle"}},
	}})["tasks"])
	secondPlan := util.AsMapSlice(call("plan_canvas_text_tasks", map[string]any{"tasks": []map[string]any{
		{"key": "source", "nodeId": "source", "question": "Edit reference", "dependsOn": []string{}},
	}})["tasks"])
	if len(firstPlan) != 2 || len(secondPlan) != 1 {
		t.Fatalf("unexpected plans: %v, %v", firstPlan, secondPlan)
	}
	middleID, leafID, sourceID := util.Clean(firstPlan[0]["id"]), util.Clean(firstPlan[1]["id"]), util.Clean(secondPlan[0]["id"])
	draft := func(id string, rev int) map[string]any {
		return call("draft_canvas_text_tasks", map[string]any{"tasks": []map[string]any{{"id": id, "expectedRevision": rev}}})
	}
	proposal := func(id string, rev int) string {
		t.Helper()
		result := draft(id, rev)
		reviews := util.AsMapSlice(result["reviews"])
		if len(reviews) != 1 || util.Clean(reviews[0]["proposalId"]) == "" {
			t.Fatalf("draft failed: %v", result)
		}
		return util.Clean(reviews[0]["proposalId"])
	}
	apply := func(id string) map[string]any {
		return call("apply_canvas_text_edits", map[string]any{"proposalIds": []string{id}})
	}
	revise := func(rev int, deps []string, question string) map[string]any {
		return call("revise_canvas_text_task", map[string]any{"id": middleID, "expectedRevision": rev, "dependsOn": deps, "question": question})
	}
	if result := apply(proposal(middleID, 1)); result["ok"] != true {
		t.Fatalf("apply failed: %v", result)
	}
	oldLeaf := proposal(leafID, 1)
	for _, item := range []struct {
		revision int
		deps     []string
		code     string
	}{
		{3, []string{sourceID}, "stale_text_task_revision"},
		{4, []string{"missing"}, "invalid_text_task_dependency"},
		{4, []string{middleID}, "invalid_text_task_dependency"},
		{4, []string{sourceID, sourceID}, "invalid_text_task_dependency"},
		{4, []string{leafID}, "invalid_text_task_dependency"},
	} {
		if result := revise(item.revision, item.deps, "Use committed reference"); result["code"] != item.code {
			t.Fatalf("invalid edit returned %v", result)
		}
	}
	if result := revise(4, []string{}, "Edit opening"); result["ok"] != true || util.ToInt(agentMap(result["task"])["revision"], 0) != 4 {
		t.Fatalf("unchanged edit moved revision: %v", result)
	}
	result := revise(4, []string{sourceID}, "Use committed reference")
	if result["ok"] != true || !slices.Equal(agentStrings(result["resetTaskIds"]), []string{leafID}) || w.node("middle").Prompt != "Updated middle" {
		t.Fatalf("edit did not preserve content and reset the dependent: %v", result)
	}
	updated, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := agentSession(updated, w.req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	board := agentMap(session["textEditTasks"])
	if task := agentMap(board[middleID]); task["status"] != "pending" || !slices.Equal(agentStrings(task["dependsOn"]), []string{sourceID}) {
		t.Fatalf("updated dependency was not saved: %v", task)
	}
	if result := apply(oldLeaf); result["code"] != "text_edit_not_found" {
		t.Fatalf("obsolete proposal applied: %v", result)
	}
	if result := draft(middleID, 5); result["code"] != "text_task_blocked" {
		t.Fatalf("updated dependency did not block claim: %v", result)
	}
	if result := apply(proposal(sourceID, 1)); result["ok"] != true {
		t.Fatalf("apply source failed: %v", result)
	}
	if id := proposal(middleID, 5); !upstreamSeen {
		t.Fatalf("proposal %s did not use committed contents of the new dependency", id)
	}
	if result := revise(7, []string{}, "Edit independently"); result["ok"] != true || len(agentStrings(agentMap(result["task"])["dependsOn"])) != 0 {
		t.Fatalf("could not clear dependencies: %v", result)
	}
}

func parallelAgentWorker(t *testing.T, media CanvasAgentMedia) *canvasAgentWorker {
	t.Helper()
	svc, identity, doc, req := agentFixture(t, nil, media)
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, req.SessionID)
	return &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
}

func parallelImageStep(key string, dependencies ...string) map[string]any {
	if dependencies == nil {
		dependencies = []string{}
	}
	return map[string]any{"key": key, "type": "image", "title": key, "prompt": key, "size": "1:1", "count": 1, "sourceNodeIds": []string{}, "attachmentIds": []string{}, "dependsOn": dependencies}
}

func TestCanvasAgentWorkflowFailureResultCanPersistConversation(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		return nil, errors.New("provider rejected image")
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("failed-image"), parallelImageStep("dependent", "failed-image")})
	if err != nil {
		t.Fatal(err)
	}
	w.activeCall = map[string]any{"id": "workflow", "name": "run_canvas_workflow", "arguments": map[string]any{"nodeIds": created["nodeIds"]}}
	result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
	if err != nil || result["ok"] != false {
		t.Fatalf("expected media failure: err=%v", err)
	}
	if _, err := json.Marshal(result); err != nil {
		t.Fatalf("workflow failure cannot be serialized: %v", err)
	}
	w.record(w.activeCall, result)
	if err := w.finish("error", "provider rejected image"); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := agentSession(saved, w.req.SessionID)
	if err != nil || saved.AgentRun == nil || saved.AgentRun.Status != "error" {
		t.Fatalf("failed workflow lost conversation: err=%v run=%+v", err, saved.AgentRun)
	}
	if len(util.AsMapSlice(session["messages"])) != 2 || !strings.Contains(string(saved.AgentSessions), "provider rejected image") {
		t.Fatal("failed workflow lost messages or original error")
	}
	runs := util.AsMapSlice(util.AsMapSlice(session["messages"])[1]["workflowRuns"])
	if len(runs) != 1 || runs[0]["status"] != "error" {
		t.Fatalf("workflow state did not survive reopening: %v", runs)
	}
	members := util.AsMapSlice(runs[0]["members"])
	if len(members) != 2 || members[0]["status"] != "error" || util.Clean(members[0]["taskId"]) == "" || members[1]["status"] != "skipped" {
		t.Fatalf("workflow lost failed and blocked members: %v", members)
	}
}

func TestCanvasAgentUnconfirmedScriptWorkflowKeepsConversation(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		t.Error("unconfirmed script submitted a media task")
		return nil, nil
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("storyboard")})
	if err != nil {
		t.Fatal(err)
	}
	ids := agentStrings(created["nodeIds"])
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{
		ID: "script", Type: "script", Prompt: "Original story", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Step: 2, Shots: []CanvasScriptShot{{ID: "shot", Seconds: 5, Description: "Opening shot", ImageNodeID: ids[0]}}},
	})
	w.activeCall = map[string]any{"id": "workflow", "name": "run_canvas_workflow", "arguments": map[string]any{"nodeIds": ids}}
	result, err := w.runCanvasWorkflow(ids)
	if err != nil || result["code"] != "script_not_confirmed" {
		t.Fatalf("expected unconfirmed script error: err=%v", err)
	}
	w.record(w.activeCall, result)
	if err := w.finish("error", util.Clean(result["message"])); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := agentSession(saved, w.req.SessionID); err != nil || saved.AgentRun == nil || saved.AgentRun.Status != "error" {
		t.Fatalf("blocked workflow lost its conversation: err=%v", err)
	}
}

func TestCanvasAgentWorkflowParallelismAndDependencyInputs(t *testing.T) {
	var active, maximum, firstWave atomic.Int32
	barrier := make(chan struct{})
	var completedMu sync.Mutex
	completed := map[string]bool{}
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		count := active.Add(1)
		defer active.Add(-1)
		for {
			old := maximum.Load()
			if count <= old || maximum.CompareAndSwap(old, count) {
				break
			}
		}
		if n.Title != "poster" {
			if firstWave.Add(1) == 4 {
				close(barrier)
			}
			select {
			case <-barrier:
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(5 * time.Second):
				return nil, errors.New("independent images were executed serially")
			}
		} else {
			completedMu.Lock()
			for _, key := range []string{"front", "open", "side", "back"} {
				if !completed[key] {
					t.Errorf("poster started before %s completed", key)
				}
			}
			completedMu.Unlock()
			want := []string{"/front.png", "/open.png", "/side.png", "/back.png"}
			if !slices.Equal(n.GenerationReferenceURLs, want) {
				t.Errorf("wrong upstream input ordering: %v", n.GenerationReferenceURLs)
			}
		}
		completedMu.Lock()
		completed[n.Title] = true
		completedMu.Unlock()
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}}}, nil
	})
	steps := []map[string]any{}
	for _, key := range []string{"front", "open", "side", "back", "extra"} {
		steps = append(steps, parallelImageStep(key))
	}
	steps = append(steps, parallelImageStep("poster", "front", "open", "side", "back"))
	created, err := w.createGroupedCanvasWorkflow(steps, "产品图")
	if err != nil {
		t.Fatal(err)
	}
	result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
	if err != nil || result["ok"] != true {
		t.Fatalf("workflow failed: %v %v", result, err)
	}
	if maximum.Load() != 4 || len(completed) != 6 {
		t.Fatalf("parallelism=%d completed=%d", maximum.Load(), len(completed))
	}
	groupID := util.Clean(created["groupId"])
	if groupID == "" {
		t.Fatal("batch was not grouped")
	}
	for _, id := range agentStrings(created["nodeIds"]) {
		if n := w.node(id); n.GroupID != groupID || n.GenerationStatus != "success" {
			t.Fatalf("missing group or result: %+v", n)
		}
	}
	if len(w.doc.Connections) != 4 {
		t.Fatalf("independent nodes should not be connected: %v", w.doc.Connections)
	}
}

func TestCanvasAgentParallelFailureDrainsSubmittedWorkAndBlocksDownstream(t *testing.T) {
	entered := make(chan string, 4)
	release := make(chan struct{})
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		entered <- n.Title
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if n.Title == "front" {
			return nil, errors.New("provider rejected image")
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}}}, nil
	})
	steps := []map[string]any{}
	for _, key := range []string{"front", "open", "side", "back"} {
		steps = append(steps, parallelImageStep(key))
	}
	steps = append(steps, parallelImageStep("poster", "front", "open", "side", "back"))
	created, err := w.createCanvasWorkflow(steps)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan map[string]any, 1)
	go func() {
		result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
		if err != nil {
			result = agentError("test_error", err.Error())
		}
		finished <- result
	}()
	for range 4 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("four independent tasks did not start")
		}
	}
	close(release)
	var result map[string]any
	select {
	case result = <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("parallel run did not drain")
	}
	if result["ok"] != false || len(util.AsMapSlice(result["results"])) != 4 {
		t.Fatalf("lost submitted results: %v", result)
	}
	if len(entered) != 0 {
		t.Fatal("downstream was submitted after upstream failed")
	}
	for _, node := range w.doc.Nodes {
		if node.Title == "poster" && node.TaskID != "" {
			t.Fatal("poster was submitted")
		}
		if node.Title != "poster" && node.Title != "front" && node.GenerationStatus != "success" {
			t.Fatal("successful sibling result was lost")
		}
	}
}

func TestCanvasAgentParallelGroupDeletionDoesNotRestoreResults(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}, {"url": "/extra.png"}}}, nil
	})
	steps := []map[string]any{}
	for i := 0; i < 4; i++ {
		step := parallelImageStep(fmt.Sprint(i))
		step["count"] = 2
		steps = append(steps, step)
	}
	created, err := w.createGroupedCanvasWorkflow(steps, "四张图")
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan map[string]any, 1)
	go func() {
		result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
		if err != nil {
			result = agentError("test_error", err.Error())
		}
		finished <- result
	}()
	for range 4 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("parallel tasks did not start")
		}
	}
	// The worker saves concurrently, so a user edit must re-read and retry on a revision conflict.
	for attempt := 0; ; attempt++ {
		current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		current.Nodes, current.Connections = nil, nil
		_, err = w.service.canvas.SaveAtRevision(w.identity.ID, current)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrCanvasRevisionConflict) || attempt >= 20 {
			close(release)
			t.Fatal(err)
		}
	}
	close(release)
	select {
	case result := <-finished:
		if result["code"] != "canvas_changed" {
			t.Fatalf("deletion not recovered: %v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("parallel tasks did not finish")
	}
	if len(w.doc.Nodes) != 0 || len(w.doc.Connections) != 0 {
		t.Fatal("deleted group or outputs were restored")
	}
}

func TestCanvasAgentAdditionalOutputsRetainSourcesAndGroupDeletionScope(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "/first.png"}, {"url": "/second.png"}}}, nil
	})
	w.doc.Nodes = []CanvasNode{{ID: "source", Type: "image", Title: "原照", URL: "/source.png", GenerationStatus: "success", Width: 360, Height: 360}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	step := parallelImageStep("result")
	step["count"] = 2
	step["sourceNodeIds"] = []string{"source"}
	other := parallelImageStep("other")
	created, err := w.createGroupedCanvasWorkflow([]map[string]any{step, other}, "结果")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.generateNode(agentStrings(created["nodeIds"])[0]); err != nil {
		t.Fatal(err)
	}
	if len(w.doc.Connections) != 2 {
		t.Fatal("additional output has no source edge")
	}
	groupID := util.Clean(created["groupId"])
	for _, edge := range w.doc.Connections {
		if edge.FromNodeID != "source" || w.node(edge.ToNodeID).GroupID != groupID {
			t.Fatal("wrong source or group on extra output")
		}
	}
	deleted := w.deleteNode(groupID)
	if deleted["ok"] != true || len(w.doc.Nodes) != 1 || w.doc.Nodes[0].ID != "source" || len(w.doc.Connections) != 0 {
		t.Fatalf("wrong group removal scope: %v", deleted)
	}
}

func TestCanvasAgentSDKRunsIndependentWorkflowInParallel(t *testing.T) {
	var turns, started atomic.Int32
	barrier := make(chan struct{})
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		switch turns.Add(1) {
		case 1:
			steps := []map[string]any{}
			for i := 0; i < 4; i++ {
				steps = append(steps, parallelImageStep(fmt.Sprint(i)))
			}
			return agentTurn(agentCall("create", "create_canvas_workflow", map[string]any{"groupTitle": "产品图", "steps": steps})), nil
		case 2:
			for _, message := range request.Messages {
				if message["role"] == "tool" {
					var result map[string]any
					if json.Unmarshal([]byte(util.Clean(message["content"])), &result) == nil && len(agentStrings(result["nodeIds"])) == 4 {
						return agentTurn(agentCall("run", "run_canvas_workflow", map[string]any{"nodeIds": result["nodeIds"]})), nil
					}
				}
			}
			return nil, errors.New("SDK did not receive created workflow IDs")
		default:
			return agentTurn(), nil
		}
	}, func(ctx context.Context, _ Identity, node CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		if started.Add(1) == 4 {
			close(barrier)
		}
		select {
		case <-barrier:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
			return nil, errors.New("SDK generation is still serial")
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + node.Title + ".png"}}}, nil
	})
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || started.Load() != 4 || len(done.Nodes) != 5 {
		t.Fatalf("SDK parallel workflow failed: %+v, started=%d nodes=%d", done.AgentRun, started.Load(), len(done.Nodes))
	}
	_, session, _ := agentSession(done, req.SessionID)
	count := 0
	for _, entry := range util.AsMapSlice(util.AsMapSlice(session["messages"])[1]["trace"]) {
		if entry["kind"] == "generate" {
			if entry["status"] != "success" {
				t.Fatal("generation progress was not finalized")
			}
			count++
		}
	}
	if count != 4 {
		t.Fatalf("expected four individual generation progress rows, got %d", count)
	}
}

func TestCanvasAgentPublishesMediaProgressBeforeCompletion(t *testing.T) {
	for _, parallel := range []bool{false, true} {
		t.Run(fmt.Sprintf("parallel-%t", parallel), func(t *testing.T) {
			release := make(chan struct{})
			releaseGeneration := sync.OnceFunc(func() { close(release) })
			defer releaseGeneration()
			w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, node CanvasNode, _ map[string]any, progress func(int) error) (map[string]any, error) {
				if progress != nil {
					if err := progress(37); err != nil {
						return nil, err
					}
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-release:
				}
				return map[string]any{"data": []map[string]any{{"url": "/" + node.ID + ".png"}}}, nil
			})
			steps := []map[string]any{parallelImageStep("first")}
			if parallel {
				steps = append(steps, parallelImageStep("second"))
			}
			created, err := w.createGroupedCanvasWorkflow(steps, "")
			if err != nil {
				t.Fatal(err)
			}
			ids := agentStrings(created["nodeIds"])
			projectID := w.doc.ID
			done := make(chan error, 1)
			go func() {
				var result map[string]any
				var err error
				if parallel {
					result, err = w.runCanvasWorkflow(ids)
				} else {
					result, err = w.generateNode(ids[0])
				}
				if err == nil && result["ok"] != true {
					err = fmt.Errorf("generation failed: %v", result)
				}
				done <- err
			}()
			deadline := time.NewTimer(3 * time.Second)
			defer deadline.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
		published:
			for {
				select {
				case <-deadline.C:
					t.Fatal("in-progress media was not published before completion")
				case err := <-done:
					t.Fatalf("generation finished before release: %v", err)
				case <-ticker.C:
					doc, err := w.service.canvas.Project(w.identity.ID, projectID)
					if err != nil {
						t.Fatal(err)
					}
					count := 0
					for _, node := range doc.Nodes {
						if slices.Contains(ids, node.ID) && node.GenerationProgress == 37 && node.GenerationStatus == "loading" && node.URL == "" {
							count++
						}
					}
					if count == len(ids) {
						break published
					}
				}
			}
			releaseGeneration()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCanvasAgentProgressSaveFailureKeepsOriginalTaskRecoverable(t *testing.T) {
	var w *canvasAgentWorker
	storageFailure := errors.New("progress storage unavailable")
	var firstTaskID string
	w = parallelAgentWorker(t, func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any, progress func(int) error) (map[string]any, error) {
		if firstTaskID != "" {
			if node.TaskID != firstTaskID {
				t.Fatal("progress observer failure caused a new paid task ID")
			}
			return map[string]any{"data": []map[string]any{{"url": "/original-task.png"}}}, nil
		}
		firstTaskID = node.TaskID
		failed := false
		w.service.canvas.store = &countingCanvasDocumentBackend{documents: w.service.canvas.store, saves: map[string]int{}, failSave: func(string) error {
			if !failed {
				failed = true
				return storageFailure
			}
			return nil
		}}
		return nil, progress(37)
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("progress")})
	if err != nil {
		t.Fatal(err)
	}
	id := agentStrings(created["nodeIds"])[0]
	_, err = w.generateNode(id)
	if !errors.Is(err, storageFailure) {
		t.Fatalf("progress persistence failure not returned: %v", err)
	}
	if node := w.node(id); node.TaskID != firstTaskID || node.GenerationStatus != "loading" || !slices.Contains(agentStrings(w.state["pendingTaskIds"]), firstTaskID) {
		t.Fatalf("observer failure falsely ended the original paid task: node=%+v state=%v", node, w.state)
	}
	if result, err := w.generateNode(id); err != nil || result["ok"] != true || w.node(id).URL != "/original-task.png" {
		t.Fatalf("failed to resume the existing task: result=%v err=%v", result, err)
	}
}
