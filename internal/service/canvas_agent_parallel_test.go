package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func parallelAgentWorker(t *testing.T, media CanvasAgentMedia) *canvasAgentWorker {
	t.Helper()
	svc, identity, doc, req := agentFixture(t, nil, media)
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, req.SessionID)
	return &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: doc, req: req, session: session, state: agentMap(session["agentState"])}
}

func parallelImageStep(key string, dependencies ...string) map[string]any {
	if dependencies == nil {
		dependencies = []string{}
	}
	return map[string]any{"key": key, "type": "image", "title": key, "prompt": key, "size": "1:1", "count": 1, "sourceNodeIds": []string{}, "attachmentIds": []string{}, "dependsOn": dependencies}
}

func TestCanvasAgentWorkflowFailureResultCanPersistConversation(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		return nil, errors.New("provider rejected image")
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("failed-image")})
	if err != nil {
		t.Fatal(err)
	}
	w.activeCall = map[string]any{"id": "workflow", "name": "run_canvas_workflow", "arguments": map[string]any{"nodeIds": created["nodeIds"]}}
	result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
	if err != nil || result["ok"] != false {
		t.Fatalf("expected media failure: err=%v", err)
	}
	if _, err := json.Marshal(result); err != nil {
		t.Fatalf("workflow failure cannot be serialized: %v", err)
	}
	w.record(w.activeCall, result)
	if err := w.finish("error", "provider rejected image"); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := agentSession(saved, w.req.SessionID)
	if err != nil || saved.AgentRun == nil || saved.AgentRun.Status != "error" {
		t.Fatalf("failed workflow lost conversation: err=%v run=%+v", err, saved.AgentRun)
	}
	if len(util.AsMapSlice(session["messages"])) != 2 || !strings.Contains(string(saved.AgentSessions), "provider rejected image") {
		t.Fatal("failed workflow lost messages or original error")
	}
}

func TestCanvasAgentUnconfirmedScriptWorkflowKeepsConversation(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		t.Error("unconfirmed script submitted a media task")
		return nil, nil
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("storyboard")})
	if err != nil {
		t.Fatal(err)
	}
	ids := agentStrings(created["nodeIds"])
	w.doc.Nodes = append(w.doc.Nodes, CanvasNode{
		ID: "script", Type: "script", Prompt: "Original story", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
		ScriptProject: &CanvasScriptProject{Step: 2, Shots: []CanvasScriptShot{{ID: "shot", Seconds: 5, Description: "Opening shot", ImageNodeID: ids[0]}}},
	})
	w.activeCall = map[string]any{"id": "workflow", "name": "run_canvas_workflow", "arguments": map[string]any{"nodeIds": ids}}
	result, err := w.runCanvasWorkflow(ids)
	if err != nil || result["code"] != "script_not_confirmed" {
		t.Fatalf("expected unconfirmed script error: err=%v", err)
	}
	w.record(w.activeCall, result)
	if err := w.finish("error", util.Clean(result["message"])); err != nil {
		t.Fatal(err)
	}
	saved, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := agentSession(saved, w.req.SessionID); err != nil || saved.AgentRun == nil || saved.AgentRun.Status != "error" {
		t.Fatalf("blocked workflow lost its conversation: err=%v", err)
	}
}

