package service

import (
	"encoding/json"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
	"github.com/google/uuid"
)

const canvasTextEditTaskLimit = 32

type CanvasAgentTextTaskDetail struct {
	ProposalStatus string  `json:"proposalStatus"`
	Content        *string `json:"content,omitempty"`
}

// Read the task and its target from the same workspace snapshot.
func (s *CanvasDocumentService) AgentTextTaskDetail(ownerID, projectID, sessionID, taskID string, revision int) (CanvasAgentTextTaskDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	document, history, err := s.agentHistoryIndexLocked(ownerID, projectID)
	if err != nil {
		return CanvasAgentTextTaskDetail{}, err
	}
	for _, item := range history.Sessions {
		if item.ID != sessionID {
			continue
		}
		body, err := s.agentHistorySessionBodyLocked(ownerID, projectID, document, item)
		if err != nil {
			return CanvasAgentTextTaskDetail{}, err
		}
		var session map[string]any
		if err := json.Unmarshal(body, &session); err != nil {
			return CanvasAgentTextTaskDetail{}, err
		}
		task := agentMap(agentMap(session["textEditTasks"])[taskID])
		if len(task) == 0 {
			return CanvasAgentTextTaskDetail{}, invalidCanvasDocument("找不到编辑任务")
		}
		if revision != util.ToInt(task["revision"], 0) {
			return CanvasAgentTextTaskDetail{}, ErrCanvasRevisionConflict
		}
		if task["status"] == "deleted" {
			return CanvasAgentTextTaskDetail{ProposalStatus: "deleted"}, nil
		}
		if task["status"] != "drafted" {
			return CanvasAgentTextTaskDetail{ProposalStatus: "none"}, nil
		}
		worker := canvasAgentWorker{doc: document, session: session}
		proposal := worker.canvasTextTaskProposal(task)
		if proposal == nil {
			return CanvasAgentTextTaskDetail{ProposalStatus: "stale"}, nil
		}
		content, ok := proposal["content"].(string)
		if !ok {
			return CanvasAgentTextTaskDetail{ProposalStatus: "stale"}, nil
		}
		return CanvasAgentTextTaskDetail{ProposalStatus: "current", Content: &content}, nil
	}
	return CanvasAgentTextTaskDetail{}, invalidCanvasDocument("找不到 Agent 会话")
}

func (w *canvasAgentWorker) canvasTextTaskProposal(task map[string]any) map[string]any {
	proposal := agentMap(agentMap(w.session["textEditProposals"])[util.Clean(task["proposalId"])])
	node := w.node(util.Clean(task["nodeId"]))
	if task["status"] != "drafted" || len(proposal) == 0 || proposal["taskId"] != task["id"] ||
		util.ToInt(proposal["taskRevision"], 0) != util.ToInt(task["revision"], 0) ||
		canvasTextTaskTargetKey(proposal) != canvasTextTaskTargetKey(task) ||
		!canvasTextTaskEditable(task, node) || !w.canvasTextProposalCurrent(proposal) {
		return nil
	}
	return proposal
}

