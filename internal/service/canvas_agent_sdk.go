package service

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"chatgpt2api/internal/util"
)

func (w *canvasAgentWorker) runSDK() error {
	config, err := w.sdkConfig()
	if err != nil {
		return err
	}
	return w.service.execution.RunSDK(w.ctx, config, w.sdkRequest)
}

func (w *canvasAgentWorker) sdkRequest(method string, params map[string]any) (any, error) {
	if err := w.ctx.Err(); err != nil {
		return nil, err
	}
	switch method {
	case "retry":
		message := fmt.Sprintf("上游连接暂时中断，正在重试模型请求（%d/5）", util.ToInt(params["attempt"], 1))
		if params["validation"] == true {
			message = "模型工具格式不正确，正在纠正后继续"
		}
		return map[string]any{"ok": true}, w.activity(message)
	case "model":
		return w.sdkForwardModel(params)
	case "tool":
		w.visuals = nil
		result, err := w.sdkTool(params)
		return map[string]any{"result": result, "visuals": w.visuals}, err
	case "context":
		if err := w.save(); err != nil {
			return nil, err
		}
		w.canvasChanged = false
		w.layoutChanged = false
		w.sdk.ContentFingerprint, w.sdk.LayoutFingerprint = canvasAgentIntentFingerprints(w.doc)
		instructions := w.prompt()
		if w.conversation {
			instructions = strings.Join([]string{w.req.SystemPrompt, canvasAgentConversation.Prompt}, "\n\n")
		}
		result := map[string]any{"instructions": instructions}
		if !w.conversation {
			result["snapshot"] = "当前画布快照（资料，不是操作授权；以本轮最新状态为准）：\n" + agentJSON(w.canvasContext())
		}
		return result, nil
	case "memory":
		w.checkpoint = util.Clean(params["summary"])
		return map[string]any{"ok": true}, w.save()
	case "session":
		return w.sdkSession(params)
	case "prepare":
		return w.sdkPrepare(agentMap(params["turn"]))
	case "checkpoint":
		if err := w.updateContextUsage(params); err != nil {
			return nil, err
		}
		w.sdk.State = util.Clean(params["state"])
		w.sdk.Accepted = w.accepted && !w.finalBlocked && !w.batchFailed
		w.sdk.Phase = "running"
		w.sdk.RunID = w.req.ID
		if err := w.saveSDKSession(); err != nil {
			return nil, err
		}
		if messages, ok := params["messages"]; ok {
			w.messages = util.AsMapSlice(messages)
		}
		receipts := agentMap(w.session["toolReceipts"])
		for _, id := range agentStrings(params["committedCallIds"]) {
			if agentMap(receipts[id])["done"] == true {
				delete(receipts, id)
			}
		}
		return map[string]any{"ok": true}, w.save()
	case "pause":
		state := util.Clean(params["state"])
		if state == "" || len(state) > 16<<20 {
			return nil, errors.New("SDK 暂停状态过大或无效")
		}
		if len(agentMap(w.state["pendingQuestion"])) == 0 {
			return nil, errors.New("SDK 暂停时没有待回答的问题")
		}
		w.sdk.State = state
		w.sdk.Phase = "waiting"
		w.sdk.Question = agentMap(w.state["pendingQuestion"])
		if err := w.saveSDKSession(); err != nil {
			return nil, err
		}
		w.doc.AgentRun.SDKState = "sdk-session"
		return map[string]any{"ok": true}, w.finish("waiting", util.Clean(agentMap(w.state["pendingQuestion"])["question"]))
	case "finish":
		if len(agentMap(w.state["pendingQuestion"])) > 0 {
			return nil, errors.New("仍有未回答的问题")
		}
		w.reconcilePendingMedia()
		status := util.Clean(params["status"])
		reply := util.Clean(params["text"])
		if !w.conversation && (!w.accepted || w.finalBlocked || w.hasPendingPlan() || len(agentStrings(w.state["pendingTaskIds"])) > 0) {
			status = "waiting"
			reply = "任务仍有未完成步骤，已有结果和执行记录已保存，可以继续执行。"
		}
		if messages, ok := params["messages"]; ok {
			w.messages = util.AsMapSlice(messages)
		}
		w.sdk.State = ""
		w.sdk.Phase = "complete"
		w.sdk.Question = nil
		w.sdk.RejectedCallIDs = nil
		w.sdk.ApprovedCallID = ""
		w.sdk.ApprovedAnswer = ""
		w.sdk.ApprovedMediaChoice = ""
		if err := w.saveSDKSession(); err != nil {
			return nil, err
		}
		w.doc.AgentRun.SDKState = ""
		return map[string]any{"ok": true}, w.finish(status, reply)
	}
	return nil, fmt.Errorf("未知 SDK 请求 %s", method)
}

