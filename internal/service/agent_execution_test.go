package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
	"time"
)

func executionFixture(t *testing.T) (*AgentExecutionService, Identity) {
	t.Helper()
	runtimePath, err := filepath.Abs("../../agent-runtime/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_RUNTIME_PATH", runtimePath)
	service := NewAgentExecutionService(context.Background(), newTestStorageBackend(t))
	t.Cleanup(service.Close)
	return service, Identity{ID: "execution-owner"}
}
func executionWait(t *testing.T, s *AgentExecutionService, owner Identity, id string) AgentExecution {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		run, err := s.Snapshot(owner, id, "")
		if err != nil {
			t.Fatal(err)
		}
		if run.Status != "running" {
			return run
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("execution did not stop")
	return AgentExecution{}
}
func executionTool(name string) map[string]any {
	return map[string]any{"function": map[string]any{"name": name, "description": name, "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}}
}

func TestAgentExecutionsResumeBothDomainsWithoutRepeatingCommittedTools(t *testing.T) {
	for _, domain := range []string{"workflow", "video_contract"} {
		t.Run(domain, func(t *testing.T) {
			s, owner := executionFixture(t)
			var models, writes atomic.Int32
			fail := atomic.Bool{}
			fail.Store(true)
			handler := func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
				return w.Run(ctx, map[string]any{"tools": []map[string]any{executionTool("write"), executionTool("finish")}, "completionTool": "finish", "input": []map[string]any{{"role": "user", "content": "continue existing task"}}}, func(method string, params map[string]any) (any, error) {
					switch method {
					case "context":
						return map[string]any{"instructions": "Use tools."}, nil
					case "prepare":
						return map[string]any{}, nil
					case "model":
						count := models.Add(1)
						if count == 1 {
							return agentTurn(agentCall("write-once", "write", map[string]any{})), nil
						}
						if fail.Load() {
							return nil, protocol.HTTPError{Status: 400, Message: "invalid parameter"}
						}
						return agentTurn(agentCall("finished", "finish", map[string]any{})), nil
					case "tool":
						if params["name"] == "write" {
							writes.Add(1)
							return map[string]any{"result": map[string]any{"ok": true}}, nil
						}
						w.SetResult(map[string]any{"draft": "saved result"})
						return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
					}
					return map[string]any{"ok": true}, nil
				})
			}
			s.Register(domain, handler)
			input := map[string]any{"prompt": "original"}
			if _, err := s.Start(owner, "existing", domain, input); err != nil {
				t.Fatal(err)
			}
			run := executionWait(t, s, owner, "existing")
			if run.Status != "error" || models.Load() != 2 || writes.Load() != 1 {
				t.Fatalf("failed run=%+v models=%d writes=%d", run, models.Load(), writes.Load())
			}
			if _, err := s.Start(owner, "existing", domain, input); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Start(owner, "existing", domain, map[string]any{"prompt": "different"}); err == nil {
				t.Fatal("ID reuse accepted different input")
			}
			if _, err := s.Snapshot(Identity{ID: "another-owner"}, "existing", domain); !errors.Is(err, ErrAgentExecutionNotFound) {
				t.Fatalf("owner isolation: %v", err)
			}
			s.Close()
			restarted := NewAgentExecutionService(context.Background(), s.store.(storage.Backend))
			t.Cleanup(restarted.Close)
			restarted.Register(domain, handler)
			fail.Store(false)
			if _, err := restarted.Resume(owner, "existing"); err != nil {
				t.Fatal(err)
			}
			run = executionWait(t, restarted, owner, "existing")
			if run.Status != "success" || writes.Load() != 1 || models.Load() != 3 {
				t.Fatalf("recovered run=%+v models=%d writes=%d", run, models.Load(), writes.Load())
			}
		})
	}
}

func TestAgentExecutionDoesNotTreatTextAsBusinessCompletion(t *testing.T) {
	s, owner := executionFixture(t)
	s.Register("workflow", func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"tools": []map[string]any{}, "input": []map[string]any{{"role": "user", "content": "unfinished"}}}, func(method string, _ map[string]any) (any, error) {
			if method == "context" {
				return map[string]any{"instructions": "work"}, nil
			}
			if method == "model" {
				return map[string]any{"text_response": "done"}, nil
			}
			return map[string]any{"ok": true}, nil
		})
	})
	if _, err := s.Start(owner, "unfinished", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	run := executionWait(t, s, owner, "unfinished")
	if run.Status == "success" || run.Result != nil {
		t.Fatalf("false completion: %+v", run)
	}
}

