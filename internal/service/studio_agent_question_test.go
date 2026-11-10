package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestStudioQuestionNeedsRealAnswerAndPreservesPendingCall(t *testing.T) {
	s, owner := executionFixture(t)
	var models, answers atomic.Int32
	s.Register("studio", func(ctx context.Context, _ Identity, w *AgentExecutionWorker) error {
		return w.Run(ctx, map[string]any{"tools": []map[string]any{executionTool("ask_user_question"), executionTool("finish_task")}, "completionTool": "finish_task", "input": []map[string]any{{"role": "user", "content": "make a poster"}}}, func(method string, params map[string]any) (any, error) {
			switch method {
			case "context":
				return map[string]any{"instructions": "Use tools"}, nil
			case "prepare":
				return map[string]any{}, nil
			case "model":
				if models.Add(1) == 1 {
					return agentTurn(agentCall("question-1", "ask_user_question", map[string]any{"text": "Which product?"})), nil
				}
				return agentTurn(agentCall("done", "finish_task", map[string]any{})), nil
			case "tool":
				if params["name"] == "ask_user_question" {
					if w.QuestionAnswer("question-1") != "A blue bottle" {
						return nil, errors.New("missing actual user answer")
					}
					answers.Add(1)
				} else {
					w.SetResult(map[string]any{"text": "done"})
				}
				return map[string]any{"result": map[string]any{"ok": true, "text": "done"}}, nil
			}
			return nil, errors.New("unexpected method")
		})
	})
	if _, err := s.Start(owner, "question-run", "studio", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if run := executionWait(t, s, owner, "question-run"); run.Status != "waiting" {
		t.Fatalf("run=%+v", run)
	}
	if _, err := s.Resume(owner, "question-run"); err != nil {
		t.Fatal(err)
	}
	if run := executionWait(t, s, owner, "question-run"); run.Status != "waiting" || answers.Load() != 0 || models.Load() != 1 {
		t.Fatalf("resume bypassed answer: %+v", run)
	}
	for _, test := range []struct {
		owner        Identity
		call, answer string
	}{{Identity{ID: "other"}, "question-1", "A blue bottle"}, {owner, "stale-call", "A blue bottle"}, {owner, "question-1", " "}} {
		if err := s.AnswerQuestion(test.owner, "question-run", test.call, test.answer); err == nil {
			t.Fatal("invalid answer accepted")
		}
	}
	if err := s.AnswerQuestion(owner, "question-run", "question-1", "A blue bottle"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resume(owner, "question-run"); err != nil {
		t.Fatal(err)
	}
	if run := executionWait(t, s, owner, "question-run"); run.Status != "success" || answers.Load() != 1 {
		t.Fatalf("run=%+v answers=%d", run, answers.Load())
	}
}

func TestStudioCancellationDistinguishesShutdownFromExplicitStop(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit-stop", true: "service-shutdown"}[shutdown], func(t *testing.T) {
			s, owner := executionFixture(t)
			started, cancelled := make(chan struct{}), make(chan bool, 1)
			s.Register("studio", func(ctx context.Context, _ Identity, worker *AgentExecutionWorker) error {
				close(started)
				<-ctx.Done()
				cancelled <- worker.CancelledByUser(ctx)
				return ctx.Err()
			})
			if _, err := s.Start(owner, "stop-run", "studio", map[string]any{}); err != nil {
				t.Fatal(err)
			}
			<-started
			if shutdown {
				s.Close()
			} else if err := s.Stop(owner, "stop-run"); err != nil {
				t.Fatal(err)
			}
			if got := <-cancelled; got == shutdown {
				t.Fatalf("cancel media=%v, shutdown=%v", got, shutdown)
			}
		})
	}
}
