package service

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"chatgpt2api/internal/util"
)

func runExternalAgentTool(t *testing.T, svc *CanvasAgentService, identity Identity, doc CanvasDocument, req CanvasAgentRequest, id, name string, args map[string]any) CanvasDocument {
	t.Helper()
	req.ID, req.Model, req.RelayTokenName = id, "", ""
	input := CanvasAgentToolRequest{Context: req}
	input.Call.ID, input.Call.Name, input.Call.Arguments = id, name, args
	if _, err := svc.StartTool(identity, doc.ID, input); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Engine != "codex-tools" || done.AgentRun.ToolResult == nil {
		t.Fatalf("missing external tool result: %+v", done.AgentRun)
	}
	return done
}

func TestCanvasAgentExternalVideoSwitchSurvivesStaleClientContext(t *testing.T) {
	generated := 0
	svc, identity, doc, req := agentFixture(t, nil, func(_ context.Context, _ Identity, node CanvasNode, metadata map[string]any, _ func(int) error) (map[string]any, error) {
		generated++
		if node.GenerationVideoModel != "minimax-h3-768p" || node.GenerationVideoAudio == nil || !*node.GenerationVideoAudio || metadata["relay_token_name"] != "h3-token" {
			t.Errorf("new model, audio or model-specific token lost: %+v %v", node, metadata)
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/video.mp4"}}}, nil
	})
	svc.SetVideoModels(canvasAgentTestVideoModels)
	req.Generation["videoModel"] = "seedance2.0-A"
	req.VideoRelayTokens = map[string]string{"minimax-h3-768p": "h3-token", "seedance2.0-A": "other-token"}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "switch-video", "set_video_model", map[string]any{"model": "minimax-h3-768p"})
	if generated != 0 || doc.AgentRun.ToolResult["ok"] != true {
		t.Fatal("switch submitted media or failed", doc.AgentRun.ToolResult)
	}
	req.Generation["videoModel"] = "seedance2.0-A"
	req.Generation["videoSupportsAudio"] = false
	doc = runExternalAgentTool(t, svc, identity, doc, req, "read-video", "get_generation_config", map[string]any{})
	generation := agentMap(doc.AgentRun.ToolResult["generation"])
	if generation["videoModel"] != "minimax-h3-768p" || generation["videoSupportsAudio"] != true {
		t.Fatal("stale client overwrote saved choice", generation)
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "new-video", "generate_video", map[string]any{"prompt": "A speaking character", "sourceNodeIds": []string{}, "size": "16:9", "resolution": "768p", "seconds": 5, "generateAudio": true})
	if generated != 1 || doc.AgentRun.ToolResult["ok"] != true || len(doc.Nodes) != 1 || doc.Nodes[0].GenerationStatus != "success" {
		t.Fatalf("video did not use persisted selection: generated=%d result=%v", generated, doc.AgentRun.ToolResult)
	}
}

