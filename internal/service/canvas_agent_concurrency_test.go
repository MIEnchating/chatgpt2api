package service

import (
	"context"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentGenerationChangeDetailsContainFieldNamesWithoutValues(t *testing.T) {
	before := CanvasDocument{Nodes: []CanvasNode{{ID: "image", Type: "image", Prompt: "private original"}, {ID: "reference", Type: "image", URL: "https://private.example/original"}}, Connections: []CanvasConnection{{ID: "edge", FromNodeID: "reference", ToNodeID: "image"}}}
	after := cloneCanvasAgentDocument(before)
	after.Nodes[0].Prompt = "private changed"
	after.Nodes[1].URL = "https://private.example/changed"
	details := canvasAgentGenerationChanges(before, after, "image")
	for _, expected := range []string{"image.prompt", "reference.url"} {
		if !slices.Contains(details, expected) {
			t.Fatalf("missing field %s in %v", expected, details)
		}
	}
	if strings.Contains(strings.Join(details, ","), "private") {
		t.Fatal("generation diagnostic leaked field values")
	}
}

func TestCanvasAgentGenerationPreservesConcurrentPresentationEdits(t *testing.T) {
	for _, target := range []string{"target", "source"} {
		for _, change := range []string{"title", "group"} {
			t.Run(target+"-"+change, func(t *testing.T) {
				var w *canvasAgentWorker
				submissions := 0
				w = parallelAgentWorker(t, func(_ context.Context, _ Identity, _ CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
					submissions++
					current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
					if err != nil {
						return nil, err
					}
					for i := range current.Nodes {
						if current.Nodes[i].ID == target {
							if change == "title" {
								current.Nodes[i].Title = "Renamed during generation"
							} else {
								current.Nodes[i].GroupID = "group"
							}
						}
					}
					if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
						return nil, err
					}
					return map[string]any{"data": []map[string]any{{"url": "/generated.mp4"}}}, nil
				})
				w.doc.Nodes = []CanvasNode{
					{ID: "target", Type: "video", Title: "Video", Width: 360, Height: 360, Prompt: "Continue the scene", GenerationVideoModel: "video-test", GenerationVideoSeconds: 5, GenerationVideoReferenceImages: []string{"/reference.png"}},
					{ID: "source", Type: "image", Title: "Reference", Width: 360, Height: 360, URL: "/reference.png", GenerationStatus: "success"},
					{ID: "group", Type: "group", Width: 800, Height: 500},
				}
				w.doc.Connections = []CanvasConnection{{ID: "reference", FromNodeID: "source", ToNodeID: "target"}}
				if err := w.save(); err != nil {
					t.Fatal(err)
				}
				result, err := w.generateNode("target")
				if err != nil || result["ok"] != true || submissions != 1 {
					t.Fatalf("presentation edit discarded a valid result: result=%v err=%v submissions=%d", result, err, submissions)
				}
				if err := w.save(); err != nil {
					t.Fatal(err)
				}
				if w.node("target").URL != "/generated.mp4" || w.node("target").GenerationStatus != "success" || len(agentStrings(w.state["detachedTaskIds"])) != 0 {
					t.Fatal("generation output was detached or lost during the final save")
				}
				if change == "title" && w.node(target).Title != "Renamed during generation" || change == "group" && w.node(target).GroupID != "group" {
					t.Fatal("concurrent presentation edit was lost")
				}
				before := cloneCanvasAgentDocument(w.doc)
				for i := range before.Nodes {
					if before.Nodes[i].ID == target {
						if change == "title" {
							before.Nodes[i].Title = "Previous title"
						} else {
							before.Nodes[i].GroupID = ""
						}
					}
				}
				if !canvasAgentContentChanged(before, w.doc) {
					t.Fatal("presentation edit bypassed the general instruction conflict check")
				}
				if canvasAgentGenerationInputFingerprint(before, "target") != canvasAgentGenerationInputFingerprint(w.doc, "target") {
					t.Fatal("presentation edit invalidated a persisted generation checkpoint")
				}
				if fields := canvasAgentGenerationChanges(before, w.doc, "target"); len(fields) != 0 {
					t.Fatalf("presentation edit reported as changed generation fields: %v", fields)
				}
			})
		}
	}
}

