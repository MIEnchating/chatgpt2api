package service

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"chatgpt2api/internal/util"
)

// runSDK supervises a single SDK turn over private stdio. The child cannot select
// an identity or project: every callback uses the authenticated worker context.
func (w *canvasAgentWorker) runSDK() error {
	path := os.Getenv("AGENT_RUNTIME_PATH")
	if path == "" {
		path = "agent-runtime/worker.mjs"
	}
	binary := os.Getenv("AGENT_NODE_BINARY")
	if binary == "" {
		binary = "node"
	}
	command := exec.CommandContext(w.ctx, binary, path)
	// Only runtime configuration is inherited; application secrets stay in Go.
	command.Env = []string{"NODE_NO_WARNINGS=1", "ELECTRON_RUN_AS_NODE=1"}
	for _, key := range []string{"PATH", "HOME", "SystemRoot", "TEMP", "TMP", "USERPROFILE"} {
		if value, ok := os.LookupEnv(key); ok {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return fmt.Errorf("启动 Agents SDK 失败，请安装 Node.js 22 和 agent-runtime 依赖: %w", err)
	}
	defer func() {
		input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	encoder := json.NewEncoder(input)
	if err = encoder.Encode(map[string]any{"tools": w.tools(), "state": w.doc.AgentRun.SDKState}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	finished := false
	for scanner.Scan() {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err = json.Unmarshal(scanner.Bytes(), &request); err != nil {
			return fmt.Errorf("无效 SDK worker 消息: %w", err)
		}
		if request.Method == "error" {
			return errors.New(util.Clean(request.Params["message"]))
		}
		result, callErr := w.sdkRequest(request.Method, request.Params)
		response := map[string]any{"id": request.ID, "result": result}
		if callErr != nil {
			response["error"] = callErr.Error()
		}
		if err = encoder.Encode(response); err != nil {
			return err
		}
		if callErr != nil {
			return callErr
		}
		if request.Method == "finish" || request.Method == "pause" {
			finished = true
		}
	}
	if w.ctx.Err() != nil {
		return w.ctx.Err()
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	if err = command.Wait(); err != nil {
		return fmt.Errorf("Agents SDK worker 执行失败: %w", err)
	}
	if !finished {
		return errors.New("Agents SDK worker 未返回完成状态")
	}
	return nil
}

func (w *canvasAgentWorker) sdkRequest(method string, params map[string]any) (any, error) {
	if err := w.ctx.Err(); err != nil {
		return nil, err
	}
	switch method {
	case "model":
		return w.sdkModel()
	case "tool":
		return w.sdkTool(params)
	case "pause":
		state := util.Clean(params["state"])
		if state == "" || len(state) > 512<<10 {
			return nil, errors.New("SDK 暂停状态过大或无效")
		}
		if len(agentMap(w.state["pendingQuestion"])) == 0 {
			return nil, errors.New("SDK 暂停时没有待回答的问题")
		}
		w.doc.AgentRun.SDKState = state
		return map[string]any{"ok": true}, w.finish("waiting", util.Clean(agentMap(w.state["pendingQuestion"])["question"]))
	case "finish":
		status := util.Clean(params["status"])
		if len(agentMap(w.state["pendingQuestion"])) > 0 {
			return nil, errors.New("仍有未回答的问题")
		}
		if !w.conversation {
			for _, step := range util.AsMapSlice(agentMap(w.state["plan"])["steps"]) {
				if step["status"] == "pending" || step["status"] == "in_progress" {
					status = "waiting"
				}
			}
			for _, node := range w.doc.Nodes {
				if node.GenerationStatus == "loading" {
					status = "waiting"
				}
			}
		}
		w.doc.AgentRun.SDKState = ""
		return map[string]any{"ok": true}, w.finish(status, util.Clean(params["text"]))
	}
	return nil, fmt.Errorf("未知 SDK 请求 %s", method)
}

func (w *canvasAgentWorker) sdkModel() (any, error) {
	label := "正在分析需求"
	if w.conversation {
		label = "正在组织回复"
	} else {
		for _, step := range util.AsMapSlice(agentMap(w.state["plan"])["steps"]) {
			if step["status"] == "in_progress" {
				label = "正在分析：" + util.Clean(step["title"])
				break
			}
		}
	}
	if err := w.activity(label); err != nil {
		return nil, err
	}
	budget := 56000
	var turn map[string]any
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if w.conversation {
			turn, err = w.modelTurn(strings.Join([]string{w.req.SystemPrompt, canvasAgentConversation.Prompt}, "\n\n"), w.conversationMessages(), nil, 700)
			break
		}
		if err = w.compact(budget); err != nil {
			return nil, err
		}
		w.canvasChanged = false
		w.layoutChanged = false
		turn, err = w.modelTurn(w.prompt(), w.messages, w.tools(), 0)
		if err == nil {
			if err = w.save(); err != nil {
				return nil, err
			}
			if w.canvasChanged {
				w.messages = append(w.messages, map[string]any{"role": "system", "content": "用户刚刚修改了画布。请以当前画布为准重新判断，不要执行基于旧内容的操作，不要恢复已删除节点。必要素材缺失时询问用户，不索要内部 ID。"})
				w.trace(map[string]any{"id": fmt.Sprintf("canvas-change:%d", len(w.messages)), "type": "operation", "kind": "read", "label": "同步画布变化", "status": "changed", "detail": "已保留你的修改，正在根据最新画布重新判断下一步"})
				err = errCanvasAgentEditing
				continue
			}
			break
		}
		if !containsAny(strings.ToLower(err.Error()), "context length", "context_length", "context window", "maximum context", "too many input tokens", "上下文") {
			return nil, err
		}
		budget /= 2
	}
	if err != nil {
		return nil, err
	}
	if containsAny(util.Clean(turn["finish_reason"]), "length", "incomplete") {
		return nil, errors.New("模型输出被截断，本批操作未执行")
	}
	calls, err := agentCalls(turn["tool_calls"])
	if err != nil {
		return nil, err
	}
	if w.conversation && len(calls) > 0 {
		return nil, errors.New("普通对话不执行工具，请重新发送消息")
	}
	text := util.Clean(turn["text_response"])
	message := map[string]any{"role": "assistant", "content": text}
	if v := turn["response_items"]; v != nil {
		message["responseItems"] = v
	}
	if v := turn["reasoning_content"]; v != nil {
		message["reasoningContent"] = v
	}
	if len(calls) > 0 {
		message["toolCalls"] = calls
	}
	w.messages = append(w.messages, message)
	w.batchCalls = calls
	w.batchFailed = false
	w.batchQuestion = ""
	if text != "" && len(calls) > 0 {
		w.assistant()["text"] = ""
		w.trace(map[string]any{"id": fmt.Sprintf("text:%d", len(w.messages)), "type": "text", "text": text})
	}
	for _, call := range calls {
		if call["name"] == "ask_user_question" || call["name"] == "delete_node" {
			w.batchQuestion = util.Clean(call["id"])
			args := agentMap(call["arguments"])
			q := map[string]any{"id": call["id"], "question": args["question"], "reason": args["reason"], "options": args["options"], "kind": args["kind"], "request": w.req.UserText}
			if args["purpose"] != nil {
				q["purpose"] = args["purpose"]
			}
			if args["purpose"] == "workflow_review" {
				reviewNodeIDs := w.workflowReviewUnapprovedIDs()
				if len(reviewNodeIDs) == 0 {
					return nil, errors.New("当前没有待审核的系列提示词")
				}
				q["nodeIds"] = reviewNodeIDs
				q["question"] = fmt.Sprintf("画布中有 %d 条系列提示词，请逐条检查并按需修改。确认后才会提交对应图片生成。", len(reviewNodeIDs))
				q["reason"] = "系列工作流要求先审核提示词，确认后才会开始生成。"
				q["options"] = []string{"确认审核并生成", "暂不生成，保留提示词"}
				q["kind"] = "confirmation"
			}
			if call["name"] == "delete_node" {
				q["purpose"] = "delete_node"
				q["nodeId"] = args["nodeId"]
				label := "所选节点"
				if node := w.node(util.Clean(args["nodeId"])); node != nil {
					label = firstAgentString(node.Title, label)
					q["nodeFingerprint"] = w.deletionFingerprint(node.ID)
				}
				q["question"] = "确定删除“" + label + "”？请输入“确认删除”继续。"
				if node := w.node(util.Clean(args["nodeId"])); node != nil && node.Type == "group" {
					q["question"] = fmt.Sprintf("确定删除“%s”及组内 %d 个节点？请输入“确认删除”继续。", label, len(canvasAgentRemovalIDs(w.doc.Nodes, node.ID))-1)
				}
				q["reason"] = "删除后无法通过此对话恢复"
				q["kind"] = "confirmation"
				q["options"] = []string{}
			}
			w.state["pendingQuestion"] = q
			w.trace(map[string]any{"id": call["id"], "type": "question", "question": q["question"]})
			break
		}
	}
	// Only the chosen question enters the SDK approval state. All other calls in
	// that batch are explicitly recorded as unexecuted, including extra questions.
	sdkCalls := calls
	if w.batchQuestion != "" {
		sdkCalls = []map[string]any{}
	}
	for _, call := range calls {
		if call["id"] == w.batchQuestion {
			sdkCalls = append(sdkCalls, call)
			continue
		}
		if w.batchQuestion != "" {
			w.record(call, agentError("waiting_for_user", "本批未执行，等待用户回答"))
		} else {
			w.record(call, agentError("execution_not_started", "尚未执行"))
		}
	}
	if err = w.save(); err != nil {
		return nil, err
	}
	return map[string]any{"text": text, "calls": sdkCalls}, nil
}

func (w *canvasAgentWorker) sdkTool(call map[string]any) (any, error) {
	id := util.Clean(call["id"])
	q := agentMap(w.state["pendingQuestion"])
	if len(q) > 0 {
		if id != q["id"] || w.doc.AgentRun.SDKState == "" {
			return nil, errors.New("问题尚未获得用户回答")
		}
		if err := w.save(); err != nil {
			return nil, err
		}
		result := map[string]any{"ok": true, "answer": w.req.UserText}
		if q["purpose"] == "delete_node" {
			result = agentError("delete_cancelled", "未确认删除，节点已保留")
			if strings.TrimSpace(w.req.UserText) == "确认删除" {
				node := w.node(util.Clean(q["nodeId"]))
				if node == nil || q["nodeFingerprint"] != w.deletionFingerprint(node.ID) {
					result = w.canvasChangedResult("待删除节点已变化，旧的删除确认不再适用，已保留当前画布")
				} else {
					result = w.deleteNode(node.ID)
				}
			}
		}
		if q["purpose"] == "media_generation" && w.req.MediaChoice != "" {
			w.state["mediaGenerationDeferred"] = w.req.MediaChoice != "generate"
		}
		if q["purpose"] == "workflow_review" {
			approved := []string{}
			if canvasAgentWorkflowReviewApproved(w.req.UserText) {
				approved = w.approveWorkflowReview(agentStrings(q["nodeIds"]))
			}
			if len(approved) == 0 {
				result = agentError("workflow_review_deferred", "用户未确认系列提示词或审核状态已变化；节点已保留且未提交生成")
			} else {
				result = map[string]any{"ok": true, "answer": w.req.UserText, "approvedNodeIds": approved}
			}
		}
		w.record(call, result)
		delete(w.state, "pendingQuestion")
		w.doc.AgentRun.SDKState = ""
		if err := w.save(); err != nil {
			return nil, err
		}
		return result, nil
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
	w.record(call, agentError("execution_unknown", "执行中，恢复时必须先核对已有结果"))
	label := agentLabels[util.Clean(call["name"])]
	w.trace(map[string]any{"id": id, "type": "operation", "kind": agentToolKind(util.Clean(call["name"])), "label": label, "status": "running", "detail": "准备执行：" + label})
	if err := w.save(); err != nil {
		return nil, err
	}
	w.activeCall = call
	var result map[string]any
	var err error
	if w.canvasChanged || w.layoutChanged && (call["name"] == "arrange_nodes" || call["name"] == "create_group") {
		result = w.canvasChangedResult("画布已变化，本批剩余操作未执行，正在重新判断下一步")
	} else {
		result, err = w.tool(call)
	}
	if err != nil {
		if w.ctx.Err() != nil {
			return nil, w.ctx.Err()
		}
		result = agentError("tool_error", err.Error())
	}
	// Persist before reporting success so a concurrent merge cannot silently
	// turn an uncommitted edit into a successful tool result.
	if err = w.save(); err != nil {
		return nil, err
	}
	if w.canvasChanged && result["ok"] == true {
		previous := result
		result = w.canvasChangedResult("已保留你的画布修改，正在核对本次操作结果并调整后续步骤")
		result["operationResult"] = previous
	}
	w.record(call, result)
	status := "success"
	if result["ok"] != true {
		status = "error"
		w.batchFailed = true
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
