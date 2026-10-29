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

func TestCanvasAgentConversationIsOneSmallStreamingTurnWithoutMediaRecovery(t *testing.T) {
	var calls atomic.Int32
	partial := make(chan struct{})
	release := make(chan struct{})
	svc, identity, doc, req := agentFixture(t, func(ctx context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		if r.Metadata["tools"] != nil || r.Metadata["stream"] != true || r.Metadata["reasoning_enabled"] != false {
			t.Errorf("heavy conversation metadata: %v", r.Metadata)
		}
		if len(agentJSON(r.Messages)) > 12000 || strings.Contains(agentJSON(r.Messages), "OLD_TOOL_SECRET") {
			t.Error("old tool history loaded for greeting")
		}
		if r.OnText == nil {
			t.Error("missing streaming callback")
		} else if err := r.OnText("你好，我可以"); err != nil {
			return nil, err
		}
		close(partial)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"text_response": "你好，我可以协助你创作。"}, nil
	}, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
		t.Error("greeting resumed media generation")
		return nil, nil
	})
	doc.Nodes = []CanvasNode{{ID: "old-image", Type: "image", Title: "待生成", Prompt: "旧海报", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, GenerationStatus: "idle", GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1}}
	sessions, session, _ := agentSession(doc, req.SessionID)
	session["protocolMessages"] = []map[string]any{{"role": "tool", "name": "generate_image", "toolCallId": "old", "content": agentJSON(map[string]any{"nodeId": "old-image", "status": "idle", "extra": strings.Repeat("OLD_TOOL_SECRET", 20000)})}}
	agentMap(session["agentState"])["plan"] = map[string]any{"steps": []map[string]any{{"id": "old", "title": "旧计划", "status": "in_progress"}}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	req.UserText = "你好啊"
	if _, err = svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	<-partial
	snapshot, err := svc.Snapshot(identity, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ = agentSession(snapshot, req.SessionID)
	assistant := util.AsMapSlice(session["messages"])[1]
	if assistant["text"] != "你好，我可以" || snapshot.AgentRun.Status != "running" {
		t.Fatal("partial text not visible before completion")
	}
	close(release)
	done := agentWait(t, svc, identity, doc.ID)
	if calls.Load() != 1 || done.AgentRun.Status != "success" || done.Nodes[0].TaskID != "" {
		t.Fatalf("greeting did extra work: calls=%d run=%+v", calls.Load(), done.AgentRun)
	}
	_, session, _ = agentSession(done, req.SessionID)
	if util.AsMapSlice(session["messages"])[1]["interactionMode"] != "conversation" {
		t.Fatal("missing conversation presentation mode")
	}
}

func TestCanvasAgentConversationRoutingDoesNotSwallowTasksOrAnswers(t *testing.T) {
	for _, text := range []string{"你好啊", "你可以干什么呢？", " Hello! "} {
		w := canvasAgentWorker{doc: CanvasDocument{AgentRun: &CanvasAgentRun{}}, state: map[string]any{}, req: CanvasAgentRequest{UserText: text}}
		if !w.isConversation() {
			t.Fatalf("not recognized: %s", text)
		}
		w.state["pendingQuestion"] = map[string]any{"id": "question"}
		if w.isConversation() {
			t.Fatal("pending answer routed as greeting")
		}
	}
	for _, text := range []string{"你好，帮我生成海报", "你可以生成一段5秒的视频吗", "继续", "确认", "谢谢，继续生成下一张"} {
		w := canvasAgentWorker{doc: CanvasDocument{AgentRun: &CanvasAgentRun{}}, state: map[string]any{}, req: CanvasAgentRequest{UserText: text}}
		if w.isConversation() {
			t.Fatalf("task swallowed: %s", text)
		}
	}
}

func TestCanvasAgentTaskWaitPublishesTextBeforeModelCompletes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan string, 4)
	release := make(chan struct{})
	tasks := newTestImageTaskService(t, nil, nil, func(ctx context.Context, _ Identity, payload map[string]any) (map[string]any, error) {
		payload[TextOutputCallbackPayloadKey].(func(string))("正在流式回复")
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"output_type": "text", "data": []map[string]any{{"text_response": "完整回复"}}}, nil
	}, func() int { return 30 })
	identity := Identity{ID: "alice", Role: AuthRoleUser}
	_, err := tasks.SubmitChat(ctx, identity, "stream", "你好", "test", []map[string]any{{"role": "user", "content": "你好"}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := WaitCanvasAgentTask(ctx, tasks, identity, "stream", func(text string) error { received <- text; return nil })
		done <- err
	}()
	select {
	case text := <-received:
		if text != "正在流式回复" {
			t.Fatal(text)
		}
	case <-ctx.Done():
		t.Fatal("partial response was withheld")
	}
	select {
	case <-done:
		t.Fatal("returned before final output")
	default:
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if text := <-received; text != "完整回复" {
		t.Fatal(text)
	}
}