func TestAgentExecutionInFlightRestartKeepsCompletedTool(t *testing.T) {
	s, owner := executionFixture(t)
	entered := make(chan struct{})
	var models, writes atomic.Int32
	handler := func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"completionTool": "finish", "tools": []map[string]any{executionTool("write"), executionTool("finish")}, "inputProtocol": []map[string]any{{"role": "user", "content": "original task"}}}, func(method string, params map[string]any) (any, error) {
			switch method {
			case "context":
				return map[string]any{"instructions": "use tools"}, nil
			case "model":
				switch models.Add(1) {
				case 1:
					return agentTurn(agentCall("saved-write", "write", map[string]any{})), nil
				case 2:
					close(entered)
					<-ctx.Done()
					return nil, ctx.Err()
				default:
					return agentTurn(agentCall("done", "finish", map[string]any{})), nil
				}
			case "tool":
				if params["name"] == "write" {
					writes.Add(1)
				} else {
					w.SetResult(map[string]any{"ok": true})
				}
				return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
			}
			return map[string]any{}, nil
		})
	}
	s.Register("workflow", handler)
	if _, err := s.Start(owner, "restart", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("model did not start")
	}
	s.Close()
	restarted := NewAgentExecutionService(context.Background(), s.store.(storage.Backend))
	t.Cleanup(restarted.Close)
	restarted.Register("workflow", handler)
	run, err := restarted.Snapshot(owner, "restart", "")
	if err != nil || run.Status != "interrupted" {
		t.Fatalf("restart snapshot=%+v %v", run, err)
	}
	if _, err = restarted.Resume(owner, "restart"); err != nil {
		t.Fatal(err)
	}
	run = executionWait(t, restarted, owner, "restart")
	if run.Status != "success" || writes.Load() != 1 {
		t.Fatalf("replayed tool: %+v writes=%d", run, writes.Load())
	}
	record, err := restarted.load(owner, "restart")
	if err != nil {
		t.Fatal(err)
	}
	users := 0
	for _, item := range record.SDK.Items {
		if item["role"] == "user" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("resume duplicated the original user input: %d", users)
	}
}

type executionLostAcknowledgementBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	fail atomic.Bool
}

