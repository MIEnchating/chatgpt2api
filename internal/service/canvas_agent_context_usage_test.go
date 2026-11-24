package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestCanvasAgentManualCompactionPersistsAcrossNewRequests(t *testing.T) {
	const summary = "前一轮已经完成第一版，不重复提交。"
	var summaryCalls int
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if err := request.BeforeDispatch(); err != nil {
			return nil, err
		}
		if request.Diagnostic["purpose"] == "summary" {
			summaryCalls++
			return map[string]any{"text_response": summary}, nil
		}
		if input := agentJSON(request.Messages); !strings.Contains(input, summary) || strings.Contains(input, "原始素材原始素材") || !strings.Contains(input, "接着检查当前画布") {
			t.Errorf("next request did not apply the persisted projection")
		}
		return map[string]any{"text_response": "已检查"}, nil
	}, nil)
	sessions, session, _ := agentSession(doc, req.SessionID)
	session["protocolMessages"] = []map[string]any{
		{"role": "user", "content": strings.Repeat("原始素材", 2000)},
		{"role": "assistant", "content": "已完成第一版"},
		{"role": "user", "content": "保留原尺寸"},
		{"role": "assistant", "content": "已确认"},
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.Compact(context.Background(), identity, doc.ID, CanvasAgentCompactionRequest{SessionID: req.SessionID, Model: req.Model, RelayTokenName: req.RelayTokenName, APIMode: req.APIMode})
	if err != nil || result.Kind != "summarized" || result.SavedTokens < 7000 || summaryCalls != 1 {
		t.Fatalf("unexpected compaction: %+v calls=%d err=%v", result, summaryCalls, err)
	}
	stored := canvasAgentWorker{service: svc, identity: identity, doc: doc, req: req}
	if found, err := stored.loadSDKSession(); err != nil || !found {
		t.Fatalf("load manual compaction: found=%v err=%v", found, err)
	}
	records := util.AsMapSlice(agentMapFromJSON(t, stored.sdk.ModelContext)["compactions"])
	if len(records) != 1 || records[0]["trigger"] != "manual" || records[0]["summary"] != summary || agentJSON(records[0]["sourceRanges"]) != "[[0,2],[3,4]]" {
		t.Fatalf("manual compaction lost the source boundaries: %s", stored.sdk.ModelContext)
	}
	after, err := svc.Snapshot(identity, doc.ID)
	if err != nil || after.Revision != doc.Revision || string(after.AgentSessions) != string(doc.AgentSessions) {
		t.Fatalf("manual compaction edited the visible history: %v", err)
	}
	req.ReadOnly, req.UserText = true, "接着检查当前画布"
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	if done := agentWait(t, svc, identity, doc.ID); done.AgentRun.Status != "success" {
		t.Fatalf("failed to continue on compacted context: %+v", done.AgentRun)
	}
}

func TestCanvasAgentAutomaticCompactionSourcesSurviveCompletion(t *testing.T) {
	const summary = "旧稿已核对。"
	const old = "原始素材原始素材"
	var summaryCalls int
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if request.Diagnostic["purpose"] == "summary" {
			summaryCalls++
			return map[string]any{"text_response": summary}, nil
		}
		input := agentJSON(request.Messages)
		if !strings.Contains(input, summary) || strings.Contains(input, old) || strings.Contains(input, "sourceRanges") {
			t.Error("model did not receive only the compacted context and its new input")
		}
		return map[string]any{"text_response": "已检查"}, nil
	}, nil)
	sessions, session, _ := agentSession(doc, req.SessionID)
	session["protocolMessages"] = []map[string]any{
		{"role": "user", "content": strings.Repeat(old, 2000)},
		{"role": "assistant", "content": "第一版已完成"},
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc.AgentConfig = json.RawMessage(`{"contextWindowTokens":12000}`)
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.ReadOnly = true
	for _, id := range []string{"read-first", "read-second"} {
		req.ID, req.UserText = id, "核对画布 "+id
		if _, err := svc.Start(identity, doc.ID, req); err != nil {
			t.Fatal(err)
		}
		if done := agentWait(t, svc, identity, doc.ID); done.AgentRun.Status != "success" {
			t.Fatalf("read after compaction failed: %+v", done.AgentRun)
		}
	}
	stored := canvasAgentWorker{service: svc, identity: identity, doc: doc, req: req}
	if found, err := stored.loadSDKSession(); err != nil || !found {
		t.Fatalf("load automatic compaction: found=%v err=%v", found, err)
	}
	records := util.AsMapSlice(agentMapFromJSON(t, stored.sdk.ModelContext)["compactions"])
	if summaryCalls != 1 || len(records) != 1 || records[0]["trigger"] != "pressure" || records[0]["summary"] != summary || agentJSON(records[0]["sourceRanges"]) != "[[0,2]]" || !strings.Contains(agentJSON(stored.sdk.Items), old) {
		t.Fatalf("automatic compaction lost persisted provenance or original history: summaries=%d records=%v", summaryCalls, records)
	}
}

