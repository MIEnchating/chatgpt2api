package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentEightReferenceImagesReachFirstModelTurnWithoutCompaction(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		if r.Metadata["max_output_tokens"] != nil {
			t.Error("first turn attempted image summarization")
		}
		var parts []map[string]any
		for _, message := range r.Messages {
			if message["role"] == "user" && len(util.AsMapSlice(message["content"])) > 0 {
				parts = util.AsMapSlice(message["content"])
				break
			}
		}
		if len(parts) != 17 {
			t.Fatalf("got %d input parts, want text and eight labeled images", len(parts))
		}
		for i := 0; i < 8; i++ {
			if !strings.Contains(util.Clean(parts[1+i*2]["text"]), "ID="+fmt.Sprint(i)) || agentMap(parts[2+i*2]["image_url"])["url"] != fmt.Sprintf("/api/files/photo-%d/content", i) {
				t.Errorf("reference %d lost its image/ID pairing", i)
			}
		}
		return agentTurn(), nil
	}, nil)
	req.UserText = "这是产品的八个面，先做白底图，再做温馨的宣传图，请先确认必要参数。"
	for i := 0; i < 8; i++ {
		req.References = append(req.References, map[string]any{"id": fmt.Sprint(i), "type": "image", "source": "attachment", "title": fmt.Sprintf("产品视角%d", i), "url": fmt.Sprintf("/api/files/photo-%d/content", i), "storageKey": "server:opaque-storage-key"})
	}
	doc = persistAgentTestReferences(t, svc, identity, doc, &req)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if calls.Load() != 1 || done.AgentRun.Status != "success" {
		t.Fatalf("unexpected first turn: calls=%d run=%+v", calls.Load(), done.AgentRun)
	}
	_, session, _ := agentSession(done, req.SessionID)
	if util.Clean(session["contextCheckpoint"]) != "" || strings.Contains(string(done.AgentSessions), "base64,") || strings.Contains(string(done.AgentSessions), "当前画布快照") {
		t.Fatal("unnecessary memory summary or persisted image bytes")
	}
}

func memoryWorker(t *testing.T, model AgentModel) *canvasAgentWorker {
	t.Helper()
	svc, identity, doc, req := agentFixture(t, model, nil)
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, req.SessionID)
	return &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
}

func persistAgentTestReferences(t *testing.T, svc *CanvasAgentService, identity Identity, doc CanvasDocument, req *CanvasAgentRequest) CanvasDocument {
	t.Helper()
	sessions, session, _ := agentSession(doc, req.SessionID)
	for _, message := range util.AsMapSlice(session["messages"]) {
		if message["role"] == "user" {
			message["references"] = req.References
		}
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	refs := []map[string]any{}
	for _, ref := range req.References {
		refs = append(refs, map[string]any{"id": ref["id"], "source": ref["source"]})
	}
	req.References = refs
	return doc
}

func TestCanvasAgentResumeInspectsExistingResultsWithoutRegeneration(t *testing.T) {
	var turns, generated atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
		images := 0
		for _, message := range r.Messages {
			for _, part := range util.AsMapSlice(message["content"]) {
				if part["type"] == "image_url" {
					images++
				}
			}
		}
		if images > canvasAgentMaxActiveImages {
			t.Errorf("sent %d active images", images)
		}
		if turns.Add(1) == 1 {
			calls := []map[string]any{}
			for i := 0; i < 4; i++ {
				calls = append(calls, agentCall(fmt.Sprintf("read-%d", i), "get_node", map[string]any{"nodeId": fmt.Sprintf("result-%d", i)}))
			}
			return agentTurn(calls...), nil
		}
		return agentTurn(), nil
	}, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		generated.Add(1)
		return nil, errors.New("must not regenerate")
	})
	for i := 0; i < 8; i++ {
		req.References = append(req.References, map[string]any{"id": fmt.Sprintf("photo-%d", i), "source": "attachment", "type": "image", "title": "Product", "url": fmt.Sprintf("/api/files/photo-%d/content", i)})
	}
	for i := 0; i < 4; i++ {
		doc.Nodes = append(doc.Nodes, CanvasNode{ID: fmt.Sprintf("result-%d", i), Type: "image", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1, URL: fmt.Sprintf("/images/result-%d.png", i), GenerationStatus: "success", TaskID: fmt.Sprintf("completed-%d", i)})
	}
	doc = persistAgentTestReferences(t, svc, identity, doc, &req)
	req.Resume = true
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || generated.Load() != 0 || turns.Load() != 2 || len(done.Nodes) != 4 {
		t.Fatalf("resume failed: %+v, generated=%d, turns=%d", done.AgentRun, generated.Load(), turns.Load())
	}
}

const canvasAgentMaxActiveImages = 8

func canvasAgentCompleteToolRounds(messages []map[string]any) bool {
	pending := map[string]bool{}
	for _, message := range messages {
		if message["role"] == "assistant" {
			for _, call := range util.AsMapSlice(message["toolCalls"]) {
				id, _ := call["id"].(string)
				if id == "" || pending[id] {
					return false
				}
				pending[id] = true
			}
		}
		if message["role"] == "tool" {
			id, _ := message["toolCallId"].(string)
			if !pending[id] {
				return false
			}
			delete(pending, id)
		}
	}
	return len(pending) == 0
}
