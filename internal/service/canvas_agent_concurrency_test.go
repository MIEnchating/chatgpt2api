package service

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentReplansAfterConcurrentModelEdit(t *testing.T) {
	for _, change := range []string{"delete", "content", "move", "arrange"} {
		t.Run(change, func(t *testing.T) {
			var svc *CanvasAgentService
			var identity Identity
			var doc CanvasDocument
			var req CanvasAgentRequest
			var turns atomic.Int32
			svc, identity, doc, req = agentFixture(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
				if turns.Add(1) == 1 {
					current, err := svc.canvas.Project(identity.ID, doc.ID)
					if err != nil {
						return nil, err
					}
					switch change {
					case "delete":
						current.Nodes = nil
					case "content":
						current.Nodes[0].Prompt = "user content"
					case "move", "arrange":
						current.Nodes[0].X = 800
					}
					if _, err = svc.canvas.SaveAtRevision(identity.ID, current); err != nil {
						return nil, err
					}
					if change == "arrange" {
						return agentTurn(agentCall("stale", "arrange_nodes", map[string]any{"nodeIds": []string{"target"}})), nil
					}
					return agentTurn(agentCall("stale", "update_text_node", map[string]any{"nodeId": "target", "content": "model content"})), nil
				}
				if change != "move" && change != "arrange" && !strings.Contains(agentJSON(r.Messages), "用户刚刚修改了画布") {
					t.Error("model did not receive the canvas change")
				}
				return agentTurn(), nil
			}, nil)
			if change == "arrange" {
				req.UserText = "整理画布"
			}
			doc.Nodes = []CanvasNode{{ID: "target", Type: "text", Width: 360, Height: 360, Prompt: "original"}}
			if _, err := svc.canvas.SaveAtRevision(identity.ID, doc); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			if done.AgentRun.Status != "success" {
				t.Fatalf("run failed: %+v", done.AgentRun)
			}
			switch change {
			case "delete":
				if len(done.Nodes) != 0 {
					t.Fatal("deleted node restored")
				}
			case "content":
				if done.Nodes[0].Prompt != "user content" {
					t.Fatal("user content overwritten")
				}
			case "move":
				if done.Nodes[0].X != 800 || done.Nodes[0].Prompt != "model content" {
					t.Fatal("layout edit blocked work or was lost")
				}
			case "arrange":
				if done.Nodes[0].X != 800 || !strings.Contains(string(done.AgentSessions), "canvas_changed") {
					t.Fatal("stale arrangement overwrote the user's new position")
				}
			}
		})
	}
}

