package service

import (
	"context"
	"testing"
	"time"
)

func TestCanvasAgentParallelMediaPanicBecomesFailureInsteadOfHanging(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
		panic("provider client crashed")
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("front")})
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan map[string]any, 1)
	go func() {
		result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
		if err != nil {
			result = agentError("test_error", err.Error())
		}
		finished <- result
	}()
	select {
	case result := <-finished:
		if result["ok"] != false {
			t.Fatalf("a panicking generation must be reported as a failure: %v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workflow hung after the media generation panicked")
	}
}