func TestCanvasAgentGenerationIgnoresScriptNavigationAndReviews(t *testing.T) {
	before := CanvasDocument{Nodes: []CanvasNode{
		{ID: "script", Type: "script", ScriptProject: &CanvasScriptProject{Confirmed: true, Shots: []CanvasScriptShot{{ID: "shot", Seconds: 15, Description: "A knock at the door", VideoNodeID: "video"}}}},
		{ID: "video", Type: "video", Prompt: "A knock at the door", GenerationVideoSeconds: 15},
	}, Connections: []CanvasConnection{{ID: "script-video", FromNodeID: "script", ToNodeID: "video"}}}
	for _, change := range []string{"navigation", "color", "review", "merged-result", "content", "confirmation"} {
		t.Run(change, func(t *testing.T) {
			after := cloneCanvasAgentDocument(before)
			script := after.Nodes[0].ScriptProject
			switch change {
			case "navigation":
				script.Step = 2
			case "review":
				script.Shots[0].QualityReview = &CanvasScriptQualityReview{MediaURL: "/previous.mp4", Continuity: "needs_fix", Dialogue: "unchecked", Speaker: "unchecked", LipSync: "unchecked", Notes: "Review of a previous result"}
			case "color":
				script.Shots[0].Color = "#4bb7ef"
			case "merged-result":
				script.MergedVideoNodeID = "existing-movie"
				script.MergedVideoFingerprint = "fingerprint"
				script.MergedVideoOutdated = true
			case "content":
				script.Shots[0].Description = "A different scene"
			case "confirmation":
				script.Confirmed = false
			}
			wantChanged := change == "content" || change == "confirmation"
			if contentChanged := canvasAgentContentChanged(before, after); contentChanged != (change != "navigation" && change != "color") {
				t.Fatal("script navigation triggered replanning or an actual content/review edit was ignored")
			}
			if changed := canvasAgentGenerationChanged(before, after, "video"); changed != wantChanged {
				t.Fatalf("generation changed = %v, want %v; fields=%v", changed, wantChanged, canvasAgentGenerationChanges(before, after, "video"))
			}
			if sameFingerprint := canvasAgentGenerationInputFingerprint(before, "video") == canvasAgentGenerationInputFingerprint(after, "video"); sameFingerprint == wantChanged {
				t.Fatal("checkpoint fingerprint disagrees with the generation content check")
			}
		})
	}
	if before.Nodes[0].ScriptProject.Step != 0 || before.Nodes[0].ScriptProject.Shots[0].QualityReview != nil {
		t.Fatal("generation comparison mutated the saved script")
	}
}

func TestCanvasAgentReplansAfterConcurrentModelEdit(t *testing.T) {
	for _, change := range []string{"delete", "content", "move", "arrange"} {
		t.Run(change, func(t *testing.T) {
			var svc *CanvasAgentService
			var identity Identity
			var doc CanvasDocument
			var req CanvasAgentRequest
			var turns atomic.Int32
			svc, identity, doc, req = agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
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
				if change != "move" && change != "arrange" && !strings.Contains(agentJSON(r.Messages), "画布状态与执行快照不一致") {
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
			svc, identity, doc, req = agentFixture(t, func(_ context.Context, _ Identity, r AgentModelRequest) (map[string]any, error) {
				if turns.Add(1) == 1 {
					return agentTurn(agentCall("generate", "generate_node", map[string]any{"nodeId": "target"}), agentCall("later", "create_text_node", map[string]any{"title": "later", "content": "next step"})), nil
				}
				if change != "move" && !strings.Contains(agentJSON(r.Messages), "canvas_changed") {
					t.Error("generation conflict not delivered to model")
				}
				return agentTurn(), nil
			}, func(_ context.Context, _ Identity, _ CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
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

func TestCanvasAgentGenerationIgnoresAutomaticMediaMetadata(t *testing.T) {
	for _, metadata := range []string{"bytes", "duration", "thumbnail"} {
		t.Run(metadata, func(t *testing.T) {
			var w *canvasAgentWorker
			submissions := 0
			w = parallelAgentWorker(t, func(_ context.Context, _ Identity, _ CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
				submissions++
				current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
				if err != nil {
					return nil, err
				}
				switch metadata {
				case "bytes":
					current.Nodes[1].Bytes = 123456
				case "duration":
					current.Nodes[1].DurationMS = 5000
				case "thumbnail":
					current.Nodes[1].ThumbnailURL = "/preview.png"
				}
				if _, err := w.service.canvas.SaveAtRevision(w.identity.ID, current); err != nil {
					return nil, err
				}
				return map[string]any{"data": []map[string]any{{"url": "/generated.mp4"}}}, nil
			})
			w.doc.Nodes = []CanvasNode{
				{ID: "target", Type: "video", Width: 360, Height: 360, Prompt: "Continue the scene", GenerationVideoModel: "video-test", GenerationVideoSeconds: 5, GenerationVideoReferenceImages: []string{"/reference.png"}},
				{ID: "source", Type: "image", Width: 360, Height: 360, URL: "/reference.png", GenerationStatus: "success"},
			}
			w.doc.Connections = []CanvasConnection{{ID: "reference", FromNodeID: "source", ToNodeID: "target"}}
			if err := w.save(); err != nil {
				t.Fatal(err)
			}
			before := cloneCanvasAgentDocument(w.doc)
			result, err := w.generateNode("target")
			if err != nil || result["ok"] != true || w.canvasChanged || submissions != 1 {
				t.Fatalf("automatic metadata discarded a valid result: result=%v err=%v changed=%v submissions=%d", result, err, w.canvasChanged, submissions)
			}
			if err := w.save(); err != nil {
				t.Fatal(err)
			}
			if w.node("target").URL != "/generated.mp4" || w.node("target").GenerationStatus != "success" || len(agentStrings(w.state["detachedTaskIds"])) != 0 {
				t.Fatal("generation output was detached or lost during the final save")
			}
			source := w.node("source")
			if metadata == "bytes" && source.Bytes != 123456 || metadata == "duration" && source.DurationMS != 5000 || metadata == "thumbnail" && source.ThumbnailURL != "/preview.png" {
				t.Fatal("automatic metadata was lost during the final save")
			}
			before.Nodes[0] = w.doc.Nodes[0]
			if canvasAgentGenerationInputFingerprint(before, "target") != canvasAgentGenerationInputFingerprint(w.doc, "target") {
				t.Fatal("automatic metadata invalidated a persisted generation checkpoint")
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
	svc, identity, doc, req := agentFixture(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
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
	svc, identity, doc, req := agentFixture(t, nil, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
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
