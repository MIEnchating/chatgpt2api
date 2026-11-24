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

var errCanvasAgentSessionNotFound = errors.New("canvas agent session not found")

// CanvasAgentRun is persisted with the document; it contains no credentials.
type CanvasAgentRun struct {
	ToolResult   map[string]any `json:"toolResult,omitempty"`
	SDKState     string         `json:"sdkState,omitempty"`
	Engine       string         `json:"engine"`
	ID           string         `json:"id"`
	SessionID    string         `json:"sessionId"`
	AssistantID  string         `json:"assistantId"`
	Status       string         `json:"status"`
	Error        string         `json:"error,omitempty"`
	UpdatedAt    string         `json:"updatedAt"`
	ModelRetryAt string         `json:"modelRetryAt,omitempty"`
	ReadOnly     bool           `json:"readOnly,omitempty"`
	Unread       bool           `json:"unread,omitempty"`
}

type CanvasAgentRequest struct {
	queueAfterRun       string
	queueResume         bool
	leaseToken          string
	historyReference    string
	goalRevision        string
	goalMediaRestricted bool
	MediaBaseURL        string            `json:"-"`
	ID                  string            `json:"id"`
	SessionID           string            `json:"sessionId"`
	AssistantID         string            `json:"assistantId"`
	UserMessageID       string            `json:"userMessageId"`
	UserText            string            `json:"userText"`
	Model               string            `json:"model"`
	RelayTokenName      string            `json:"relayTokenName"`
	APIMode             string            `json:"apiMode"`
	Stream              bool              `json:"stream"`
	Reasoning           bool              `json:"reasoningEnabled"`
	SystemPrompt        string            `json:"configuredSystemPrompt"`
	Generation          map[string]any    `json:"generation"`
	RelayTokens         map[string]string `json:"relayTokens"`
	VideoRelayTokens    map[string]string `json:"videoRelayTokens"`
	References          []map[string]any  `json:"references"`
	SelectedNodeIDs     []string          `json:"selectedNodeIds"`
	SkillIDs            []string          `json:"skillIds"`
	Resume              bool              `json:"resume"`
	Edit                bool              `json:"editPreviousRequest"`
	MediaChoice         string            `json:"mediaGenerationChoice"`
	ReadOnly            bool              `json:"readOnly"`
	ModelRequestLimit   int               `json:"modelRequestLimit,omitempty"`
	GoalContinuation    int               `json:"goalContinuation,omitempty"`
}

type AgentModelRequest struct {
	RunID              string
	Diagnostic         map[string]any
	OnText             func(string) error
	OnReasoningSummary func(string, string, bool) error
	BeforeDispatch     func() error
	Model              string
	Prompt             string
	Messages           []map[string]any
	Metadata           map[string]any
}
type AgentModel func(context.Context, Identity, AgentModelRequest) (map[string]any, error)
type CanvasAgentMedia func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error)

type CanvasAgentService struct {
	mu            sync.Mutex
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	canvas        *CanvasDocumentService
	execution     *AgentExecutionService
	workflows     *WorkflowService
	skills        *AgentSkillService
	model         AgentModel
	media         CanvasAgentMedia
	videoModels   func() []CanvasAgentVideoModel
	videoMerger   func(context.Context, Identity, []CanvasNode, CanvasVideoMergeOptions) (CanvasMergedVideo, error)
	videoAnalyzer func(context.Context, Identity, CanvasNode, CanvasVideoAnalysisOptions) (CanvasVideoAnalysis, error)
	active        map[string]context.CancelFunc
	compacting    map[string]*CanvasAgentRequest
	closed        bool
}