func agentMapFromJSON(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestCanvasAgentCompactionLeaseBlocksOtherServiceInstances(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			databaseURL := os.Getenv("TEST_CANVAS_" + strings.ToUpper(dialect) + "_DATABASE_URL")
			if dialect == "sqlite" {
				databaseURL = "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "compaction-lease.db"))
			} else if databaseURL == "" {
				t.Skip("isolated canvas database not configured")
			}
			exerciseCanvasAgentCompactionLease(t, databaseURL)
		})
	}
}

func exerciseCanvasAgentCompactionLease(t *testing.T, databaseURL string) {
	t.Helper()
	t.Setenv("AGENT_RUNTIME_PATH", "../../agent-runtime/worker.mjs")
	firstBackend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = firstBackend.Close() })
	secondBackend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secondBackend.Close() })
	identity := Identity{ID: "compaction-lease-owner"}
	firstCanvas := NewCanvasDocumentService(firstBackend)
	doc, err := loadCanvas(firstCanvas, identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions = json.RawMessage(`[{"id":"session","title":"Test","messages":[{"id":"u","role":"user","text":"Initial request"},{"id":"a","role":"assistant","text":"Done"}],"protocolMessages":[{"role":"user","content":"` + strings.Repeat("long retained context ", 2000) + `"},{"role":"assistant","content":"Done"}]}]`)
	doc.ActiveAgentSessionID = "session"
	doc.AgentRun = &CanvasAgentRun{ID: "finished", SessionID: "session", AssistantID: "a", Status: "success"}
	doc, err = firstCanvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var enteredOnce sync.Once
	model := func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if request.Diagnostic["purpose"] == "summary" {
			enteredOnce.Do(func() { close(entered) })
			select {
			case <-release:
				return map[string]any{"text_response": "Retain the approved constraints."}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return map[string]any{"text_response": "Done"}, nil
	}
	firstExecution := NewAgentExecutionService(context.Background(), firstBackend)
	secondExecution := NewAgentExecutionService(context.Background(), secondBackend)
	t.Cleanup(firstExecution.Close)
	t.Cleanup(secondExecution.Close)
	first := NewCanvasAgentService(context.Background(), firstExecution, firstCanvas, NewAgentSkillService(firstBackend), model, nil)
	secondCanvas := NewCanvasDocumentService(secondBackend)
	second := NewCanvasAgentService(context.Background(), secondExecution, secondCanvas, NewAgentSkillService(secondBackend), model, nil)
	t.Cleanup(first.Close)
	t.Cleanup(second.Close)
	request := CanvasAgentCompactionRequest{SessionID: "session", Model: "test", RelayTokenName: "test", APIMode: "responses"}
	result := make(chan error, 1)
	go func() {
		_, err := first.Compact(context.Background(), identity, doc.ID, request)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("compaction did not reach the summary model")
	}
	if _, err := second.Compact(context.Background(), identity, doc.ID, request); !errors.Is(err, ErrCanvasAgentBusy) {
		close(release)
		t.Fatalf("second instance entered a leased compaction: %v", err)
	}
	start := CanvasAgentRequest{ID: "concurrent-run", SessionID: "session", AssistantID: "a", UserText: "Continue", Model: "test", RelayTokenName: "test", APIMode: "responses"}
	if _, err := second.Start(identity, doc.ID, start); !errors.Is(err, ErrCanvasAgentBusy) {
		close(release)
		t.Fatalf("agent started during compaction: %v", err)
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	workspace, err := secondCanvas.loadCompactionLeaseWorkspace(identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := workspace.AgentCompactionLeases[doc.ID]; exists {
		t.Fatal("completed compaction left its durable lease behind")
	}
}

func TestCanvasAgentCompactionLeaseRecoversAfterOwnerExit(t *testing.T) {
	backend := newTestStorageBackend(t)
	canvas := NewCanvasDocumentService(backend)
	doc, err := loadCanvas(canvas, "expired-compaction-owner")
	if err != nil {
		t.Fatal(err)
	}
	firstToken, err := canvas.acquireAgentCompactionLease("expired-compaction-owner", doc.ID, "session")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := canvas.loadCompactionLeaseWorkspace("expired-compaction-owner")
	if err != nil {
		t.Fatal(err)
	}
	lease := workspace.AgentCompactionLeases[doc.ID]
	lease.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	workspace.AgentCompactionLeases[doc.ID] = lease
	if err := saveStoredJSONBounded(canvas.store, canvasWorkspaceName("expired-compaction-owner"), workspace); err != nil {
		t.Fatal(err)
	}
	secondToken, err := canvas.acquireAgentCompactionLease("expired-compaction-owner", doc.ID, "session")
	if err != nil || secondToken == firstToken {
		t.Fatalf("expired lease was not replaced: token=%q err=%v", secondToken, err)
	}
	if err := canvas.releaseAgentCompactionLease("expired-compaction-owner", doc.ID, firstToken); !errors.Is(err, errCanvasAgentLeaseLost) {
		t.Fatalf("expired owner released the replacement lease: %v", err)
	}
	active, err := canvas.agentCompactionLeaseActive("expired-compaction-owner", doc.ID)
	if err != nil || !active {
		t.Fatalf("stale owner removed the replacement lease: active=%v err=%v", active, err)
	}
	if err := canvas.releaseAgentCompactionLease("expired-compaction-owner", doc.ID, secondToken); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasAgentRunLeaseFencesExpiredOwner(t *testing.T) {
	backend := newTestStorageBackend(t)
	canvas := NewCanvasDocumentService(backend)
	owner := "expired-agent-run-owner"
	doc, err := loadCanvas(canvas, owner)
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentRun = &CanvasAgentRun{ID: "old-run", SessionID: "session", AssistantID: "assistant", Status: "running"}
	doc, err = canvas.saveAgent(owner, doc)
	if err != nil {
		t.Fatal(err)
	}
	firstToken, err := canvas.acquireAgentRunLease(owner, doc.ID, "session")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := canvas.loadCompactionLeaseWorkspace(owner)
	if err != nil {
		t.Fatal(err)
	}
	lease := workspace.AgentRunLeases[doc.ID]
	lease.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	workspace.AgentRunLeases[doc.ID] = lease
	if err := saveStoredJSONBounded(canvas.store, canvasWorkspaceName(owner), workspace); err != nil {
		t.Fatal(err)
	}
	secondToken, err := canvas.acquireAgentRunLease(owner, doc.ID, "session")
	if err != nil || secondToken == firstToken {
		t.Fatalf("expired run lease was not replaced: token=%q err=%v", secondToken, err)
	}
	doc.AgentRun.Status = "success"
	if _, err := canvas.saveAgentWithLease(owner, doc, firstToken); !errors.Is(err, errCanvasAgentLeaseLost) {
		t.Fatalf("expired owner wrote after lease takeover: %v", err)
	}
	active, err := canvas.agentRunLeaseActive(owner, doc.ID)
	if err != nil || !active {
		t.Fatalf("stale owner removed the replacement run lease: active=%v err=%v", active, err)
	}
	if err := canvas.releaseAgentRunLease(owner, doc.ID, secondToken); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasAgentRunLeaseBlocksOtherServiceInstances(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			databaseURL := os.Getenv("TEST_CANVAS_" + strings.ToUpper(dialect) + "_DATABASE_URL")
			if dialect == "sqlite" {
				databaseURL = "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "agent-run-lease.db"))
			} else if databaseURL == "" {
				t.Skip("isolated canvas database not configured")
			}
			exerciseCanvasAgentRunLease(t, databaseURL)
		})
	}
}

func exerciseCanvasAgentRunLease(t *testing.T, databaseURL string) {
	t.Helper()
	t.Setenv("AGENT_RUNTIME_PATH", "../../agent-runtime/worker.mjs")
	firstBackend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = firstBackend.Close() })
	secondBackend, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secondBackend.Close() })
	identity := Identity{ID: "agent-run-lease-owner-" + util.NewUUID()}
	firstCanvas := NewCanvasDocumentService(firstBackend)
	doc, err := loadCanvas(firstCanvas, identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions = json.RawMessage(`[{"id":"session","title":"Test","messages":[{"id":"u","role":"user","text":"Initial request"},{"id":"a","role":"assistant","text":"","status":"thinking"}],"protocolMessages":[],"agentState":{"phase":"intake","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]}}]`)
	doc.ActiveAgentSessionID = "session"
	doc, err = firstCanvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var modelCalls atomic.Int32
	var enteredOnce sync.Once
	model := func(ctx context.Context, _ Identity, _ AgentModelRequest) (map[string]any, error) {
		modelCalls.Add(1)
		enteredOnce.Do(func() { close(entered) })
		select {
		case <-release:
			return agentTurn(), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	firstExecution := NewAgentExecutionService(context.Background(), firstBackend)
	secondExecution := NewAgentExecutionService(context.Background(), secondBackend)
	t.Cleanup(firstExecution.Close)
	t.Cleanup(secondExecution.Close)
	first := NewCanvasAgentService(context.Background(), firstExecution, firstCanvas, NewAgentSkillService(firstBackend), model, nil)
	secondCanvas := NewCanvasDocumentService(secondBackend)
	second := NewCanvasAgentService(context.Background(), secondExecution, secondCanvas, NewAgentSkillService(secondBackend), model, nil)
	t.Cleanup(first.Close)
	t.Cleanup(second.Close)
	request := CanvasAgentRequest{ID: "first-run", SessionID: "session", AssistantID: "a", UserMessageID: "u", UserText: "Make a draft", Model: "test", RelayTokenName: "test", APIMode: "responses"}
	if _, err := first.Start(identity, doc.ID, request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("first service did not start its model request")
	}
	request.ID = "second-run"
	if _, err := second.Start(identity, doc.ID, request); !errors.Is(err, ErrCanvasAgentBusy) {
		close(release)
		t.Fatalf("second service started a competing model run: %v", err)
	}
	close(release)
	done := agentWait(t, first, identity, doc.ID)
	if done.AgentRun == nil || done.AgentRun.ID != "first-run" || done.AgentRun.Status != "success" || modelCalls.Load() != 1 {
		t.Fatalf("run lease did not preserve the first execution: run=%+v modelCalls=%d", done.AgentRun, modelCalls.Load())
	}
	workspace, err := secondCanvas.loadCompactionLeaseWorkspace(identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := workspace.AgentRunLeases[doc.ID]; exists {
		t.Fatal("completed run left its durable lease behind")
	}
}

func TestCanvasAgentManualCompactionKeepsQueuedFollowupsInOrder(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if request.Diagnostic["purpose"] == "summary" {
			close(entered)
			select {
			case <-release:
				return map[string]any{"text_response": "保留项目约束"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		index := calls.Add(1)
		want := map[int32]string{1: "先核对剧本", 2: "再核对分镜"}[index]
		if want == "" || !strings.Contains(agentJSON(request.Messages), want) || request.Metadata["tool_choice"] == "required" {
			t.Errorf("unexpected queued request %d, expected %q", index, want)
		}
		return map[string]any{"text_response": "已核对"}, nil
	}, nil)
	sessions, session, _ := agentSession(doc, req.SessionID)
	session["protocolMessages"] = []map[string]any{
		{"role": "user", "content": strings.Repeat("原始对话", 1200)},
		{"role": "assistant", "content": "已确认"},
		{"role": "user", "content": "保留尺寸"},
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "success"}
	doc, err := svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := svc.Compact(context.Background(), identity, doc.ID, CanvasAgentCompactionRequest{SessionID: req.SessionID, Model: req.Model, RelayTokenName: req.RelayTokenName, APIMode: req.APIMode})
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("compaction did not reach the summary")
	}
	for i, prompt := range []string{"先核对剧本", "再核对分镜"} {
		queued, err := svc.UpdateQueue(identity, doc.ID, CanvasAgentQueueMutation{
			SessionID: req.SessionID, Action: "append", AfterRun: req.ID, Settings: req,
			Message: map[string]any{"id": agentJSON(i), "text": prompt, "createdAt": util.NowISO(), "references": []any{}, "readOnly": true},
		})
		if err != nil || queued.AgentRun.ID != req.ID || queued.AgentRun.Status != "success" {
			t.Fatalf("queue changed the current run during compaction: %v", err)
		}
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, stored, _ := agentSession(done, req.SessionID)
	if done.AgentRun.Status != "success" || !done.AgentRun.ReadOnly || calls.Load() != 2 || len(util.AsMapSlice(agentMap(stored["messageQueue"])["messages"])) != 0 {
		t.Fatalf("queue did not finish in order: %+v calls=%d", done.AgentRun, calls.Load())
	}
}

func TestCanvasAgentSDKContextUsageSurvivesReloadAndBrowserSaves(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	usage := agentMap(session["contextUsage"])
	if done.AgentRun.Status != "success" || usage["model"] != req.Model || usage["maxTokens"] != float64(365600) || usage["compacting"] != false || usage["basis"] != "compression-budget" || len(usage) != 5 {
		t.Fatalf("SDK context estimate missing or exposed private inputs: run=%+v usage=%v", done.AgentRun, usage)
	}
	if used, ok := usage["usedTokens"].(float64); !ok || used <= 0 || used > 365600 {
		t.Fatalf("invalid input estimate: %v", usage)
	}
	before := agentJSON(usage)
	for _, forged := range []any{nil, map[string]any{"usedTokens": 0, "maxTokens": 1}} {
		sessions, edited, _ := agentSession(done, req.SessionID)
		if forged == nil {
			delete(edited, "contextUsage")
		} else {
			edited["contextUsage"] = forged
		}
		done.AgentSessions, _ = json.Marshal(sessions)
		var err error
		done, err = svc.canvas.SaveAtRevision(identity.ID, done)
		if err != nil {
			t.Fatal(err)
		}
		_, saved, _ := agentSession(done, req.SessionID)
		if agentJSON(saved["contextUsage"]) != before {
			t.Fatal("browser snapshot changed server context statistics")
		}
	}
}

func TestCanvasAgentSDKCompactionBudgetUsesSavedContextWindow(t *testing.T) {
	for _, window := range []int{128000, 257001} {
		t.Run(agentJSON(window), func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				return agentTurn(), nil
			}, nil)
			doc.AgentConfig = json.RawMessage(agentJSON(map[string]any{"contextWindowTokens": window}))
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			_, session, _ := agentSession(done, req.SessionID)
			budget := math.Floor(float64(window) * 0.8)
			if done.AgentRun.Status != "success" || agentMap(session["contextUsage"])["maxTokens"] != budget {
				t.Fatalf("saved window did not reach SDK filter: run=%+v usage=%v", done.AgentRun, session["contextUsage"])
			}
		})
	}
}

func TestCanvasAgentSDKContextWindowValidationAndResume(t *testing.T) {
	w := memoryWorker(t, nil)
	for _, raw := range []string{`{"contextWindowTokens":0}`, `{"contextWindowTokens":1}`, `{"contextWindowTokens":-1}`, `{"contextWindowTokens":1.5}`, `{"contextWindowTokens":9007199254740992}`, `{"contextWindowTokens":"457000"}`} {
		w.doc.AgentConfig = json.RawMessage(raw)
		if _, err := w.sdkConfig(); err == nil {
			t.Fatalf("invalid context window accepted: %s", raw)
		}
	}
	for _, resume := range []bool{false, true} {
		w.req.Resume = resume
		w.doc.AgentConfig = json.RawMessage(`{"contextWindowTokens":128000}`)
		config, err := w.sdkConfig()
		if err != nil || config["contextWindowTokens"] != float64(128000) {
			t.Fatalf("context window lost for resume=%v: config=%v err=%v", resume, config, err)
		}
	}
}

func TestCanvasAgentContextUsageRejectsInvalidCountersWithoutMutation(t *testing.T) {
	w := memoryWorker(t, nil)
	valid := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": true}
	if err := w.updateContextUsage(map[string]any{"contextUsage": valid}); err != nil {
		t.Fatal(err)
	}
	before := agentJSON(w.session["contextUsage"])
	for _, field := range []string{"usedTokens", "maxTokens"} {
		for _, value := range []any{-1.0, 1.5, math.Inf(1), math.NaN(), float64(1 << 53), "36560", nil} {
			invalid := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": false}
			invalid[field] = value
			if err := w.updateContextUsage(map[string]any{"contextUsage": invalid}); err == nil || agentJSON(w.session["contextUsage"]) != before {
				t.Fatalf("accepted or mutated %s=%v", field, value)
			}
		}
	}
	if err := w.updateContextUsage(map[string]any{}); err != nil || agentJSON(w.session["contextUsage"]) != before {
		t.Fatal("absent telemetry changed the last reported estimate")
	}
	if err := w.finish("error", "summary failed"); err != nil {
		t.Fatal(err)
	}
	doc, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, w.req.SessionID)
	if agentMap(session["contextUsage"])["compacting"] != false || agentMap(session["contextUsage"])["usedTokens"] != float64(36560) {
		t.Fatal("failed summary retained a running indicator or lost its estimate")
	}
}

