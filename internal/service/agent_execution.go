package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

var ErrAgentExecutionNotFound = errors.New("Agent 任务不存在")

// AgentExecution is the public projection; inputs, SDK state and tool receipts stay private.
type AgentExecution struct {
	ID           string           `json:"id"`
	Domain       string           `json:"domain"`
	Status       string           `json:"status"`
	Error        string           `json:"error,omitempty"`
	UpdatedAt    string           `json:"updatedAt"`
	ModelRetryAt string           `json:"modelRetryAt,omitempty"`
	Events       []map[string]any `json:"events"`
	Result       any              `json:"result,omitempty"`
}
type agentExecutionRecord struct {
	AgentExecution
	Input    json.RawMessage           `json:"input"`
	Data     json.RawMessage           `json:"data,omitempty"`
	SDK      AgentSDKSession           `json:"sdk"`
	Receipts map[string]map[string]any `json:"receipts"`
	Answers  map[string]string         `json:"answers,omitempty"`
}
type AgentExecutionHandler func(context.Context, Identity, *AgentExecutionWorker) error

type AgentExecutionService struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	store    storage.JSONDocumentBackend
	handlers map[string]AgentExecutionHandler
	active   map[string]context.CancelFunc
	watchers map[string]map[chan struct{}]struct{}
	wg       sync.WaitGroup
	closed   bool
}

func NewAgentExecutionService(ctx context.Context, store storage.Backend) *AgentExecutionService {
	ctx, cancel := context.WithCancel(ctx)
	return &AgentExecutionService{ctx: ctx, cancel: cancel, store: jsonDocumentStoreFromBackend(store), handlers: map[string]AgentExecutionHandler{}, active: map[string]context.CancelFunc{}, watchers: map[string]map[chan struct{}]struct{}{}}
}

// WatchProgress subscribes to changes for one owned run. Subscribe before reading the first snapshot.
func (s *AgentExecutionService) WatchProgress(identity Identity, id string) (<-chan struct{}, func()) {
	return s.watchProgress(agentExecutionPath(identity, id))
}

func (s *AgentExecutionService) watchProgress(key string) (<-chan struct{}, func()) {
	changed := make(chan struct{}, 1)
	s.mu.Lock()
	if s.watchers[key] == nil {
		s.watchers[key] = make(map[chan struct{}]struct{})
	}
	s.watchers[key][changed] = struct{}{}
	s.mu.Unlock()
	return changed, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.watchers[key], changed)
		if len(s.watchers[key]) == 0 {
			delete(s.watchers, key)
		}
	}
}

func (s *AgentExecutionService) notifyProgress(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notifyProgressLocked(key)
}

