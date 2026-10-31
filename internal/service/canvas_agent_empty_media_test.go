package service

import (
	"context"
	"slices"
	"testing"
)

// A media task without a usable URL must fail the node and release its pending task.
func TestCanvasAgentFinishGenerationRejectsMissingMediaURL(t *testing.T) {
	cases := map[string]map[string]any{
		"no data":                 {"data": []map[string]any{}},
		"item without url":        {"data": []map[string]any{{"width": 1}}},
		"second item without url": {"data": []map[string]any{{"url": "/a.png"}, {"width": 1}}},
	}
	for name, task := range cases {
		t.Run(name, func(t *testing.T) {
			w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
				return task, nil
			})
			created, err := w.createGroupedCanvasWorkflow([]map[string]any{parallelImageStep("solo"), parallelImageStep("other")}, "empty media")
			if err != nil {
				t.Fatal(err)
			}
			id := agentStrings(created["nodeIds"])[0]
			result, err := w.generateNode(id)
			if err != nil || result["ok"] == true || result["code"] != "empty_media" {
				t.Fatalf("expected empty_media failure, got %v %v", result, err)
			}
			n := w.node(id)
			if n.GenerationStatus != "error" || n.GenerationError == "" || n.URL != "" {
				t.Fatalf("node must be failed without a partial result: %+v", n)
			}
			if slices.Contains(agentStrings(w.state["pendingTaskIds"]), n.TaskID) {
				t.Fatalf("pending task was not released: %v", w.state["pendingTaskIds"])
			}
		})
	}
}
