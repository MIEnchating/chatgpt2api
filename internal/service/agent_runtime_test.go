package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestAgentModelRetryClassification(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{errors.New("stream error: stream ID 127; INTERNAL_ERROR; received from peer"), true},
		{fmt.Errorf("read: %w", io.ErrUnexpectedEOF), true},
		{protocol.HTTPError{Status: 503, Message: "unavailable"}, true},
		{protocol.HTTPError{Status: 429, Message: "limited"}, true},
		{protocol.HTTPError{Status: 400, Message: "invalid parameter"}, false},
		{protocol.HTTPError{Status: 401, Message: "unauthorized"}, false},
		{AgentModelStreamError{Err: errors.New("missing terminal event")}, true},
		{AgentModelStreamError{Err: protocol.HTTPError{Status: 401, Message: "unauthorized"}}, false},
		{AgentModelStreamError{Err: context.Canceled}, false},
		{AgentModelStreamError{Err: context.DeadlineExceeded}, false},
		{AgentModelStreamError{Err: ErrAgentProgressPersistence}, false},
		{context.Canceled, false}, {context.DeadlineExceeded, false},
		{errors.New("checkpoint write failed"), false},
		{fmt.Errorf("%w: %w", ErrAgentProgressPersistence, syscall.ECONNRESET), false},
	} {
		if got := AgentModelRetryable(tc.err); got != tc.want {
			t.Errorf("%v: got %v", tc.err, got)
		}
	}
}

func TestAgentSDKHistoryDeadlineDoesNotAcknowledgeTransactionAndRetryIsIdempotent(t *testing.T) {
	session := &AgentSDKSession{
		Items: []map[string]any{{"role": "user", "content": "original request"}},
		State: `{"status":"waiting"}`,
	}
	params := map[string]any{
		"action": "transaction", "operationId": "save-tool-result",
		"transaction": map[string]any{
			"type":  "append_items",
			"items": []map[string]any{{"role": "tool", "content": "already-submitted-task"}},
		},
	}
	before := agentJSON(session)
	_, err := ApplyAgentSDKSession(session, params, func(*AgentSDKSession) error {
		return fmt.Errorf("checkpoint save: %w", context.DeadlineExceeded)
	})
	if !errors.Is(err, context.DeadlineExceeded) || agentJSON(session) != before {
		t.Fatalf("failed save changed checkpoint: session=%s err=%v", agentJSON(session), err)
	}
	saves := 0
	var durable string
	for range 2 {
		if _, err := ApplyAgentSDKSession(session, params, func(next *AgentSDKSession) error {
			saves++
			durable = agentJSON(next)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if saves != 1 || len(session.Items) != 2 || durable != agentJSON(session) {
		t.Fatalf("retry duplicated or lost history: saves=%d session=%s durable=%s", saves, agentJSON(session), durable)
	}
}