func TestCanvasAgentGenerationPreservesConcurrentUserChanges(t *testing.T) {
	for _, change := range []string{"delete", "content", "move", "unrelated", "upstream", "replace"} {
		t.Run(change, func(t *testing.T) {
			var svc *CanvasAgentService
			var identity Identity
			var doc CanvasDocument
			var req CanvasAgentRequest
			var turns, submissions atomic.Int32
			svc, identity, doc, req = agentFixture(t, func(_ context.Context, _ Identity, r CanvasAgentModelRequest) (map[string]any, error) {
				if turns.Add(1) == 1 {
					return agentTurn(agentCall("generate", "generate_node", map[string]any{"nodeId": "target"}), agentCall("later", "create_text_node", map[string]any{"title": "later", "content": "next step"})), nil
				}
				if change != "move" && !strings.Contains(agentJSON(r.Messages), "canvas_changed") {
					t.Error("generation conflict not delivered to model")
				}
				return agentTurn(), nil
			}, func(_ context.Context, _ Identity, _ CanvasNode, _ map[string]any) (map[string]any, error) {
				submissions.Add(1)
				current, err := svc.canvas.Project(identity.ID, doc.ID)
				if err != nil {
					return nil, err
				}
				switch change {
				case "delete":
					current.Nodes = current.Nodes[1:]
					current.Connections = nil
				case "content":
					current.Nodes[0].Prompt = "user content"
				case "replace":
					current.Nodes[0].URL, current.Nodes[0].GenerationStatus = "/user.png", "success"
				case "move":
					current.Nodes[0].X = 800
				case "unrelated", "upstream":
					current.Nodes[1].Prompt = "user changed text"
				}
				if _, err = svc.canvas.SaveAtRevision(identity.ID, current); err != nil {
					return nil, err
				}
				return map[string]any{"data": []map[string]any{{"url": "/generated.png"}, {"url": "/generated-2.png"}}}, nil
			})
			doc.Nodes = []CanvasNode{
				{ID: "target", Type: "image", Width: 360, Height: 360, Prompt: "original", GenerationModel: "image-test", GenerationCount: 2, GenerationSize: "1:1"},
				{ID: "text", Type: "text", Width: 360, Height: 360, Prompt: "original text"},
			}
			if change == "upstream" {
				doc.Connections = []CanvasConnection{{ID: "edge", FromNodeID: "text", ToNodeID: "target"}}
			}
			if _, err := svc.canvas.SaveAtRevision(identity.ID, doc); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Start(identity, doc.ID, req); err != nil {
				t.Fatal(err)
			}
			done := agentWait(t, svc, identity, doc.ID)
			if done.AgentRun.Status != "success" || submissions.Load() != 1 {
				t.Fatalf("run status or duplicate submission: %+v, %d", done.AgentRun, submissions.Load())
			}
			for _, n := range done.Nodes {
				if change != "move" && n.Title == "later" {
					t.Fatal("stale batch continued after canvas change")
				}
				if change == "delete" && n.Type == "image" {
					t.Fatal("deleted target or extra outputs restored")
				}
				if (change == "content" || change == "upstream") && n.Type == "image" && (n.URL != "" || n.GenerationStatus == "loading") {
					t.Fatal("stale media was applied or target left loading")
				}
			}
			if change == "move" && (done.Nodes[0].X != 800 || done.Nodes[0].URL != "/generated.png") {
				t.Fatal("moving a node interrupted generation")
			}
			if change == "unrelated" && done.Nodes[0].URL != "/generated.png" {
				t.Fatal("unrelated edit discarded the valid media result")
			}
			if change == "content" && done.Nodes[0].Prompt != "user content" {
				t.Fatal("user prompt lost")
			}
			if change == "replace" && (done.Nodes[0].URL != "/user.png" || done.Nodes[0].GenerationStatus != "success") {
				t.Fatal("user replacement or its status was overwritten")
			}
			_, session, _ := agentSession(done, "session")
			for _, m := range util.AsMapSlice(session["messages"]) {
				for _, trace := range util.AsMapSlice(m["trace"]) {
					if trace["status"] == "error" {
						t.Fatalf("concurrent edit displayed as failure: %v", trace)
					}
				}
			}
		})
	}
}

func TestCanvasAgentMergeDoesNotDeleteConcurrentlyEditedNode(t *testing.T) {
	base := DefaultCanvasDocument()
	base.Nodes = []CanvasNode{{ID: "target", Type: "text", Prompt: "original"}}
	edited := cloneCanvasAgentDocument(base)
	edited.Nodes = nil
	current := cloneCanvasAgentDocument(base)
	current.Nodes[0].Prompt = "user content"
	merged := mergeCanvasAgentDocument(base, edited, current)
	if len(merged.Nodes) != 1 || merged.Nodes[0].Prompt != "user content" {
		t.Fatal("worker deletion discarded the user's concurrent edit")
	}
}