func TestCanvasAgentWorkflowParallelismAndDependencyInputs(t *testing.T) {
	var active, maximum, firstWave atomic.Int32
	barrier := make(chan struct{})
	var completedMu sync.Mutex
	completed := map[string]bool{}
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		count := active.Add(1)
		defer active.Add(-1)
		for {
			old := maximum.Load()
			if count <= old || maximum.CompareAndSwap(old, count) {
				break
			}
		}
		if n.Title != "poster" {
			if firstWave.Add(1) == 4 {
				close(barrier)
			}
			select {
			case <-barrier:
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(5 * time.Second):
				return nil, errors.New("independent images were executed serially")
			}
		} else {
			completedMu.Lock()
			for _, key := range []string{"front", "open", "side", "back"} {
				if !completed[key] {
					t.Errorf("poster started before %s completed", key)
				}
			}
			completedMu.Unlock()
			want := []string{"/front.png", "/open.png", "/side.png", "/back.png"}
			if !slices.Equal(n.GenerationReferenceURLs, want) {
				t.Errorf("wrong upstream input ordering: %v", n.GenerationReferenceURLs)
			}
		}
		completedMu.Lock()
		completed[n.Title] = true
		completedMu.Unlock()
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}}}, nil
	})
	steps := []map[string]any{}
	for _, key := range []string{"front", "open", "side", "back", "extra"} {
		steps = append(steps, parallelImageStep(key))
	}
	steps = append(steps, parallelImageStep("poster", "front", "open", "side", "back"))
	created, err := w.createGroupedCanvasWorkflow(steps, "产品图")
	if err != nil {
		t.Fatal(err)
	}
	result, err := w.runCanvasWorkflow(agentStrings(created["nodeIds"]))
	if err != nil || result["ok"] != true {
		t.Fatalf("workflow failed: %v %v", result, err)
	}
	if maximum.Load() != 4 || len(completed) != 6 {
		t.Fatalf("parallelism=%d completed=%d", maximum.Load(), len(completed))
	}
	groupID := util.Clean(created["groupId"])
	if groupID == "" {
		t.Fatal("batch was not grouped")
	}
	for _, id := range agentStrings(created["nodeIds"]) {
		if n := w.node(id); n.GroupID != groupID || n.GenerationStatus != "success" {
			t.Fatalf("missing group or result: %+v", n)
		}
	}
	if len(w.doc.Connections) != 4 {
		t.Fatalf("independent nodes should not be connected: %v", w.doc.Connections)
	}
}

func TestCanvasAgentParallelFailureDrainsSubmittedWorkAndBlocksDownstream(t *testing.T) {
	entered := make(chan string, 4)
	release := make(chan struct{})
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		entered <- n.Title
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if n.Title == "front" {
			return nil, errors.New("provider rejected image")
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}}}, nil
	})
	steps := []map[string]any{}
	for _, key := range []string{"front", "open", "side", "back"} {
		steps = append(steps, parallelImageStep(key))
	}
	steps = append(steps, parallelImageStep("poster", "front", "open", "side", "back"))
	created, err := w.createCanvasWorkflow(steps)
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
	for range 4 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("four independent tasks did not start")
		}
	}
	close(release)
	var result map[string]any
	select {
	case result = <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("parallel run did not drain")
	}
	if result["ok"] != false || len(util.AsMapSlice(result["results"])) != 4 {
		t.Fatalf("lost submitted results: %v", result)
	}
	if len(entered) != 0 {
		t.Fatal("downstream was submitted after upstream failed")
	}
	for _, node := range w.doc.Nodes {
		if node.Title == "poster" && node.TaskID != "" {
			t.Fatal("poster was submitted")
		}
		if node.Title != "poster" && node.Title != "front" && node.GenerationStatus != "success" {
			t.Fatal("successful sibling result was lost")
		}
	}
}