func NewCanvasAgentService(ctx context.Context, execution *AgentExecutionService, canvas *CanvasDocumentService, skills *AgentSkillService, model AgentModel, media CanvasAgentMedia) *CanvasAgentService {
	ctx, cancel := context.WithCancel(ctx)
	return &CanvasAgentService{ctx: ctx, cancel: cancel, canvas: canvas, execution: execution, skills: skills, model: model, media: media, active: map[string]context.CancelFunc{}, compacting: map[string]*CanvasAgentRequest{}}
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

func (s *CanvasAgentService) WatchProgress(identity Identity, project string) (<-chan struct{}, func()) {
	return s.execution.watchProgress("canvas/" + agentKey(canvasAgentOwner(identity), project))
}

func (s *CanvasAgentService) notifyProgress(identity Identity, project string) {
	if s.execution == nil {
		return
	}
	s.execution.notifyProgress("canvas/" + agentKey(canvasAgentOwner(identity), project))
}

func (s *CanvasAgentService) Snapshot(identity Identity, project string) (CanvasDocument, error) {
	workspace, err := s.Workspace(identity, project, nil, CanvasHistoryFull)
	return workspace.Document, err
}

func (s *CanvasAgentService) ProjectList(identity Identity) (CanvasProjectList, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := canvasAgentOwner(identity)
	list, err := s.canvas.ProjectList(owner)
	if err != nil {
		return list, err
	}
	for _, project := range list.Projects {
		if project.AgentStatus == nil || project.AgentStatus.Status != "running" || s.active[agentKey(owner, project.ID)] != nil {
			continue
		}
		active, err := s.canvas.agentRunLeaseActive(owner, project.ID)
		if err != nil {
			return CanvasProjectList{}, err
		}
		if !active {
			project.AgentStatus.Status = "interrupted"
		}
	}
	return list, nil
}

// Workspace loads and reconciles one canvas under the execution lock, so a new
// run cannot start between the document read and its snapshot reconciliation.
func (s *CanvasAgentService) Workspace(identity Identity, project string, keepIDs []string, scope CanvasHistoryScope) (CanvasWorkspaceResult, error) {
	return s.workspace(identity, project, keepIDs, scope, false)
}

// ActivateWorkspace opens the selected project under the execution lock and
// reconciles its run using the same rules as an ordinary workspace read.
func (s *CanvasAgentService) ActivateWorkspace(identity Identity, project string, scope CanvasHistoryScope) (CanvasWorkspaceResult, error) {
	return s.workspace(identity, project, nil, scope, true)
}

func (s *CanvasAgentService) workspace(identity Identity, project string, keepIDs []string, scope CanvasHistoryScope, activate bool) (CanvasWorkspaceResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := canvasAgentOwner(identity)
	workspace, err := s.canvas.readProjectWorkspace(owner, project, keepIDs, scope, activate, func(id string) bool {
		key := agentKey(owner, id)
		_, compacting := s.compacting[key]
		return !compacting && s.active[key] != nil
	})
	if err != nil || workspace.Document.AgentRun == nil || workspace.historyDeferred {
		return workspace, err
	}
	document, err := s.snapshotLocked(identity, workspace.Document, workspace.agentRunActive)
	if err != nil {
		return CanvasWorkspaceResult{}, err
	}
	if !document.AgentHistoryPartial && (scope == CanvasHistoryActive || scope == CanvasHistoryEditor) {
		document, err = CanvasAgentHistoryView(document, keepIDs)
		if err != nil {
			return CanvasWorkspaceResult{}, err
		}
	}
	workspace.Document = document
	for index := range workspace.Projects {
		if workspace.Projects[index].ID == document.ID {
			workspace.Projects[index].Revision = document.Revision
			workspace.Projects[index].UpdatedAt = document.UpdatedAt
		}
	}
	return workspace, nil
}

func (s *CanvasAgentService) snapshotLocked(identity Identity, doc CanvasDocument, workerActive bool) (CanvasDocument, error) {
	if doc.AgentRun == nil {
		return doc, nil
	}
	owner, project := canvasAgentOwner(identity), doc.ID
	runSessionID := doc.AgentRun.SessionID
	interrupted := doc.AgentRun.Status == "running" && !workerActive

	var err error
	var sessions []map[string]any
	var session map[string]any
	// A partial workspace always includes and verifies the execution's body
	// when its session is in the directory and history was not deferred.
	indexed := doc.AgentHistoryPartial && slices.ContainsFunc(doc.AgentSessionSummaries, func(summary CanvasAgentSessionSummary) bool {
		return summary.ID == runSessionID
	})
	if !indexed {
		sessions, session, err = agentSession(doc, runSessionID)
		if err != nil && (workerActive || !errors.Is(err, errCanvasAgentSessionNotFound)) {
			return doc, err
		}
	}
	if workerActive {
		// Publish completion only after the worker has released its execution slot.
		doc.AgentRun.Status = "running"
		return doc, nil
	}
	orphaned := errors.Is(err, errCanvasAgentSessionNotFound)
	compacted := false
	// Reclaim duplicate response payloads before the browser appends another
	// request. Only expand a partial read if a repair will actually write.
	if !orphaned && !(doc.AgentHistoryPartial && interrupted) && len(doc.AgentSessions) > canvasDocumentMaxAgentDataBytes/2 {
		private := &canvasAgentWorker{service: s, identity: identity, doc: doc, req: CanvasAgentRequest{SessionID: runSessionID}}
		if found, loadErr := private.loadSDKSession(); loadErr != nil {
			return doc, loadErr
		} else if found && (private.sdk.State != "" || len(private.sdk.Items) > 0) {
			if session == nil {
				sessions, session, err = agentSession(doc, runSessionID)
				if err != nil {
					return doc, err
				}
			}
			responsesChanged := omitCanvasAgentResponseCopies(session)
			journalChanged := compactCanvasAgentToolJournal(session)
			compacted = responsesChanged || journalChanged
		}
	}
	if doc.AgentHistoryPartial && (orphaned || interrupted || compacted) {
		// A repair must preserve every transcript, including unloaded sessions.
		complete, loadErr := s.canvas.readProjectWorkspace(owner, project, nil, CanvasHistoryFull, false, nil)
		if loadErr != nil {
			return doc, loadErr
		}
		return s.snapshotLocked(identity, complete.Document, complete.agentRunActive)
	}
	if orphaned {
		doc.AgentRun = nil
		if doc.ActiveAgentSessionID == runSessionID {
			doc.ActiveAgentSessionID = ""
		}
		return s.canvas.saveAgent(owner, doc)
	}
	if compacted {
		base := doc
		doc.AgentSessions, err = json.Marshal(sessions)
		if err != nil {
			return base, err
		}
		doc, err = s.canvas.saveAgentChanges(owner, base, doc)
		if err != nil {
			return doc, err
		}
	}
	if interrupted {
		doc.AgentRun.Status = "interrupted"
		doc.AgentRun.Error = "服务已重启，执行已暂停；请检查已有结果后继续。"
		if err = agentSetMessage(&doc, runSessionID, doc.AgentRun.AssistantID, "waiting", doc.AgentRun.Error); err != nil {
			return doc, err
		}
		return s.canvas.saveAgent(owner, doc)
	}
	return doc, nil
}

func (s *CanvasAgentService) Start(identity Identity, project string, req CanvasAgentRequest) (CanvasDocument, error) {
	return s.start(identity, project, req, nil)
}

func (s *CanvasAgentService) start(identity Identity, project string, req CanvasAgentRequest, call map[string]any) (CanvasDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startLocked(identity, project, req, call)
}

func (s *CanvasAgentService) startLocked(identity Identity, project string, req CanvasAgentRequest, call map[string]any) (CanvasDocument, error) {
	if req.SessionID == "" || call == nil && (req.Model == "" || req.RelayTokenName == "") || req.queueAfterRun == "" && (req.ID == "" || len(req.ID) > 128 || req.AssistantID == "" || strings.TrimSpace(req.UserText) == "") {
		return CanvasDocument{}, invalidCanvasDocument("Agent 请求缺少会话、模型或内容")
	}
	if req.APIMode != "chat" && req.APIMode != "responses" {
		return CanvasDocument{}, invalidCanvasDocument("无效的 Agent 协议")
	}
	if req.MediaChoice != "" && req.MediaChoice != "generate" && req.MediaChoice != "defer" {
		return CanvasDocument{}, invalidCanvasDocument("无效的媒体生成选择")
	}
	if req.ModelRequestLimit < 0 || req.ModelRequestLimit > 1000 {
		return CanvasDocument{}, invalidCanvasDocument("模型请求上限必须在 0 到 1000 之间")
	}
	if req.GoalContinuation < 0 || req.GoalContinuation > 3 || req.GoalContinuation > 0 && (call != nil || req.Resume || req.Edit || req.ReadOnly || req.queueAfterRun != "") {
		return CanvasDocument{}, invalidCanvasDocument("每次目标执行可开启 1 至 3 轮自动续跑")
	}
	if req.GoalContinuation > 0 && req.MediaChoice != "" {
		return CanvasDocument{}, invalidCanvasDocument("创作目标自动续跑不能同时设置媒体生成选择")
	}
	if s.closed {
		return CanvasDocument{}, errors.New("Agent 服务已停止")
	}
	owner := canvasAgentOwner(identity)
	key := agentKey(owner, project)
	doc, err := s.canvas.Project(owner, project)
	if err != nil {
		return doc, err
	}
	if req.queueAfterRun != "" {
		if s.active[key] != nil {
			if _, compacting := s.compacting[key]; compacting {
				s.compacting[key] = &req
				return doc, nil
			}
			doc.AgentRun.Status = "running"
			return doc, nil
		}
		var admitted bool
		doc, admitted, err = admitCanvasQueuedRun(doc, &req)
		if err != nil || !admitted {
			return doc, err
		}
	}
	if doc.AgentRun != nil && doc.AgentRun.ID == req.ID {
		return doc, nil
	}
	if s.active[key] != nil {
		return doc, ErrCanvasAgentBusy
	}
	compacting, err := s.canvas.agentCompactionLeaseActive(owner, project)
	if err != nil {
		return doc, err
	}
	if compacting {
		return doc, ErrCanvasAgentBusy
	}
	if call == nil && doc.AgentRun != nil && doc.AgentRun.SessionID == req.SessionID {
		if at, parseErr := time.Parse(time.RFC3339Nano, doc.AgentRun.ModelRetryAt); parseErr == nil && time.Now().Before(at) {
			return doc, invalidCanvasDocument("上游仍在限流，请在 " + at.UTC().Format(time.RFC3339) + " 后继续")
		}
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
	if call != nil {
		guard := canvasAgentWorker{service: s, identity: identity, doc: doc, req: req}
		if found, loadErr := guard.loadSDKSession(); loadErr != nil {
			return doc, loadErr
		} else if found && len(guard.sdk.Question) > 0 {
			return doc, invalidCanvasDocument("请先回答或取消内置 Agent 的待处理问题")
		}
	}
	references := []map[string]any{}
	missingReferences := false
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
			if req.Resume || req.queueAfterRun != "" {
				missingReferences = true
				continue
			}
			return doc, invalidCanvasDocument(resolveErr.Error())
		}
		references = append(references, resolved)
		seenReferences[key] = true
	}
	req.References = references
	if missingReferences {
		session["protocolMessages"] = append(util.AsMapSlice(session["protocolMessages"]), map[string]any{"role": "system", "content": "继续任务时，原请求中的部分引用素材已经移除或不可用。请重新读取当前画布并保留用户修改，不要重建已删除节点；缺少必需素材时询问用户，不要求提供内部 ID。"})
	}
	mediaRestrictionSource := ""
	if call == nil {
		if req.Resume {
			mediaRestrictionSource = req.AssistantID
		} else if !req.Edit && doc.AgentRun != nil && doc.AgentRun.SessionID == req.SessionID && len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
			mediaRestrictionSource = doc.AgentRun.AssistantID
		}
	}
	found := false
	for _, m := range util.AsMapSlice(session["messages"]) {
		if m["role"] != "assistant" {
			continue
		}
		if m["id"] == mediaRestrictionSource && m["goalMediaRestricted"] == true && req.MediaChoice != "generate" {
			req.goalMediaRestricted = true
		}
		if util.Clean(m["id"]) == req.AssistantID {
			found = true
			if call == nil && req.Resume {
				req.ReadOnly = req.ReadOnly || m["readOnly"] == true
			}
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
	if req.ReadOnly && (call != nil || !req.Edit && len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0) {
		return doc, invalidCanvasDocument("请先处理待确认的操作，再发送只读请求")
	}
	private := &canvasAgentWorker{service: s, identity: identity, doc: doc, req: req}
	if found, loadErr := private.loadSDKSession(); loadErr != nil {
		return doc, loadErr
	} else if req.ReadOnly && !req.Edit && len(private.sdk.Question) > 0 {
		return doc, invalidCanvasDocument("请先处理待确认的操作，再发送只读请求")
	} else if found && (private.sdk.State != "" || len(private.sdk.Items) > 0) {
		omitCanvasAgentResponseCopies(session)
	}
	if req.GoalContinuation > 0 {
		goal := agentMap(session["goal"])
		if session["engine"] == "codex" || goal["status"] != "active" || len(private.sdk.Question) > 0 || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
			return doc, invalidCanvasDocument("请先启用创作目标并处理待确认问题")
		}
		req.goalRevision = agentJSON(goal)
		req.goalMediaRestricted = true
		session["goalRun"] = map[string]any{
			"runId":         req.ID,
			"goalRevision":  req.goalRevision,
			"roundsStarted": 0,
			"maxRounds":     req.GoalContinuation,
		}
	}
	if call == nil {
		for _, message := range util.AsMapSlice(session["messages"]) {
			if message["id"] != req.AssistantID || message["role"] != "assistant" {
				continue
			}
			if req.Resume && !req.Edit {
				req.historyReference, _ = message["historyReference"].(string)
				if req.historyReference != "" {
					break
				}
			}
			if req.historyReference == "" {
				req.historyReference, err = captureCanvasAgentHistoryReferences(sessions, req.SessionID, req.UserText)
				if err != nil {
					return doc, err
				}
			}
			delete(message, "historyReference")
			if req.historyReference != "" {
				if len(private.sdk.Question) > 0 || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
					return doc, invalidCanvasDocument("请先回答或取消当前问题，再引用历史对话")
				}
				message["historyReference"] = req.historyReference
			}
			break
		}
	}
	leaseToken, err := s.canvas.acquireAgentRunLease(owner, project, req.SessionID)
	if err != nil {
		return doc, err
	}
	req.leaseToken = leaseToken
	doc.AgentRun = &CanvasAgentRun{SDKState: sdkState, Engine: "langgraph", ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running", UpdatedAt: util.NowISO(), ReadOnly: req.ReadOnly}
	if call != nil {
		doc.AgentRun.Engine = "codex-tools"
	}
	for _, message := range util.AsMapSlice(session["messages"]) {
		if message["id"] == req.AssistantID {
			setCanvasAgentProcessing(message, true, time.Now())
			if req.goalMediaRestricted {
				message["goalMediaRestricted"] = true
			} else {
				delete(message, "goalMediaRestricted")
			}
			if req.ReadOnly {
				message["readOnly"] = true
			}
		}
	}
	private.doc = doc
	private.req = req
	doc.AgentSessions, _ = json.Marshal(sessions)
	doc, err = s.canvas.saveAgentWithLease(owner, doc, leaseToken)
	if err != nil {
		_ = s.canvas.releaseAgentRunLease(owner, project, leaseToken)
		return doc, err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.active[key] = cancel
	s.notifyProgress(identity, project)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		leaseRenewalStop := make(chan struct{})
		leaseRenewalDone := make(chan error, 1)
		go func() {
			ticker := time.NewTicker(canvasAgentWorkspaceLeaseRenewal)
			defer ticker.Stop()
			for {
				select {
				case <-leaseRenewalStop:
					leaseRenewalDone <- nil
					return
				case <-ctx.Done():
					leaseRenewalDone <- ctx.Err()
					return
				case <-ticker.C:
					if renewErr := s.canvas.renewAgentRunLease(owner, project, leaseToken); renewErr != nil {
						cancel()
						leaseRenewalDone <- renewErr
						return
					}
				}
			}
		}()
		worker := &canvasAgentWorker{service: s, ctx: ctx, identity: identity, doc: doc, req: req, skills: selected, session: session}
		defer func() {
			close(leaseRenewalStop)
			leaseErr := <-leaseRenewalDone
			if leaseErr != nil && !errors.Is(leaseErr, context.Canceled) {
				slog.Error("Canvas agent run lease renewal failed", "run_id", req.ID, "error", leaseErr)
			}
			if releaseErr := s.canvas.releaseAgentRunLease(owner, project, leaseToken); releaseErr != nil && !errors.Is(releaseErr, errCanvasAgentLeaseLost) {
				slog.Error("Failed to release canvas agent run lease", "run_id", req.ID, "error", releaseErr)
			}
			if recovered := recover(); recovered != nil {
				slog.Error("Canvas agent worker panicked", "run_id", req.ID, "panic", recovered)
				func() {
					defer func() { _ = recover() }()
					_ = worker.finish("error", "Agent 执行异常中断，已保留已保存的进度")
				}()
			}
			s.mu.Lock()
			delete(s.active, key)
			if call == nil && ctx.Err() == nil && !s.closed && worker.doc.AgentRun != nil && worker.doc.AgentRun.Status == "success" {
				next := queuedCanvasRunSettings(req, req.ID, req.SessionID, false)
				if _, err := s.startLocked(identity, project, next, nil); err != nil {
					slog.Error("Failed to start queued canvas message", "run_id", req.ID, "error", err)
				}
			}
			s.mu.Unlock()
			s.notifyProgress(identity, project)
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
	key := agentKey(canvasAgentOwner(identity), project)
	if _, compacting := s.compacting[key]; compacting {
		return ErrCanvasAgentBusy
	}
	if cancel := s.active[key]; cancel != nil {
		cancel()
		return nil
	}
	active, err := s.canvas.agentRunLeaseActive(canvasAgentOwner(identity), project)
	if err != nil {
		return err
	}
	if active {
		return ErrCanvasAgentBusy
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
			worker := canvasAgentWorker{messages: util.AsMapSlice(session["protocolMessages"])}
			worker.record(map[string]any{"id": question["id"], "name": name}, agentError("user_cancelled", "用户取消了请求，不执行依赖此回答的操作"))
			session["protocolMessages"] = worker.messages
			delete(state, "pendingQuestion")
			session["agentState"] = state
		}
		worker := &canvasAgentWorker{service: s, identity: identity, doc: doc, req: CanvasAgentRequest{SessionID: doc.AgentRun.SessionID}}
		if e = worker.revokeSDKQuestion(); e != nil {
			return e
		}
		doc.AgentSessions, _ = json.Marshal(sessions)
		doc.AgentRun.Status = "cancelled"
		doc.AgentRun.SDKState = ""
		_ = agentSetMessage(&doc, doc.AgentRun.SessionID, doc.AgentRun.AssistantID, "waiting", "已取消本次请求。")
		_, e = s.canvas.saveAgent(canvasAgentOwner(identity), doc)
		if e == nil {
			s.notifyProgress(identity, project)
		}
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
	return nil, nil, fmt.Errorf("%w: 找不到 Agent 会话: %w", ErrInvalidCanvasDocument, errCanvasAgentSessionNotFound)
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
	if doc.AgentRun != nil && doc.AgentRun.Status == "interrupted" {
		interruptCanvasTextTasks(session)
	}
	for _, m := range util.AsMapSlice(session["messages"]) {
		if m["id"] == mid {
			finishedAt := time.Now()
			if doc.AgentRun != nil && doc.AgentRun.Status == "interrupted" {
				settleCanvasAgentReviews(m, "interrupted")
				for _, workflow := range util.AsMapSlice(m["workflowRuns"]) {
					if workflow["status"] == "running" {
						settleCanvasWorkflowRun(workflow, "interrupted")
					}
				}
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
	return s.saveAgentWithLease(owner, doc, "")
}

func (s *CanvasDocumentService) saveAgentWithLease(owner string, doc CanvasDocument, leaseToken string) (CanvasDocument, error) {
	expected := doc.Revision
	return s.saveWithAgent(owner, doc, &expected, true, leaseToken, "")
}

// WaitCanvasAgentTask waits independently of the requesting browser connection.
// It is driven by task change notifications instead of polling.
func WaitCanvasAgentTask(ctx context.Context, tasks *ImageTaskService, identity Identity, id string, onText func(string) error, onProgress func(int) error) (map[string]any, error) {
	subscription, err := tasks.SubscribeTasks(identity, CreationTaskEventScope{TaskIDs: []string{id}})
	if err != nil {
		return nil, err
	}
	defer subscription.Close()
	lastText := ""
	lastProgress := -1
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
			progress := util.ToInt(item["progress"], -1)
			if onProgress != nil && progress >= 0 && progress < 100 && progress != lastProgress && (item["status"] == TaskStatusQueued || item["status"] == TaskStatusRunning) {
				if err := onProgress(progress); err != nil {
					return nil, err
				}
				lastProgress = progress
			}
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