func TestCanvasAgentNativeCanSwitchAndGenerateAudibleVideoInSameBatch(t *testing.T) {
	turn, generated := 0, 0
	svc, identity, doc, req := agentFixture(t, func(_ context.Context, _ Identity, request AgentModelRequest) (map[string]any, error) {
		turn++
		if turn == 1 {
			return agentTurn(agentCall("switch", "set_video_model", map[string]any{"model": "minimax-h3-768p"}), agentCall("generate", "generate_video", map[string]any{"prompt": "A speaking character", "sourceNodeIds": []string{}, "size": "16:9", "seconds": 5, "generateAudio": true})), nil
		}
		return agentTurn(), nil
	}, func(_ context.Context, _ Identity, node CanvasNode, metadata map[string]any, _ func(int) error) (map[string]any, error) {
		generated++
		if metadata["media_base_url"] != "https://canvas.example.test" {
			t.Errorf("native generation lost site: %v", metadata)
		}
		if node.GenerationVideoModel != "minimax-h3-768p" || metadata["relay_token_name"] != "h3-token" {
			t.Errorf("native switch did not reach generation: %+v %v", node, metadata)
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/native.mp4"}}}, nil
	})
	req.MediaBaseURL = "https://canvas.example.test"
	svc.SetVideoModels(canvasAgentTestVideoModels)
	req.Generation["videoModel"] = "seedance2.0-A"
	req.VideoRelayTokens = map[string]string{"minimax-h3-768p": "h3-token"}
	if _, err := svc.Start(identity, doc.ID, req); err != nil {
		t.Fatal(err)
	}
	done := agentWait(t, svc, identity, doc.ID)
	if done.AgentRun.Status != "success" || generated != 1 || len(done.Nodes) != 1 || done.Nodes[0].Type != "video" {
		t.Fatalf("native switch/generation failed or created extra audio: %+v, generated=%d", done.AgentRun, generated)
	}
}

func TestCanvasAgentExternalBusinessFailureIsNotReportedAsSuccess(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, nil, nil)
	doc.Nodes = []CanvasNode{{ID: "image", Type: "image", Title: "保留", GenerationStatus: "idle", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	done := runExternalAgentTool(t, svc, identity, doc, req, "invalid-update", "update_text_node", map[string]any{"nodeId": "image", "content": "不能把图片当作文本修改"})
	if done.AgentRun.Status != "error" || done.AgentRun.ToolResult["ok"] != false || done.AgentRun.ToolResult["code"] != "invalid_node_type" {
		t.Fatalf("business failure was hidden: %+v", done.AgentRun)
	}
}

func TestCanvasAgentExternalWorkflowToolsExecuteWithoutModel(t *testing.T) {
	generated := []string{}
	svc, identity, doc, req := agentFixture(t, nil, func(_ context.Context, _ Identity, node CanvasNode, _ map[string]any, _ func(int) error) (map[string]any, error) {
		generated = append(generated, node.Type)
		if node.Type == "video" && !slices.Contains(node.GenerationVideoReferenceImages, "https://example.test/image.png") {
			t.Error("missing generated upstream image")
		}
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/" + node.Type + ".png"}}}, nil
	})
	svc.SetWorkflowService(NewWorkflowService(newTestStorageBackend(t)))
	req.Generation["videoModel"] = "video-test"
	req.Generation["capabilities"].(map[string]any)["video"] = map[string]any{"sizes": []string{"1280x720"}, "audioControl": "optional"}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "save", "save_workflow", map[string]any{"name": "品牌广告", "mode": "single_image", "promptTemplate": "{{brand}} 海报", "variables": []map[string]any{{"key": "brand", "label": "品牌", "required": true, "type": "select", "options": []string{"山野", "星河"}, "placeholder": "选择品牌"}}})
	workflowID := util.Clean(doc.AgentRun.ToolResult["workflowId"])
	if workflowID == "" {
		t.Fatalf("save failed: %v", doc.AgentRun.ToolResult)
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "list", "list_workflows", map[string]any{"keyword": "品牌广告"})
	if len(util.AsMapSlice(doc.AgentRun.ToolResult["workflows"])) != 1 {
		t.Fatal(doc.AgentRun.ToolResult)
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "get", "get_workflow", map[string]any{"workflowId": workflowID})
	if doc.AgentRun.ToolResult["ok"] != true {
		t.Fatal(doc.AgentRun.ToolResult)
	}
	variables := util.AsMapSlice(agentMap(doc.AgentRun.ToolResult["workflow"])["variables"])
	if len(variables) != 1 || variables[0]["type"] != "select" || util.Clean(variables[0]["placeholder"]) != "选择品牌" || len(agentStrings(variables[0]["options"])) != 2 {
		t.Fatalf("workflow variable contract lost through external tools: %v", variables)
	}
	req.MediaChoice = "defer"
	doc = runExternalAgentTool(t, svc, identity, doc, req, "apply", "run_saved_workflow", map[string]any{"workflowId": workflowID, "items": []map[string]any{{"values": []map[string]any{{"key": "brand", "value": "山野"}}, "size": "1:1", "count": 1, "sourceNodeIds": []string{}, "attachmentIds": []string{}}}})
	if len(doc.Nodes) != 1 || len(generated) != 0 {
		t.Fatalf("template execution: %v", doc.AgentRun.ToolResult)
	}
	req.MediaChoice = "generate"
	doc = runExternalAgentTool(t, svc, identity, doc, req, "graph", "create_canvas_workflow", map[string]any{"steps": []map[string]any{
		{"key": "image", "type": "image", "title": "海报", "prompt": "产品广告", "size": "1:1", "count": 1, "dependsOn": []string{}, "sourceNodeIds": []string{}, "attachmentIds": []string{}},
		{"key": "video", "type": "video", "title": "宣传片", "prompt": "展示产品", "size": "1280x720", "seconds": 5, "generateAudio": false, "dependsOn": []string{"image"}, "sourceNodeIds": []string{}, "attachmentIds": []string{}},
	}})
	if len(doc.Nodes) != 3 || len(doc.Connections) != 1 {
		t.Fatalf("graph creation: %v", doc.AgentRun.ToolResult)
	}
	if doc.Nodes[2].Width/doc.Nodes[2].Height != 16.0/9.0 {
		t.Fatalf("video frame does not match workflow ratio: %+v", doc.Nodes[2])
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "execute", "run_canvas_workflow", map[string]any{"nodeIds": []string{doc.Nodes[2].ID}})
	if doc.AgentRun.ToolResult["ok"] != true || !slices.Equal(generated, []string{"image", "video"}) {
		t.Fatalf("execution: %v, %v", generated, doc.AgentRun.ToolResult)
	}
	// The same request is idempotent even after completion.
	doc = runExternalAgentTool(t, svc, identity, doc, req, "execute", "run_canvas_workflow", map[string]any{"nodeIds": []string{doc.Nodes[2].ID}})
	if len(generated) != 2 {
		t.Fatal("duplicate request regenerated media")
	}
}

func TestCanvasAgentExternalReviewRequiresCurrentPromptsAndExplicitAnswer(t *testing.T) {
	var generated int
	svc, identity, doc, req := agentFixture(t, nil, func(context.Context, Identity, CanvasNode, map[string]any, func(int) error) (map[string]any, error) {
		generated++
		return map[string]any{"data": []map[string]any{{"url": "https://example.test/result.png"}}}, nil
	})
	node := CanvasNode{ID: "draft", Type: "image", Title: "系列海报", Prompt: "春季商品", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, GenerationModel: "image-test", GenerationSize: "1:1", GenerationCount: 1, GenerationStatus: "idle"}
	doc.Nodes = []CanvasNode{node}
	sessions, session, _ := agentSession(doc, req.SessionID)
	agentMap(session["agentState"])["pendingWorkflowReview"] = map[string]any{"nodeIds": []string{node.ID}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	var err error
	doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"nodeIds": []string{node.ID}}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "unapproved", "run_canvas_workflow", args)
	if generated != 0 || doc.AgentRun.ToolResult["requiresUserReview"] != true {
		t.Fatal(doc.AgentRun.ToolResult)
	}
	answer := CanvasAgentWorkflowReviewAnswer{SessionID: req.SessionID, Prompts: map[string]string{node.ID: canvasAgentWorkflowFingerprint(node)}, Answer: "暂不生成，修改提示词"}
	doc, err = svc.AnswerWorkflowReview(identity, doc.ID, answer)
	if err != nil {
		t.Fatal(err)
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "declined", "run_canvas_workflow", args)
	if generated != 0 {
		t.Fatal("generated after denial")
	}
	answer.Answer = "确认审核并生成"
	answer.Prompts[node.ID] = "stale"
	if _, err = svc.AnswerWorkflowReview(identity, doc.ID, answer); err == nil {
		t.Fatal("stale approval accepted")
	}
	answer.Prompts[node.ID] = canvasAgentWorkflowFingerprint(node)
	if _, err = svc.AnswerWorkflowReview(Identity{ID: "other"}, doc.ID, answer); err == nil {
		t.Fatal("cross-owner approval accepted")
	}
	if _, err = svc.AnswerWorkflowReview(identity, doc.ID, answer); err != nil {
		t.Fatal(err)
	}
	doc = runExternalAgentTool(t, svc, identity, doc, req, "approved", "run_canvas_workflow", args)
	if generated != 1 || doc.AgentRun.ToolResult["ok"] != true {
		t.Fatal(doc.AgentRun.ToolResult)
	}
}