func TestCanvasAgentParallelGroupDeletionDoesNotRestoreResults(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, n CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + n.Title + ".png"}, {"url": "/extra.png"}}}, nil
	})
	steps := []map[string]any{}
	for i := 0; i < 4; i++ {
		step := parallelImageStep(fmt.Sprint(i))
		step["count"] = 2
		steps = append(steps, step)
	}
	created, err := w.createGroupedCanvasWorkflow(steps, "四张图")
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
	for range 4 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("parallel tasks did not start")
		}
	}
	// The worker saves concurrently, so a user edit must re-read and retry on a revision conflict.
	for attempt := 0; ; attempt++ {
		current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		current.Nodes, current.Connections = nil, nil
		_, err = w.service.canvas.SaveAtRevision(w.identity.ID, current)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrCanvasRevisionConflict) || attempt >= 20 {
			close(release)
			t.Fatal(err)
		}
	}
	close(release)
	select {
	case result := <-finished:
		if result["code"] != "canvas_changed" {
			t.Fatalf("deletion not recovered: %v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("parallel tasks did not finish")
	}
	if len(w.doc.Nodes) != 0 || len(w.doc.Connections) != 0 {
		t.Fatal("deleted group or outputs were restored")
	}
}

func TestCanvasAgentAdditionalOutputsRetainSourcesAndGroupDeletionScope(t *testing.T) {
	w := parallelAgentWorker(t, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		return map[string]any{"data": []map[string]any{{"url": "/first.png"}, {"url": "/second.png"}}}, nil
	})
	w.doc.Nodes = []CanvasNode{{ID: "source", Type: "image", Title: "原照", URL: "/source.png", GenerationStatus: "success", Width: 360, Height: 360}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	step := parallelImageStep("result")
	step["count"] = 2
	step["sourceNodeIds"] = []string{"source"}
	other := parallelImageStep("other")
	created, err := w.createGroupedCanvasWorkflow([]map[string]any{step, other}, "结果")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.generateNode(agentStrings(created["nodeIds"])[0]); err != nil {
		t.Fatal(err)
	}
	if len(w.doc.Connections) != 2 {
		t.Fatal("additional output has no source edge")
	}
	groupID := util.Clean(created["groupId"])
	for _, edge := range w.doc.Connections {
		if edge.FromNodeID != "source" || w.node(edge.ToNodeID).GroupID != groupID {
			t.Fatal("wrong source or group on extra output")
		}
	}
	deleted := w.deleteNode(groupID)
	if deleted["ok"] != true || len(w.doc.Nodes) != 1 || w.doc.Nodes[0].ID != "source" || len(w.doc.Connections) != 0 {
		t.Fatalf("wrong group removal scope: %v", deleted)
	}
}

func TestCanvasAgentSDKRunsIndependentWorkflowInParallel(t *testing.T) {
	var turns, started atomic.Int32
	barrier := make(chan struct{})
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		switch turns.Add(1) {
		case 1:
			steps := []map[string]any{}
			for i := 0; i < 4; i++ {
				steps = append(steps, parallelImageStep(fmt.Sprint(i)))
			}
			return agentTurn(agentCall("create", "create_canvas_workflow", map[string]any{"groupTitle": "产品图", "steps": steps})), nil
		case 2:
			for _, message := range request.Messages {
				if message["role"] == "tool" {
					var result map[string]any
					if json.Unmarshal([]byte(util.Clean(message["content"])), &result) == nil && len(agentStrings(result["nodeIds"])) == 4 {
						return agentTurn(agentCall("run", "run_canvas_workflow", map[string]any{"nodeIds": result["nodeIds"]})), nil
					}
				}
			}
			return nil, errors.New("SDK did not receive created workflow IDs")
		default:
			return agentTurn(), nil
		}
	}, func(ctx context.Context, _ Identity, node CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		if started.Add(1) == 4 {
			close(barrier)
		}
		select {
		case <-barrier:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
			return nil, errors.New("SDK generation is still serial")
		}
		return map[string]any{"data": []map[string]any{{"url": "/" + node.Title + ".png"}}}, nil
	})
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || started.Load() != 4 || len(done.Nodes) != 5 {
		t.Fatalf("SDK parallel workflow failed: %+v, started=%d nodes=%d", done.AgentRun, started.Load(), len(done.Nodes))
	}
	_, session, _ := agentSession(done, req.SessionID)
	count := 0
	for _, entry := range util.AsMapSlice(util.AsMapSlice(session["messages"])[1]["trace"]) {
		if entry["kind"] == "generate" {
			if entry["status"] != "success" {
				t.Fatal("generation progress was not finalized")
			}
			count++
		}
	}
	if count != 4 {
		t.Fatalf("expected four individual generation progress rows, got %d", count)
	}
}