func (b *executionLostAcknowledgementBackend) SaveJSONDocument(name string, value any) error {
	if err := b.JSONDocumentBackend.SaveJSONDocument(name, value); err != nil {
		return err
	}
	if b.fail.Load() {
		return errors.New("storage acknowledgement lost")
	}
	return nil
}
func TestAgentExecutionLostToolAcknowledgementReusesCommittedResult(t *testing.T) {
	base := newTestStorageBackend(t)
	backend := &executionLostAcknowledgementBackend{Backend: base, JSONDocumentBackend: base.(storage.JSONDocumentBackend)}
	s := NewAgentExecutionService(context.Background(), backend)
	t.Cleanup(s.Close)
	path, err := filepath.Abs("../../agent-runtime/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_RUNTIME_PATH", path)
	owner := Identity{ID: "ack-owner"}
	var writes, models atomic.Int32
	handler := func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"completionTool": "finish", "tools": []map[string]any{executionTool("write"), executionTool("finish")}, "input": []map[string]any{{"role": "user", "content": "write exactly once"}}}, func(method string, params map[string]any) (any, error) {
			switch method {
			case "context":
				return map[string]any{"instructions": "use tools"}, nil
			case "model":
				if models.Add(1) == 1 {
					return agentTurn(agentCall("paid-task", "write", map[string]any{})), nil
				}
				return agentTurn(agentCall("finish", "finish", map[string]any{})), nil
			case "tool":
				if params["name"] == "write" {
					writes.Add(1)
					backend.fail.Store(true)
				} else {
					w.SetResult(map[string]any{"taskId": "same-paid-task"})
				}
				return map[string]any{"result": map[string]any{"ok": true, "taskId": "same-paid-task", "text": "done"}}, nil
			}
			return map[string]any{}, nil
		})
	}
	s.Register("workflow", handler)
	if _, err = s.Start(owner, "lost-ack", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		active := s.active[agentExecutionPath(owner, "lost-ack")] != nil
		s.mu.Unlock()
		if !active {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	backend.fail.Store(false)
	if _, err = s.Resume(owner, "lost-ack"); err != nil {
		t.Fatal(err)
	}
	run := executionWait(t, s, owner, "lost-ack")
	if run.Status != "success" || writes.Load() != 1 {
		t.Fatalf("write replayed after lost acknowledgement: %+v writes=%d", run, writes.Load())
	}
}

func TestAgentExecutionHistorySurvivesDatabaseReopen(t *testing.T) {
	cases := []struct{ name, url string }{
		{"sqlite", "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "agent.db"))},
		{"postgres", os.Getenv("TEST_POSTGRES_DATABASE_URL")},
		{"mysql", os.Getenv("TEST_MYSQL_DATABASE_URL")},
	}
	path, err := filepath.Abs("../../agent-runtime/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_RUNTIME_PATH", path)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.url == "" {
				t.Skip("isolated database URL is not configured")
			}
			backend, err := storage.NewDatabaseBackend(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			owner := Identity{ID: "reopen-" + tc.name + "-" + util.NewUUID()}
			s := NewAgentExecutionService(context.Background(), backend)
			var models atomic.Int32
			handler := func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
				return w.Run(ctx, map[string]any{"completionTool": "finish", "tools": []map[string]any{executionTool("finish")}, "input": []map[string]any{{"role": "user", "content": "original durable request"}}}, func(method string, params map[string]any) (any, error) {
					if method == "context" {
						return map[string]any{"instructions": "use finish"}, nil
					}
					if method == "model" {
						if models.Add(1) == 1 {
							return nil, protocol.HTTPError{Status: 400, Message: "reject once"}
						}
						return agentTurn(agentCall("finish", "finish", map[string]any{})), nil
					}
					if method == "tool" {
						w.SetResult(map[string]any{"draft": "preserved"})
						return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
					}
					return map[string]any{}, nil
				})
			}
			s.Register("workflow", handler)
			if _, err = s.Start(owner, "reopen", "workflow", map[string]any{}); err != nil {
				t.Fatal(err)
			}
			first := executionWait(t, s, owner, "reopen")
			if first.Status != "error" {
				t.Fatalf("first run=%+v", first)
			}
			s.Close()
			if err = backend.Close(); err != nil {
				t.Fatal(err)
			}
			backend, err = storage.NewDatabaseBackend(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer backend.Close()
			restarted := NewAgentExecutionService(context.Background(), backend)
			defer restarted.Close()
			restarted.Register("workflow", handler)
			if _, err = restarted.Resume(owner, "reopen"); err != nil {
				t.Fatal(err)
			}
			last := executionWait(t, restarted, owner, "reopen")
			if last.Status != "success" || models.Load() != 2 {
				t.Fatalf("lost recovered state: %+v models=%d", last, models.Load())
			}
		})
	}
}