func (s *AgentExecutionService) notifyProgressLocked(key string) {
	for changed := range s.watchers[key] {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
}

func (s *AgentExecutionService) Register(domain string, handler AgentExecutionHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[domain] = handler
}
func (s *AgentExecutionService) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
}
func agentExecutionPath(identity Identity, id string) string {
	hash := sha256.Sum256([]byte(canvasAgentOwner(identity) + "\x00" + id))
	return fmt.Sprintf("agent_executions/%x.json", hash)
}
func agentExecutionLatestPath(identity Identity, domain string) string {
	hash := sha256.Sum256([]byte(canvasAgentOwner(identity) + "\x00" + domain))
	return fmt.Sprintf("agent_execution_indexes/%x.json", hash)
}
func (s *AgentExecutionService) load(identity Identity, id string) (*agentExecutionRecord, error) {
	raw, err := loadStoredJSONBounded(s.store, agentExecutionPath(identity, id))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, ErrAgentExecutionNotFound
	}
	record := &agentExecutionRecord{}
	if err = json.Unmarshal([]byte(agentJSON(raw)), record); err != nil {
		return nil, err
	}
	return record, nil
}
func (s *AgentExecutionService) Snapshot(identity Identity, id, domain string) (AgentExecution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" {
		raw, err := loadStoredJSONBounded(s.store, agentExecutionLatestPath(identity, domain))
		if err != nil {
			return AgentExecution{}, err
		}
		id = util.Clean(agentMap(raw)["id"])
		if id == "" {
			return AgentExecution{}, ErrAgentExecutionNotFound
		}
	}
	record, err := s.load(identity, id)
	if err != nil {
		return AgentExecution{}, err
	}
	if domain != "" && record.Domain != domain {
		return AgentExecution{}, ErrAgentExecutionNotFound
	}
	if record.Status == "running" && s.active[agentExecutionPath(identity, id)] == nil {
		record.Status = "interrupted"
		record.Error = "执行已中断，已保留最近成功保存的进度，可以继续。"
		if err = saveStoredJSONBounded(s.store, agentExecutionPath(identity, id), record); err != nil {
			return AgentExecution{}, err
		}
	}
	if s.active[agentExecutionPath(identity, id)] != nil {
		record.Status = "running"
	}
	return record.AgentExecution, nil
}
func (s *AgentExecutionService) Start(identity Identity, id, domain string, input any) (AgentExecution, error) {
	if strings.TrimSpace(id) == "" || len(id) > 128 {
		return AgentExecution{}, errors.New("无效的 Agent 任务")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AgentExecution{}, errors.New("Agent 服务已停止")
	}
	if s.handlers[domain] == nil {
		return AgentExecution{}, errors.New("Agent 业务不可用")
	}
	if existing, err := s.load(identity, id); err == nil {
		if existing.Domain != domain {
			return AgentExecution{}, errors.New("任务 ID 已用于其他业务")
		}
		encoded, _ := json.Marshal(input)
		var original, incoming any
		_ = json.Unmarshal(existing.Input, &original)
		_ = json.Unmarshal(encoded, &incoming)
		if !reflect.DeepEqual(original, incoming) {
			return AgentExecution{}, errors.New("任务 ID 已用于不同输入")
		}
		return existing.AgentExecution, nil
	} else if !errors.Is(err, ErrAgentExecutionNotFound) {
		return AgentExecution{}, err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return AgentExecution{}, err
	}
	record := &agentExecutionRecord{AgentExecution: AgentExecution{ID: id, Domain: domain, Status: "running", Events: []map[string]any{}, UpdatedAt: util.NowISO()}, Input: encoded, SDK: AgentSDKSession{Items: []map[string]any{}}, Receipts: map[string]map[string]any{}}
	if err = saveStoredJSONBounded(s.store, agentExecutionPath(identity, id), record); err != nil {
		return AgentExecution{}, err
	}
	if err = saveStoredJSONBounded(s.store, agentExecutionLatestPath(identity, domain), map[string]any{"id": id}); err != nil {
		return AgentExecution{}, err
	}
	s.launch(identity, record)
	return record.AgentExecution, nil
}
func (s *AgentExecutionService) Resume(identity Identity, id string) (AgentExecution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AgentExecution{}, errors.New("Agent 服务已停止")
	}
	record, err := s.load(identity, id)
	if err != nil {
		return AgentExecution{}, err
	}
	if s.active[agentExecutionPath(identity, id)] != nil || record.Status == "success" {
		return record.AgentExecution, nil
	}
	if s.handlers[record.Domain] == nil {
		return AgentExecution{}, errors.New("Agent 业务不可用")
	}
	if retryAt, err := time.Parse(time.RFC3339Nano, record.ModelRetryAt); err == nil {
		if time.Now().Before(retryAt) {
			return record.AgentExecution, fmt.Errorf("上游要求延后重试，请在 %s 后继续", retryAt.UTC().Format(time.RFC3339Nano))
		}
		if record.Status == "waiting" {
			record.SDK.RetryWaitMS = 0
		}
		record.ModelRetryAt = ""
	}
	record.Status = "running"
	record.Error = ""
	record.UpdatedAt = util.NowISO()
	if err = saveStoredJSONBounded(s.store, agentExecutionPath(identity, id), record); err != nil {
		return AgentExecution{}, err
	}
	s.launch(identity, record)
	return record.AgentExecution, nil
}

