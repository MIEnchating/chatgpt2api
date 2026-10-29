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

func TestCanvasAgentImageTokenEstimateDoesNotCountBase64Bytes(t *testing.T) {
	image := func(url string) map[string]any {
		return map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}}
	}
	small := estimateCanvasAgentTokens(image("data:image/png;base64,AA=="))
	large := estimateCanvasAgentTokens(image("data:image/png;base64," + strings.Repeat("A", 2<<20)))
	remote := estimateCanvasAgentTokens(image("https://example.test/reference.png"))
	if small != large || small != remote || small < canvasAgentImageTokenEstimate || small > canvasAgentImageTokenEstimate+100 {
		t.Fatalf("image estimates %d %d %d", small, large, remote)
	}
	if estimateCanvasAgentTokens(strings.Repeat("文", 10000)) < 10000 {
		t.Fatal("real text no longer counts")
	}
}

func TestCanvasAgentEightReferenceImagesReachFirstModelTurnWithoutCompaction(t *testing.T) {
	var calls atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
		calls.Add(1)
		if r.Metadata["max_output_tokens"] != nil {
			t.Error("first turn attempted image summarization")
		}
		parts := util.AsMapSlice(r.Messages[len(r.Messages)-1]["content"])
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
	if util.Clean(session["contextCheckpoint"]) != "" || strings.Contains(string(done.AgentSessions), "base64,") {
		t.Fatal("unnecessary memory summary or persisted image bytes")
	}
}

func memoryWorker(t *testing.T, model CanvasAgentModel) *canvasAgentWorker {
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

func TestCanvasAgentHistoryCompactionKeepsCurrentImagesAndExcludesOldPixels(t *testing.T) {
	var summaries int
	w := memoryWorker(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
		summaries++
		if strings.Contains(agentJSON(r.Messages), "base64,") || strings.Contains(agentJSON(r.Messages), "encrypted-private") {
			t.Error("pixels or opaque reasoning sent for textual summary")
		}
		return map[string]any{"text_response": "旧节点已完成，保持品牌约束。"}, nil
	})
	current := map[string]any{"role": "user", "content": []map[string]any{{"type": "text", "text": "本轮要求，不得改写"}, {"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,current-original"}}}}
	original := agentJSON(current)
	w.messages = []map[string]any{
		{"role": "user", "content": []map[string]any{{"type": "text", "text": strings.Repeat("历史资料", 16000)}, {"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,old-original"}}}},
		{"role": "assistant", "content": "已完成", "reasoningContent": "encrypted-private", "responseItems": []map[string]any{{"encrypted_content": "encrypted-private"}}}, current,
	}
	if err := w.compact(56000); err != nil {
		t.Fatal(err)
	}
	if summaries == 0 || len(w.messages) != 1 || agentJSON(w.messages[0]) != original {
		t.Fatal("active multimodal input changed")
	}
}

func TestCanvasAgentCompactionFailurePreservesOriginalHistory(t *testing.T) {
	calls := 0
	w := memoryWorker(t, func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error) {
		calls++
		if calls == 1 {
			return map[string]any{"text_response": "第一段摘要"}, nil
		}
		return nil, errors.New("summary failed")
	})
	w.checkpoint = "原记忆"
	w.messages = []map[string]any{{"role": "user", "content": strings.Repeat("历史", 60000)}, {"role": "assistant", "content": "已完成"}, {"role": "user", "content": "继续制作"}}
	original := agentJSON(w.messages)
	if err := w.compact(56000); err == nil {
		t.Fatal("summary error hidden")
	}
	if agentJSON(w.messages) != original || w.checkpoint != "原记忆" {
		t.Fatal("failed summary replaced source history")
	}
}