func TestCanvasAgentMergeRejectsLateGenerationConflict(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		base := DefaultCanvasDocument()
		base.Nodes = []CanvasNode{{ID: "target", Type: "image", Prompt: "original", TaskID: "task", GenerationStatus: "loading"}}
		edited := cloneCanvasAgentDocument(base)
		edited.Nodes[0].URL, edited.Nodes[0].GenerationStatus = "/generated.png", "success"
		child := edited.Nodes[0]
		child.ID = "extra-output"
		edited.Nodes = append(edited.Nodes, child)
		current := cloneCanvasAgentDocument(base)
		if deleted {
			current.Nodes = nil
		} else {
			current.Nodes[0].Prompt = "user content"
		}
		merged := mergeCanvasAgentDocument(base, edited, current)
		if deleted && len(merged.Nodes) != 0 {
			t.Fatal("late deletion resurrected additional generated outputs")
		}
		if !deleted && (len(merged.Nodes) != 1 || merged.Nodes[0].URL != "" || merged.Nodes[0].Prompt != "user content" || merged.Nodes[0].GenerationStatus == "loading") {
			t.Fatal("late prompt change received stale generation output")
		}
	}
}

func TestCanvasAgentDeleteApprovalExpiresWhenNodeChanges(t *testing.T) {
	var turns atomic.Int32
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, CanvasAgentModelRequest) (map[string]any, error) {
		if turns.Add(1) == 1 {
			return agentTurn(agentCall("delete", "delete_node", map[string]any{"nodeId": "target"})), nil
		}
		return agentTurn(), nil
	}, nil)
	doc.Nodes = []CanvasNode{{ID: "target", Type: "text", Title: "产品文案", Width: 360, Height: 360, Prompt: "original"}}
	if _, err := svc.canvas.SaveAtRevision(identity.ID, doc); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	waiting := agentWait(t, svc, identity, doc.ID)
	_, session, _ := agentSession(waiting, req.SessionID)
	question := util.Clean(agentMap(agentMap(session["agentState"])["pendingQuestion"])["question"])
	if !strings.Contains(question, "产品文案") || strings.Contains(question, "target") {
		t.Fatalf("delete question exposed an internal ID: %s", question)
	}
	waiting.Nodes[0].Prompt = "user content"
	if _, err := svc.canvas.SaveAtRevision(identity.ID, waiting); err != nil {
		t.Fatal(err)
	}
	req.ID, req.UserText = "answer", "确认删除"
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || len(done.Nodes) != 1 || done.Nodes[0].Prompt != "user content" || !strings.Contains(string(done.AgentSessions), "canvas_changed") {
		t.Fatal("old approval deleted a changed node")
	}
}

func TestCanvasAgentPreSubmissionConflictPreservesExistingTask(t *testing.T) {
	var submissions atomic.Int32
	svc, identity, doc, req := agentFixture(t, nil, func(context.Context, Identity, CanvasNode, map[string]any) (map[string]any, error) {
		submissions.Add(1)
		return map[string]any{}, nil
	})
	doc.Nodes = []CanvasNode{{ID: "target", Type: "image", Width: 360, Height: 360, Prompt: "original", TaskID: "existing-task", GenerationStatus: "loading", GenerationSize: "1:1", GenerationCount: 1}}
	doc.AgentRun = &CanvasAgentRun{ID: req.ID, SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, session, _ := agentSession(doc, req.SessionID)
	w := &canvasAgentWorker{persisted: cloneCanvasAgentDocument(doc), service: svc, ctx: context.Background(), identity: identity, doc: cloneCanvasAgentDocument(doc), req: req, session: session, state: agentMap(session["agentState"])}
	w.state["pendingTaskIds"] = []string{"existing-task"}
	doc.Nodes[0].Prompt = "user content"
	if _, err := svc.canvas.SaveAtRevision(identity.ID, doc); err != nil {
		t.Fatal(err)
	}
	result, err := w.generateNode("target")
	if err != nil || result["code"] != "canvas_changed" || submissions.Load() != 0 || w.node("target").TaskID != "existing-task" || w.node("target").Prompt != "user content" || len(agentStrings(w.state["pendingTaskIds"])) != 1 {
		t.Fatalf("pre-submission conflict lost task identity or submitted stale request: %v %v", result, err)
	}
}