func TestCanvasAgentPublishesMediaProgressBeforeCompletion(t *testing.T) {
	for _, parallel := range []bool{false, true} {
		t.Run(fmt.Sprintf("parallel-%t", parallel), func(t *testing.T) {
			release := make(chan struct{})
			releaseGeneration := sync.OnceFunc(func() { close(release) })
			defer releaseGeneration()
			w := parallelAgentWorker(t, func(ctx context.Context, _ Identity, node CanvasNode, _ map[string]any, progress func(int) error) (map[string]any, error) {
				if progress != nil {
					if err := progress(37); err != nil {
						return nil, err
					}
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-release:
				}
				return map[string]any{"data": []map[string]any{{"url": "/" + node.ID + ".png"}}}, nil
			})
			steps := []map[string]any{parallelImageStep("first")}
			if parallel {
				steps = append(steps, parallelImageStep("second"))
			}
			created, err := w.createGroupedCanvasWorkflow(steps, "")
			if err != nil {
				t.Fatal(err)
			}
			ids := agentStrings(created["nodeIds"])
			projectID := w.doc.ID
			done := make(chan error, 1)
			go func() {
				var result map[string]any
				var err error
				if parallel {
					result, err = w.runCanvasWorkflow(ids)
				} else {
					result, err = w.generateNode(ids[0])
				}
				if err == nil && result["ok"] != true {
					err = fmt.Errorf("generation failed: %v", result)
				}
				done <- err
			}()
			deadline := time.NewTimer(3 * time.Second)
			defer deadline.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
		published:
			for {
				select {
				case <-deadline.C:
					t.Fatal("in-progress media was not published before completion")
				case err := <-done:
					t.Fatalf("generation finished before release: %v", err)
				case <-ticker.C:
					doc, err := w.service.canvas.Project(w.identity.ID, projectID)
					if err != nil {
						t.Fatal(err)
					}
					count := 0
					for _, node := range doc.Nodes {
						if slices.Contains(ids, node.ID) && node.GenerationProgress == 37 && node.GenerationStatus == "loading" && node.URL == "" {
							count++
						}
					}
					if count == len(ids) {
						break published
					}
				}
			}
			releaseGeneration()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCanvasAgentProgressSaveFailureKeepsOriginalTaskRecoverable(t *testing.T) {
	var w *canvasAgentWorker
	storageFailure := errors.New("progress storage unavailable")
	var firstTaskID string
	w = parallelAgentWorker(t, func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any, progress func(int) error) (map[string]any, error) {
		if firstTaskID != "" {
			if node.TaskID != firstTaskID {
				t.Fatal("progress observer failure caused a new paid task ID")
			}
			return map[string]any{"data": []map[string]any{{"url": "/original-task.png"}}}, nil
		}
		firstTaskID = node.TaskID
		failed := false
		w.service.canvas.store = &countingCanvasDocumentBackend{documents: w.service.canvas.store, saves: map[string]int{}, failSave: func(string) error {
			if !failed {
				failed = true
				return storageFailure
			}
			return nil
		}}
		return nil, progress(37)
	})
	created, err := w.createCanvasWorkflow([]map[string]any{parallelImageStep("progress")})
	if err != nil {
		t.Fatal(err)
	}
	id := agentStrings(created["nodeIds"])[0]
	_, err = w.generateNode(id)
	if !errors.Is(err, storageFailure) {
		t.Fatalf("progress persistence failure not returned: %v", err)
	}
	if node := w.node(id); node.TaskID != firstTaskID || node.GenerationStatus != "loading" || !slices.Contains(agentStrings(w.state["pendingTaskIds"]), firstTaskID) {
		t.Fatalf("observer failure falsely ended the original paid task: node=%+v state=%v", node, w.state)
	}
	if result, err := w.generateNode(id); err != nil || result["ok"] != true || w.node(id).URL != "/original-task.png" {
		t.Fatalf("failed to resume the existing task: result=%v err=%v", result, err)
	}
}