func TestCanvasAgentCompactionNeverRemovesIncompleteToolPairs(t *testing.T) {
	for _, orphan := range []bool{false, true} {
		w := memoryWorker(t, func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error) {
			t.Error("incomplete tools summarized")
			return agentTurn(), nil
		})
		w.messages = []map[string]any{{"role": "user", "content": "继续制作"}}
		if orphan {
			w.messages = append(w.messages, map[string]any{"role": "tool", "toolCallId": "unknown", "content": strings.Repeat("工具输出", 16000)})
		} else {
			w.messages = append(w.messages, map[string]any{"role": "assistant", "content": strings.Repeat("处理进度", 16000), "toolCalls": []map[string]any{{"id": "pending", "name": "get_node", "arguments": map[string]any{"nodeId": "n"}}}})
		}
		original := agentJSON(w.messages)
		if err := w.compact(56000); err == nil {
			t.Fatal("incomplete records silently discarded")
		}
		if agentJSON(w.messages) != original {
			t.Fatal("tool pair lost")
		}
	}
}

func TestCanvasAgentCompactionSummarizesCompletedToolsAndKeepsCurrentRequest(t *testing.T) {
	summaries := 0
	w := memoryWorker(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
		summaries++
		if strings.Contains(agentJSON(r.Messages), "base64,") {
			t.Error("current image included in tool summary")
		}
		return map[string]any{"text_response": "已读取节点 n 的详细资料，未提交生成任务。"}, nil
	})
	current := map[string]any{"role": "user", "content": []map[string]any{
		{"type": "text", "text": "根据这张图和节点资料制作"},
		{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,original"}},
	}}
	original := agentJSON(current)
	w.messages = []map[string]any{
		current,
		{"role": "assistant", "toolCalls": []map[string]any{{"id": "read", "name": "get_node", "arguments": map[string]any{"nodeId": "n"}}}},
		{"role": "tool", "toolCallId": "read", "name": "get_node", "content": strings.Repeat("节点资料", 16000)},
	}
	if err := w.compact(56000); err != nil {
		t.Fatal(err)
	}
	if summaries == 0 || w.checkpoint == "" || len(w.messages) != 1 || agentJSON(w.messages[0]) != original {
		t.Fatal("completed tool records were not summarized while preserving current input")
	}
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

func TestCanvasAgentResultInspectionBoundsVisualContextAndKeepsReferences(t *testing.T) {
	w := memoryWorker(t, func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	})
	w.messages = []map[string]any{{"role": "user", "content": []map[string]any{{"type": "text", "text": "Make four product images"}}}}
	for i := 0; i < 12; i++ {
		w.appendVisualReference(map[string]any{"id": fmt.Sprintf("ref-%d", i), "source": "attachment", "type": "image", "title": "Product view", "url": fmt.Sprintf("/api/files/ref-%d/content", i)})
	}
	parts := util.AsMapSlice(w.messages[0]["content"])
	images := []string{}
	for _, part := range parts {
		if part["type"] == "image_url" {
			images = append(images, util.Clean(agentMap(part["image_url"])["url"]))
		}
	}
	if len(images) != 8 || images[0] != "/api/files/ref-4/content" || images[7] != "/api/files/ref-11/content" {
		t.Fatalf("unbounded/wrong visual window: %v", images)
	}
	for i := 0; i < 12; i++ {
		if !strings.Contains(agentJSON(parts), fmt.Sprintf("ID=ref-%d，", i)) {
			t.Fatalf("lost reference %d", i)
		}
	}
	w.appendVisualReference(map[string]any{"id": "ref-0", "source": "attachment", "type": "image", "title": "Product view", "url": "/api/files/ref-0/content"})
	if !strings.Contains(agentJSON(w.messages[len(w.messages)-1]), `"url":"/api/files/ref-0/content"`) {
		t.Fatal("older image could not be read again")
	}
	if err := w.compact(56000); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasAgentVisualWindowDoesNotMutateOriginalMessages(t *testing.T) {
	source := []map[string]any{{"role": "user", "content": []map[string]any{{"type": "image_url", "image_url": map[string]any{"url": "/old.png"}}, {"type": "image_url", "image_url": map[string]any{"url": "/new.png"}}}}}
	before := agentJSON(source)
	result := canvasAgentVisualWindow(source, 1)
	if agentJSON(source) != before {
		t.Fatal("original input was mutated")
	}
	if strings.Count(agentJSON(result), `"type":"image_url"`) != 1 || !strings.Contains(agentJSON(result), "/new.png") {
		t.Fatal(result)
	}
}

func TestCanvasAgentResumeInspectsExistingResultsWithoutRegeneration(t *testing.T) {
	var turns, generated atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
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
	}, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
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