func TestCanvasAgentExternalToolRejectsInvalidCallsAndNativeInterruptions(t *testing.T) {
	svc, identity, doc, req := agentFixture(t, nil, nil)
	for index, name := range []string{"unknown_tool", "delete_node", "ask_user_question", "read_skill_file", "create_text_node"} {
		input := CanvasAgentToolRequest{Context: req}
		input.Call.ID, input.Call.Name, input.Call.Arguments = fmt.Sprint(index), name, map[string]any{}
		if _, err := svc.StartTool(identity, doc.ID, input); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	doc.AgentRun = &CanvasAgentRun{ID: "native", SessionID: req.SessionID, AssistantID: req.AssistantID, Status: "waiting", Engine: "openai-agents-sdk", SDKState: "pending-sdk-state"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	input := CanvasAgentToolRequest{Context: req}
	input.Call.ID, input.Call.Name, input.Call.Arguments = "read", "get_canvas_summary", map[string]any{}
	if _, err = svc.StartTool(identity, doc.ID, input); err == nil {
		t.Fatal("native interruption overwritten")
	}
	if _, err = svc.StartTool(Identity{ID: "other"}, doc.ID, input); err == nil {
		t.Fatal("cross-owner tool accepted")
	}
}

func TestCanvasAgentExternalArrangeRequiresDirectRequest(t *testing.T) {
	for _, text := range []string{"不整理画布，只回答问题", "不能整理画布", "解释一下整理画布功能", "请整理画布"} {
		t.Run(text, func(t *testing.T) {
			svc, identity, doc, req := agentFixture(t, nil, nil)
			req.UserText = text
			doc.Nodes = []CanvasNode{{ID: "a", Type: "text", X: 999, Y: 888, Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
			var err error
			doc, err = svc.canvas.SaveAtRevision(identity.ID, doc)
			if err != nil {
				t.Fatal(err)
			}
			done := runExternalAgentTool(t, svc, identity, doc, req, "arrange", "arrange_nodes", map[string]any{})
			if text == "请整理画布" {
				if done.AgentRun.Status != "success" || done.Nodes[0].X != 0 || done.Nodes[0].Y != 0 {
					t.Fatalf("authorized arrange failed: run=%+v position=(%v,%v)", done.AgentRun, done.Nodes[0].X, done.Nodes[0].Y)
				}
			} else if done.AgentRun.ToolResult["code"] != "action_not_requested" || done.Nodes[0].X != 999 || done.Nodes[0].Y != 888 {
				t.Fatalf("unauthorized arrange persisted: run=%+v position=(%v,%v)", done.AgentRun, done.Nodes[0].X, done.Nodes[0].Y)
			}
		})
	}
}
