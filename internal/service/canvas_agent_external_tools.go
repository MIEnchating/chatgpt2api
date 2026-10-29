package service

import (
	"encoding/json"
	"errors"
	"strings"

	"chatgpt2api/internal/util"
)

// External engines share the authenticated canvas tools without starting a model loop.
type CanvasAgentToolRequest struct {
	Context CanvasAgentRequest `json:"context"`
	Call    struct {
		ID        string         `json:"id"`
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"call"`
}

func (s *CanvasAgentService) StartTool(identity Identity, project string, input CanvasAgentToolRequest) (CanvasDocument, error) {
	if input.Call.Name == "ask_user_question" || input.Call.Name == "delete_node" || input.Call.Name == "read_skill_file" {
		return CanvasDocument{}, invalidCanvasDocument("此工具需要当前对话的交互流程")
	}
	calls, err := agentCalls([]map[string]any{{"id": input.Call.ID, "function": map[string]any{"name": input.Call.Name, "arguments": agentJSON(input.Call.Arguments)}}})
	if err != nil {
		return CanvasDocument{}, invalidCanvasDocument(err.Error())
	}
	return s.start(identity, project, input.Context, calls[0])
}

func (w *canvasAgentWorker) runTool(call map[string]any) {
	var doc CanvasDocument
	_ = json.Unmarshal([]byte(agentJSON(w.doc)), &doc)
	w.doc = doc
	w.persisted = cloneCanvasAgentDocument(doc)
	_, w.session, _ = agentSession(w.doc, w.req.SessionID)
	w.state = agentMap(w.session["agentState"])
	w.messages = util.AsMapSlice(w.session["protocolMessages"])
	w.checkpoint = util.Clean(w.session["contextCheckpoint"])
	if w.req.MediaChoice != "" {
		w.state["mediaGenerationDeferred"] = w.req.MediaChoice != "generate"
	}
	w.batchCalls = []map[string]any{call}
	found := false
	for _, message := range w.messages {
		for _, previous := range util.AsMapSlice(message["toolCalls"]) {
			if previous["id"] == call["id"] {
				found = true
			}
		}
	}
	if !found {
		w.messages = append(w.messages, map[string]any{"role": "assistant", "toolCalls": w.batchCalls})
	}
	result, err := w.sdkTool(call)
	status := "success"
	if err != nil {
		result = agentError("tool_error", err.Error())
		status = "error"
	}
	if w.ctx.Err() != nil {
		result = agentError("execution_interrupted", "工具执行已停止，已提交任务和节点已保留；继续前请读取真实状态")
		status = "cancelled"
	}
	w.doc.AgentRun.ToolResult = agentMap(result)
	reviewPrompts := map[string]string{}
	for _, id := range w.workflowReviewUnapprovedIDs() {
		reviewPrompts[id] = canvasAgentWorkflowFingerprint(*w.node(id))
	}
	if len(reviewPrompts) > 0 {
		w.doc.AgentRun.ToolResult["reviewPrompts"] = reviewPrompts
	}
	reply := util.Clean(w.assistant()["text"])
	if status != "success" {
		reply = util.Clean(agentMap(result)["message"])
	}
	_ = w.finish(status, reply)
}

type CanvasAgentWorkflowReviewAnswer struct {
	SessionID string            `json:"sessionId"`
	Prompts   map[string]string `json:"prompts"`
	Answer    string            `json:"answer"`
}

// Answers come from the user's confirmation UI, never from model tool arguments.
func (s *CanvasAgentService) AnswerWorkflowReview(identity Identity, project string, answer CanvasAgentWorkflowReviewAnswer) (CanvasDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := canvasAgentOwner(identity)
	doc, err := s.canvas.Project(owner, project)
	if err != nil {
		return doc, err
	}
	if s.closed {
		return doc, errors.New("Agent 服务已停止")
	}
	if s.active[agentKey(owner, project)] != nil {
		return doc, ErrCanvasAgentBusy
	}
	if doc.AgentRun == nil || doc.AgentRun.Engine != "codex-tools" || doc.AgentRun.SessionID != answer.SessionID {
		return doc, invalidCanvasDocument("当前会话没有待审核工作流")
	}
	_, session, err := agentSession(doc, answer.SessionID)
	if err != nil {
		return doc, err
	}
	w := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: s, ctx: s.ctx, identity: identity, doc: doc, session: session, state: agentMap(session["agentState"]), messages: util.AsMapSlice(session["protocolMessages"]), checkpoint: util.Clean(session["contextCheckpoint"]), req: CanvasAgentRequest{SessionID: answer.SessionID}}
	ids := w.workflowReviewUnapprovedIDs()
	if len(ids) == 0 {
		return doc, invalidCanvasDocument("当前没有待审核的系列提示词")
	}
	if canvasAgentWorkflowReviewApproved(answer.Answer) {
		if len(ids) != len(answer.Prompts) {
			return doc, invalidCanvasDocument("系列已变化，请重新读取并审核提示词")
		}
		for _, id := range ids {
			if answer.Prompts[id] != canvasAgentWorkflowFingerprint(*w.node(id)) {
				return doc, invalidCanvasDocument("提示词已变化，请重新读取并审核")
			}
		}
	}
	if strings.TrimSpace(answer.Answer) == "" || !canvasAgentWorkflowReviewApproved(answer.Answer) {
		w.state["mediaGenerationDeferred"] = true
	} else {
		w.approveWorkflowReview(ids)
		w.state["mediaGenerationDeferred"] = false
	}
	if err = w.save(); err != nil {
		return doc, err
	}
	return w.doc, nil
}
