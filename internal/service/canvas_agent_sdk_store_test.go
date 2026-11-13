package service

import (
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCanvasAgentSDKHistoryTransactionsAreAtomicIdempotentAndOwnerScoped(t *testing.T) {
	w := memoryWorker(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		t.Fatal("storage must not call model")
		return nil, nil
	})
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	item := map[string]any{"role": "user", "content": "existing request"}
	appendItems := map[string]any{"action": "transaction", "operationId": "append-1", "transaction": map[string]any{"type": "append_items", "items": []map[string]any{item}}}
	for range 2 {
		if _, err := w.sdkSession(appendItems); err != nil {
			t.Fatal(err)
		}
	}
	if len(w.sdk.Items) != 1 {
		t.Fatalf("duplicate transaction appended %d items", len(w.sdk.Items))
	}
	before := agentJSON(w.sdk)
	conflict := map[string]any{"action": "transaction", "operationId": "append-1", "transaction": map[string]any{"type": "append_items", "items": []map[string]any{{"role": "user", "content": "forged"}}}}
	if _, err := w.sdkSession(conflict); err == nil || agentJSON(w.sdk) != before {
		t.Fatal("transaction collision mutated history")
	}
	suffix := map[string]any{"action": "transaction", "operationId": "rewrite", "transaction": map[string]any{"type": "replace_suffix", "expectedSuffix": []map[string]any{{"role": "user", "content": "wrong"}}, "replacement": []map[string]any{}}}
	if _, err := w.sdkSession(suffix); err == nil || agentJSON(w.sdk) != before {
		t.Fatal("invalid suffix mutated history")
	}
	suffix["transaction"].(map[string]any)["expectedSuffix"] = []map[string]any{item}
	suffix["transaction"].(map[string]any)["replacement"] = []map[string]any{{"role": "user", "content": "rewritten"}}
	for range 2 {
		if _, err := w.sdkSession(suffix); err != nil {
			t.Fatal(err)
		}
	}
	if w.sdk.Items[0]["content"] != "rewritten" {
		t.Fatal(w.sdk.Items)
	}
	if found, err := w.loadSDKSession(); err != nil || !found || w.sdk.Items[0]["content"] != "rewritten" {
		t.Fatalf("not durable: found=%v err=%v", found, err)
	}
	w.identity.ID = "another-owner"
	if found, err := w.loadSDKSession(); err != nil || found {
		t.Fatalf("cross-owner SDK history: found=%v err=%v", found, err)
	}
}

func TestCanvasAgentSDKCompletedCheckpointRestoresAcceptanceOnlyForUnchangedCanvas(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprintf("changed=%t", changed), func(t *testing.T) {
			w := memoryWorker(t, nil)
			w.req.Resume = true
			w.sdk = &AgentSDKSession{}
			w.sdk.ContentFingerprint, w.sdk.LayoutFingerprint = canvasAgentIntentFingerprints(w.doc)
			w.accepted = true
			if _, err := w.sdkRequest("checkpoint", map[string]any{"state": `{"version":"langgraph-1","status":"finished"}`}); err != nil {
				t.Fatal(err)
			}
			w.accepted = false
			if changed {
				w.doc.Nodes = append(w.doc.Nodes, CanvasNode{ID: "changed", Type: "text", Title: "User edit"})
			}
			if _, err := w.sdkConfig(); err != nil {
				t.Fatal(err)
			}
			if w.accepted == changed {
				t.Fatalf("accepted=%t for changed=%t", w.accepted, changed)
			}
		})
	}
}

