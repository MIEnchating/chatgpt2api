package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/util"
)

var ErrCanvasAgentBusy = errors.New("Agent 正在后台执行，请停止后再修改画布")

// CanvasAgentRun is persisted with the document; it contains no credentials.
type CanvasAgentRun struct {
	ToolResult  map[string]any `json:"toolResult,omitempty"`
	SDKState    string         `json:"sdkState,omitempty"`
	Engine      string         `json:"engine"`
	ID          string         `json:"id"`
	SessionID   string         `json:"sessionId"`
	AssistantID string         `json:"assistantId"`
	Status      string         `json:"status"`
	Error       string         `json:"error,omitempty"`
	UpdatedAt   string         `json:"updatedAt"`
}

type CanvasAgentRequest struct {
	ID              string            `json:"id"`
	SessionID       string            `json:"sessionId"`
	AssistantID     string            `json:"assistantId"`
	UserMessageID   string            `json:"userMessageId"`
	UserText        string            `json:"userText"`
	Model           string            `json:"model"`
	RelayTokenName  string            `json:"relayTokenName"`
	APIMode         string            `json:"apiMode"`
	Stream          bool              `json:"stream"`
	Reasoning       bool              `json:"reasoningEnabled"`
	SystemPrompt    string            `json:"configuredSystemPrompt"`
	Generation      map[string]any    `json:"generation"`
	RelayTokens     map[string]string `json:"relayTokens"`
	References      []map[string]any  `json:"references"`
	SelectedNodeIDs []string          `json:"selectedNodeIds"`
	SkillIDs        []string          `json:"skillIds"`
	Resume          bool              `json:"resume"`
	Edit            bool              `json:"editPreviousRequest"`
	MediaChoice     string            `json:"mediaGenerationChoice"`
}

type CanvasAgentModelRequest struct {
	OnText   func(string) error
	TaskID   string
	Model    string
	Prompt   string
	Messages []map[string]any
	Metadata map[string]any
}
type CanvasAgentModel func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error)
type CanvasAgentMedia func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error)

type CanvasAgentService struct {
	mu        sync.Mutex
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	canvas    *CanvasDocumentService
	workflows *WorkflowService
	skills    *AgentSkillService
	model     CanvasAgentModel
	media     CanvasAgentMedia
	active    map[string]context.CancelFunc
	closed    bool
}

func NewCanvasAgentService(ctx context.Context, canvas *CanvasDocumentService, skills *AgentSkillService, model CanvasAgentModel, media CanvasAgentMedia) *CanvasAgentService {
	ctx, cancel := context.WithCancel(ctx)
	return &CanvasAgentService{ctx: ctx, cancel: cancel, canvas: canvas, skills: skills, model: model, media: media, active: map[string]context.CancelFunc{}}
}
func (s *CanvasAgentService) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
}
func canvasAgentOwner(i Identity) string {
	if i.OwnerID != "" {
		return i.OwnerID
	}
	return i.ID
}
func agentKey(owner, project string) string { return owner + "\x00" + project }

func (s *CanvasAgentService) Snapshot(identity Identity, project string) (CanvasDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.canvas.Project(canvasAgentOwner(identity), project)
	if err != nil {
		return doc, err
	}
	if doc.AgentRun != nil && doc.AgentRun.Status == "running" && s.active[agentKey(canvasAgentOwner(identity), project)] == nil {
		doc.AgentRun.Status = "interrupted"
		doc.AgentRun.Error = "服务已重启，执行已暂停；请检查已有结果后继续。"
		if err = agentSetMessage(&doc, doc.AgentRun.SessionID, doc.AgentRun.AssistantID, "waiting", doc.AgentRun.Error); err != nil {
			return doc, err
		}
		doc, err = s.canvas.saveAgent(canvasAgentOwner(identity), doc)
	}
	// Publish completion only after the worker has released its execution slot.
	if doc.AgentRun != nil && s.active[agentKey(canvasAgentOwner(identity), project)] != nil {
		doc.AgentRun.Status = "running"
	}
	return doc, err
}

func (s *CanvasAgentService) Start(identity Identity, project string, req CanvasAgentRequest) (CanvasDocument, error) {
	return s.start(identity, project, req, nil)
}