func TestCanvasAgentContextShowsUpstreamInputTokensWithoutReplacingCompressionEstimate(t *testing.T) {
	for _, field := range []string{"input_tokens", "prompt_tokens"} {
		w := memoryWorker(t, nil)
		counters := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": false}
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		w.recordModelInputUsage(map[string]any{"usage": map[string]any{field: float64(41234)}})
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		usage := agentMap(w.session["contextUsage"])
		if usage["inputTokens"] != float64(41234) || usage["usedTokens"] != float64(36560) {
			t.Fatalf("usage lost its actual/estimated distinction: %v", usage)
		}
		counters["usedTokens"] = float64(37000)
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		if _, ok := agentMap(w.session["contextUsage"])["inputTokens"]; ok {
			t.Fatal("new model input reused a stale actual count")
		}
	}
}

func TestCanvasAgentSDKPersistsUpstreamInputTokens(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		result := agentTurn()
		result["usage"] = map[string]any{"input_tokens": float64(41234)}
		return result, nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	usage := agentMap(session["contextUsage"])
	if done.AgentRun.Status != "success" || usage["inputTokens"] != float64(41234) || usage["usedTokens"] == usage["inputTokens"] {
		t.Fatalf("upstream usage lost across model response and final checkpoint: run=%+v usage=%v", done.AgentRun, usage)
	}
}

