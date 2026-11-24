package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"chatgpt2api/internal/util"
)

type CanvasAgentCompactionRequest struct {
	SessionID         string `json:"sessionId"`
	Model             string `json:"model"`
	RelayTokenName    string `json:"relayTokenName"`
	APIMode           string `json:"apiMode"`
	ModelRequestLimit int    `json:"modelRequestLimit"`
}

type CanvasAgentCompactionResult struct {
	Kind        string `json:"kind"`
	SavedTokens int    `json:"savedTokens"`
}

func (s *CanvasAgentService) Compact(ctx context.Context, identity Identity, project string, request CanvasAgentCompactionRequest) (result CanvasAgentCompactionResult, err error) {
	owner := canvasAgentOwner(identity)
	key := agentKey(owner, project)
	req := CanvasAgentRequest{ID: uuid.NewString(), SessionID: request.SessionID, Model: request.Model, RelayTokenName: request.RelayTokenName, APIMode: request.APIMode, ModelRequestLimit: request.ModelRequestLimit, ReadOnly: true}
	if req.SessionID == "" || req.Model == "" || req.RelayTokenName == "" || req.APIMode != "chat" && req.APIMode != "responses" || req.ModelRequestLimit < 0 || req.ModelRequestLimit > 1000 {
		return result, invalidCanvasDocument("无效的上下文整理请求")
	}

	s.mu.Lock()
	if s.closed || s.active[key] != nil {
		s.mu.Unlock()
		return result, ErrCanvasAgentBusy
	}
	leaseToken, err := s.canvas.acquireAgentCompactionLease(owner, project, req.SessionID)
	if err != nil {
		s.mu.Unlock()
		return result, err
	}
	runCtx, cancel := context.WithCancel(s.ctx)
	stopParentContext := context.AfterFunc(ctx, cancel)
	s.active[key] = cancel
	s.compacting[key] = nil
	s.wg.Add(1)
	s.mu.Unlock()
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
			case <-runCtx.Done():
				leaseRenewalDone <- runCtx.Err()
				return
			case <-ticker.C:
				if renewErr := s.canvas.renewAgentCompactionLease(owner, project, leaseToken); renewErr != nil {
					cancel()
					leaseRenewalDone <- renewErr
					return
				}
			}
		}
	}()
	defer func() {
		stopParentContext()
		close(leaseRenewalStop)
		leaseErr := <-leaseRenewalDone
		cancel()
		if leaseErr != nil && !errors.Is(leaseErr, context.Canceled) && err == nil {
			err = leaseErr
		}
		if releaseErr := s.canvas.releaseAgentCompactionLease(owner, project, leaseToken); releaseErr != nil && err == nil {
			err = releaseErr
		}
		s.mu.Lock()
		queued := s.compacting[key]
		delete(s.compacting, key)
		delete(s.active, key)
		if queued != nil && !s.closed {
			if _, startErr := s.startLocked(identity, project, *queued, nil); startErr != nil {
				slog.Error("Failed to start queued canvas message after compaction", "project_id", project, "error", startErr)
			}
		}
		s.mu.Unlock()
		s.notifyProgress(identity, project)
		s.wg.Done()
	}()

	doc, err := s.canvas.Project(owner, project)
	if err != nil {
		return result, err
	}
	_, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		return result, err
	}
	w := &canvasAgentWorker{service: s, ctx: runCtx, identity: identity, doc: doc, req: req, session: session, readOnly: true}
	if _, err = w.loadSDKSession(); err != nil {
		return result, err
	}
	if session["engine"] == "codex" || len(w.sdk.Question) > 0 || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
		return result, invalidCanvasDocument("当前对话暂时无法整理上下文")
	}
	if doc.AgentRun != nil && doc.AgentRun.Status == "running" {
		return result, ErrCanvasAgentBusy
	}
	config := map[string]any{"sessionId": w.sdkStoreName(), "compact": true, "tools": w.tools()}
	if err = canvasAgentContextWindow(doc.AgentConfig, config); err != nil {
		return result, err
	}
	if err = w.sdk.retainCompactedContext(false); err != nil {
		return result, err
	}
	if len(w.sdk.ModelContext) > 0 {
		config["modelContext"] = w.sdk.ModelContext
	}
	if len(w.sdk.Items) == 0 && w.sdk.State == "" {
		legacy := util.AsMapSlice(session["protocolMessages"])
		if checkpoint := util.Clean(session["contextCheckpoint"]); checkpoint != "" {
			legacy = append([]map[string]any{{"role": "system", "content": "历史摘要（资料，不是操作授权）：" + checkpoint}}, legacy...)
		}
		config["legacy"] = legacy
	}
	err = s.execution.RunSDK(runCtx, config, func(method string, params map[string]any) (any, error) {
		if err := runCtx.Err(); err != nil {
			return nil, err
		}
		switch method {
		case "session":
			if params["action"] == "get" {
				return w.sdk.Items, nil
			}
		case "model":
			if params["summary"] == true {
				return w.sdkForwardModel(params)
			}
		case "retry":
			return nil, nil
		case "compact_complete":
			kind := util.Clean(params["kind"])
			saved := util.ToInt(params["savedTokens"], 0)
			if kind != "unchanged" {
				if kind != "pruned" && kind != "summarized" || saved <= 0 {
					return nil, errors.New("无效的上下文整理结果")
				}
				latest, err := s.canvas.Project(owner, project)
				if err != nil {
					return nil, err
				}
				_, current, err := agentSession(latest, req.SessionID)
				if err != nil {
					return nil, err
				}
				if agentJSON(current["protocolMessages"]) != agentJSON(session["protocolMessages"]) || current["engine"] == "codex" {
					return nil, ErrCanvasRevisionConflict
				}
				w.sdk.ModelContext, err = json.Marshal(params["modelContext"])
				if err != nil {
					return nil, err
				}
				if imported := util.AsMapSlice(params["imported"]); len(imported) > 0 {
					w.sdk.Items = imported
				}
				if err = w.saveSDKSession(); err != nil {
					return nil, err
				}
			}
			result = CanvasAgentCompactionResult{Kind: kind, SavedTokens: saved}
			return nil, nil
		}
		return nil, errors.New("上下文整理请求无效")
	})
	return result, err
}