func (w *canvasAgentWorker) planCanvasTextEditTasks(args map[string]any) map[string]any {
	plans := util.AsMapSlice(args["tasks"])
	board := agentMap(w.session["textEditTasks"])
	activeTasks := 0
	for _, raw := range board {
		if agentMap(raw)["status"] != "deleted" {
			activeTasks++
		}
	}
	if len(plans) == 0 || activeTasks+len(plans) > canvasTextEditTaskLimit {
		return agentError("text_task_limit", "当前对话最多保存 32 个文本编辑任务")
	}
	ids := make(map[string]string, len(plans))
	nodes := make(map[string]bool, len(plans))
	kinds := make(map[string]string, len(plans))
	for _, plan := range plans {
		key, nodeID := util.Clean(plan["key"]), util.Clean(plan["nodeId"])
		node := w.node(nodeID)
		target := canvasTextTaskTargetKey(plan)
		if key == "" || ids[key] != "" || node == nil || nodes[target] || util.Clean(plan["question"]) == "" {
			return agentError("invalid_text_task", "任务必须有唯一名称、可编辑的正文、镜头或媒体提示词及修改要求")
		}
		if slices.Contains([]string{"image", "video", "audio"}, node.Type) && util.Clean(plan["shotId"]) == "" {
			plan = util.CopyMap(plan)
			plan["kind"] = "media_prompt"
			kinds[key] = "media_prompt"
		}
		if !canvasTextTaskEditable(plan, node) {
			return agentError("invalid_text_task", "任务必须有唯一名称、可编辑的正文、镜头或媒体提示词及修改要求")
		}
		for _, item := range board {
			task := agentMap(item)
			if canvasTextTaskTargetKey(task) == target && task["status"] != "completed" && task["status"] != "deleted" {
				return agentError("text_task_overlap", "此目标已有待处理的编辑任务")
			}
		}
		ids[key], nodes[target] = uuid.NewString(), true
	}
	nextBoard := util.CopyMap(board)
	created := make([]map[string]any, 0, len(plans))
	for _, plan := range plans {
		key := util.Clean(plan["key"])
		id := ids[key]
		dependencies := []string{}
		for _, dep := range agentStrings(plan["dependsOn"]) {
			upstream := ids[dep]
			if board[dep] != nil {
				if agentMap(board[dep])["status"] == "deleted" {
					return agentError("invalid_text_task_dependency", "依赖不能指向已删除的任务")
				}
				if upstream != "" {
					return agentError("invalid_text_task_dependency", "依赖同时匹配本批名称和已有任务 ID，请更换本批名称")
				}
				upstream = dep
			}
			if upstream == "" || upstream == id || slices.Contains(dependencies, upstream) {
				return agentError("invalid_text_task_dependency", "依赖必须指向不同的任务，请使用本批任务名称或当前对话的已有任务 ID")
			}
			dependencies = append(dependencies, upstream)
		}
		task := map[string]any{"id": id, "key": key, "nodeId": util.Clean(plan["nodeId"]), "question": plan["question"], "dependsOn": dependencies, "revision": 1, "status": "pending"}
		if shotID := util.Clean(plan["shotId"]); shotID != "" {
			task["shotId"], task["kind"] = shotID, "script_shot"
		} else if kind := kinds[key]; kind != "" {
			task["kind"] = kind
		}
		created = append(created, task)
		nextBoard[id] = util.CopyMap(task)
	}
	if err := validateCanvasTextTaskGraph(nextBoard); err != nil {
		return agentError("invalid_text_task_dependency", err.Error())
	}
	w.session["textEditTasks"] = nextBoard
	return map[string]any{"ok": true, "tasks": created}
}

func validateCanvasTextTaskGraph(board map[string]any) error {
	ids := make([]string, 0, len(board))
	nodes := make([]CanvasNode, 0, len(board))
	var edges []CanvasConnection
	for id, raw := range board {
		if agentMap(raw)["status"] == "deleted" {
			continue
		}
		ids = append(ids, id)
		nodes = append(nodes, CanvasNode{ID: id})
		for _, upstream := range agentStrings(agentMap(raw)["dependsOn"]) {
			edges = append(edges, CanvasConnection{FromNodeID: upstream, ToNodeID: id})
		}
	}
	_, err := agentWorkflowOrder(ids, nodes, edges)
	return err
}

func (w *canvasAgentWorker) listCanvasTextEditTasks(taskID string) map[string]any {
	board := agentMap(w.session["textEditTasks"])
	if taskID != "" && board[taskID] == nil {
		return agentError("text_task_not_found", "当前对话没有该文本编辑任务")
	}
	tasks := make([]map[string]any, 0, len(board))
	for _, raw := range board {
		task := util.CopyMap(agentMap(raw))
		if task["status"] == "deleted" {
			if taskID == "" {
				continue
			}
		}
		if taskID != "" && task["id"] != taskID {
			continue
		}
		delete(task, "ownerRunId")
		delete(task, "ownerCallId")
		if proposalID := util.Clean(task["proposalId"]); proposalID != "" {
			proposal := w.canvasTextTaskProposal(task)
			if proposal == nil {
				task["proposalStale"] = true
			} else if taskID != "" {
				task["content"] = proposal["content"]
			}
		}
		node := w.node(util.Clean(task["nodeId"]))
		ready := canvasTextTaskEditable(task, node) &&
			(task["status"] == "pending" || task["status"] == "interrupted" || task["status"] == "failed")
		for _, id := range agentStrings(task["dependsOn"]) {
			upstream := agentMap(board[id])
			if upstream["status"] != "completed" || !canvasTextTaskEditable(upstream, w.node(util.Clean(upstream["nodeId"]))) {
				ready = false
			}
		}
		task["ready"] = ready
		tasks = append(tasks, task)
	}
	slices.SortFunc(tasks, func(a, b map[string]any) int {
		return strings.Compare(util.Clean(a["id"]), util.Clean(b["id"]))
	})
	return map[string]any{"ok": true, "tasks": tasks}
}

