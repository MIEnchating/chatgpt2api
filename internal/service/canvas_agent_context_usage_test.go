package service

import (
	"context"
	"encoding/json"
	"math"
	"testing"
)

func TestCanvasAgentSDKContextUsageSurvivesReloadAndBrowserSaves(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	usage := agentMap(session["contextUsage"])
	if done.AgentRun.Status != "success" || usage["model"] != req.Model || usage["maxTokens"] != float64(365600) || usage["compacting"] != false || usage["basis"] != "compression-budget" || len(usage) != 5 {
		t.Fatalf("SDK context estimate missing or exposed private inputs: run=%+v usage=%v", done.AgentRun, usage)
	}
	if used, ok := usage["usedTokens"].(float64); !ok || used <= 0 || used > 365600 {
		t.Fatalf("invalid input estimate: %v", usage)
	}
	before := agentJSON(usage)
	for _, forged := range []any{nil, map[string]any{"usedTokens": 0, "maxTokens": 1}} {
		sessions, edited, _ := agentSession(done, req.SessionID)
		if forged == nil {
			delete(edited, "contextUsage")
		} else {
			edited["contextUsage"] = forged
		}
		done.AgentSessions, _ = json.Marshal(sessions)
		var err error
		done, err = svc.canvas.SaveAtRevision(identity.ID, done)
		if err != nil {
			t.Fatal(err)
		}
		_, saved, _ := agentSession(done, req.SessionID)
		if agentJSON(saved["contextUsage"]) != before {
			t.Fatal("browser snapshot changed server context statistics")
		}
	}
}

func TestCanvasAgentSDKCompactionBudgetUsesSavedContextWindow(t *testing.T) {
	for _, window := range []int{128000, 257001} {
		t.Run(agentJSON(window), func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
				return agentTurn(), nil
			}, nil)
			doc.AgentConfig = json.RawMessage(agentJSON(map[string]any{"contextWindowTokens": window}))
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			_, session, _ := agentSession(done, req.SessionID)
			budget := math.Floor(float64(window) * 0.8)
			if done.AgentRun.Status != "success" || agentMap(session["contextUsage"])["maxTokens"] != budget {
				t.Fatalf("saved window did not reach SDK filter: run=%+v usage=%v", done.AgentRun, session["contextUsage"])
			}
		})
	}
}

func TestCanvasAgentSDKContextWindowValidationAndResume(t *testing.T) {
	w := memoryWorker(t, nil)
	for _, raw := range []string{`{"contextWindowTokens":0}`, `{"contextWindowTokens":1}`, `{"contextWindowTokens":-1}`, `{"contextWindowTokens":1.5}`, `{"contextWindowTokens":9007199254740992}`, `{"contextWindowTokens":"457000"}`} {
		w.doc.AgentConfig = json.RawMessage(raw)
		if _, err := w.sdkConfig(); err == nil {
			t.Fatalf("invalid context window accepted: %s", raw)
		}
	}
	for _, resume := range []bool{false, true} {
		w.req.Resume = resume
		w.doc.AgentConfig = json.RawMessage(`{"contextWindowTokens":128000}`)
		config, err := w.sdkConfig()
		if err != nil || config["contextWindowTokens"] != float64(128000) {
			t.Fatalf("context window lost for resume=%v: config=%v err=%v", resume, config, err)
		}
	}
}

func TestCanvasAgentContextUsageRejectsInvalidCountersWithoutMutation(t *testing.T) {
	w := memoryWorker(t, nil)
	valid := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": true}
	if err := w.updateContextUsage(map[string]any{"contextUsage": valid}); err != nil {
		t.Fatal(err)
	}
	before := agentJSON(w.session["contextUsage"])
	for _, field := range []string{"usedTokens", "maxTokens"} {
		for _, value := range []any{-1.0, 1.5, math.Inf(1), math.NaN(), float64(1 << 53), "36560", nil} {
			invalid := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": false}
			invalid[field] = value
			if err := w.updateContextUsage(map[string]any{"contextUsage": invalid}); err == nil || agentJSON(w.session["contextUsage"]) != before {
				t.Fatalf("accepted or mutated %s=%v", field, value)
			}
		}
	}
	if err := w.updateContextUsage(map[string]any{}); err != nil || agentJSON(w.session["contextUsage"]) != before {
		t.Fatal("absent telemetry changed the last reported estimate")
	}
	if err := w.finish("error", "summary failed"); err != nil {
		t.Fatal(err)
	}
	doc, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, w.req.SessionID)
	if agentMap(session["contextUsage"])["compacting"] != false || agentMap(session["contextUsage"])["usedTokens"] != float64(36560) {
		t.Fatal("failed summary retained a running indicator or lost its estimate")
	}
}

func TestCanvasAgentContextShowsUpstreamInputTokensWithoutReplacingCompressionEstimate(t *testing.T) {
	for _, field := range []string{"input_tokens", "prompt_tokens"} {
		w := memoryWorker(t, nil)
		counters := map[string]any{"usedTokens": float64(36560), "maxTokens": float64(365600), "compacting": false}
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		w.recordModelInputUsage(map[string]any{"usage": map[string]any{field: float64(41234)}})
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		usage := agentMap(w.session["contextUsage"])
		if usage["inputTokens"] != float64(41234) || usage["usedTokens"] != float64(36560) {
			t.Fatalf("usage lost its actual/estimated distinction: %v", usage)
		}
		counters["usedTokens"] = float64(37000)
		if err := w.updateContextUsage(map[string]any{"contextUsage": counters}); err != nil {
			t.Fatal(err)
		}
		if _, ok := agentMap(w.session["contextUsage"])["inputTokens"]; ok {
			t.Fatal("new model input reused a stale actual count")
		}
	}
}

func TestCanvasAgentSDKPersistsUpstreamInputTokens(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		result := agentTurn()
		result["usage"] = map[string]any{"input_tokens": float64(41234)}
		return result, nil
	}, nil)
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(done, req.SessionID)
	usage := agentMap(session["contextUsage"])
	if done.AgentRun.Status != "success" || usage["inputTokens"] != float64(41234) || usage["usedTokens"] == usage["inputTokens"] {
		t.Fatalf("upstream usage lost across model response and final checkpoint: run=%+v usage=%v", done.AgentRun, usage)
	}
}
