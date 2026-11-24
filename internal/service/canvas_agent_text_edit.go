package service

import (
	"errors"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
	"github.com/google/uuid"
)

var errCanvasTextEditStale = errors.New("文本修改提案对应的节点已变化")

const canvasTextEditProposalLimit = 32

func canvasTextEditRevision(node CanvasNode) string {
	return canvasAgentReviewRevision(agentJSON([]any{node.ID, node.Type, node.Title, node.Prompt, node.ComposerContent, node.GenerationStatus == "loading"}))
}

func canvasScriptShotRevision(node CanvasNode, shotID string) string {
	if node.Type != "script" || node.ScriptProject == nil {
		return ""
	}
	for _, shot := range node.ScriptProject.Shots {
		if shot.ID == shotID {
			shot.Color = ""
			shot.QualityReview = nil
			return canvasAgentReviewRevision(agentJSON([]any{node.ID, node.Title, shot}))
		}
	}
	return ""
}

func canvasTextTaskNodeRevision(doc CanvasDocument, node CanvasNode) string {
	switch node.Type {
	case "script":
		return canvasAgentReviewRevision(agentJSON([]any{canvasScriptConfirmationFingerprint(node), node.GenerationStatus == "loading", node.ScriptOperation}))
	case "image", "video", "audio":
		return canvasAgentReviewRevision(agentJSON([]any{node.Title, node.ScriptOperation, canvasAgentGenerationInputFingerprint(doc, node.ID)}))
	default:
		return canvasTextEditRevision(node)
	}
}

func canvasTextTaskTargetKey(task map[string]any) string {
	return util.Clean(task["nodeId"]) + "\x00" + util.Clean(task["shotId"])
}

func canvasTextTaskTargetRevision(doc CanvasDocument, task map[string]any, node CanvasNode) string {
	if task["kind"] == "script_shot" {
		return canvasScriptShotRevision(node, util.Clean(task["shotId"]))
	}
	return canvasTextTaskNodeRevision(doc, node)
}

func (w *canvasAgentWorker) canvasTextProposalCurrent(proposal map[string]any) bool {
	node := w.node(util.Clean(proposal["nodeId"]))
	if node == nil || canvasTextTaskTargetRevision(w.doc, proposal, *node) != proposal["revision"] {
		return false
	}
	for id, revision := range agentMap(proposal["dependencyRevisions"]) {
		upstream := w.node(id)
		if upstream == nil || canvasTextTaskNodeRevision(w.doc, *upstream) != revision {
			return false
		}
	}
	return true
}

func (w *canvasAgentWorker) pruneCanvasTextEditProposals() {
	proposals := agentMap(w.session["textEditProposals"])
	for id, value := range proposals {
		proposal := agentMap(value)
		node := w.node(util.Clean(proposal["nodeId"]))
		if proposal["taskId"] == nil && (proposal["runId"] != w.req.ID || node == nil || canvasTextTaskTargetRevision(w.doc, proposal, *node) != proposal["revision"]) {
			delete(proposals, id)
		}
	}
}

func (w *canvasAgentWorker) saveCanvasTextEditProposal(nodeID, revision, author, content string) string {
	return w.saveCanvasTaskProposal(nodeID, "", "text", revision, author, content)
}

func (w *canvasAgentWorker) saveCanvasTaskProposal(nodeID, shotID, kind, revision, author, content string) string {
	proposals := agentMap(w.session["textEditProposals"])
	if len(proposals) >= canvasTextEditProposalLimit {
		return ""
	}
	id := uuid.NewString()
	proposals[id] = map[string]any{"nodeId": nodeID, "shotId": shotID, "kind": kind, "revision": revision, "author": author, "content": content, "runId": w.req.ID}
	w.session["textEditProposals"] = proposals
	return id
}