func (w *canvasAgentWorker) hasPendingPlan() bool {
	for _, step := range util.AsMapSlice(agentMap(w.state["plan"])["steps"]) {
		if step["status"] == "pending" || step["status"] == "in_progress" {
			return true
		}
	}
	return false
}

// sdkPrepare validates business contracts; retries and subsequent turns belong to SDK.
func (w *canvasAgentWorker) sdkPrepare(turn map[string]any) (any, error) {
	if containsAny(util.Clean(turn["finish_reason"]), "length", "incomplete") {
		return nil, errors.New("模型输出被截断，本批操作未执行")
	}
	calls, err := agentCalls(turn["tool_calls"])
	if err != nil {
		return map[string]any{"error": err.Error()}, nil
	}
	for _, call := range calls {
		if _, used := agentMap(w.session["toolReceipts"])[util.Clean(call["id"])]; used {
			return map[string]any{"error": "工具调用 ID 已使用，请核对已保存结果；新操作必须使用新的调用 ID", "failedCallId": call["id"], "errorCode": "duplicate_call_id"}, nil
		}
	}
	for _, message := range w.messages {
		for _, previous := range util.AsMapSlice(message["toolCalls"]) {
			for _, call := range calls {
				if call["id"] == previous["id"] {
					return map[string]any{"error": "工具调用 ID 已使用，请核对已保存结果；新操作必须使用新的调用 ID", "failedCallId": call["id"], "errorCode": "duplicate_call_id"}, nil
				}
			}
		}
	}
	if w.conversation && len(calls) > 0 {
		return nil, errors.New("普通对话不执行工具")
	}
	w.finalBlocked = w.batchFailed && !w.canvasChanged
	w.batchCalls = calls
	w.batchFailed = false
	w.sdk.BatchFailed = false
	w.batchQuestion = ""
	message := map[string]any{"role": "assistant", "content": util.Clean(turn["text_response"]), "toolCalls": calls}
	if value := turn["reasoning_content"]; value != nil {
		message["reasoningContent"] = value
	}
	if value := turn["response_items"]; value != nil {
		message["responseItems"] = value
	}
	for _, call := range calls {
		if call["name"] == "ask_user_question" || call["name"] == "delete_node" {
			w.batchQuestion = util.Clean(call["id"])
			if previous := agentMap(w.state["pendingQuestion"]); previous["id"] == call["id"] {
				break
			}
			args := agentMap(call["arguments"])
			q := map[string]any{"id": call["id"], "question": args["question"], "reason": args["reason"], "options": args["options"], "kind": args["kind"], "request": w.req.UserText}
			if args["purpose"] != nil {
				q["purpose"] = args["purpose"]
			}
			if args["purpose"] == "workflow_review" {
				reviewNodeIDs := w.workflowReviewUnapprovedIDs()
				if len(reviewNodeIDs) == 0 {
					return map[string]any{"error": "当前没有待审核的系列提示词。workflow_review 仅用于 requiresUserReview=true 的系列提示词；普通需求确认请省略 purpose。", "errorCode": "workflow_review_unavailable", "failedCallId": call["id"]}, nil
				}
				q["nodeIds"] = reviewNodeIDs
				q["question"] = fmt.Sprintf("画布中有 %d 条系列提示词，请逐条检查并按需修改。确认后才会提交对应图片生成。", len(reviewNodeIDs))
				q["reason"] = "系列工作流要求先审核提示词，确认后才会开始生成。"
				q["options"] = []string{"确认审核并生成（推荐）", "暂不生成，保留提示词"}
				q["kind"] = "confirmation"
			}
			if call["name"] == "delete_node" {
				ids, targetErr := canvasAgentDeletionTargets(args)
				if targetErr != nil {
					return map[string]any{"error": targetErr.Error(), "failedCallId": call["id"]}, nil
				}
				fingerprints := map[string]any{}
				removed := map[string]bool{}
				for _, id := range ids {
					if w.node(id) == nil {
						return map[string]any{"error": "待删除节点不存在，请重新读取画布后核对整批范围", "failedCallId": call["id"]}, nil
					}
					fingerprints[id] = w.deletionFingerprint(id)
					for target := range canvasAgentRemovalIDs(w.doc.Nodes, id) {
						removed[target] = true
					}
				}
				titles := []string{}
				for _, node := range w.doc.Nodes {
					if removed[node.ID] {
						titles = append(titles, firstAgentString(node.Title, "未命名节点"))
					}
				}
				q["purpose"] = "delete_node"
				q["nodeIds"] = ids
				q["nodeFingerprints"] = fingerprints
				q["question"] = fmt.Sprintf("确认删除以下 %d 个节点及关联连线？\n• %s", len(removed), strings.Join(titles, "\n• "))
				q["reason"] = "一次确认整批删除；删除后无法通过此对话恢复"
				q["kind"] = "confirmation"
				q["options"] = []string{"确认删除", "保留全部"}
			}
			w.state["pendingQuestion"] = q
			w.trace(map[string]any{"id": call["id"], "type": "question", "question": q["question"]})
			break
		}
	}
	if text := util.Clean(turn["text_response"]); text != "" && len(calls) > 0 {
		w.assistant()["text"] = ""
		w.trace(map[string]any{"id": "sdk-text:" + util.Clean(calls[0]["id"]), "type": "text", "text": text})
	}
	w.messages = append(w.messages, message)
	w.sdk.Calls = calls
	w.sdk.Question = agentMap(w.state["pendingQuestion"])
	if err = w.saveSDKSession(); err != nil {
		return nil, err
	}
	if err = w.save(); err != nil {
		return nil, err
	}
	return map[string]any{"question": w.batchQuestion}, nil
}

