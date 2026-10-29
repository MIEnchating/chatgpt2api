package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentQuestionResumeRestoresLabeledImagesWithoutNewAttachments(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
		turn := turns.Add(1)
		images := 0
		for _, message := range r.Messages {
			parts := util.AsMapSlice(message["content"])
			for i, part := range parts {
				if part["type"] != "image_url" {
					continue
				}
				if i == 0 || !strings.Contains(util.Clean(parts[i-1]["text"]), fmt.Sprintf("ID=photo-%d", images)) || agentMap(part["image_url"])["url"] != fmt.Sprintf("/api/files/photo-%d/content", images) {
					t.Error("image is not paired with its own reference ID")
				}
				images++
			}
		}
		wantImages := 8
		if turn == 4 {
			wantImages = 0
		}
		if images != wantImages {
			t.Errorf("turn %d received %d images, want %d", turn, images, wantImages)
		}
		if turn < 3 {
			return agentTurn(agentCall(fmt.Sprintf("q%d", turn), "ask_user_question", map[string]any{"question": "采用正面关门的方案吗？", "reason": "确认交付偏好", "kind": "clarification", "options": []string{"采用正面关门图", "采用开门图"}})), nil
		}
		if turn == 3 && !strings.Contains(agentJSON(r.Messages), "用户第二次回答") {
			t.Error("answer missing from tool result")
		}
		return agentTurn(), nil
	}, nil)
	for i := 0; i < 8; i++ {
		req.References = append(req.References, map[string]any{"id": fmt.Sprintf("photo-%d", i), "source": "attachment", "type": "image", "title": "产品角度", "url": fmt.Sprintf("/api/files/photo-%d/content", i)})
	}
	doc = persistAgentTestReferences(t, svc, identity, doc, &req)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(waiting, req.SessionID)
	if !strings.Contains(agentJSON(session["protocolMessages"]), "image_url") {
		t.Fatal("pause discarded durable image inputs")
	}
	// Simulate an interrupted turn whose model history contains only an old summary.
	sessions, session, _ := agentSession(waiting, req.SessionID)
	util.AsMapSlice(session["protocolMessages"])[0]["content"] = "原请求及旧摘要"
	waiting.AgentSessions, _ = json.Marshal(sessions)
	if _, err := svc.canvas.SaveAtRevision(identity.ID, waiting); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		req.ID = fmt.Sprintf("answer-%d", i)
		req.UserText = "用户第二次回答"
		req.References = nil
		if _, err := svc.Start(identity, doc.ID, req); err != nil {
			t.Fatal(err)
		}
		done := agentWait(t, svc, identity, doc.ID)
		if i == 2 && done.AgentRun.Status != "success" {
			t.Fatal(done.AgentRun)
		}
		_, saved, _ := agentSession(done, req.SessionID)
		if len(util.AsMapSlice(saved["messages"])) != 2 {
			t.Fatal("resuming invented user messages")
		}
	}
	req.ID, req.UserText = "new-request", "制作第二批海报"
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	if done := agentWait(t, svc, identity, doc.ID); done.AgentRun.Status != "success" {
		t.Fatal(done.AgentRun)
	}
	if turns.Load() != 4 {
		t.Fatal("unexpected model turns", turns.Load())
	}
}

func TestCanvasAgentCanFindAndViewHistoricalReferenceWithoutAskingUserForID(t *testing.T) {
	w := memoryWorker(t, nil)
	w.session["messages"] = []map[string]any{{"role": "user", "references": []map[string]any{{"id": "photo", "source": "attachment", "type": "image", "title": "正面关门", "url": "/api/files/photo/content"}}}}
	w.messages = []map[string]any{{"role": "user", "content": "继续制作"}}
	index, err := w.tool(map[string]any{"name": "list_references", "arguments": map[string]any{}})
	if err != nil || len(util.AsMapSlice(index["references"])) != 1 {
		t.Fatal(index, err)
	}
	for i := 0; i < 2; i++ {
		result, err := w.tool(map[string]any{"name": "get_reference", "arguments": map[string]any{"referenceId": "photo"}})
		if err != nil || result["ok"] != true {
			t.Fatal(result, err)
		}
	}
	parts := util.AsMapSlice(w.messages[0]["content"])
	if len(parts) != 3 || !strings.Contains(util.Clean(parts[1]["text"]), "ID=photo") || agentMap(parts[2]["image_url"])["url"] != "/api/files/photo/content" {
		t.Fatal("lookup did not supply the actual image exactly once")
	}
	if len(util.AsMapSlice(w.session["messages"])) != 1 {
		t.Fatal("lookup added a visible user message")
	}
}