func (s *CanvasAgentService) start(identity Identity, project string, req CanvasAgentRequest, call map[string]any) (CanvasDocument, error) {
	if req.ID == "" || len(req.ID) > 128 || req.SessionID == "" || req.AssistantID == "" || strings.TrimSpace(req.UserText) == "" || call == nil && (req.Model == "" || req.RelayTokenName == "") {
		return CanvasDocument{}, invalidCanvasDocument("Agent 请求缺少会话、模型或内容")
	}
	if req.APIMode != "chat" && req.APIMode != "responses" {
		return CanvasDocument{}, invalidCanvasDocument("无效的 Agent 协议")
	}
	if req.MediaChoice != "" && req.MediaChoice != "generate" && req.MediaChoice != "defer" {
		return CanvasDocument{}, invalidCanvasDocument("无效的媒体生成选择")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return CanvasDocument{}, errors.New("Agent 服务已停止")
	}
	owner := canvasAgentOwner(identity)
	key := agentKey(owner, project)
	doc, err := s.canvas.Project(owner, project)
	if err != nil {
		return doc, err
	}
	if doc.AgentRun != nil && doc.AgentRun.ID == req.ID {
		return doc, nil
	}
	if s.active[key] != nil {
		return doc, ErrCanvasAgentBusy
	}
	if call != nil && doc.AgentRun != nil && doc.AgentRun.SDKState != "" {
		return doc, invalidCanvasDocument("请先回答或取消内置 Agent 的待处理问题")
	}
	sessions, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		return doc, err
	}
	if err = validateCanvasAgentSessionForRun(session); err != nil {
		return doc, err
	}
	references := []map[string]any{}
	seenReferences := map[string]bool{}
	for _, ref := range req.References {
		id, source := util.Clean(ref["id"]), util.Clean(ref["source"])
		if source != "attachment" {
			source = "node"
		}
		key := source + ":" + id
		if seenReferences[key] {
			continue
		}
		resolved, resolveErr := canvasAgentReference(doc, session, id, source)
		if resolveErr != nil {
			return doc, invalidCanvasDocument(resolveErr.Error())
		}
		references = append(references, resolved)
		seenReferences[key] = true
	}
	req.References = references
	found := false
	for _, m := range util.AsMapSlice(session["messages"]) {
		if util.Clean(m["id"]) == req.AssistantID && m["role"] == "assistant" {
			found = true
		}
	}
	if !found {
		return doc, invalidCanvasDocument("Agent 回复记录不存在，请先保存会话")
	}
	selected := []AgentSkill{}
	for _, id := range req.SkillIDs {
		skill, e := s.skills.Get(owner, id, false)
		if e != nil || !skill.Enabled {
			return doc, invalidCanvasDocument("所选 Skill 不可用")
		}
		selected = append(selected, skill)
	}
	if req.Generation == nil {
		req.Generation = map[string]any{}
	}
	sdkState := ""
	if call == nil && doc.AgentRun != nil && doc.AgentRun.SessionID == req.SessionID && !req.Edit {
		sdkState = doc.AgentRun.SDKState
	}
	doc.AgentRun = &CanvasAgentRun{SDKState: sdkState, Engine: "openai-agents-sdk", ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running", UpdatedAt: util.NowISO()}
	if call != nil {
		doc.AgentRun.Engine = "codex-tools"
	}
	for _, message := range util.AsMapSlice(session["messages"]) {
		if message["id"] == req.AssistantID {
			setCanvasAgentProcessing(message, true, time.Now())
		}
	}
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc, err = s.canvas.saveAgent(owner, doc)
	if err != nil {
		return doc, err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.active[key] = cancel
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		worker := &canvasAgentWorker{service: s, ctx: ctx, identity: identity, doc: doc, req: req, skills: selected, session: session}
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("Canvas agent worker panicked", "run_id", req.ID, "panic", recovered)
				func() {
					defer func() { _ = recover() }()
					_ = worker.finish("error", "Agent 执行异常中断，已保留已保存的进度")
				}()
			}
			s.mu.Lock()
			delete(s.active, key)
			s.mu.Unlock()
		}()
		if call != nil {
			worker.runTool(call)
		} else {
			worker.run()
		}
	}()
	return doc, nil
}
func (s *CanvasAgentService) Stop(identity Identity, project, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.canvas.Project(canvasAgentOwner(identity), project)
	if err != nil {
		return err
	}
	if doc.AgentRun == nil || doc.AgentRun.ID != runID {
		return invalidCanvasDocument("执行已变化，请刷新后重试")
	}
	if cancel := s.active[agentKey(canvasAgentOwner(identity), project)]; cancel != nil {
		cancel()
		return nil
	}
	if doc.AgentRun.Status == "waiting" {
		sessions, session, e := agentSession(doc, doc.AgentRun.SessionID)
		if e != nil {
			return e
		}
		state := agentMap(session["agentState"])
		question := agentMap(state["pendingQuestion"])
		if len(question) > 0 {
			name := "ask_user_question"
			if question["purpose"] == "delete_node" {
				name = "delete_node"
			}
			session["protocolMessages"] = append(util.AsMapSlice(session["protocolMessages"]), map[string]any{"role": "tool", "name": name, "toolCallId": question["id"], "content": agentJSON(agentError("user_cancelled", "用户取消了请求，不执行依赖此回答的操作"))})
			delete(state, "pendingQuestion")
			session["agentState"] = state
		}
		doc.AgentSessions, _ = json.Marshal(sessions)
		doc.AgentRun.Status = "cancelled"
		doc.AgentRun.SDKState = ""
		_ = agentSetMessage(&doc, doc.AgentRun.SessionID, doc.AgentRun.AssistantID, "waiting", "已取消本次请求。")
		_, e = s.canvas.saveAgent(canvasAgentOwner(identity), doc)
		return e
	}
	return nil
}