func TestAgentExecutionContextOverflowRetainsOriginalRequest(t *testing.T) {
	s, owner := executionFixture(t)
	original := strings.Repeat("素材", 30000)
	var models atomic.Int32
	s.Register("workflow", func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		var input map[string]string
		if err := w.Input(&input); err != nil {
			return err
		}
		return w.Run(ctx, map[string]any{"contextWindowTokens": 64000, "tools": []map[string]any{}, "input": []map[string]any{{"role": "user", "content": input["prompt"]}}}, func(method string, _ map[string]any) (any, error) {
			if method == "context" {
				return map[string]any{"instructions": "preserve required input"}, nil
			}
			if method == "model" {
				models.Add(1)
				return map[string]any{}, nil
			}
			return map[string]any{}, nil
		})
	})
	if _, err := s.Start(owner, "overflow", "workflow", map[string]string{"prompt": original}); err != nil {
		t.Fatal(err)
	}
	run := executionWait(t, s, owner, "overflow")
	if run.Status != "error" || models.Load() != 0 || !strings.Contains(run.Error, "上下文预算") {
		t.Fatalf("unsafe context handling: %+v model calls=%d", run, models.Load())
	}
	saved, err := s.load(owner, "overflow")
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]string
	if err = json.Unmarshal(saved.Input, &input); err != nil || input["prompt"] != original {
		t.Fatalf("overflow discarded original input: %v", err)
	}
}

func TestAgentExecutionTurnBudgetResumesWithoutDuplicatingInput(t *testing.T) {
	s, owner := executionFixture(t)
	var models, reads atomic.Int32
	s.Register("workflow", func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"completionTool": "finish", "maxTurns": 2, "tools": []map[string]any{executionTool("read"), executionTool("finish")}, "inputProtocol": []map[string]any{{"role": "user", "content": "keep the original task"}}}, func(method string, params map[string]any) (any, error) {
			if method == "context" {
				return map[string]any{"instructions": "use tools"}, nil
			}
			if method == "model" {
				step := models.Add(1)
				if step <= 2 {
					return agentTurn(agentCall(fmt.Sprintf("read-%d", step), "read", map[string]any{})), nil
				}
				return agentTurn(agentCall("finish", "finish", map[string]any{})), nil
			}
			if method == "tool" {
				if params["name"] == "read" {
					reads.Add(1)
				} else {
					w.SetResult(map[string]any{"draft": "complete"})
				}
				return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
			}
			return map[string]any{}, nil
		})
	})
	if _, err := s.Start(owner, "budget", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	first := executionWait(t, s, owner, "budget")
	if first.Status != "waiting" || models.Load() != 2 || reads.Load() != 2 {
		t.Fatalf("budget lost progress: %+v models=%d reads=%d", first, models.Load(), reads.Load())
	}
	if _, err := s.Resume(owner, "budget"); err != nil {
		t.Fatal(err)
	}
	last := executionWait(t, s, owner, "budget")
	if last.Status != "success" || models.Load() != 3 || reads.Load() != 2 {
		t.Fatalf("resume repeated work: %+v models=%d reads=%d", last, models.Load(), reads.Load())
	}
	saved, err := s.load(owner, "budget")
	if err != nil {
		t.Fatal(err)
	}
	users := 0
	for _, item := range saved.SDK.Items {
		if item["role"] == "user" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("original request duplicated: %d", users)
	}
}

func TestAgentExecutionRetryProgress(t *testing.T) {
	s, owner := executionFixture(t)
	var calls int
	s.Register("workflow", func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"tools": []map[string]any{executionTool("finish")}, "completionTool": "finish", "input": []map[string]any{{"role": "user", "content": "Finish once"}}}, func(method string, _ map[string]any) (any, error) {
			switch method {
			case "model":
				calls++
				if calls <= 5 {
					return nil, protocol.HTTPError{Status: 503, Message: "temporarily unavailable"}
				}
				return agentTurn(agentCall("finish", "finish", map[string]any{})), nil
			case "tool":
				w.SetResult(map[string]any{"text": "done"})
				return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
			}
			return map[string]any{}, nil
		})
	})
	if _, err := s.Start(owner, "retry-progress", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	run := executionWait(t, s, owner, "retry-progress")
	if run.Status != "success" {
		t.Fatalf("retry run = %+v", run)
	}
	retries := 0
	for _, event := range run.Events {
		if event["stage"] != "retrying" {
			continue
		}
		retries++
		if got := util.Clean(event["message"]); !strings.Contains(got, fmt.Sprintf("（%d/5）", retries)) {
			t.Fatalf("retry event = %q", got)
		}
	}
	if retries != 5 || calls != 6 {
		t.Fatalf("retries=%d model calls=%d", retries, calls)
	}
}
