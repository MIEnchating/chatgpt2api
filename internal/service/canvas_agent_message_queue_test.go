package service

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentMessageQueueSurvivesConcurrentBrowserAndWorkerSaves(t *testing.T) {
	svc, identity, doc, _ := agentFixture(t, nil, nil)
	doc.AgentRun = &CanvasAgentRun{ID: "run", SessionID: "session", AssistantID: "a", Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	base := cloneCanvasAgentDocument(doc)
	sessions, session, _ := agentSession(doc, "session")
	session["messageQueue"] = map[string]any{"paused": false, "messages": []map[string]any{{"id": "q1", "text": "先调整脚本", "createdAt": "now", "references": []any{}}}}
	session["messages"] = []map[string]any{{"id": "forged", "role": "assistant", "text": "forged browser progress"}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	saved, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, current, _ := agentSession(saved, "session")
	if len(current["messageQueue"].(map[string]any)["messages"].([]any)) != 1 {
		t.Fatal("browser queue was discarded during execution")
	}
	if len(current["messages"].([]any)) != 2 {
		t.Fatal("browser replaced worker progress")
	}
	edited := cloneCanvasAgentDocument(base)
	workerSessions, worker, _ := agentSession(edited, "session")
	worker["messages"] = []map[string]any{{"id": "a", "role": "assistant", "text": "worker result"}}
	edited.AgentSessions, _ = json.Marshal(workerSessions)
	edited.AgentRun.Status = "success"
	finished, err := svc.canvas.saveAgentChanges(identity.ID, base, edited)
	if err != nil {
		t.Fatal(err)
	}
	_, after, _ := agentSession(finished, "session")
	if after["messageQueue"] == nil {
		t.Fatal("worker completion erased queued messages")
	}
	if after["messages"].([]any)[0].(map[string]any)["text"] != "worker result" {
		t.Fatal("worker progress was discarded")
	}
	reloaded, err := svc.canvas.Project(identity.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, persisted, _ := agentSession(reloaded, "session")
	if persisted["messageQueue"] == nil {
		t.Fatal("queue was not persisted")
	}
}

func TestCanvasAgentMessageQueueValidation(t *testing.T) {
	valid := json.RawMessage(`[{"id":"session","messageQueue":{"paused":true,"messages":[{"id":"q","text":"new direction","createdAt":"now","references":[]}]}}]`)
	if err := validateCanvasAgentJSON(valid, true); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []string{
		`{"paused":false,"messages":[{"id":"q","text":" ","createdAt":"now","references":[]}]}`,
		`{"paused":false,"messages":[{"id":"q","text":"a","createdAt":"now","references":[],"readOnly":"true"}]}`,
		`{"paused":false,"messages":[{"id":"q","text":"a","createdAt":"now","references":[],"modelRequestLimit":-1}]}`,
		`{"paused":false,"messages":[],"steeringId":"missing"}`,
		`{"paused":"false","messages":[]}`,
		`{"paused":false,"messages":[{"id":"q","text":"a","createdAt":"now","references":[]},{"id":"q","text":"b","createdAt":"now","references":[]}]}`,
	} {
		if validateCanvasAgentJSON(json.RawMessage(`[{"id":"session","messageQueue":`+queue+`}]`), true) == nil {
			t.Fatalf("accepted malformed queue: %s", queue)
		}
	}
	for _, sessions := range []string{
		`{}`,
		`[null]`,
		`["session"]`,
		`[{"id":"session"}] trailing`,
		`[{"id":"session","messageQueue":null}]`,
	} {
		if validateCanvasAgentJSON(json.RawMessage(sessions), true) == nil {
			t.Fatalf("accepted malformed sessions: %s", sessions)
		}
	}
}

func TestCanvasAgentQueuedReadOnlyRunsSeparatelyFromWritableSteering(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		n := calls.Add(1)
		input := agentJSON(request.Messages)
		if n < 3 && strings.Contains(input, "仅核对新文稿") {
			t.Error("read-only steering entered a writable run")
		}
		if n == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return agentTurn(agentCall("read-before-finish", "get_canvas_summary", map[string]any{})), nil
		}
		if n == 2 {
			return agentTurn(), nil
		}
		if !strings.Contains(input, "仅核对新文稿") || request.Metadata["tool_choice"] == "required" {
			t.Error("queued read-only settings were lost")
		}
		return map[string]any{"text_response": "已核对"}, nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("initial model call did not start")
	}
	for _, update := range []CanvasAgentQueueMutation{
		{SessionID: req.SessionID, Action: "append", Message: map[string]any{"id": "readonly", "text": "仅核对新文稿", "createdAt": util.NowISO(), "references": []any{}, "readOnly": true}},
		{SessionID: req.SessionID, Action: "steer", MessageID: "readonly"},
	} {
		if _, err := svc.UpdateQueue(identity, doc.ID, update); err != nil {
			t.Fatal(err)
		}
	}
	close(release)
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.ID == req.ID || !done.AgentRun.ReadOnly || done.AgentRun.Status != "success" || calls.Load() != 3 {
		t.Fatalf("unexpected queued run: %+v calls=%d", done.AgentRun, calls.Load())
	}
}

func TestCanvasAgentServerQueueSteersNextStepAndDrainsFollowup(t *testing.T) {
	modelEntered := make(chan struct{})
	releaseModel := make(chan struct{})
	const citation = "\n\n> 引用对话「素材决策」 [canvas-session:source]"
	var modelCalls atomic.Int32
	svc, identity, doc, request := agentFixture(t, func(ctx context.Context, _ Identity, req AgentModelRequest) (map[string]any, error) {
		count := modelCalls.Add(1)
		switch count {
		case 1:
			close(modelEntered)
			select {
			case <-releaseModel:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return agentTurn(agentCall("read-once", "get_canvas_summary", map[string]any{})), nil
		case 2:
			if req.RunID != "run" || strings.Count(agentJSON(req.Messages), "调整当前镜头") != 1 || strings.Contains(agentJSON(req.Messages), "下一条普通任务") {
				t.Errorf("steering was not applied to the next step of the original run: %s %s", req.RunID, agentJSON(req.Messages))
			}
			if !strings.Contains(agentJSON(req.Messages), "固定使用蓝色背景") {
				t.Error("steering lost its captured history")
			}
		case 3:
			if req.RunID == "run" || strings.Count(agentJSON(req.Messages), "下一条普通任务") != 1 {
				t.Errorf("normal message did not start a separate run: %s %s", req.RunID, agentJSON(req.Messages))
			}
			if strings.Count(agentJSON(req.Messages), "固定使用蓝色背景") != 2 {
				t.Error("queued follow-up lost its snapshot or the preceding steering snapshot")
			}
		default:
			t.Errorf("unexpected repeat model call: %d", count)
		}
		return agentTurn(), nil
	}, nil)
	var sessions []json.RawMessage
	if err := json.Unmarshal(doc.AgentSessions, &sessions); err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions, _ = json.Marshal(append(sessions, json.RawMessage(`{"id":"source","title":"素材决策","messages":[{"id":"m","role":"assistant","text":"固定使用蓝色背景","status":"success"}]}`)))
	doc, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start(identity, doc.ID, request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-modelEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("initial model call did not start")
	}
	appendMessage := func(id, text string) {
		t.Helper()
		_, err := svc.UpdateQueue(identity, doc.ID, CanvasAgentQueueMutation{
			SessionID: "session", Action: "append",
			Message: map[string]any{"id": id, "text": text, "createdAt": util.NowISO(), "references": []any{}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	appendMessage("ordinary", "下一条普通任务"+citation)
	appendMessage("steering", "调整当前镜头"+citation)
	appendMessage("ordinary", "下一条普通任务"+citation)
	if _, err := svc.UpdateQueue(identity, doc.ID, CanvasAgentQueueMutation{SessionID: "session", Action: "steer", MessageID: "steering"}); err != nil {
		t.Fatal(err)
	}
	close(releaseModel)
	finished := agentWait(t, svc, identity, doc.ID)
	if finished.AgentRun.ID == "run" || finished.AgentRun.Status != "success" || modelCalls.Load() != 3 {
		t.Fatalf("queue did not finish in order: %+v calls=%d", finished.AgentRun, modelCalls.Load())
	}
	appendMessage("ordinary", "下一条普通任务")
	reopened, err := svc.Snapshot(identity, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(reopened, "session")
	queue := agentMap(session["messageQueue"])
	if len(util.AsMapSlice(queue["messages"])) != 0 || !canvasQueueMessageUsed(session, "steering") || !canvasQueueMessageUsed(session, "ordinary") {
		t.Fatalf("queue consumption was not durable: %s", agentJSON(session))
	}
}

func TestCanvasAgentQueuedHistoryReferenceUsesEnqueueSnapshot(t *testing.T) {
	svc, identity, doc, request := agentFixture(t, func(_ context.Context, _ Identity, req AgentModelRequest) (map[string]any, error) {
		if !strings.Contains(agentJSON(req.Messages), "固定使用蓝色背景") {
			t.Error("queued request lost the snapshot after the source was deleted")
		}
		return agentTurn(), nil
	}, nil)
	var sessions []json.RawMessage
	if err := json.Unmarshal(doc.AgentSessions, &sessions); err != nil {
		t.Fatal(err)
	}
	doc.AgentSessions, _ = json.Marshal(append(sessions, json.RawMessage(`{"id":"source","title":"素材决策","messages":[{"id":"m","role":"assistant","text":"固定使用蓝色背景","status":"success"}]}`)))
	doc.AgentRun = &CanvasAgentRun{ID: request.ID, SessionID: request.SessionID, AssistantID: request.AssistantID, Status: "success"}
	doc, err := svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	queued, err := svc.UpdateQueue(identity, doc.ID, CanvasAgentQueueMutation{
		SessionID: request.SessionID, Action: "append",
		Message: map[string]any{"id": "queued", "text": "继续草案\n\n> 引用对话「素材决策」 [canvas-session:source]", "createdAt": util.NowISO(), "references": []any{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(queued.AgentSessions, &sessions); err != nil {
		t.Fatal(err)
	}
	queued.AgentSessions, _ = json.Marshal(sessions[:1])
	if _, err := svc.canvas.SaveAtRevision(identity.ID, queued); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateQueue(identity, doc.ID, CanvasAgentQueueMutation{
		SessionID: request.SessionID, Action: "resume", Settings: request,
	}); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.ID == request.ID || done.AgentRun.Status != "success" {
		t.Fatalf("queued request did not finish: %+v", done.AgentRun)
	}
}