// AnswerQuestion records real user input against the pending call before resuming.
func (s *AgentExecutionService) AnswerQuestion(identity Identity, id, callID, answer string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.load(identity, id)
	if err != nil {
		return err
	}
	if record.Domain != "studio" || record.Status != "waiting" || s.active[agentExecutionPath(identity, id)] != nil {
		return errors.New("任务当前没有等待回答的问题")
	}
	var state struct {
		Pending []struct {
			ID       string `json:"id"`
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"pending"`
	}
	if json.Unmarshal([]byte(record.SDK.State), &state) != nil || strings.TrimSpace(answer) == "" || len(answer) > 12000 {
		return errors.New("无效的问题回答")
	}
	if len(state.Pending) == 0 || state.Pending[0].ID != callID || state.Pending[0].Function.Name != "ask_user_question" {
		return errors.New("问题已变化，请重新读取任务")
	}
	if record.Answers == nil {
		record.Answers = map[string]string{}
	}
	if previous, ok := record.Answers[callID]; ok && previous != answer {
		return errors.New("此问题已经回答")
	}
	record.Answers[callID] = answer
	return saveStoredJSONBounded(s.store, agentExecutionPath(identity, id), record)
}

func (w *AgentExecutionWorker) QuestionAnswer(callID string) string { return w.record.Answers[callID] }
func (s *AgentExecutionService) Stop(identity Identity, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.load(identity, id)
	if err != nil {
		return err
	}
	if cancel := s.active[agentExecutionPath(identity, id)]; cancel != nil {
		cancel()
		return nil
	}
	if record.Status != "success" {
		record.Status = "cancelled"
		record.UpdatedAt = util.NowISO()
		key := agentExecutionPath(identity, id)
		if err := saveStoredJSONBounded(s.store, key, record); err != nil {
			return err
		}
		s.notifyProgressLocked(key)
	}
	return nil
}
func (s *AgentExecutionService) launch(identity Identity, record *agentExecutionRecord) {
	key := agentExecutionPath(identity, record.ID)
	ctx, cancel := context.WithCancel(s.ctx)
	handler := s.handlers[record.Domain]
	s.active[key] = cancel
	s.notifyProgressLocked(key)
	s.wg.Add(1)
	// Return a projection before the goroutine can mutate its slices.
	copyRecord := &agentExecutionRecord{}
	_ = json.Unmarshal([]byte(agentJSON(record)), copyRecord)
	go func() {
		defer s.wg.Done()
		defer cancel()
		worker := &AgentExecutionWorker{service: s, identity: identity, record: copyRecord}
		err := handler(ctx, identity, worker)
		if err != nil {
			copyRecord.Status = "error"
			copyRecord.Error = err.Error()
			if ctx.Err() != nil {
				copyRecord.Status = "cancelled"
				if s.ctx.Err() != nil {
					copyRecord.Status = "interrupted"
				}
			}
		} else if copyRecord.Status == "running" {
			copyRecord.Status = "waiting"
			copyRecord.Error = "任务尚未通过完成验收，可以继续。"
		}
		if saveErr := worker.Save(); saveErr != nil {
			slog.Error("Agent progress persistence failed", "run_id", copyRecord.ID, "error", saveErr)
		}
		s.mu.Lock()
		delete(s.active, key)
		s.notifyProgressLocked(key)
		s.mu.Unlock()
	}()
}

// AgentExecutionWorker is owned by one server-side execution, independent of HTTP observers.
type AgentExecutionWorker struct {
	service          *AgentExecutionService
	identity         Identity
	record           *agentExecutionRecord
	persistenceError error
	modelAttempt     map[string]any
}

// A service shutdown preserves paid media tasks for recovery.
func (w *AgentExecutionWorker) CancelledByUser(ctx context.Context) bool {
	return ctx.Err() != nil && w.service.ctx.Err() == nil
}

func (w *AgentExecutionWorker) ID() string { return w.record.ID }

func (w *AgentExecutionWorker) Input(target any) error { return json.Unmarshal(w.record.Input, target) }
func (w *AgentExecutionWorker) Restore(target any) error {
	if len(w.record.Data) == 0 {
		return nil
	}
	return json.Unmarshal(w.record.Data, target)
}
func (w *AgentExecutionWorker) SetData(value any) error {
	data, err := json.Marshal(value)
	if err == nil {
		w.record.Data = data
	}
	return err
}
func (w *AgentExecutionWorker) SetResult(value any) { w.record.Result = value }
func (w *AgentExecutionWorker) Save() error {
	if w.persistenceError != nil {
		return w.persistenceError
	}
	w.record.UpdatedAt = util.NowISO()
	err := saveStoredJSONBounded(w.service.store, agentExecutionPath(w.identity, w.record.ID), w.record)
	if err != nil {
		w.persistenceError = fmt.Errorf("%w: %w", ErrAgentProgressPersistence, err)
		return w.persistenceError
	}
	return err
}

// SaveProgress publishes a change only after it has reached storage.
func (w *AgentExecutionWorker) SaveProgress() error {
	if err := w.Save(); err != nil {
		return err
	}
	s := w.service
	s.notifyProgress(agentExecutionPath(w.identity, w.record.ID))
	return nil
}

func (w *AgentExecutionWorker) Event(event map[string]any) error {
	sequence := 1
	if len(w.record.Events) > 0 {
		sequence = util.ToInt(w.record.Events[len(w.record.Events)-1]["sequence"], 0) + 1
	}
	event["sequence"] = sequence
	if len(w.modelAttempt) > 0 {
		event["modelAttempt"] = w.modelAttempt
	}
	w.record.Events = append(w.record.Events, event)
	// Bound event payloads separately from the SDK's authoritative history.
	if len(w.record.Events) > 160 {
		w.record.Events = w.record.Events[len(w.record.Events)-160:]
	}
	return w.SaveProgress()
}
func (w *AgentExecutionWorker) Run(ctx context.Context, config map[string]any, business func(string, map[string]any) (any, error)) error {
	config["sessionId"] = agentExecutionPath(w.identity, w.record.ID)
	config["preserveRetryCheckpoint"] = true
	config["retryWaitMs"] = w.record.SDK.RetryWaitMS
	if len(w.record.SDK.Items) > 0 || w.record.SDK.State != "" {
		delete(config, "inputProtocol")
		config["input"] = []map[string]any{}
	}
	if len(w.record.SDK.ModelContext) > 0 {
		config["modelContext"] = w.record.SDK.ModelContext
	}
	if w.record.SDK.State != "" {
		config["state"] = w.record.SDK.State
		config["input"] = []map[string]any{}
		var state struct {
			Pending []struct {
				ID string `json:"id"`
			} `json:"pending"`
		}
		if json.Unmarshal([]byte(w.record.SDK.State), &state) == nil && len(state.Pending) > 0 && w.record.Answers[state.Pending[0].ID] != "" {
			config["answerCallId"] = state.Pending[0].ID
		}
	}
	return w.service.RunSDK(ctx, config, func(method string, params map[string]any) (any, error) {
		if w.persistenceError != nil {
			return nil, w.persistenceError
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		w.modelAttempt = util.StringMap(params["diagnostic"])
		switch method {
		case "retry":
			if params["validation"] == true {
				return map[string]any{"ok": true}, w.Event(map[string]any{"stage": "retrying", "message": "模型工具格式不正确，正在纠正后继续"})
			}
			message := fmt.Sprintf("上游连接暂时中断，正在重试模型请求（%d/%d）",
				util.ToInt(params["attempt"], 1), util.ToInt(w.modelAttempt["maxAttempts"], 0)-1)
			return map[string]any{"ok": true}, w.recordModelRetry(params, "retrying", message)
		case "model":
			if w.record.ModelRetryAt != "" {
				w.record.ModelRetryAt = ""
				if err := w.Save(); err != nil {
					return nil, err
				}
			}
		case "session":
			return ApplyAgentSDKSession(&w.record.SDK, params, func(next *AgentSDKSession) error {
				previous := w.record.SDK
				w.record.SDK = *next
				err := w.Save()
				w.record.SDK = previous
				return err
			})
		case "checkpoint":
			w.record.SDK.State = util.Clean(params["state"])
			return map[string]any{"ok": true}, w.Save()
		case "memory":
			return map[string]any{"ok": true}, w.Save()
		case "pause":
			w.record.SDK.State = util.Clean(params["state"])
			w.record.Status = "waiting"
			return map[string]any{"ok": true}, w.Save()
		case "finish":
			if params["retryBudgetExceeded"] == true {
				if w.record.SDK.State == "" {
					return nil, errors.New("延后重试缺少执行检查点")
				}
				w.record.Status = "waiting"
				w.record.Error = fmt.Sprintf("等待时间超过本次自动重试预算，进度已保存。请在 %s 后继续。", util.Clean(params["retryAt"]))
				return map[string]any{"ok": true}, w.recordModelRetry(params, "retry_deferred", w.record.Error)
			}
			waiting := params["status"] == "waiting"
			if !waiting && w.record.Result == nil {
				return nil, errors.New("任务尚未通过业务验收")
			}
			if err := w.record.SDK.retainCompactedContext(true); err != nil {
				return nil, err
			}
			w.record.SDK.State = ""
			w.record.SDK.RetryWaitMS = 0
			w.record.ModelRetryAt = ""
			w.record.Status = "success"
			if waiting {
				w.record.Status = "waiting"
			}
			return map[string]any{"ok": true}, w.Save()
		case "tool":
			id := util.Clean(params["id"])
			delete(params, "diagnostic")
			fingerprint := agentJSON(params)
			if receipt := w.record.Receipts[id]; receipt != nil {
				if receipt["fingerprint"] != fingerprint {
					return nil, errors.New("工具调用 ID 冲突")
				}
				if receipt["done"] == true {
					return receipt["response"], nil
				}
				// Domain tools must report an uncertain operation to the model, never blindly replay it.
				return map[string]any{"result": map[string]any{"ok": false, "code": "execution_unknown", "message": "原工具未确认完成，请核对已有状态后继续。"}}, nil
			}
			receipt := map[string]any{"fingerprint": fingerprint}
			w.record.Receipts[id] = receipt
			if err := w.Save(); err != nil {
				return nil, err
			}
			result, err := business(method, params)
			if err != nil {
				return nil, err
			}
			receipt["done"] = true
			receipt["response"] = result
			if err = w.Save(); err != nil {
				return nil, err
			}
			return result, nil
		}
		return business(method, params)
	})
}

func (w *AgentExecutionWorker) recordModelRetry(params map[string]any, stage, message string) error {
	retryAt := util.Clean(params["retryAt"])
	wait, validWait := util.StrictInt(params["retryWaitMs"])
	if _, err := time.Parse(time.RFC3339Nano, retryAt); err != nil || !validWait || wait < 0 || int64(wait) > agentModelRetryBudgetMS {
		return errors.New("模型重试时间或等待预算无效")
	}
	w.record.ModelRetryAt = retryAt
	w.record.SDK.RetryWaitMS = int64(wait)
	event := map[string]any{
		"stage": stage, "message": message, "retryAt": retryAt,
		"retryDelayMs": params["delayMs"], "retryWaitMs": wait, "rateLimited": params["rateLimited"],
	}
	if code := util.Clean(params["failureCode"]); code != "" {
		event["failureCode"] = code
	}
	return w.Event(event)
}

// WaitAgentExecution observes saved state; disconnecting never cancels the worker.
func WaitAgentExecution(ctx context.Context, s *AgentExecutionService, identity Identity, id string, onProgress func(AgentExecution)) (AgentExecution, error) {
	changed, stop := s.WatchProgress(identity, id)
	defer stop()
	for {
		run, err := s.Snapshot(identity, id, "")
		if err != nil {
			return run, err
		}
		if onProgress != nil {
			onProgress(run)
		}
		if run.Status != "running" {
			if run.Status != "success" {
				return run, errors.New(firstAgentString(run.Error, "任务尚未完成，可以继续"))
			}
			return run, nil
		}
		select {
		case <-ctx.Done():
			return run, ctx.Err()
		case <-changed:
		}
	}
}