func (w *canvasAgentWorker) applyCanvasTextEdits(args map[string]any) (map[string]any, map[string]string) {
	ids := agentStrings(args["proposalIds"])
	if len(ids) < 1 || len(ids) > canvasAgentReviewConcurrency {
		return agentError("invalid_text_edit", "请选择 1 至 4 个修改提案"), nil
	}
	proposals := agentMap(w.session["textEditProposals"])
	revisions := make(map[string]string, len(ids))
	targets := make(map[string]bool, len(ids))
	updated := make(map[string]bool, len(ids))
	for _, id := range ids {
		proposal := agentMap(proposals[id])
		node := w.node(util.Clean(proposal["nodeId"]))
		if len(proposal) == 0 || proposal["taskId"] == nil && proposal["runId"] != w.req.ID {
			return agentError("text_edit_not_found", "修改提案不存在或已提交"), nil
		}
		if taskID := util.Clean(proposal["taskId"]); taskID != "" {
			task := agentMap(agentMap(w.session["textEditTasks"])[taskID])
			if task["status"] != "drafted" || task["proposalId"] != id || util.ToInt(task["revision"], 0) != util.ToInt(proposal["taskRevision"], 0) {
				return agentError("stale_text_task_revision", "任务已更新，请重新读取任务列表"), nil
			}
		}
		if !w.canvasTextProposalCurrent(proposal) {
			return w.canvasChangedResult("提案对应的节点已变化，整批修改未提交"), nil
		}
		switch proposal["kind"] {
		case "script_shot":
			if node.Type != "script" || node.ScriptProject == nil {
				return agentError("invalid_script_edit", "分镜任务对应的脚本节点已不可编辑"), nil
			}
		case "media_prompt":
			if !slices.Contains([]string{"image", "video", "audio"}, node.Type) {
				return agentError("invalid_media_node", "媒体提示词对应的节点已不可编辑"), nil
			}
		default:
			if node.Type != "text" {
				return agentError("invalid_text_edit", "正文任务对应的文本节点已不可编辑"), nil
			}
		}
		content, _ := proposal["content"].(string)
		if node.GenerationStatus == "loading" || node.ScriptOperation != nil || strings.TrimSpace(content) == "" && proposal["kind"] != "script_shot" && content != node.Prompt || len(content) > canvasDocumentMaxPrompt {
			return agentError("invalid_text_edit", "提案必须对应可编辑的节点和有效内容"), nil
		}
		target := canvasTextTaskTargetKey(proposal)
		if targets[target] {
			return agentError("text_edit_overlap", "同一编辑目标只能提交一个提案，整批修改未提交"), nil
		}
		targets[target] = true
		for dependency, fingerprint := range agentMap(proposal["dependencyRevisions"]) {
			revisions[dependency] = util.Clean(fingerprint)
		}
		revisions[node.ID] = canvasTextTaskNodeRevision(w.doc, *node)
		updated[node.ID] = true
	}
	for _, id := range ids {
		proposal := agentMap(proposals[id])
		for dependency := range agentMap(proposal["dependencyRevisions"]) {
			for _, other := range ids {
				if other == id || agentMap(proposals[other])["nodeId"] != dependency {
					continue
				}
				return agentError("text_task_dependency_conflict", "请先提交上游修改，再基于新版本重新起草下游"), nil
			}
		}
		if proposal["kind"] == "media_prompt" {
			nodeID := util.Clean(proposal["nodeId"])
			for _, upstream := range canvasAgentGenerationContext(w.doc, nodeID).Nodes {
				if upstream.ID != nodeID && updated[upstream.ID] {
					return agentError("text_task_dependency_conflict", "请先提交上游修改，再基于新版本重新起草媒体提示词"), nil
				}
			}
		}
	}
	staged := *w
	staged.doc.Nodes = slices.Clone(w.doc.Nodes)
	staged.state = util.CopyMap(w.state)
	staged.state["detachedTaskIds"] = slices.Clone(agentStrings(w.state["detachedTaskIds"]))
	nodes := make([]string, 0, len(updated))
	for _, id := range ids {
		proposal := agentMap(proposals[id])
		nodeID := util.Clean(proposal["nodeId"])
		node := staged.node(nodeID)
		content, _ := proposal["content"].(string)
		switch proposal["kind"] {
		case "script_shot":
			if err := applyCanvasShotDescription(node, util.Clean(proposal["shotId"]), content); err != nil {
				return agentError("invalid_script_edit", err.Error()), nil
			}
		case "media_prompt":
			result, err := staged.updateNode(map[string]any{"nodeId": nodeID, "prompt": content})
			if err != nil {
				return agentError("invalid_media_node", err.Error()), nil
			}
			if result["ok"] != true {
				return result, nil
			}
		default:
			if node.Prompt != content {
				node.Prompt, node.GenerationStatus = content, "success"
			}
		}
		if !slices.Contains(nodes, nodeID) {
			nodes = append(nodes, nodeID)
		}
	}
	w.doc.Nodes, w.state = staged.doc.Nodes, staged.state
	for _, id := range ids {
		proposal := agentMap(proposals[id])
		if taskID := util.Clean(proposal["taskId"]); taskID != "" {
			task := agentMap(agentMap(w.session["textEditTasks"])[taskID])
			setCanvasTextTaskStatus(task, "completed")
			delete(task, "proposalId")
		}
		delete(proposals, id)
	}
	return map[string]any{"ok": true, "updatedNodeIds": nodes, "message": "已提交编辑提案"}, revisions
}

func applyCanvasShotDescription(node *CanvasNode, shotID, content string) error {
	project := *node.ScriptProject
	project.Shots = slices.Clone(project.Shots)
	for i := range project.Shots {
		if project.Shots[i].ID == shotID {
			project.Shots[i].Description = content
			reconcileCanvasScriptProject(node.ScriptProject, &project)
			node.ScriptProject = &project
			return validateCanvasScript(*node)
		}
	}
	return errors.New("原分镜已不存在")
}