func agentSession(doc CanvasDocument, id string) ([]map[string]any, map[string]any, error) {
	var sessions []map[string]any
	if err := json.Unmarshal(doc.AgentSessions, &sessions); err != nil {
		return nil, nil, invalidCanvasDocument("会话记录无效")
	}
	for _, session := range sessions {
		if session["id"] == id {
			return sessions, session, nil
		}
	}
	return nil, nil, invalidCanvasDocument("找不到 Agent 会话")
}

func validateCanvasAgentSessionForRun(session map[string]any) error {
	invalid := func() error { return invalidCanvasDocument("Agent 会话状态无效，请重新创建对话") }
	state, ok := session["agentState"].(map[string]any)
	if !ok || !slices.Contains([]string{"intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"}, util.Clean(state["phase"])) {
		return invalid()
	}
	for _, key := range []string{"approvedNodeIds", "referenceNodeIds", "pendingTaskIds", "completedTaskIds"} {
		items, ok := state[key].([]any)
		if !ok {
			return invalid()
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return invalid()
			}
		}
	}
	for _, key := range []string{"messages", "protocolMessages"} {
		items, ok := session[key].([]any)
		if !ok {
			return invalid()
		}
		for _, item := range items {
			if message, ok := item.(map[string]any); !ok || message == nil {
				return invalid()
			}
		}
	}
	return nil
}
func agentSetMessage(doc *CanvasDocument, sid, mid, status, text string) error {
	sessions, session, err := agentSession(*doc, sid)
	if err != nil {
		return err
	}
	for _, m := range util.AsMapSlice(session["messages"]) {
		if m["id"] == mid {
			finishedAt := time.Now()
			if doc.AgentRun != nil && doc.AgentRun.Status == "interrupted" {
				if checkpoint, err := time.Parse(time.RFC3339Nano, doc.AgentRun.UpdatedAt); err == nil {
					finishedAt = checkpoint
				}
			}
			setCanvasAgentProcessing(m, false, finishedAt)
			m["status"] = status
			m["text"] = text
			delete(m, "activity")
		}
	}
	session["updatedAt"] = util.NowISO()
	doc.AgentSessions, _ = json.Marshal(sessions)
	return nil
}
func agentJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func agentMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}
func agentStrings(v any) []string {
	out := []string{}
	switch values := v.(type) {
	case []string:
		return values
	case []any:
		for _, item := range values {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func agentError(code, message string) map[string]any {
	return map[string]any{"ok": false, "code": code, "message": message}
}

func (s *CanvasDocumentService) saveAgent(owner string, doc CanvasDocument) (CanvasDocument, error) {
	expected := doc.Revision
	return s.saveWithAgent(owner, doc, &expected, true)
}

// WaitCanvasAgentTask waits independently of the requesting browser connection.
// It is driven by task change notifications instead of polling.
func WaitCanvasAgentTask(ctx context.Context, tasks *ImageTaskService, identity Identity, id string, onText func(string) error) (map[string]any, error) {
	subscription, err := tasks.SubscribeTasks(identity)
	if err != nil {
		return nil, err
	}
	defer subscription.Close()
	lastText := ""
	for {
		result, err := tasks.ListTasksWithError(identity, []string{id})
		if err != nil {
			return nil, err
		}
		if slices.Contains(agentStrings(result["missing_ids"]), id) {
			return nil, fmt.Errorf("任务不存在: %s", id)
		}
		items := util.AsMapSlice(result["items"])
		if len(items) > 0 {
			item := items[0]
			if onText != nil {
				data := util.AsMapSlice(item["data"])
				if len(data) > 0 {
					text := util.Clean(data[0]["text_response"])
					if text != "" && text != lastText {
						if err := onText(text); err != nil {
							return nil, err
						}
						lastText = text
					}
				}
			}
			switch util.Clean(item["status"]) {
			case "success":
				return item, nil
			case "error", "cancelled":
				return item, fmt.Errorf("%s", util.Clean(item["error"]))
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-subscription.Changed():
		}
	}
}
