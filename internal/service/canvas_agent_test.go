package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func agentFixture(t *testing.T, model AgentModel, media CanvasAgentMedia) (*CanvasAgentService, Identity, CanvasDocument, CanvasAgentRequest) {
	t.Helper()
	runtimePath, err := filepath.Abs("../../agent-runtime/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_RUNTIME_PATH", runtimePath)
	backend := newTestStorageBackend(t)
	canvas := NewCanvasDocumentService(backend)
	identity := Identity{ID: "agent-owner"}
	doc, err := loadCanvas(canvas, identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions = json.RawMessage(`[{"id":"session","title":"测试","engine":"native","createdAt":"2026-10-29T00:00:00Z","updatedAt":"2026-10-29T00:00:00Z","messages":[{"id":"u","role":"user","text":"制作海报"},{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	doc.ActiveAgentSessionID = "session"
	doc, err = canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req := CanvasAgentRequest{ID: "run", SessionID: "session", AssistantID: "a", UserMessageID: "u", UserText: "制作海报", Model: "test", RelayTokenName: "test", APIMode: "responses", Generation: map[string]any{"imageModel": "image-test", "autoGenerateMedia": true, "capabilities": map[string]any{"image": map[string]any{"maxCount": 15.0}}}}
	execution := NewAgentExecutionService(context.Background(), backend)
	t.Cleanup(execution.Close)
	svc := NewCanvasAgentService(context.Background(), execution, canvas, NewAgentSkillService(backend), model, media)
	t.Cleanup(svc.Close)
	return svc, identity, doc, req
}

var agentFinishSerial atomic.Int64

func agentTurn(calls ...map[string]any) map[string]any {
	if len(calls) == 0 {
		calls = []map[string]any{agentCall(fmt.Sprintf("finish-%d", agentFinishSerial.Add(1)), "finish_task", map[string]any{"text": "完成"})}
	}
	return map[string]any{"text_response": "完成", "tool_calls": calls}
}
func agentCall(id, name string, args map[string]any) map[string]any {
	return map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": agentJSON(args)}}
}
func agentWait(t *testing.T, svc *CanvasAgentService, identity Identity, project string, limits ...time.Duration) CanvasDocument {
	t.Helper()
	wait := 45 * time.Second
	if len(limits) > 0 {
		wait = limits[0]
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		doc, err := svc.Snapshot(identity, project)
		if err != nil {
			t.Fatal(err)
		}
		if doc.AgentRun != nil && doc.AgentRun.Status != "running" {
			svc.mu.Lock()
			active := svc.active[agentKey(identity.ID, project)] != nil
			svc.mu.Unlock()
			if !active {
				return doc
			}
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal("agent did not finish")
	return CanvasDocument{}
}
func TestCanvasAgentPlanWithoutExplanationContinuesAndPersists(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("plan", "update_plan", map[string]any{"steps": []any{map[string]any{"id": "brief", "title": "确认需求", "status": "completed"}}})), nil
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, err := agentSession(done, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	plan := agentMap(agentMap(session["agentState"])["plan"])
	if done.AgentRun.Status != "success" || turns.Load() != 2 || plan["explanation"] != "" || len(util.AsMapSlice(plan["steps"])) != 1 {
		t.Fatalf("run=%+v, turns=%d, plan=%v", done.AgentRun, turns.Load(), plan)
	}
}

func TestCanvasAgentRunsWithoutBrowserAndMergesConcurrentEdits(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, _ AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return agentTurn(agentCall("c", "create_text_node", map[string]any{"title": "海报文案", "content": "Hello"})), nil
		}
		return agentTurn(), nil
	}, nil)
	_, err := svc.Start(identity, doc.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	editing, err := svc.canvas.Project(identity.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	editing.Title = "用户修改的名称"
	editing.Viewport.X = 123
	editing.AgentSessions = json.RawMessage(`[]`)
	if _, err = svc.canvas.SaveAtRevision(identity.ID, editing); err != nil {
		t.Fatalf("concurrent edit failed: %v", err)
	}
	duplicate, err := svc.Start(identity, doc.ID, req)
	if err != nil || duplicate.AgentRun.ID != req.ID {
		t.Fatalf("duplicate submission: %v", err)
	}
	other := req
	other.ID = "other"
	if _, err = svc.Start(identity, doc.ID, other); !errors.Is(err, ErrCanvasAgentBusy) {
		t.Fatalf("parallel run: %v", err)
	}
	close(release)
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || len(done.Nodes) != 1 || done.Nodes[0].Prompt != "Hello" || done.Title != "用户修改的名称" || done.Viewport.X != 123 {
		t.Fatalf("unexpected document: %+v", done.AgentRun)
	}
	if _, err = svc.Snapshot(Identity{ID: "another-owner"}, doc.ID); err == nil {
		t.Fatal("cross-owner read allowed")
	}
}
func TestCanvasAgentQuestionPausesWholeBatchAndResumes(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("q", "ask_user_question", map[string]any{"question": "什么比例？", "reason": "确定交付规格", "kind": "clarification", "options": []string{"竖版", "横版"}}), agentCall("ignored", "create_text_node", map[string]any{"title": "不应创建", "content": "no"})), nil
		}
		if !strings.Contains(agentJSON(r.Messages), "用户自定义比例") {
			t.Error("answer not delivered")
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	if waiting.AgentRun.Status != "waiting" || len(waiting.Nodes) != 0 {
		t.Fatal("question did not pause batch")
	}
	_, session, _ := agentSession(waiting, "session")
	q := agentMap(agentMap(session["agentState"])["pendingQuestion"])
	if q["id"] != "q" {
		t.Fatal(q)
	}
	req.ID = "answer"
	req.UserText = "用户自定义比例"
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" {
		t.Fatal(done.AgentRun)
	}
	_, session, _ = agentSession(done, "session")
	if len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) != 0 {
		t.Fatal("pending question retained")
	}
}
func TestCanvasAgentCancellationPreservesSubmittedMedia(t *testing.T) {
	entered := make(chan struct{})
	var submissions atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(agentCall("image", "generate_image", map[string]any{"prompt": "海报", "sourceNodeIds": []string{}, "size": "1:1", "count": 1})), nil
	}, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any) (map[string]any, error) {
		if n.TaskID == "" {
			t.Error("task ID was not saved")
		}
		submissions.Add(1)
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("media not submitted")
	}
	if err := svc.Stop(identity, doc.ID, req.ID); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "cancelled" || len(done.Nodes) != 1 || done.Nodes[0].TaskID == "" || done.Nodes[0].GenerationStatus != "loading" || submissions.Load() != 1 {
		t.Fatalf("lost media progress: %+v", done)
	}
}
func TestCanvasAgentRejectsMissingMediaParametersBeforeAnyMutation(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(agentCall("text", "create_text_node", map[string]any{"title": "不创建", "content": "no"}), agentCall("bad", "generate_image", map[string]any{"prompt": "海报", "sourceNodeIds": []string{}})), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "error" || len(done.Nodes) != 0 {
		t.Fatal("invalid batch executed")
	}
}
func TestCanvasAgentPersistedQuestionSurvivesServiceRestart(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(agentCall("q", "ask_user_question", map[string]any{"question": "品牌名称？", "reason": "需要文案", "kind": "clarification", "options": []string{}})), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	agentWait(t, svc, identity, doc.ID)
	svc.Close()
	restarted := NewCanvasAgentService(context.Background(), svc.execution, svc.canvas, svc.skills, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	defer restarted.Close()
	req.ID = "after-restart"
	req.UserText = "示例品牌"
	if _, err := restarted.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, restarted, identity, doc.ID)
	if done.AgentRun.Status != "success" {
		t.Fatal(done.AgentRun)
	}
}
func TestCanvasAgentHistorySummaryPreservesLatestTurn(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		if r.Metadata["max_output_tokens"] != nil {
			return map[string]any{"text_response": "已确认品牌与比例；旧节点已创建，不能重复。"}, nil
		}
		return agentTurn(), nil
	}, nil)
	// Exercise compaction with a deterministic budget, independent of model defaults.
	doc.AgentConfig = json.RawMessage(`{"contextWindowTokens":64000}`)
	sessions, session, _ := agentSession(doc, "session")
	session["protocolMessages"] = []map[string]any{{"role": "user", "content": strings.Repeat("历史", 60000)}, {"role": "assistant", "content": "收到"}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	// Keep this fixture below the persisted session quota.
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ = agentSession(done, "session")
	if util.Clean(session["contextCheckpoint"]) == "" || calls.Load() < 2 {
		t.Fatalf("summary missing: %+v", done.AgentRun)
	}
}

func TestCanvasAgentDeleteRequiresExactConfirmationAndCancellationSurvivesReload(t *testing.T) {
	for _, answer := range []string{"确认删除", "保留"} {
		t.Run(answer, func(t *testing.T) {
			var calls atomic.Int32
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				if calls.Add(1) == 1 {
					return agentTurn(agentCall("delete", "delete_node", map[string]any{"nodeId": "existing"})), nil
				}
				return agentTurn(), nil
			}, nil)
			doc.Nodes = []CanvasNode{{ID: "existing", Type: "text", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1, Prompt: "keep"}}
			doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			waiting := agentWait(t, svc, identity, doc.ID)
			if len(waiting.Nodes) != 1 {
				t.Fatal("deleted before confirmation")
			}
			req.ID = "answer-delete"
			req.UserText = answer
			if _, err = svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			want := 1
			if answer == "确认删除" {
				want = 0
			}
			if len(done.Nodes) != want {
				t.Fatalf("nodes=%d want=%d", len(done.Nodes), want)
			}
		})
	}
}
func TestCanvasAgentCancelQuestionDoesNotRunModel(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		return agentTurn(agentCall("q", "ask_user_question", map[string]any{"question": "继续吗？", "reason": "确认", "kind": "confirmation", "options": []string{}})), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	sessions, session, _ := agentSession(waiting, req.SessionID)
	session["protocolMessages"] = append(util.AsMapSlice(session["protocolMessages"]), map[string]any{"role": "system", "content": "恢复时发现原素材已移除"})
	waiting.AgentSessions, _ = json.Marshal(sessions)
	if _, err := svc.canvas.saveAgent(identity.ID, waiting); err != nil {
		t.Fatal(err)
	}
	if err := svc.Stop(identity, doc.ID, req.ID); err != nil {
		t.Fatal(err)
	}
	done, err := svc.Snapshot(identity, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ = agentSession(done, "session")
	if done.AgentRun.Status != "cancelled" || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 || calls.Load() != 1 {
		t.Fatal("question cancellation failed")
	}
	protocol := util.AsMapSlice(session["protocolMessages"])
	if len(protocol) < 2 || protocol[len(protocol)-1]["role"] != "system" || protocol[len(protocol)-2]["toolCallId"] != "q" {
		t.Fatalf("cancelled question result was separated from its tool call: %v", protocol)
	}
}
func TestCanvasAgentMissingNodeStopsDependentWrites(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if calls.Add(1) == 1 {
			return agentTurn(agentCall("missing", "update_node", map[string]any{"nodeId": "missing", "title": "no"}), agentCall("skip", "create_text_node", map[string]any{"title": "skip", "content": "skip"})), nil
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if len(done.Nodes) > 0 || !strings.Contains(string(done.AgentSessions), "canvas_changed") {
		t.Fatal("dependent mutation executed")
	}
}
func TestCanvasAgentProtocolReplaysReasoningAndToolPairs(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
				if calls.Add(1) == 1 {
					turn := agentTurn(agentCall("read", "get_canvas_summary", map[string]any{}))
					turn["reasoning_content"] = "reasoning"
					turn["response_items"] = []map[string]any{{"type": "reasoning", "id": "r"}}
					return turn, nil
				}
				encoded := agentJSON(r.Messages)
				if !strings.Contains(encoded, "tool_call_id") || !strings.Contains(encoded, "reasoning_content") || !strings.Contains(encoded, "response_items") {
					t.Error("missing native protocol pair")
				}
				return agentTurn(), nil
			}, nil)
			req.APIMode = mode
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			if done.AgentRun.Status != "success" {
				t.Fatal(done.AgentRun)
			}
		})
	}
}

func TestCanvasAgentImageInputIsNotPersistedAsBase64(t *testing.T) {
	var sawImage bool
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		sawImage = strings.Contains(agentJSON(r.Messages), "/api/files/image/content") && strings.Contains(agentJSON(r.Messages), "image_url")
		return agentTurn(), nil
	}, nil)
	req.References = []map[string]any{{"id": "attachment", "type": "image", "source": "attachment", "title": "参考图", "url": "/api/files/image/content"}}
	doc = persistAgentTestReferences(t, svc, identity, doc, &req)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if !sawImage || strings.Contains(string(done.AgentSessions), "base64,fixture") {
		t.Fatal("image was lost or persisted inline")
	}
}
func TestCanvasAgentOversizedCurrentRequestIsPreservedWithoutSummarizing(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		return agentTurn(), nil
	}, nil)
	// Keep the overflow case independent of the default model context window.
	doc.AgentConfig = json.RawMessage(`{"contextWindowTokens":64000}`)
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.UserText = strings.Repeat("创作资料", 16000) + "最终品牌约束"
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	if calls.Load() != 0 || done.AgentRun.Status != "error" || !strings.Contains(done.AgentRun.Error, "本轮输入") || !strings.Contains(agentJSON(session["protocolMessages"]), req.UserText) {
		t.Fatalf("current request was summarized or lost: %+v calls=%d", done.AgentRun, calls.Load())
	}
}

func TestCanvasAgentResumeReusesSavedMediaNodeAndTask(t *testing.T) {
	var turns atomic.Int32
	var media atomic.Int32
	entered := make(chan struct{})
	var originalTask string
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("create", "generate_image", map[string]any{"prompt": "poster", "sourceNodeIds": []string{}, "size": "1:1", "count": 1})), nil
		}
		return agentTurn(), nil
	}, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any) (map[string]any, error) {
		if media.Add(1) == 1 {
			originalTask = n.TaskID
			close(entered)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if n.TaskID != originalTask {
			t.Error("new media task created on resume")
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/poster.png"}}}, nil
	})
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := svc.Stop(identity, doc.ID, req.ID); err != nil {
		t.Fatal(err)
	}
	agentWait(t, svc, identity, doc.ID)
	req.ID = "resume-media"
	req.Resume = true
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if len(done.Nodes) != 1 || done.Nodes[0].TaskID != originalTask || done.Nodes[0].GenerationStatus != "success" {
		t.Fatalf("resume duplicated or lost media: run=%+v nodes=%+v", done.AgentRun, done.Nodes)
	}
}

func TestCanvasAgentResumeReconcilesMediaFinishedWhileStopped(t *testing.T) {
	for _, status := range []string{"success", "error", "deleted"} {
		t.Run(status, func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				return agentTurn(), nil
			}, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
				t.Error("an already settled task must not be submitted again")
				return nil, errors.New("unexpected generation")
			})
			if status != "deleted" {
				doc.Nodes = []CanvasNode{{ID: "existing-result", Type: "image", Title: "已有结果", TaskID: "saved-task", GenerationStatus: status, GenerationError: "", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
				if status == "success" {
					doc.Nodes[0].URL = "https://example.test/completed.png"
				} else {
					doc.Nodes[0].GenerationError = "上游任务失败"
				}
			}
			sessions, session, _ := agentSession(doc, req.SessionID)
			agentMap(session["agentState"])["pendingTaskIds"] = []string{"saved-task"}
			session["protocolMessages"] = []map[string]any{
				{"role": "user", "content": "生成海报"},
				{"role": "assistant", "toolCalls": []map[string]any{{"id": "generate", "name": "generate_image", "arguments": map[string]any{}}}},
				{"role": "tool", "toolCallId": "generate", "name": "generate_image", "content": agentJSON(map[string]any{"ok": true, "nodeId": "existing-result", "taskId": "saved-task", "status": "loading", "submitted": true})},
			}
			doc.AgentSessions, _ = json.Marshal(sessions)
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			req.Resume = true
			if _, err = svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			_, session, _ = agentSession(done, req.SessionID)
			state := agentMap(session["agentState"])
			want := "success"
			if status == "error" {
				want = "waiting"
			}
			if done.AgentRun.Status != want || len(agentStrings(state["pendingTaskIds"])) != 0 || (status == "success" && !slices.Contains(agentStrings(state["completedTaskIds"]), "saved-task")) || (status == "deleted" && len(done.Nodes) != 0) {
				t.Fatalf("settled media still blocks recovery: run=%+v, state=%v, nodes=%d", done.AgentRun, state, len(done.Nodes))
			}
		})
	}
}
func TestCanvasAgentBackgroundRunDoesNotSwitchActiveProject(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, _ AgentModelRequest) (map[string]any, error) {
		close(entered)
		select {
		case <-release:
			return agentTurn(), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	<-entered
	other, err := svc.canvas.UpdateProject(identity.ID, "create", "", "另一个项目")
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	agentWait(t, svc, identity, doc.ID)
	workspace, err := svc.canvas.Workspace(identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	if workspace.ActiveProjectID != other.ActiveProjectID {
		t.Fatal("background checkpoint changed active project")
	}
}

func TestCanvasAgentRejectsMalformedRuntimeState(t *testing.T) {
	for _, key := range []string{"phase", "pendingTaskIds", "messages", "protocolMessages"} {
		t.Run(key, func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, nil, nil)
			sessions, session, _ := agentSession(doc, "session")
			if key == "phase" || key == "pendingTaskIds" {
				agentMap(session["agentState"])[key] = nil
			} else {
				session[key] = nil
			}
			doc.AgentSessions, _ = json.Marshal(sessions)
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = svc.Start(identity, doc.ID, req); err == nil {
				t.Fatal("malformed runtime state accepted")
			}
		})
	}
}

func TestCanvasAgentWorkflowIsAtomicAndExecutesDependencies(t *testing.T) {
	var turn atomic.Int32
	generated := []string{}
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		switch turn.Add(1) {
		case 1:
			return agentTurn(agentCall("graph", "create_canvas_workflow", map[string]any{"steps": []map[string]any{
				{"key": "brief", "type": "text", "title": "品牌要求", "prompt": "统一使用蓝色", "dependsOn": []string{}, "sourceNodeIds": []string{}, "attachmentIds": []string{}},
				{"key": "image", "type": "image", "title": "品牌海报", "prompt": "产品广告", "dependsOn": []string{"brief"}, "size": "1:1", "count": 1, "sourceNodeIds": []string{}, "attachmentIds": []string{}},
				{"key": "video", "type": "video", "title": "宣传片", "prompt": "展示产品", "dependsOn": []string{"image"}, "size": "1280x720", "seconds": 5, "generateAudio": false, "sourceNodeIds": []string{}, "attachmentIds": []string{}},
			}})), nil
		case 2:
			return agentTurn(agentCall("find", "get_canvas_summary", map[string]any{})), nil
		default:
			return agentTurn(), nil
		}
	}, func(_ context.Context, _ Identity, n CanvasNode, _ map[string]any) (map[string]any, error) {
		generated = append(generated, n.Type)
		if n.Type == "image" && !strings.Contains(n.Prompt, "统一使用蓝色") {
			t.Error("upstream text missing")
		}
		if n.Type == "video" && !slices.Contains(n.GenerationVideoReferenceImages, "https://example.test/image.png") {
			t.Error("upstream image missing")
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/" + n.Type + ".png"}}}, nil
	})
	req.Generation["videoModel"] = "video-test"
	req.Generation["capabilities"].(map[string]any)["video"] = map[string]any{"sizes": []string{"1280x720"}, "audioControl": "optional"}
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if len(done.Nodes) != 3 || len(done.Connections) != 2 || len(generated) != 0 {
		t.Fatalf("graph should only be planned: %+v", done.AgentRun)
	}
	target := done.Nodes[2].ID
	svc.model = func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if turn.Add(1) == 4 {
			return agentTurn(agentCall("run-graph", "run_canvas_workflow", map[string]any{"nodeIds": []string{target}})), nil
		}
		return agentTurn(), nil
	}
	req.ID = "execute-graph"
	req.UserText = "执行已确认的工作流"
	req.Resume = true
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done = agentWait(t, svc, identity, doc.ID)
	if !slices.Equal(generated, []string{"image", "video"}) || done.Nodes[2].GenerationStatus != "success" {
		t.Fatalf("dependency execution failed: %v %+v", generated, done.AgentRun)
	}
}

func TestCanvasAgentWorkflowRejectsCyclesAndMissingParametersWithoutMutation(t *testing.T) {
	for _, cycle := range []bool{true, false} {
		t.Run(fmt.Sprint(cycle), func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				return agentTurn(), nil
			}, nil)
			_, session, _ := agentSession(doc, "session")
			w := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
			steps := []map[string]any{{"key": "a", "type": "image", "title": "a", "prompt": "poster", "size": "1:1", "count": 1, "dependsOn": []string{"b"}}, {"key": "b", "type": "text", "title": "b", "prompt": "brief", "dependsOn": []string{"a"}}}
			if !cycle {
				steps[0]["dependsOn"] = []string{}
				delete(steps[0], "size")
			}
			if _, err := w.createCanvasWorkflow(steps); err == nil {
				t.Fatal("invalid graph accepted")
			}
			current, err := svc.canvas.Project(identity.ID, doc.ID)
			if err != nil || len(current.Nodes) != 0 {
				t.Fatal("invalid graph partially persisted")
			}
		})
	}
}

func TestCanvasAgentWorkflowTemplateOwnershipAndRequiredVariables(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	workflows := NewWorkflowService(newTestStorageBackend(t))
	svc.SetWorkflowService(workflows)
	template, err := workflows.Save(identity.ID, CreativeWorkflow{Name: "广告", Scope: "private", Mode: "single_image", Variables: []WorkflowVariable{{Key: "brand", Label: "品牌", Type: "text", Required: true}}, Config: WorkflowGenerationConfig{PromptTemplate: "{{brand}} 海报"}})
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, "session")
	w := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
	_, err = w.runSavedWorkflow(map[string]any{"workflowId": template.ID, "items": []map[string]any{{"values": []map[string]any{}, "size": "1:1", "count": 1}}})
	if err == nil || !strings.Contains(err.Error(), "品牌") {
		t.Fatal("missing required variable accepted")
	}
	w.identity = Identity{ID: "other"}
	if _, err = w.workflow(template.ID); err == nil {
		t.Fatal("private workflow leaked")
	}
}

func TestCanvasAgentContinuesAfterPrematureFinalReply(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		turn := turns.Add(1)
		switch turn {
		case 1:
			return agentTurn(agentCall("plan", "update_plan", map[string]any{"steps": []any{map[string]any{"id": "write", "title": "完成制作方案", "status": "in_progress"}}})), nil
		case 3, 5, 7:
			if !strings.Contains(agentJSON(r.Messages), "未完成") {
				t.Error("remaining plan was not returned to the model")
			}
			status := "in_progress"
			if turn == 7 {
				status = "completed"
			}
			return agentTurn(agentCall(fmt.Sprint("complete-plan-", turn), "update_plan", map[string]any{"explanation": fmt.Sprint("已完成阶段 ", turn), "steps": []any{map[string]any{"id": "write", "title": "完成制作方案", "status": status}}})), nil
		default:
			return agentTurn(), nil
		}
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns.Load() != 8 {
		t.Fatalf("prematurely stopped: run=%+v, turns=%d", done.AgentRun, turns.Load())
	}
}

func TestCanvasAgentUnrelatedLoadingMediaDoesNotBlockCompletion(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	doc.Nodes = []CanvasNode{{ID: "unrelated", Type: "image", Title: "其他任务", GenerationStatus: "loading", TaskID: "unrelated-task", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || done.Nodes[0].TaskID != "unrelated-task" {
		t.Fatalf("unrelated work blocked the current request: %+v", done.AgentRun)
	}
}

func TestCanvasAgentUpstreamCancellationIsNotReportedAsUserStop(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return nil, context.Canceled
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "error" || !strings.Contains(done.AgentRun.Error, "context canceled") {
		t.Fatalf("upstream cancellation was attributed to a user stop: %+v", done.AgentRun)
	}
}

func TestCanvasAgentFinalReplyDoesNotHideToolFailure(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("bad-connection", "create_connection", map[string]any{"fromNodeId": "script", "toNodeId": "script"})), nil
		}
		return map[string]any{"text_response": "全部完成"}, nil
	}, nil)
	doc.Nodes = []CanvasNode{{ID: "script", Type: "text", Title: "剧本", Prompt: "保留", GenerationStatus: "success", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	if done.AgentRun.Status != "waiting" || util.AsMapSlice(session["messages"])[1]["text"] == "全部完成" || turns.Load() != 2 {
		t.Fatalf("failed operation was reported as complete: run=%+v, turns=%d", done.AgentRun, turns.Load())
	}
}

func TestCanvasAgentPrematureCompletionIsBoundedAndResumable(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("plan", "update_plan", map[string]any{"steps": []any{map[string]any{"id": "work", "title": "仍待处理", "status": "pending"}}})), nil
		}
		return map[string]any{"text_response": "全部完成"}, nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	message := util.AsMapSlice(session["messages"])[1]
	if done.AgentRun.Status != "waiting" || turns.Load() != 2 || message["status"] != "waiting" || message["text"] == "全部完成" {
		t.Fatalf("run=%+v, turns=%d, message=%v", done.AgentRun, turns.Load(), message)
	}
}

func TestCanvasAgentQuestionWithoutSDKCheckpointCanResume(t *testing.T) {
	for _, resumeWithoutAnswer := range []bool{false, true} {
		t.Run(fmt.Sprint("resumeWithoutAnswer=", resumeWithoutAnswer), func(t *testing.T) {
			var turns atomic.Int32
			svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
				if turns.Add(1) == 1 {
					return agentTurn(agentCall("question", "ask_user_question", map[string]any{"question": "品牌名称？", "reason": "需要确认文案", "kind": "clarification", "options": []string{}})), nil
				}
				if !strings.Contains(agentJSON(r.Messages), "用户真实品牌") {
					t.Error("real answer missing after checkpoint recovery")
				}
				return agentTurn(), nil
			}, nil)
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			waiting := agentWait(t, svc, identity, doc.ID)
			waiting.AgentRun.SDKState = ""
			if _, err := svc.canvas.saveAgent(identity.ID, waiting); err != nil {
				t.Fatal(err)
			}
			if resumeWithoutAnswer {
				req.ID, req.Resume = "restore-question", true
				if _, err := svc.Start(identity, doc.ID, req); err != nil {
					t.Fatal(err)
				}
				waiting = agentWait(t, svc, identity, doc.ID)
				if waiting.AgentRun.Status != "waiting" || waiting.AgentRun.SDKState == "" || turns.Load() != 1 {
					t.Fatalf("question was not restored: run=%+v, turns=%d", waiting.AgentRun, turns.Load())
				}
				req.ID = "resume-without-answer"
				if _, err := svc.Start(identity, doc.ID, req); err != nil {
					t.Fatal(err)
				}
				waiting = agentWait(t, svc, identity, doc.ID)
				_, restoredSession, _ := agentSession(waiting, req.SessionID)
				if waiting.AgentRun.Status != "waiting" || waiting.AgentRun.SDKState == "" || turns.Load() != 1 || len(agentMap(agentMap(restoredSession["agentState"])["pendingQuestion"])) == 0 {
					t.Fatalf("resume consumed an unanswered question: run=%+v, turns=%d", waiting.AgentRun, turns.Load())
				}
			}
			req.ID, req.Resume, req.UserText = "answer-restored-question", false, "用户真实品牌"
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			if done.AgentRun.Status != "success" || turns.Load() != 2 {
				t.Fatalf("question recovery failed: run=%+v, turns=%d", done.AgentRun, turns.Load())
			}
		})
	}
}

func TestCanvasAgentResumeSkipsDeletedReferences(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		if !strings.Contains(agentJSON(r.Messages), "移除") {
			t.Error("model was not told that the original reference is missing")
		}
		return agentTurn(), nil
	}, nil)
	req.Resume = true
	req.References = []map[string]any{{"id": "deleted-photo", "source": "node"}}
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatalf("deleted reference permanently blocked resume: %v", err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || len(done.Nodes) != 0 {
		t.Fatalf("deleted reference was recreated: %+v", done.AgentRun)
	}
}

func TestCanvasAgentInvalidToolArgumentsCanBeCorrected(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		switch turns.Add(1) {
		case 1:
			return agentTurn(agentCall("blocked", "create_text_node", map[string]any{"title": "不得执行", "content": "依赖无效批次"}), agentCall("bad", "generate_image", map[string]any{"prompt": "缺少必要参数"})), nil
		case 2:
			return agentTurn(agentCall("read", "get_canvas_summary", map[string]any{})), nil
		case 3:
			calls := []map[string]any{}
			for i := range 13 {
				calls = append(calls, agentCall(fmt.Sprintf("over-limit-%d", i), "create_text_node", map[string]any{"title": "不得执行", "content": "超限批次"}))
			}
			return agentTurn(calls...), nil
		case 4:
			return agentTurn(agentCall("corrected", "create_text_node", map[string]any{"title": "修正后创建", "content": "有效分批操作"})), nil
		}
		if !strings.Contains(agentJSON(r.Messages), "校验") {
			t.Error("validation failure was not returned to the model")
		}
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns.Load() != 5 || len(done.Nodes) != 1 || done.Nodes[0].Title != "修正后创建" {
		t.Fatalf("invalid batch did not recover safely: run=%+v, turns=%d, nodes=%d", done.AgentRun, turns.Load(), len(done.Nodes))
	}
}

func TestCanvasAgentResumeReusesWorkflowNodes(t *testing.T) {
	for _, sameCallID := range []bool{false, true} {
		t.Run(fmt.Sprint("sameCallID=", sameCallID), func(t *testing.T) {
			var turns atomic.Int32
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				turn := turns.Add(1)
				if turn == 1 || turn == 3 {
					id := "workflow"
					if turn == 3 && !sameCallID {
						id = "retry-workflow"
					}
					return agentTurn(agentCall(id, "create_canvas_workflow", map[string]any{"steps": []any{map[string]any{"key": "script", "type": "text", "title": "剧本", "prompt": "已有内容", "dependsOn": []string{}, "sourceNodeIds": []string{}, "attachmentIds": []string{}}}})), nil
				}
				return agentTurn(), nil
			}, nil)
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			first := agentWait(t, svc, identity, doc.ID)
			if len(first.Nodes) != 1 {
				t.Fatal("workflow fixture was not created")
			}
			req.ID, req.Resume = "resume-workflow", true
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			if done.AgentRun.Status != "success" || len(done.Nodes) != 1 || done.Nodes[0].ID != first.Nodes[0].ID {
				t.Fatalf("workflow duplicated on resume: run=%+v, nodes=%d", done.AgentRun, len(done.Nodes))
			}
		})
	}
}

func TestCanvasAgentInvalidWorkflowReviewQuestionIsCorrected(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		turn := turns.Add(1)
		if turn == 1 {
			return agentTurn(
				agentCall("bad-review", "ask_user_question", map[string]any{"question": "继续当前短剧？", "reason": "确认执行范围", "options": []string{"继续", "暂缓"}, "kind": "clarification", "purpose": "workflow_review"}),
				agentCall("blocked-write", "create_text_node", map[string]any{"title": "不要创建", "content": "依赖回答"}),
			), nil
		}
		encoded := agentJSON(r.Messages)
		if !strings.Contains(encoded, "workflow_review_unavailable") || !strings.Contains(encoded, "dependency_failed") {
			t.Error("model did not receive the rejected question and unexecuted batch results")
		}
		if turn == 3 {
			if !strings.Contains(encoded, "继续制作已有短剧") {
				t.Error("real answer was not delivered")
			}
			return agentTurn(), nil
		}
		return agentTurn(agentCall("clarify", "ask_user_question", map[string]any{"question": "继续当前短剧？", "reason": "确认执行范围", "options": []string{"继续", "暂缓"}, "kind": "clarification"})), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, err := agentSession(done, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	state := agentMap(session["agentState"])
	question := agentMap(state["pendingQuestion"])
	if done.AgentRun.Status != "waiting" || turns.Load() != 2 || len(done.Nodes) != 0 || question["id"] != "clarify" || question["purpose"] != nil || done.AgentRun.SDKState == "" {
		t.Fatalf("run=%+v, turns=%d, nodes=%d, question=%v", done.AgentRun, turns.Load(), len(done.Nodes), question)
	}
	if !strings.Contains(string(done.AgentSessions), "workflow_review_unavailable") {
		t.Fatal("failed question result was not persisted")
	}
	req.ID = "answer-corrected-question"
	req.UserText = "继续制作已有短剧"
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done = agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || turns.Load() != 3 || len(done.Nodes) != 0 {
		t.Fatalf("corrected question could not resume: run=%+v, turns=%d", done.AgentRun, turns.Load())
	}
}

func TestCanvasAgentRepeatedInvalidWorkflowReviewQuestionIsBounded(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(agentCall(fmt.Sprint("bad-review-", turns.Add(1)), "ask_user_question", map[string]any{"question": "审核？", "reason": "无待审核系列", "options": []string{}, "kind": "confirmation", "purpose": "workflow_review"})), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, err := agentSession(done, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if done.AgentRun.Status != "error" || turns.Load() != 2 || !canvasAgentCompleteToolRounds(util.AsMapSlice(session["protocolMessages"])) || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) != 0 {
		t.Fatalf("run=%+v, turns=%d", done.AgentRun, turns.Load())
	}
}

func TestCanvasAgentResumeRepairsUnansweredToolCallWithoutRepeatingWrites(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		var result map[string]any
		for _, message := range r.Messages {
			if message["role"] == "tool" && message["tool_call_id"] == "interrupted-create" {
				_ = json.Unmarshal([]byte(util.Clean(message["content"])), &result)
			}
		}
		if result["code"] != "execution_unknown" || result["ok"] != false {
			t.Error("interrupted tool call was not repaired as an unknown result")
		}
		return agentTurn(), nil
	}, nil)
	sessions, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	session["protocolMessages"] = []map[string]any{
		{"role": "user", "content": "制作短剧"},
		{"role": "assistant", "content": "", "toolCalls": []map[string]any{{"id": "interrupted-create", "name": "create_text_node", "arguments": map[string]any{"title": "已有剧本", "content": "保留"}}}},
		{"role": "user", "content": "继续已有结果"},
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc.Nodes = append(doc.Nodes, CanvasNode{ID: "existing-script", Type: "text", Title: "已有剧本", Prompt: "保留", GenerationStatus: "success", Width: 360, Height: 280, ScaleX: 1, ScaleY: 1})
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.Resume = true
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ = agentSession(done, req.SessionID)
	messages := util.AsMapSlice(session["protocolMessages"])
	if done.AgentRun.Status != "success" || len(done.Nodes) != 1 || done.Nodes[0].ID != "existing-script" || len(messages) < 4 || messages[2]["role"] != "tool" || messages[3]["role"] != "user" || !canvasAgentCompleteToolRounds(messages) {
		t.Fatalf("run=%+v, nodes=%d, messages=%v", done.AgentRun, len(done.Nodes), messages)
	}
}

func TestCanvasAgentSeriesWorkflowRequiresReviewAndPreservesReferenceOrder(t *testing.T) {
	var turns atomic.Int32
	var generated []string
	var generatedMu sync.Mutex
	var targetIDs []string
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, _ AgentModelRequest) (map[string]any, error) {
		switch turns.Add(1) {
		case 1:
			return agentTurn(agentCall("apply", "run_saved_workflow", map[string]any{
				"workflowId": "series-workflow",
				"items": []map[string]any{
					{"title": "春季广告", "values": []map[string]any{{"key": "brand", "value": "山野"}}, "size": "1:1", "count": 1, "sourceNodeIds": []string{"product-photo"}, "attachmentIds": []string{"uploaded-photo"}},
					{"title": "春季广告细节", "values": []map[string]any{{"key": "brand", "value": "山野"}}, "size": "1:1", "count": 1, "sourceNodeIds": []string{"product-photo"}, "attachmentIds": []string{"uploaded-photo"}},
				},
			})), nil
		case 2:
			return agentTurn(agentCall("review", "ask_user_question", map[string]any{
				"question": "请审核系列提示词，确认后开始生成。",
				"reason":   "先检查各张图片的主题和产品参考是否正确。",
				"options":  []string{"确认审核并生成", "暂不生成，保留提示词"},
				"kind":     "confirmation",
				"purpose":  "workflow_review",
			})), nil
		case 3:
			return agentTurn(agentCall("execute", "run_canvas_workflow", map[string]any{"nodeIds": targetIDs})), nil
		default:
			return agentTurn(), nil
		}
	}, func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any) (map[string]any, error) {
		generatedMu.Lock()
		generated = append(generated, node.ID)
		generatedMu.Unlock()
		return map[string]any{"data": []map[string]any{{"url": "https://result.test/" + node.ID + ".png"}}}, nil
	})

	workflows := NewWorkflowService(newTestStorageBackend(t))
	svc.SetWorkflowService(workflows)
	workflow, err := workflows.Save(identity.ID, CreativeWorkflow{
		ID: "series-workflow", Scope: "private", Mode: "multi_image_series", Name: "系列广告",
		Variables:          []WorkflowVariable{{Key: "brand", Label: "品牌", Type: "text", Required: true}},
		TemplateReferences: []WorkflowTemplateReference{{ID: "style-template", Name: "风格模板", URL: "https://template.test/style.png"}},
		Config:             WorkflowGenerationConfig{PromptTemplate: "{{brand}} 春季商品宣传"},
		SeriesConfig:       WorkflowSeriesConfig{ReviewRequired: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if workflow.ID != "series-workflow" {
		t.Fatalf("workflow ID = %q", workflow.ID)
	}
	product := CanvasNode{ID: "product-photo", Type: "image", Title: "产品实拍", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, URL: "https://product.test/photo.png", GenerationStatus: "success"}
	doc.Nodes = append(doc.Nodes, product)
	sessions, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	messages := util.AsMapSlice(session["messages"])
	messages[0]["references"] = []map[string]any{{"id": "uploaded-photo", "source": "attachment", "type": "image", "url": "https://upload.test/photo.png"}}
	session["messages"] = messages
	doc.AgentSessions, _ = json.Marshal(sessions)
	missingReferenceWorker := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
	_, missingReferenceErr := missingReferenceWorker.runSavedWorkflow(map[string]any{
		"workflowId": workflow.ID,
		"items":      []map[string]any{{"values": []map[string]any{{"key": "brand", "value": "山野"}}, "size": "1:1", "count": 1, "sourceNodeIds": []string{}, "attachmentIds": []string{}}},
	})
	if missingReferenceErr == nil || !strings.Contains(missingReferenceErr.Error(), "产品图片") {
		t.Fatalf("missing product reference accepted: %v", missingReferenceErr)
	}
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}

	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	if waiting.AgentRun.Status != "waiting" || len(waiting.Nodes) != 4 {
		t.Fatalf("expected preserved product and two draft nodes while awaiting review: status=%s nodes=%d", waiting.AgentRun.Status, len(waiting.Nodes))
	}
	image := waiting.Nodes[1]
	secondImage := waiting.Nodes[2]
	targetIDs = []string{image.ID, secondImage.ID}
	wantReferences := []string{"https://template.test/style.png", "https://product.test/photo.png", "https://upload.test/photo.png"}
	for _, seriesImage := range []CanvasNode{image, secondImage} {
		if !slices.Equal(seriesImage.GenerationReferenceURLs, wantReferences) {
			t.Fatalf("%s reference order = %#v, want %#v", seriesImage.Title, seriesImage.GenerationReferenceURLs, wantReferences)
		}
		if seriesImage.GenerationStatus != "idle" {
			t.Fatalf("series generated before review: %s status=%s", seriesImage.Title, seriesImage.GenerationStatus)
		}
	}
	if len(generated) != 0 {
		t.Fatalf("series generated before review: generated=%v", generated)
	}
	_, session, err = agentSession(waiting, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	state := agentMap(session["agentState"])
	question := agentMap(state["pendingQuestion"])
	if question["purpose"] != "workflow_review" {
		t.Fatalf("pending review question = %#v", question)
	}

	worker := &canvasAgentWorker{service: svc, ctx: context.Background(), identity: identity, doc: waiting, req: req, session: session, state: state}
	if validationErr := worker.validateMedia(image); validationErr != nil {
		t.Fatalf("pre-resume media validation: %v count=%d caps=%s", validationErr, image.GenerationCount, agentJSON(req.Generation["capabilities"]))
	}
	blocked, err := worker.generateNode(image.ID)
	if err != nil || blocked["ok"] != false || blocked["requiresUserReview"] != true || len(generated) != 0 {
		t.Fatalf("direct node generation bypassed review: result=%#v err=%v generated=%v", blocked, err, generated)
	}
	beforeMediaNodes := len(worker.doc.Nodes)
	blocked, err = worker.tool(map[string]any{"name": "generate_image", "arguments": map[string]any{"title": "绕过审核", "prompt": "unused", "sourceNodeIds": []string{}, "size": "1:1", "count": 1}})
	if err != nil || blocked["ok"] != false || blocked["requiresUserReview"] != true || len(worker.doc.Nodes) != beforeMediaNodes || len(generated) != 0 {
		t.Fatalf("new media generation bypassed review: result=%#v err=%v nodes=%d generated=%v", blocked, err, len(worker.doc.Nodes), generated)
	}

	req.ID = "approve-series"
	req.UserText = agentStrings(question["options"])[0]
	req.Resume = false
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	slices.Sort(generated)
	wantGenerated := slices.Clone(targetIDs)
	slices.Sort(wantGenerated)
	if done.AgentRun.Status != "success" || !slices.Equal(generated, wantGenerated) || done.Nodes[1].GenerationStatus != "success" || done.Nodes[2].GenerationStatus != "success" {
		_, finalSession, _ := agentSession(done, req.SessionID)
		t.Fatalf("approved workflow did not execute: generated=%v status=%s first=%s second=%s messages=%s trace=%s", generated, done.AgentRun.Status, done.Nodes[1].GenerationStatus, done.Nodes[2].GenerationStatus, agentJSON(finalSession["protocolMessages"]), agentJSON(util.AsMapSlice(finalSession["messages"])[1]["trace"]))
	}
}

func TestCanvasAgentSeriesWorkflowDeclineAndPromptEditKeepReviewRequired(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	node := CanvasNode{ID: "series-draft", Type: "image", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1, Title: "草稿", Prompt: "原始提示词", GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1, GenerationStatus: "idle"}
	doc.Nodes = append(doc.Nodes, node)
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, SDKState: "saved-run-state"}
	var saveErr error
	doc, saveErr = svc.canvas.saveAgent(identity.ID, doc)
	if saveErr != nil {
		t.Fatal(saveErr)
	}
	_, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	state := agentMap(session["agentState"])
	state["pendingWorkflowReview"] = map[string]any{"nodeIds": []string{node.ID}}
	state["pendingQuestion"] = map[string]any{"id": "review", "purpose": "workflow_review", "nodeIds": []string{node.ID}}
	worker := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: state, answerCallID: "review", answerText: "暂不生成，保留提示词"}

	result, err := worker.sdkTool(map[string]any{"id": "review", "name": "ask_user_question", "arguments": map[string]any{}})
	if err != nil || result.(map[string]any)["ok"] != false {
		t.Fatalf("declining review = %#v, %v", result, err)
	}
	if len(agentStrings(agentMap(state["pendingWorkflowReview"])["nodeIds"])) != 1 || len(agentMap(state["approvedWorkflowReviewPrompts"])) != 0 {
		t.Fatalf("declining review changed approval state: %#v", state)
	}
	if state["mediaGenerationDeferred"] != true {
		t.Fatal("declining review did not preserve the user's deferral")
	}
	blocked, err := worker.generateNode(node.ID)
	if err != nil || blocked["ok"] != false || blocked["requiresUserReview"] != true {
		t.Fatalf("declined workflow generated: %#v, %v", blocked, err)
	}

	state["pendingQuestion"] = map[string]any{"id": "review-again", "purpose": "workflow_review", "nodeIds": []string{node.ID}}
	worker.doc.AgentRun.SDKState = "saved-run-state"
	worker.req.UserText = "确认审核并生成"
	worker.answerCallID = "review-again"
	worker.answerText = worker.req.UserText
	result, err = worker.sdkTool(map[string]any{"id": "review-again", "name": "ask_user_question", "arguments": map[string]any{}})
	if err != nil || result.(map[string]any)["ok"] != true || state["mediaGenerationDeferred"] != false {
		t.Fatalf("explicit approval did not release the earlier deferral: result=%v, error=%v, state=%v", result, err, state)
	}
	worker.node(node.ID).Prompt = "用户修改后的提示词"
	if worker.workflowReviewApproved(node.ID) {
		t.Fatal("editing a reviewed prompt retained its old approval")
	}
	blocked, err = worker.generateNode(node.ID)
	if err != nil || blocked["ok"] != false || blocked["requiresUserReview"] != true {
		t.Fatalf("edited prompt bypassed review: %#v, %v", blocked, err)
	}
}

func TestCanvasAgentImageReferencesRespectModelLimit(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	capabilities := agentMap(req.Generation["capabilities"])
	imageCapabilities := agentMap(capabilities["image"])
	imageCapabilities["maxReferenceImages"] = 2
	capabilities["image"] = imageCapabilities
	req.Generation["capabilities"] = capabilities
	node := CanvasNode{
		ID: "series-image", Type: "image", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
		GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1,
		GenerationReferenceURLs: []string{"https://template.test/style.png", "https://product.test/a.png", "https://product.test/b.png"},
	}
	_, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	worker := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
	if err = worker.validateMedia(node); err == nil || !strings.Contains(err.Error(), "参考图") {
		t.Fatalf("image reference overflow accepted: %v", err)
	}
}

func TestCanvasAgentBatchDeletionUsesOneScopedConfirmation(t *testing.T) {
	for _, scenario := range []string{"confirm", "cancel", "changed"} {
		t.Run(scenario, func(t *testing.T) {
			var turns atomic.Int32
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				if turns.Add(1) == 1 {
					return agentTurn(agentCall("delete-batch", "delete_node", map[string]any{"nodeIds": []string{"audio-one", "audio-two"}})), nil
				}
				return agentTurn(), nil
			}, nil)
			for _, id := range []string{"audio-one", "audio-two", "keep-video"} {
				doc.Nodes = append(doc.Nodes, CanvasNode{ID: id, Type: "text", Title: id, Prompt: "original", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1})
			}
			doc.Connections = []CanvasConnection{{ID: "link", FromNodeID: "audio-one", ToNodeID: "keep-video"}}
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			waiting := agentWait(t, svc, identity, doc.ID)
			_, session, _ := agentSession(waiting, req.SessionID)
			question := agentMap(agentMap(session["agentState"])["pendingQuestion"])
			if waiting.AgentRun.Status != "waiting" || len(waiting.Nodes) != 3 || turns.Load() != 1 || len(agentStrings(question["nodeIds"])) != 2 {
				t.Fatalf("batch was not held for one approval: run=%+v question=%v", waiting.AgentRun, question)
			}
			for _, title := range []string{"audio-one", "audio-two"} {
				if !strings.Contains(util.Clean(question["question"]), title) {
					t.Fatalf("confirmation omitted %s", title)
				}
			}
			if scenario == "changed" {
				waiting.Nodes[1].Prompt = "user edited during confirmation"
				if _, err = svc.canvas.SaveAtRevision(identity.ID, waiting); err != nil {
					t.Fatal(err)
				}
			}
			req.ID = "answer-batch"
			req.UserText = "确认删除"
			if scenario == "cancel" {
				req.UserText = "保留全部"
			}
			if _, err = svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			want := 3
			if scenario == "confirm" {
				want = 1
			}
			if len(done.Nodes) != want {
				t.Fatalf("batch deletion was partial or out of scope: nodes=%v", done.Nodes)
			}
			if scenario == "confirm" && (done.Nodes[0].ID != "keep-video" || len(done.Connections) != 0) {
				t.Fatal("unrelated node lost or removed connections retained")
			}
			_, session, _ = agentSession(done, req.SessionID)
			if len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) != 0 || turns.Load() != 2 {
				t.Fatal("batch asked again after one response")
			}
		})
	}
}

func TestCanvasAgentBatchDeletionRejectsInvalidTargetsBeforeApproval(t *testing.T) {
	for _, args := range []map[string]any{
		{}, {"nodeId": "a", "nodeIds": []string{"b"}}, {"nodeIds": []string{"a", "a"}}, {"nodeIds": []string{"a", "missing"}},
	} {
		w := memoryWorker(t, nil)
		w.doc.Nodes = []CanvasNode{{ID: "a", Type: "text", Prompt: "keep", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
		w.sdk = &AgentSDKSession{}
		result, err := w.sdkPrepare(agentTurn(agentCall("invalid-delete", "delete_node", args)))
		if err == nil && util.Clean(agentMap(result)["error"]) == "" {
			t.Fatalf("invalid target accepted: %v", args)
		}
		if len(w.doc.Nodes) != 1 || len(agentMap(w.state["pendingQuestion"])) != 0 {
			t.Fatal("invalid deletion changed canvas or created approval")
		}
	}
}
