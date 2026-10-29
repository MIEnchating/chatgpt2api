package service

import (
	"context"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentTimingExcludesWaitingAndFreezesAtCompletion(t *testing.T) {
	message := map[string]any{}
	setCanvasAgentProcessing(message, true, time.UnixMilli(1000))
	setCanvasAgentProcessing(message, true, time.UnixMilli(76000))
	if message["elapsedMs"] != int64(75000) {
		t.Fatal(message)
	}
	setCanvasAgentProcessing(message, false, time.UnixMilli(81000))
	setCanvasAgentProcessing(message, false, time.UnixMilli(900000))
	if message["elapsedMs"] != int64(80000) || message["processingStartedAt"] != nil {
		t.Fatal(message)
	}
	setCanvasAgentProcessing(message, true, time.UnixMilli(1000000))
	setCanvasAgentProcessing(message, false, time.UnixMilli(1005000))
	if message["elapsedMs"] != int64(85000) {
		t.Fatal(message)
	}
}

func TestCanvasAgentTimingSavedOnNativeCompletionAndToolHandoff(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error) {
		return agentTurn(), nil
	}, nil)
	started, err := svc.Start(identity, doc.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(started, req.SessionID)
	if util.ToInt(util.AsMapSlice(session["messages"])[1]["processingStartedAt"], 0) <= 0 {
		t.Fatal("start time not persisted")
	}
	done := agentWait(t, svc, identity, doc.ID)
	_, session, _ = agentSession(done, req.SessionID)
	message := util.AsMapSlice(session["messages"])[1]
	if message["processingStartedAt"] != nil || message["elapsedMs"] == nil {
		t.Fatal("completed timer still active", message)
	}
	done = runExternalAgentTool(t, svc, identity, done, req, "tool", "get_canvas_summary", map[string]any{})
	_, session, _ = agentSession(done, req.SessionID)
	if util.AsMapSlice(session["messages"])[1]["processingStartedAt"] == nil {
		t.Fatal("Codex tool handoff prematurely ended the turn timer")
	}
}