func TestCanvasAgentSDKPersistsPublicReasoningSummaryDuringModelCall(t *testing.T) {
	w := memoryWorker(t, nil)
	w.req.APIMode, w.req.Stream, w.req.Reasoning = "responses", true, true
	w.service.model = func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		if request.OnReasoningSummary == nil {
			t.Fatal("missing public summary callback")
		}
		if err := request.OnReasoningSummary("r1", "正在检查画布", true); err != nil {
			t.Fatal(err)
		}
		doc, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, session, _ := agentSession(doc, w.req.SessionID)
		messages := util.AsMapSlice(session["messages"])
		var found bool
		for _, message := range messages {
			for _, entry := range util.AsMapSlice(message["trace"]) {
				if entry["text"] == "正在检查画布" && entry["isStreaming"] == true {
					found = true
				}
			}
		}
		if !found {
			t.Fatal("summary was unavailable until model completion")
		}
		if err := request.OnReasoningSummary("r1", "已检查画布", false); err != nil {
			t.Fatal(err)
		}
		return agentTurn(), nil
	}
	if _, err := w.sdkForwardModel(map[string]any{"messages": []map[string]any{{"role": "user", "content": "检查画布"}}}); err != nil {
		t.Fatal(err)
	}
	trace := util.AsMapSlice(w.assistant()["trace"])
	if len(trace) != 1 || trace[0]["text"] != "已检查画布" || trace[0]["isStreaming"] != false {
		t.Fatalf("summary duplicated or never finalized: %v", trace)
	}
}