func (w *canvasAgentWorker) sdkForwardModel(params map[string]any) (any, error) {
	if err := w.updateContextUsage(params); err != nil {
		return nil, err
	}
	if err := w.activity("正在处理任务"); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrAgentProgressPersistence, err)
	}
	metadata := map[string]any{"api_mode": w.req.APIMode, "stream": w.req.Stream, "reasoning_enabled": w.req.Reasoning, "relay_token_name": w.req.RelayTokenName, "prompt_cache_key": params["promptCacheKey"]}
	if !w.conversation {
		activeTools := []map[string]any{}
		for _, definition := range util.AsMapSlice(params["tools"]) {
			if definition["type"] != "function" {
				return nil, errors.New("SDK 模型请求包含不支持的工具类型")
			}
			for _, allowed := range w.tools() {
				if agentMap(allowed["function"])["name"] == definition["name"] {
					activeTools = append(activeTools, allowed)
					break
				}
			}
		}
		metadata["tools"] = activeTools
		metadata["tool_choice"] = agentMap(params["modelSettings"])["toolChoice"]
		if parallel, ok := agentMap(params["modelSettings"])["parallelToolCalls"].(bool); ok && len(activeTools) > 0 {
			metadata["parallel_tool_calls"] = parallel
		}
	} else {
		metadata["max_output_tokens"] = 700
		metadata["stream"] = true
		metadata["reasoning_enabled"] = false
	}
	if params["summary"] == true {
		delete(metadata, "tools")
		delete(metadata, "tool_choice")
		metadata["max_output_tokens"] = 4000
		metadata["reasoning_enabled"] = false
	}
	lastProgressSave := time.Time{}
	request := AgentModelRequest{Model: w.req.Model, Prompt: w.req.UserText, Messages: util.AsMapSlice(params["messages"]), Metadata: metadata, OnText: func(text string) error {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		w.assistant()["text"] = text
		if !lastProgressSave.IsZero() && time.Since(lastProgressSave) < 150*time.Millisecond {
			return nil
		}
		lastProgressSave = time.Now()
		if err := w.save(); err != nil {
			return fmt.Errorf("%w: %w", ErrAgentProgressPersistence, err)
		}
		return nil
	}}
	if params["summary"] == true {
		request.OnText = nil
	}
	result, err := w.service.model(w.ctx, w.identity, request)
	if err == nil && params["summary"] != true {
		w.recordModelInputUsage(result)
	}
	return result, err
}