func (w *canvasAgentWorker) draftCanvasTextTasks(call map[string]any) (map[string]any, error) {
	board := agentMap(w.session["textEditTasks"])
	selection := util.AsMapSlice(agentMap(call["arguments"])["tasks"])
	if len(selection) < 1 || len(selection) > canvasAgentReviewConcurrency {
		return agentError("invalid_text_task", "请选择 1 至 4 个文本编辑任务"), nil
	}
	ids := []string{}
	tasks := make(map[string]map[string]any, len(selection))
	for _, requested := range selection {
		id := util.Clean(requested["id"])
		task := agentMap(board[id])
		if len(task) == 0 {
			return agentError("text_task_not_found", "当前对话没有该文本编辑任务"), nil
		}
		if revision, ok := util.StrictInt(requested["expectedRevision"]); !ok || revision != util.ToInt(task["revision"], 0) {
			result := agentError("stale_text_task_revision", "任务已更新，请重新读取任务列表")
			result["revision"] = task["revision"]
			return result, nil
		}
		nodeID := util.Clean(task["nodeId"])
		node := w.node(nodeID)
		if tasks[id] != nil || !canvasTextTaskEditable(task, node) {
			return agentError("invalid_text_task", "任务必须对应不同的可编辑目标"), nil
		}
		if !slices.Contains([]string{"pending", "interrupted", "failed"}, util.Clean(task["status"])) {
			return agentError("text_task_not_claimable", "任务已被领取、已有提案或已经完成"), nil
		}
		for _, dependency := range agentStrings(task["dependsOn"]) {
			upstream := agentMap(board[dependency])
			if upstream["status"] == "deleted" {
				return agentError("text_task_blocked", "依赖任务已删除，请修改任务计划"), nil
			}
			if upstream["status"] != "completed" || !canvasTextTaskEditable(upstream, w.node(util.Clean(upstream["nodeId"]))) {
				return agentError("text_task_blocked", "请先提交依赖任务的修改"), nil
			}
		}
		ids = append(ids, id)
		tasks[id] = task
	}
	for _, task := range tasks {
		setCanvasTextTaskStatus(task, "in_progress")
		task["ownerRunId"], task["ownerCallId"] = w.req.ID, call["id"]
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	delegation := util.CopyMap(call)
	delegation["arguments"] = map[string]any{"nodeIds": ids, "question": "按各任务的修改要求起草"}
	result, err := w.reviewCanvasNodes(delegation, tasks)
	if err != nil {
		return nil, err
	}
	reviews := map[string]map[string]any{}
	for _, review := range util.AsMapSlice(result["reviews"]) {
		reviews[util.Clean(review["taskId"])] = review
	}
	for taskID, task := range tasks {
		if task["status"] != "in_progress" || task["ownerRunId"] != w.req.ID || task["ownerCallId"] != call["id"] {
			continue
		}
		review := reviews[taskID]
		if proposalID := util.Clean(review["proposalId"]); proposalID != "" {
			proposal := agentMap(agentMap(w.session["textEditProposals"])[proposalID])
			if !w.canvasTextProposalCurrent(proposal) {
				delete(agentMap(w.session["textEditProposals"]), proposalID)
				delete(review, "proposalId")
				delete(review, "content")
				review["status"], review["text"] = "changed", "上游或目标节点变化，请重新起草"
				setCanvasTextTaskStatus(task, "failed")
			} else {
				setCanvasTextTaskStatus(task, "drafted")
				task["proposalId"] = proposalID
				proposal["taskId"], proposal["taskRevision"] = task["id"], task["revision"]
			}
		} else {
			setCanvasTextTaskStatus(task, "failed")
		}
		if review != nil {
			review["taskId"], review["taskRevision"] = task["id"], task["revision"]
		}
	}
	return result, nil
}

func (w *canvasAgentWorker) discardCanvasTextTaskDraft(args map[string]any) map[string]any {
	task := agentMap(agentMap(w.session["textEditTasks"])[util.Clean(args["id"])])
	if len(task) == 0 {
		return agentError("text_task_not_found", "当前对话没有该文本编辑任务")
	}
	if task["status"] == "deleted" {
		return agentError("text_task_deleted", "该文本编辑任务已删除")
	}
	if revision, ok := util.StrictInt(args["expectedRevision"]); !ok || revision != util.ToInt(task["revision"], 0) {
		result := agentError("stale_text_task_revision", "任务已更新，请重新读取任务列表")
		result["revision"] = task["revision"]
		return result
	}
	if task["status"] != "drafted" {
		return agentError("text_task_not_drafted", "仅可放弃尚未提交的提案")
	}
	w.resetCanvasTextTask(task)
	return map[string]any{"ok": true, "task": util.CopyMap(task)}
}

func (w *canvasAgentWorker) reviseCanvasTextTask(args map[string]any, reopen bool) map[string]any {
	board := agentMap(w.session["textEditTasks"])
	id := util.Clean(args["id"])
	task := agentMap(board[id])
	if len(task) == 0 {
		return agentError("text_task_not_found", "当前对话没有该文本编辑任务")
	}
	if task["status"] == "deleted" {
		return agentError("text_task_deleted", "该文本编辑任务已删除")
	}
	if revision, ok := util.StrictInt(args["expectedRevision"]); !ok || revision != util.ToInt(task["revision"], 0) {
		result := agentError("stale_text_task_revision", "任务已更新，请重新读取任务列表")
		result["revision"] = task["revision"]
		return result
	}
	if reopen && task["status"] != "completed" {
		return agentError("text_task_not_completed", "仅可重开已完成的任务")
	}
	if reopen && !canvasTextTaskEditable(task, w.node(util.Clean(task["nodeId"]))) {
		return agentError("invalid_text_task", "重开的任务必须对应可编辑的目标")
	}
	if task["status"] == "in_progress" {
		return agentError("text_task_in_progress", "此任务正在起草")
	}
	next := util.CopyMap(task)
	question, questionProvided := args["question"]
	if questionProvided && util.Clean(question) == "" {
		return agentError("invalid_text_task", "修改要求不能为空")
	}
	if questionProvided {
		next["question"] = util.Clean(question)
	}
	deps, depsProvided := args["dependsOn"]
	if !reopen && !questionProvided && !depsProvided {
		return agentError("invalid_text_task", "请提供新的修改要求或依赖任务列表")
	}
	if depsProvided {
		dependencies := agentStrings(deps)
		seen := make(map[string]bool, len(dependencies))
		for _, upstream := range dependencies {
			if board[upstream] == nil || upstream == id || seen[upstream] {
				return agentError("invalid_text_task_dependency", "依赖必须指向当前对话中不同且存在的其他任务")
			}
			seen[upstream] = true
		}
		next["dependsOn"] = dependencies
		proposed := util.CopyMap(board)
		proposed[id] = next
		if err := validateCanvasTextTaskGraph(proposed); err != nil {
			return agentError("invalid_text_task_dependency", err.Error())
		}
	}
	if !reopen && next["question"] == task["question"] && slices.Equal(agentStrings(next["dependsOn"]), agentStrings(task["dependsOn"])) {
		return map[string]any{"ok": true, "task": util.CopyMap(task), "resetTaskIds": []string{}, "message": "任务计划已有相同内容"}
	}

	dependents := make(map[string][]string, len(board))
	for otherID, item := range board {
		if agentMap(item)["status"] == "deleted" {
			continue
		}
		for _, upstream := range agentStrings(agentMap(item)["dependsOn"]) {
			dependents[upstream] = append(dependents[upstream], otherID)
		}
	}
	resetIDs := []string{id}
	reset := map[string]bool{id: true}
	for i := 0; i < len(resetIDs); i++ {
		for _, child := range dependents[resetIDs[i]] {
			if !reset[child] {
				reset[child] = true
				resetIDs = append(resetIDs, child)
			}
		}
	}
	targets := make(map[string]bool, len(resetIDs))
	for _, resetID := range resetIDs {
		affected := agentMap(board[resetID])
		if affected["status"] == "in_progress" {
			return agentError("text_task_in_progress", "受影响的任务正在起草")
		}
		target := canvasTextTaskTargetKey(affected)
		if targets[target] {
			return agentError("text_task_overlap", "受影响的任务存在重复编辑目标")
		}
		targets[target] = true
	}
	for otherID, item := range board {
		other := agentMap(item)
		if !reset[otherID] && other["status"] != "completed" && other["status"] != "deleted" && targets[canvasTextTaskTargetKey(other)] {
			return agentError("text_task_overlap", "受影响的目标已有其他待办任务")
		}
	}

	task["question"], task["dependsOn"] = next["question"], next["dependsOn"]
	for _, resetID := range resetIDs {
		w.resetCanvasTextTask(agentMap(board[resetID]))
	}
	slices.Sort(resetIDs[1:])
	message := "任务计划已更新，下游任务按依赖顺序重新起草"
	if reopen {
		message = "任务已重开，下游任务按依赖顺序重新起草"
	}
	return map[string]any{
		"ok": true, "task": util.CopyMap(task), "resetTaskIds": resetIDs[1:],
		"message": message,
	}
}

func (w *canvasAgentWorker) resetCanvasTextTask(task map[string]any) {
	delete(agentMap(w.session["textEditProposals"]), util.Clean(task["proposalId"]))
	delete(task, "proposalId")
	delete(task, "ownerCallId")
	delete(task, "ownerRunId")
	setCanvasTextTaskStatus(task, "pending")
}

func (w *canvasAgentWorker) removeCanvasTextTask(args map[string]any) map[string]any {
	board := agentMap(w.session["textEditTasks"])
	id := util.Clean(args["id"])
	task := agentMap(board[id])
	if len(task) == 0 {
		return agentError("text_task_not_found", "当前对话没有该文本编辑任务")
	}
	if task["status"] == "deleted" {
		return agentError("text_task_deleted", "该文本编辑任务已删除")
	}
	if revision, ok := util.StrictInt(args["expectedRevision"]); !ok || revision != util.ToInt(task["revision"], 0) {
		result := agentError("stale_text_task_revision", "任务已更新，请重新读取任务列表")
		result["revision"] = task["revision"]
		return result
	}
	if task["status"] == "in_progress" {
		return agentError("text_task_in_progress", "此任务正在起草")
	}
	for _, value := range board {
		if agentMap(value)["status"] != "deleted" && slices.Contains(agentStrings(agentMap(value)["dependsOn"]), id) {
			return agentError("text_task_has_dependents", "请先移除依赖此任务的下游任务")
		}
	}
	delete(agentMap(w.session["textEditProposals"]), util.Clean(task["proposalId"]))
	delete(task, "proposalId")
	delete(task, "ownerCallId")
	delete(task, "ownerRunId")
	setCanvasTextTaskStatus(task, "deleted")
	return map[string]any{"ok": true, "task": util.CopyMap(task), "message": "已删除任务记录，画布正文保持原样"}
}

func setCanvasTextTaskStatus(task map[string]any, status string) {
	task["status"] = status
	task["revision"] = util.ToInt(task["revision"], 0) + 1
}

func interruptCanvasTextTasks(session map[string]any) {
	for _, raw := range agentMap(session["textEditTasks"]) {
		task := agentMap(raw)
		if task["status"] == "in_progress" {
			setCanvasTextTaskStatus(task, "interrupted")
			delete(task, "ownerRunId")
			delete(task, "ownerCallId")
		}
	}
}

func canvasTextTaskEditable(task map[string]any, node *CanvasNode) bool {
	if node == nil || node.GenerationStatus == "loading" || node.ScriptOperation != nil {
		return false
	}
	if shotID := util.Clean(task["shotId"]); shotID != "" {
		return canvasScriptShotRevision(*node, shotID) != ""
	}
	if task["kind"] == "media_prompt" {
		return slices.Contains([]string{"image", "video", "audio"}, node.Type)
	}
	return node.Type == "text"
}