func TestCanvasAgentBrowserCannotForgeOrEraseSDKToolReceipts(t *testing.T) {
	w := memoryWorker(t, nil)
	w.session["toolReceipts"] = map[string]any{"real": map[string]any{"name": "create_text_node", "done": true, "result": map[string]any{"ok": true, "nodeId": "original"}}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	// Ordinary canvas saving remains allowed while waiting, but execution receipts stay server-owned.
	w.doc.AgentRun.Status = "waiting"
	if _, err := w.service.canvas.saveAgent(w.identity.ID, w.doc); err != nil {
		t.Fatal(err)
	}
	doc, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	sessions, session, _ := agentSession(doc, w.req.SessionID)
	session["toolReceipts"] = map[string]any{"forged": map[string]any{"done": true}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	saved, err := w.service.canvas.SaveAtRevision(w.identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ = agentSession(saved, w.req.SessionID)
	receipts := agentMap(session["toolReceipts"])
	if receipts["real"] == nil || receipts["forged"] != nil {
		t.Fatalf("browser rewrote receipts: %v", receipts)
	}
}

func TestCanvasAgentSDKReplaysCommittedWriteWithoutRepeatingIt(t *testing.T) {
	w := memoryWorker(t, nil)
	call := map[string]any{"id": "create-once", "name": "create_text_node", "arguments": map[string]any{"title": "已有结果", "content": "保留"}}
	w.batchCalls = []map[string]any{call}
	first, err := w.sdkTool(call)
	if err != nil || agentMap(first)["ok"] != true {
		t.Fatalf("first call: %v %v", first, err)
	}
	_, session, _ := agentSession(w.doc, w.req.SessionID)
	w.session = session
	second, err := w.sdkTool(call)
	if err != nil || agentJSON(first) != agentJSON(second) || len(w.doc.Nodes) != 1 {
		t.Fatalf("write repeated: %v %v nodes=%d", second, err, len(w.doc.Nodes))
	}
	call["arguments"] = map[string]any{"title": "forged", "content": "changed"}
	if _, err = w.sdkTool(call); err == nil {
		t.Fatal("call ID reused for another write")
	}
}

func TestCanvasAgentSDKResumeDoesNotResubmitFailedPaidMedia(t *testing.T) {
	w := memoryWorker(t, nil)
	w.req.Resume = true
	w.doc.Nodes = []CanvasNode{{ID: "failed-video", Type: "video", TaskID: "original-paid-task", GenerationStatus: "error", GenerationError: "upstream 400"}}
	result, err := w.generateNode("failed-video")
	if err != nil || result["code"] != "media_retry_requires_confirmation" || w.doc.Nodes[0].TaskID != "original-paid-task" || w.doc.Nodes[0].GenerationError != "upstream 400" {
		t.Fatalf("failed paid media was retried or erased: %v %v node=%+v", result, err, w.doc.Nodes[0])
	}
}

func TestCanvasAgentSDKPassesActiveToolsAndRequiresCompletionAfterEveryTurn(t *testing.T) {
	turns := 0
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		turns++
		tools := util.AsMapSlice(r.Metadata["tools"])
		if len(tools) < 30 || r.Metadata["tool_choice"] != "required" || r.Metadata["parallel_tool_calls"] != false {
			t.Errorf("SDK tool policy lost at turn %d: tools=%d choice=%v", turns, len(tools), r.Metadata["tool_choice"])
		}
		if turns == 1 {
			return agentTurn(agentCall("read-for-completion", "get_canvas_summary", map[string]any{})), nil
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns != 2 {
		t.Fatalf("SDK completion failed: %+v turns=%d", done.AgentRun, turns)
	}
}

func TestCanvasAgentSDKLargeReadResultsDoNotOverflowPublicCanvasHistory(t *testing.T) {
	turns := 0
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		if r.Metadata["max_output_tokens"] != nil {
			return map[string]any{"text_response": "已读取附件 large-doc，未提交任何生成。"}, nil
		}
		turns++
		if turns == 1 {
			return agentTurn(agentCall("large-read-1", "get_reference", map[string]any{"referenceId": "large-doc"})), nil
		}
		return agentTurn(), nil
	}, nil)
	source := strings.Repeat("文", 90000)
	req.References = []map[string]any{{"id": "large-doc", "source": "attachment", "type": "text", "title": "长文资料", "text": source}}
	doc = persistAgentTestReferences(t, svc, identity, doc, &req)
	before := len(doc.AgentSessions)
	// History may exceed the old limit, while duplicate tool bodies still stay compact.
	_, control, _ := agentSession(doc, req.SessionID)
	control["protocolMessages"] = []map[string]any{{"role": "tool", "name": "get_reference", "toolCallId": "control", "content": agentJSON(map[string]any{"ok": true, "reference": map[string]any{"id": "large-doc", "text": source}})}}
	controlJSON := json.RawMessage(agentJSON([]map[string]any{control}))
	if len(controlJSON) <= 512<<10 {
		t.Fatal("fixture does not exercise long history")
	}
	if err := validateCanvasAgentJSON(controlJSON, true); err != nil {
		t.Fatalf("valid long history was rejected: %v", err)
	}
	var err error
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID, 2*time.Minute)
	if done.AgentRun.Status != "success" || turns != 2 {
		t.Fatalf("read output stalled SDK: %+v turns=%d", done.AgentRun, turns)
	}
	_, session, _ := agentSession(done, req.SessionID)
	ref, readErr := canvasAgentReference(done, session, "large-doc", "attachment")
	if len(done.AgentSessions) > before+(32<<10) || readErr != nil || ref["text"] != source {
		t.Fatal("public history overflowed or source text changed")
	}
}

func TestCanvasAgentSDKSessionPersistsAcrossDatabaseReopen(t *testing.T) {
	for _, environment := range []string{"TEST_POSTGRES_DATABASE_URL", "TEST_MYSQL_DATABASE_URL"} {
		t.Run(environment, func(t *testing.T) {
			dsn := os.Getenv(environment)
			if dsn == "" {
				t.Skip(environment + " is not configured")
			}
			backend, err := storage.NewDatabaseBackend(dsn)
			if err != nil {
				t.Fatal(err)
			}
			worker := &canvasAgentWorker{identity: Identity{ID: "sdk-storage-" + util.NewUUID()}, doc: CanvasDocument{ID: "sdk-project"}, req: CanvasAgentRequest{SessionID: "sdk-session"}, service: &CanvasAgentService{canvas: NewCanvasDocumentService(backend)}}
			t.Cleanup(func() {
				if backend != nil {
					_ = backend.DeleteJSONDocument(worker.sdkStoreName())
					_ = backend.Close()
				}
			})
			if _, err = worker.loadSDKSession(); err != nil {
				t.Fatal(err)
			}
			transaction := map[string]any{"action": "transaction", "operationId": "sdk-database-append", "transaction": map[string]any{"type": "append_items", "items": []map[string]any{{"role": "user", "content": "保留真实进度：node-1 / task-1"}}}}
			if _, err = worker.sdkSession(transaction); err != nil {
				t.Fatal(err)
			}
			worker.sdk.State = "opaque SDK checkpoint"
			worker.sdk.Accepted = true
			if err = worker.saveSDKSession(); err != nil {
				t.Fatal(err)
			}
			if err = backend.Close(); err != nil {
				t.Fatal(err)
			}
			backend, err = storage.NewDatabaseBackend(dsn)
			if err != nil {
				t.Fatal(err)
			}
			worker.service.canvas = NewCanvasDocumentService(backend)
			if found, err := worker.loadSDKSession(); err != nil || !found || worker.sdk.State != "opaque SDK checkpoint" || !worker.sdk.Accepted {
				t.Fatalf("checkpoint did not survive reopen: found=%v err=%v", found, err)
			}
			if _, err = worker.sdkSession(transaction); err != nil || len(worker.sdk.Items) != 1 {
				t.Fatalf("transaction replay duplicated history: items=%v err=%v", worker.sdk.Items, err)
			}
		})
	}
}

func TestCanvasAgentSDKInterruptedInitializationStillImportsExistingProgress(t *testing.T) {
	w := memoryWorker(t, nil)
	w.messages = []map[string]any{{"role": "user", "content": "继续原来的制作任务，保留 node-existing 和 task-existing"}}
	w.req.Resume = true
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	w.sdk.Phase = "cancelled"
	w.sdk.ApprovedCallID = "old-question"
	w.sdk.ApprovedAnswer = "旧授权"
	if err := w.saveSDKSession(); err != nil {
		t.Fatal(err)
	}
	config, err := w.sdkConfig()
	if err != nil || !strings.Contains(agentJSON(config["legacy"]), "task-existing") || config["answerCallId"] != nil {
		t.Fatalf("interrupted setup lost the old transcript: config=%v err=%v", config, err)
	}
}

func TestCanvasAgentSDKPrivateQuestionRestoresMissingCanvasCheckpoint(t *testing.T) {
	turns := 0
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		turns++
		if turns == 1 {
			return agentTurn(agentCall("private-question", "ask_user_question", map[string]any{"question": "品牌名称？", "reason": "需要真实答案", "kind": "clarification", "options": []string{}})), nil
		}
		if !strings.Contains(agentJSON(r.Messages), "真实品牌") {
			t.Error("stored question did not receive actual answer")
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	worker := &canvasAgentWorker{service: svc, identity: identity, doc: waiting, req: req}
	if found, err := worker.loadSDKSession(); err != nil || !found {
		t.Fatalf("missing SDK session: %v %v", found, err)
	}
	worker.sdk.State = ""
	worker.sdk.Phase = "running"
	if err := worker.saveSDKSession(); err != nil {
		t.Fatal(err)
	}
	sessions, session, _ := agentSession(waiting, req.SessionID)
	session["protocolMessages"] = []map[string]any{}
	delete(agentMap(session["agentState"]), "pendingQuestion")
	waiting.AgentSessions, _ = json.Marshal(sessions)
	waiting.AgentRun.SDKState = ""
	if _, err := svc.canvas.saveAgent(identity.ID, waiting); err != nil {
		t.Fatal(err)
	}
	external := CanvasAgentToolRequest{Context: req}
	external.Context.ID = "blocked-external"
	external.Call.ID = "blocked-create"
	external.Call.Name = "create_text_node"
	external.Call.Arguments = map[string]any{"title": "不应创建", "content": "no"}
	if _, err := svc.StartTool(identity, doc.ID, external); err == nil {
		t.Fatal("external engine bypassed private approval")
	}
	req.ID = "restore-private-question"
	req.Resume = true
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	restored := agentWait(t, svc, identity, doc.ID)
	if restored.AgentRun.Status != "waiting" || turns != 1 || len(restored.Nodes) != 0 {
		t.Fatalf("private approval did not restore safely: %+v turns=%d", restored.AgentRun, turns)
	}
	req.ID = "answer-private-question"
	req.Resume = false
	req.UserText = "真实品牌"
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns != 2 {
		t.Fatalf("restored approval stuck: %+v turns=%d", done.AgentRun, turns)
	}
}

func TestCanvasAgentSDKRestoredBatchPreservesOfflineUserEdits(t *testing.T) {
	w := memoryWorker(t, nil)
	w.doc.Nodes = []CanvasNode{{ID: "target", Type: "text", Prompt: "original", GenerationStatus: "success", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	w.sdk.ContentFingerprint, w.sdk.LayoutFingerprint = canvasAgentIntentFingerprints(w.doc)
	edited := cloneCanvasAgentDocument(w.doc)
	edited.Nodes[0].Prompt = "user edited while offline"
	var err error
	edited, err = w.service.canvas.SaveAtRevision(w.identity.ID, edited)
	if err != nil {
		t.Fatal(err)
	}
	w.doc = edited
	w.persisted = cloneCanvasAgentDocument(edited)
	w.canvasChanged = false
	w.layoutChanged = false
	call := map[string]any{"id": "cached-write", "name": "update_text_node", "arguments": map[string]any{"nodeId": "target", "content": "stale model text"}}
	w.batchCalls = []map[string]any{call}
	result, err := w.sdkTool(call)
	if err != nil || agentMap(result)["code"] != "canvas_changed" || w.doc.Nodes[0].Prompt != "user edited while offline" {
		t.Fatalf("restored call overwrote user edit: %v %v node=%+v", result, err, w.doc.Nodes[0])
	}
}

func TestCanvasAgentSDKMediaRecoveryRejectsChangedGenerationInputs(t *testing.T) {
	w := memoryWorker(t, nil)
	approved := false
	w.service.media = func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		if !approved {
			t.Error("changed inputs must not attach the old result")
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/new-media.png"}}}, nil
	}
	w.doc.Nodes = []CanvasNode{{ID: "target", Type: "image", Prompt: "original", TaskID: "original-task", GenerationStatus: "loading", GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1, Width: 360, Height: 360, ScaleX: 1, ScaleY: 1}}
	call := map[string]any{"id": "media-recovery", "name": "generate_node", "arguments": map[string]any{"nodeId": "target"}}
	w.activeCall = call
	w.record(call, map[string]any{"ok": true, "nodeId": "target", "taskId": "original-task", "status": "loading", "submitted": true})
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	edited := cloneCanvasAgentDocument(w.doc)
	edited.Nodes[0].Prompt = "user changed prompt"
	var err error
	edited, err = w.service.canvas.SaveAtRevision(w.identity.ID, edited)
	if err != nil {
		t.Fatal(err)
	}
	w.doc = edited
	w.persisted = cloneCanvasAgentDocument(edited)
	w.canvasChanged = false
	result, err := w.sdkTool(call)
	if err != nil || agentMap(result)["code"] != "canvas_changed" || w.doc.Nodes[0].Prompt != "user changed prompt" || w.doc.Nodes[0].URL != "" {
		t.Fatalf("old media overwrote changed input: %v %v", result, err)
	}
	approved = true
	w.answerMediaChoice = "generate"
	w.canvasChanged = false
	retry := map[string]any{"id": "approved-media-retry", "name": "generate_node", "arguments": map[string]any{"nodeId": "target"}}
	w.batchCalls = []map[string]any{retry}
	result, err = w.sdkTool(retry)
	if err != nil || agentMap(result)["ok"] != true || w.doc.Nodes[0].TaskID == "original-task" || w.doc.Nodes[0].ID != "target" || w.doc.Nodes[0].GenerationStatus != "success" {
		t.Fatalf("explicit retry could not continue on the same node: %v %v node=%+v", result, err, w.doc.Nodes[0])
	}

}

func TestCanvasAgentSDKCoalescesStreamingProgressAndKeepsFinalReply(t *testing.T) {
	var svc *CanvasAgentService
	var owner Identity
	var doc CanvasDocument
	var req CanvasAgentRequest
	svc, owner, doc, req = agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		before, err := svc.canvas.Project(owner.ID, doc.ID)
		if err != nil {
			return nil, err
		}
		for range 50 {
			if err = r.OnText("模型正在继续输出"); err != nil {
				return nil, err
			}
		}
		after, err := svc.canvas.Project(owner.ID, doc.ID)
		if err != nil {
			return nil, err
		}
		if after.Revision-before.Revision >= 50 {
			t.Error("every token rewrote the canvas")
		}
		return agentTurn(agentCall("final-streamed", "finish_task", map[string]any{"text": "完整最终回复"})), nil
	}, nil)
	if _, err := svc.Start(owner, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, owner, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	var reply string
	for _, message := range util.AsMapSlice(session["messages"]) {
		if message["id"] == req.AssistantID {
			reply = util.Clean(message["text"])
		}
	}
	if done.AgentRun.Status != "success" || reply != "完整最终回复" {
		t.Fatalf("final reply lost: %+v reply=%q", done.AgentRun, reply)
	}
}

func TestCanvasAgentSDKRetryProgress(t *testing.T) {
	w := memoryWorker(t, nil)
	for attempt := 1; attempt <= 5; attempt++ {
		if _, err := w.sdkRequest("retry", map[string]any{"attempt": attempt}); err != nil {
			t.Fatal(err)
		}
		if got := util.Clean(w.assistant()["activity"]); !strings.Contains(got, fmt.Sprintf("（%d/5）", attempt)) {
			t.Fatalf("retry activity = %q", got)
		}
	}
	if _, err := w.sdkRequest("retry", map[string]any{"attempt": 1, "validation": true}); err != nil {
		t.Fatal(err)
	}
	if got := util.Clean(w.assistant()["activity"]); got != "模型工具格式不正确，正在纠正后继续" {
		t.Fatalf("validation activity = %q", got)
	}
}