func (w *canvasAgentWorker) sdkTool(call map[string]any) (any, error) {
	id := util.Clean(call["id"])
	receipts := agentMap(w.session["toolReceipts"])
	if receipt := agentMap(receipts[id]); len(receipt) > 0 {
		if receipt["fingerprint"] != canvasAgentToolCallFingerprint(call) {
			return nil, errors.New("工具调用 ID 已用于不同操作")
		}
		result := agentMap(receipt["result"])
		if receipt["done"] == true {
			for nodeID, fingerprint := range agentMap(receipt["nodeFingerprints"]) {
				node := w.node(nodeID)
				if node == nil || fingerprint != w.deletionFingerprint(nodeID) {
					return w.canvasChangedResult("已完成操作的节点已被用户修改或移除，保留当前画布，不重复执行"), nil
				}
			}
			if call["name"] == "finish_task" && result["ok"] == true {
				w.accepted = true
			}
			return result, nil
		}
		if node := w.node(util.Clean(result["nodeId"])); node != nil && node.TaskID != "" {
			if node.TaskID != result["taskId"] {
				return w.canvasChangedResult("节点已采用另一项任务，保留当前结果，不接回旧任务"), nil
			}
			if node.GenerationStatus == "loading" && receipt["generationInputFingerprint"] != canvasAgentGenerationInputFingerprint(w.doc, node.ID) {
				taskID := node.TaskID
				if !slices.Contains(agentStrings(w.state["detachedTaskIds"]), taskID) {
					w.state["detachedTaskIds"] = append(agentStrings(w.state["detachedTaskIds"]), taskID)
				}
				w.state["pendingTaskIds"] = slices.DeleteFunc(agentStrings(w.state["pendingTaskIds"]), func(id string) bool { return id == taskID })
				node.GenerationStatus = "idle"
				result := w.canvasChangedResult("生成输入已在停止期间变化，已保留节点和原任务；未采用旧结果，重新生成前需用户明确同意")
				return result, w.save()
			}
			if node.GenerationStatus == "success" {
				return map[string]any{"ok": true, "nodeId": node.ID, "taskId": node.TaskID, "reused": true}, nil
			}
			if node.GenerationStatus == "loading" {
				w.activeCall = call
				res, err := w.generateNode(node.ID)
				if err != nil {
					return nil, err
				}
				w.record(call, res)
				receipt = agentMap(agentMap(w.session["toolReceipts"])[id])
				receipt["done"] = true
				return res, w.save()
			}
		}
		return agentError("execution_unknown", "原操作已开始但未确认完成，请核对已有节点和任务；不会重复创建或付费提交"), nil
	}
	q := agentMap(w.state["pendingQuestion"])
	if len(q) > 0 {
		if id != q["id"] || id != w.answerCallID {
			return nil, errors.New("问题尚未获得用户回答")
		}
		w.activeCall = call
		return w.answerQuestion(call)
	}
	valid := false
	for _, known := range w.batchCalls {
		if known["id"] == id && known["name"] == call["name"] && agentJSON(known["arguments"]) == agentJSON(call["arguments"]) {
			valid = true
		}
	}
	if !valid {
		return nil, errors.New("工具调用不属于当前模型批次")
	}
	if w.batchFailed && !w.canvasChanged {
		result := agentError("dependency_failed", "前序操作失败，本操作未执行")
		w.record(call, result)
		return result, w.save()
	}
	w.activeCall = call
	w.record(call, agentError("execution_unknown", "执行中，恢复时必须先核对已有结果"))
	label := agentLabels[util.Clean(call["name"])]
	w.trace(map[string]any{"id": id, "type": "operation", "kind": agentToolKind(util.Clean(call["name"])), "label": label, "status": "running", "detail": "准备执行：" + label})
	if err := w.save(); err != nil {
		return nil, err
	}
	w.activeCall = call
	if w.sdk != nil {
		content, layout := canvasAgentIntentFingerprints(w.doc)
		w.canvasChanged = w.canvasChanged || w.sdk.ContentFingerprint != "" && content != w.sdk.ContentFingerprint
		w.layoutChanged = w.layoutChanged || w.sdk.LayoutFingerprint != "" && layout != w.sdk.LayoutFingerprint
	}
	var result map[string]any
	var err error
	if w.canvasChanged || w.layoutChanged && (call["name"] == "arrange_nodes" || call["name"] == "create_group") {
		result = w.canvasChangedResult("用户刚刚修改了画布，本批剩余操作未执行。请以当前画布为准重新判断，不恢复已删除节点。")
	} else {
		result, err = w.tool(call)
	}
	if err != nil {
		if w.ctx.Err() != nil {
			return nil, w.ctx.Err()
		}
		result = agentError("tool_error", err.Error())
	}
	// The result receipt and node edits commit together. A lost reply must not
	// leave a committed write with only an "execution unknown" receipt.
	w.record(call, result)
	if receipt := agentMap(agentMap(w.session["toolReceipts"])[id]); len(receipt) > 0 {
		receipt["done"] = true
	}
	if err = w.save(); err != nil {
		return nil, err
	}
	if w.canvasChanged && result["ok"] == true {
		previous := result
		result = w.canvasChangedResult("已保留你的画布修改，正在核对本次操作结果并调整后续步骤")
		result["operationResult"] = previous
	}

	w.record(call, result)
	if receipt := agentMap(agentMap(w.session["toolReceipts"])[id]); len(receipt) > 0 {
		receipt["done"] = true
	}
	status := "success"
	if result["ok"] != true {
		status = "error"
		w.batchFailed = result["code"] != "canvas_changed"
	}
	if result["code"] == "canvas_changed" {
		status = "changed"
	}
	w.trace(map[string]any{"id": id, "type": "operation", "kind": agentToolKind(util.Clean(call["name"])), "label": label, "status": status, "detail": agentResultDetail(result), "nodeId": result["nodeId"]})
	for _, nodeID := range agentStrings(result["nodeIds"]) {
		if call["name"] == "run_canvas_workflow" {
			break
		}
		if node := w.node(nodeID); node != nil {
			nodeStatus := "success"
			if node.Type != "text" && node.GenerationStatus != "success" {
				nodeStatus = "waiting"
			}
			w.trace(map[string]any{"id": id + ":" + nodeID, "type": "operation", "kind": "create", "label": node.Title, "status": nodeStatus, "detail": "已保存到画布", "nodeId": nodeID})
		}
	}
	if err = w.save(); err != nil {
		return nil, err
	}
	if w.sdk != nil {
		content, layout := canvasAgentIntentFingerprints(w.doc)
		if !w.canvasChanged {
			w.sdk.ContentFingerprint = content
		}
		if !w.layoutChanged {
			w.sdk.LayoutFingerprint = layout
		}
		w.sdk.BatchFailed = w.batchFailed
		if err = w.saveSDKSession(); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (w *canvasAgentWorker) pendingQuestionCall() map[string]any {
	q := agentMap(w.state["pendingQuestion"])
	name := "ask_user_question"
	if q["purpose"] == "delete_node" {
		name = "delete_node"
	}
	if w.sdk != nil {
		for _, call := range w.sdk.Calls {
			if call["id"] == q["id"] && call["name"] == name {
				return call
			}
		}
	}
	for i := len(w.messages) - 1; i >= 0; i-- {
		if w.messages[i]["role"] != "assistant" {
			continue
		}
		for _, call := range util.AsMapSlice(w.messages[i]["toolCalls"]) {
			if call["id"] == q["id"] && call["name"] == name {
				return call
			}
		}
	}
	return nil
}

func (w *canvasAgentWorker) answerQuestion(call map[string]any) (any, error) {
	q := agentMap(w.state["pendingQuestion"])
	if len(q) == 0 || call["id"] != q["id"] {
		return nil, errors.New("待回答问题已变化")
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	if err := w.ctx.Err(); err != nil {
		return nil, err
	}
	result := map[string]any{"ok": true, "answer": w.answerText}
	if q["purpose"] == "delete_node" {
		result = agentError("delete_cancelled", "未确认删除，节点已保留")
		if strings.TrimSpace(w.answerText) == "确认删除" {
			ids := agentStrings(q["nodeIds"])
			fingerprints := agentMap(q["nodeFingerprints"])
			if len(ids) == 0 {
				ids = []string{util.Clean(q["nodeId"])}
				fingerprints = map[string]any{ids[0]: q["nodeFingerprint"]}
			}
			unchanged := true
			for _, id := range ids {
				if w.node(id) == nil || fingerprints[id] != w.deletionFingerprint(id) {
					unchanged = false
					break
				}
			}
			if !unchanged {
				result = w.canvasChangedResult("待删除节点已变化，整批删除确认已失效；全部节点均已保留，请重新核对删除范围")
			} else {
				removed := map[string]bool{}
				for _, id := range ids {
					for target := range canvasAgentRemovalIDs(w.doc.Nodes, id) {
						removed[target] = true
					}
				}
				deleted := []string{}
				for _, node := range w.doc.Nodes {
					if removed[node.ID] {
						deleted = append(deleted, node.ID)
					}
				}
				w.doc.Nodes = slices.DeleteFunc(w.doc.Nodes, func(node CanvasNode) bool { return removed[node.ID] })
				w.doc.Connections = slices.DeleteFunc(w.doc.Connections, func(connection CanvasConnection) bool {
					return removed[connection.FromNodeID] || removed[connection.ToNodeID]
				})
				result = map[string]any{"ok": true, "deletedNodeIds": deleted, "deletedCount": len(deleted)}
			}
		}
	}
	if q["purpose"] == "media_generation" && w.answerMediaChoice != "" {
		w.state["mediaGenerationDeferred"] = w.answerMediaChoice != "generate"
	}
	if q["purpose"] == "workflow_review" {
		approved := []string{}
		if canvasAgentWorkflowReviewApproved(w.answerText) {
			approved = w.approveWorkflowReview(agentStrings(q["nodeIds"]))
		}
		if len(approved) == 0 {
			w.state["mediaGenerationDeferred"] = true
			result = agentError("workflow_review_deferred", "用户未确认系列提示词或审核状态已变化；节点已保留且未提交生成")
		} else {
			w.state["mediaGenerationDeferred"] = false
			result = map[string]any{"ok": true, "answer": w.answerText, "approvedNodeIds": approved}
		}
	}
	w.record(call, result)
	if receipt := agentMap(agentMap(w.session["toolReceipts"])[util.Clean(call["id"])]); len(receipt) > 0 {
		receipt["done"] = true
	}
	delete(w.state, "pendingQuestion")
	if w.sdk != nil {
		w.sdk.Question = nil
		w.sdk.RejectedCallIDs = nil
		w.sdk.ApprovedCallID = ""
		w.sdk.ApprovedAnswer = ""
		w.sdk.ApprovedMediaChoice = ""
		if err := w.saveSDKSession(); err != nil {
			return nil, err
		}
	}
	w.doc.AgentRun.SDKState = ""
	if err := w.save(); err != nil {
		return nil, err
	}
	return result, nil
}

func agentToolKind(name string) string {
	if name == "read_skill_file" {
		return "file"
	}
	if name == "update_plan" || name == "set_agent_state" {
		return "plan"
	}
	if strings.Contains(name, "workflow") {
		return "workflow"
	}
	if strings.HasPrefix(name, "get_") || strings.HasPrefix(name, "list_") || strings.HasPrefix(name, "query_") {
		return "read"
	}
	if strings.HasPrefix(name, "generate_") || strings.HasPrefix(name, "run_") || name == "edit_image" {
		return "generate"
	}
	if strings.HasPrefix(name, "create_") {
		return "create"
	}
	if strings.HasPrefix(name, "update_") || strings.HasPrefix(name, "delete_") || name == "arrange_nodes" {
		return "edit"
	}
	return "tool"
}
func agentResultDetail(result map[string]any) string {
	parts := []string{}
	if message := util.Clean(result["message"]); message != "" {
		parts = append(parts, message)
	}
	if node := agentMap(result["node"]); len(node) > 0 {
		parts = append(parts, "节点："+util.Clean(node["title"]))
	}
	if nodes, ok := result["nodeIds"]; ok {
		parts = append(parts, fmt.Sprintf("画布节点：%d 个", len(agentStrings(nodes))))
	}
	if nodes, ok := result["nodes"]; ok {
		parts = append(parts, fmt.Sprintf("返回节点：%d 个", len(util.AsMapSlice(nodes))))
	}
	if task := util.Clean(result["taskId"]); task != "" {
		parts = append(parts, "任务："+task)
	}
	if len(parts) == 0 {
		if result["ok"] == true {
			return "操作已完成"
		}
		return "操作未完成"
	}
	return strings.Join(parts, "\n")
}
