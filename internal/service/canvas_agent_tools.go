package service

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
)

func (w *canvasAgentWorker) node(id string) *CanvasNode {
	for i := range w.doc.Nodes {
		if w.doc.Nodes[i].ID == id {
			return &w.doc.Nodes[i]
		}
	}
	return nil
}
func (w *canvasAgentWorker) tool(call map[string]any) (map[string]any, error) {
	name := util.Clean(call["name"])
	args := agentMap(call["arguments"])
	if w.missingCanvasReferences(args) {
		return w.canvasChangedResult("引用的节点已不在当前画布中，正在重新核对可用素材"), nil
	}
	reviewNodeIDs := w.workflowReviewNodeIDs()
	if len(reviewNodeIDs) > 0 {
		if name == "generate_node" {
			if !slices.Contains(reviewNodeIDs, util.Clean(args["nodeId"])) || !w.workflowReviewApproved(util.Clean(args["nodeId"])) {
				return map[string]any{"ok": false, "code": "workflow_review_required", "submitted": false, "requiresUserReview": true, "message": "请先让用户审核对应系列提示词并明确确认，之后才能提交媒体生成"}, nil
			}
		} else if slices.Contains([]string{"generate_image", "edit_image", "generate_video", "generate_audio"}, name) {
			return map[string]any{"ok": false, "code": "workflow_review_required", "submitted": false, "requiresUserReview": true, "message": "当前系列提示词仍待审核或生成，请先完成对应审核，不能用新媒体节点绕过审核"}, nil
		}
	}
	if w.req.Resume && (strings.HasPrefix(name, "create_") || strings.HasPrefix(name, "generate_") || name == "edit_image") {
		for _, message := range w.messages {
			if message["role"] != "assistant" {
				continue
			}
			for _, old := range util.AsMapSlice(message["toolCalls"]) {
				if old["id"] == call["id"] || old["name"] != name || agentJSON(old["arguments"]) != agentJSON(args) {
					continue
				}
				for _, m := range w.messages {
					if m["role"] != "tool" || m["toolCallId"] != old["id"] {
						continue
					}
					var result map[string]any
					if json.Unmarshal([]byte(util.Clean(m["content"])), &result) != nil {
						continue
					}
					if node := w.node(util.Clean(result["nodeId"])); node != nil {
						result["reused"] = true
						return result, nil
					}
				}
			}
		}
	}
	id := util.Clean(args["nodeId"])
	ok := map[string]any{"ok": true}
	if id != "" && w.node(id) == nil {
		return w.canvasChangedResult("引用的节点已不在当前画布中，正在重新核对可用素材"), nil
	}
	switch name {
	case "list_workflows", "get_workflow", "save_workflow", "run_saved_workflow", "create_canvas_workflow", "run_canvas_workflow":
		return w.workflowTool(name, args)
	case "get_canvas_summary":
		result := w.canvasContext()
		result["ok"] = true
		return result, nil
	case "get_generation_config":
		generation := map[string]any{}
		for key, value := range w.req.Generation {
			generation[key] = value
		}
		generation["autoGenerateMedia"] = w.autoMedia()
		return map[string]any{"ok": true, "generation": generation}, nil
	case "list_references":
		refs := w.referenceIndex(util.Clean(args["keyword"]))
		size := max(1, min(50, util.ToInt(args["pageSize"], 20)))
		start := min(len(refs), (max(1, util.ToInt(args["page"], 1))-1)*size)
		return map[string]any{"ok": true, "references": refs[start:min(len(refs), start+size)], "total": len(refs)}, nil
	case "get_reference":
		ref, err := canvasAgentReference(w.doc, w.session, util.Clean(args["referenceId"]), "attachment")
		if err == nil {
			w.appendVisualReference(ref)
		}
		return map[string]any{"ok": err == nil, "reference": ref}, err
	case "get_node":
		n := w.node(id)
		w.appendVisualReference(map[string]any{"id": n.ID, "type": n.Type, "title": n.Title, "url": n.URL})
		return map[string]any{"ok": true, "node": agentNode(*w.node(id), true)}, nil
	case "get_generation_task", "get_media_task_status":
		n := w.node(id)
		return map[string]any{"ok": true, "nodeId": id, "status": n.GenerationStatus, "taskId": n.TaskID, "error": n.GenerationError}, nil
	case "get_selected_nodes", "query_canvas_nodes":
		nodes := []map[string]any{}
		keyword := strings.ToLower(util.Clean(args["keyword"]))
		for _, n := range w.doc.Nodes {
			if name == "get_selected_nodes" && !slices.Contains(w.req.SelectedNodeIDs, n.ID) {
				continue
			}
			if id != "" && n.ID != id || util.Clean(args["type"]) != "" && n.Type != args["type"] {
				continue
			}
			if keyword != "" && !strings.Contains(strings.ToLower(n.ID+" "+n.Title+" "+n.Prompt), keyword) {
				continue
			}
			nodes = append(nodes, agentNode(n, false))
		}
		size := max(1, min(50, util.ToInt(args["pageSize"], 20)))
		start := min(len(nodes), (max(1, util.ToInt(args["page"], 1))-1)*size)
		return map[string]any{"ok": true, "nodes": nodes[start:min(len(nodes), start+size)], "total": len(nodes)}, nil
	case "get_upstream_nodes", "get_downstream_nodes", "get_connected_nodes":
		up, down := []map[string]any{}, []map[string]any{}
		connections := []CanvasConnection{}
		for _, c := range w.doc.Connections {
			if c.ToNodeID == id || c.FromNodeID == id {
				connections = append(connections, c)
			}
			if c.ToNodeID == id {
				if n := w.node(c.FromNodeID); n != nil {
					up = append(up, agentNode(*n, false))
				}
			}
			if c.FromNodeID == id {
				if n := w.node(c.ToNodeID); n != nil {
					down = append(down, agentNode(*n, false))
				}
			}
		}
		ok["connections"] = connections
		if name == "get_upstream_nodes" {
			ok["nodes"] = up
		} else if name == "get_downstream_nodes" {
			ok["nodes"] = down
		} else {
			ok["upstream"] = up
			ok["downstream"] = down
		}
		return ok, nil
	case "read_skill_file":
		sid := util.Clean(args["skillId"])
		for _, skill := range w.skills {
			if skill.ID == sid {
				content, err := w.service.skills.ReadFile(canvasAgentOwner(w.identity), sid, util.Clean(args["path"]))
				return map[string]any{"ok": err == nil, "content": content}, err
			}
		}
		return agentError("skill_not_selected", "只能读取本轮已选择的 Skill"), nil
	case "update_plan":
		seen := map[string]bool{}
		running := 0
		for _, step := range util.AsMapSlice(args["steps"]) {
			key := util.Clean(step["id"])
			if seen[key] {
				return agentError("invalid_plan", "计划 ID 重复"), nil
			}
			seen[key] = true
			if step["status"] == "in_progress" {
				running++
			}
		}
		if running > 1 {
			return agentError("invalid_plan", "最多一个进行中的步骤"), nil
		}
		w.state["plan"] = args
		return ok, nil
	case "set_agent_state":
		for _, key := range []string{"approvedNodeIds", "referenceNodeIds"} {
			for _, nid := range agentStrings(args[key]) {
				if w.node(nid) == nil {
					return w.canvasChangedResult("引用的节点已不在当前画布中，正在重新核对可用素材"), nil
				}
			}
		}
		for k, v := range args {
			w.state[k] = v
		}
		return ok, nil
	case "update_node", "update_text_node":
		n := w.node(id)
		if name == "update_text_node" && n.Type != "text" {
			return agentError("invalid_node_type", "只能修改文本节点正文"), nil
		}
		if title := util.Clean(args["title"]); title != "" {
			n.Title = title
		}
		if content, exists := args["content"].(string); exists {
			n.Prompt = content
			n.GenerationStatus = "success"
		}
		ok["nodeId"] = id
		return ok, nil
	case "create_primary_script_node", "create_text_node":
		sources := agentStrings(args["sourceNodeIds"])
		if err := w.sourcesExist(sources); err != nil {
			return nil, err
		}
		n := w.newNode("text", util.Clean(args["title"]), util.Clean(args["content"]))
		n.GenerationStatus = "success"
		n.FontSize = 14
		if name == "create_primary_script_node" {
			n.Width = 550
			n.Height = 600
			if w.doc.AgentAutoTitlePending {
				w.doc.Title = util.Clean(args["projectTitle"])
			}
		}
		w.addNode(n, sources)
		ok["nodeId"] = n.ID
		ok["status"] = n.GenerationStatus
		return ok, nil
	case "create_connection":
		from, to := util.Clean(args["fromNodeId"]), util.Clean(args["toNodeId"])
		if err := w.sourcesExist([]string{from, to}); err != nil {
			return nil, err
		}
		if from == to || w.node(from).Type == "group" || w.node(to).Type == "group" || w.node(from).Type == "config" && w.node(to).Type == "config" {
			return agentError("invalid_connection", "这些节点不能连接"), nil
		}
		for _, c := range w.doc.Connections {
			if c.FromNodeID == from && c.ToNodeID == to {
				ok["connectionId"] = c.ID
				return ok, nil
			}
		}
		c := CanvasConnection{ID: newCanvasProjectID(), FromNodeID: from, ToNodeID: to}
		w.doc.Connections = append(w.doc.Connections, c)
		ok["connectionId"] = c.ID
		return ok, nil
	case "delete_connection":
		cid := util.Clean(args["connectionId"])
		before := len(w.doc.Connections)
		w.doc.Connections = slices.DeleteFunc(w.doc.Connections, func(c CanvasConnection) bool { return c.ID == cid })
		if before == len(w.doc.Connections) {
			return agentError("connection_not_found", "找不到连线"), nil
		}
		return ok, nil
	case "create_group":
		ids := agentStrings(args["nodeIds"])
		if len(ids) < 2 {
			return agentError("invalid_group", "至少选择两个节点"), nil
		}
		if err := w.sourcesExist(ids); err != nil {
			return nil, err
		}
		minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		seen := map[string]bool{}
		for _, nid := range ids {
			n := w.node(nid)
			if seen[nid] || n.GroupID != "" || n.Type == "group" {
				return agentError("invalid_group", "请选择未分组的普通节点"), nil
			}
			seen[nid] = true
			minX = math.Min(minX, n.X)
			minY = math.Min(minY, n.Y)
			maxX = math.Max(maxX, n.X+n.Width)
			maxY = math.Max(maxY, n.Y+n.Height)
		}
		g := w.newNode("group", util.Clean(args["title"]), "")
		g.X = minX - 24
		g.Y = minY - 48
		g.Width = maxX - minX + 48
		g.Height = maxY - minY + 72
		for _, nid := range ids {
			w.node(nid).GroupID = g.ID
		}
		w.doc.Nodes = append(w.doc.Nodes, g)
		ok["groupId"] = g.ID
		return ok, nil
	case "arrange_nodes":
		if !containsAny(w.req.UserText, "整理", "排列", "布局", "arrange") {
			return agentError("action_not_requested", "用户没有要求整理画布"), nil
		}
		ids := agentStrings(args["nodeIds"])
		if err := w.sourcesExist(ids); err != nil {
			return nil, err
		}
		index := 0
		for i := range w.doc.Nodes {
			n := &w.doc.Nodes[i]
			if len(ids) > 0 && !slices.Contains(ids, n.ID) || len(ids) == 0 && n.GroupID != "" {
				continue
			}
			x, y := float64(index%4)*640, float64(index/4)*720
			dx, dy := x-n.X, y-n.Y
			if n.Type == "group" {
				for j := range w.doc.Nodes {
					child := &w.doc.Nodes[j]
					if child.GroupID == n.ID && !slices.Contains(ids, child.ID) {
						child.X += dx
						child.Y += dy
					}
				}
			}
			n.X = x
			n.Y = y
			index++
		}
		return ok, nil
	case "generate_image", "edit_image", "generate_video", "generate_audio":
		return w.createMedia(name, args)
	case "generate_node":
		return w.generateNode(id)
	}
	return agentError("unsupported_tool", "未实现工具 "+name), nil
}
func (w *canvasAgentWorker) sourcesExist(ids []string) error {
	for _, id := range ids {
		if w.node(id) == nil {
			return fmt.Errorf("找不到来源节点 %s", id)
		}
	}
	return nil
}
func (w *canvasAgentWorker) newNode(kind, title, prompt string) CanvasNode {
	x := 0.0
	y := 0.0
	for _, n := range w.doc.Nodes {
		if n.X+n.Width+72 > x {
			x = n.X + n.Width + 72
			y = n.Y
		}
	}
	return CanvasNode{ID: kind + "-" + newCanvasProjectID(), Type: kind, X: x, Y: y, Width: 360, Height: 360, ScaleX: 1, ScaleY: 1, Title: title, Prompt: prompt, CreatedAt: util.NowISO(), GenerationStatus: "idle"}
}
func (w *canvasAgentWorker) addNode(n CanvasNode, sources []string) {
	w.doc.Nodes = append(w.doc.Nodes, n)
	for _, source := range sources {
		w.doc.Connections = append(w.doc.Connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: source, ToNodeID: n.ID})
	}
	w.doc.AgentAutoTitlePending = false
}
func (w *canvasAgentWorker) deleteNode(id string) map[string]any {
	if w.node(id) == nil {
		return agentError("node_not_found", "找不到节点")
	}
	removed := canvasAgentRemovalIDs(w.doc.Nodes, id)
	w.doc.Nodes = slices.DeleteFunc(w.doc.Nodes, func(n CanvasNode) bool { return removed[n.ID] })
	w.doc.Connections = slices.DeleteFunc(w.doc.Connections, func(c CanvasConnection) bool { return removed[c.FromNodeID] || removed[c.ToNodeID] })
	return map[string]any{"ok": true, "deletedNodeId": id, "deletedCount": len(removed)}
}
func (w *canvasAgentWorker) createMedia(name string, args map[string]any) (map[string]any, error) {
	kind := "image"
	if name == "generate_video" {
		kind = "video"
	}
	if name == "generate_audio" {
		kind = "audio"
	}
	model := util.Clean(w.req.Generation[kind+"Model"])
	if model == "" {
		return agentError("model_not_configured", "请配置"+kind+"模型"), nil
	}
	sources, err := w.resolveMediaReferences(agentStrings(args["sourceNodeIds"]), agentStrings(args["attachmentIds"]))
	if err != nil {
		return nil, err
	}
	n := w.newNode(kind, util.Clean(args["title"]), util.Clean(args["prompt"]))
	n.ExcludeUpstreamText = true
	if name == "edit_image" && len(sources.Images) == 0 {
		return agentError("image_reference_required", "图片编辑需要图片来源"), nil
	}
	switch kind {
	case "image":
		n.GenerationModel = model
		n.GenerationSize = util.Clean(args["size"])
		n.GenerationCount = util.ToInt(args["count"], 1)
		n.GenerationQuality = util.Clean(args["quality"])
		n.GenerationResolution = util.Clean(args["resolution"])
		n.GenerationReferenceURLs = sources.Images
	case "video":
		n.GenerationVideoModel = model
		n.GenerationVideoSize = util.Clean(args["size"])
		n.GenerationVideoSeconds = util.ToInt(args["seconds"], 0)
		n.GenerationVideoResolution = util.Clean(args["resolution"])
		audio, _ := args["generateAudio"].(bool)
		n.GenerationVideoAudio = &audio
		n.GenerationVideoReferenceImages = sources.Images
		n.GenerationVideoReferenceURLs = sources.Videos
		n.GenerationVideoReferenceAudio = sources.Audios
		n.GenerationVideoReferenceMode = "reference"
	case "audio":
		n.GenerationAudioModel = model
		n.GenerationAudioVoice = util.Clean(args["voice"])
		if n.GenerationAudioVoice == "" {
			n.GenerationAudioVoice = util.Clean(w.req.Generation["audioVoice"])
		}
		n.GenerationAudioInstructions = util.Clean(args["instructions"])
		n.GenerationAudioFormat = util.Clean(w.req.Generation["audioFormat"])
		n.GenerationAudioSpeed = 1
		if speed, valid := w.req.Generation["audioSpeed"].(float64); valid {
			n.GenerationAudioSpeed = speed
		}
	}
	if err := w.validateMedia(n); err != nil {
		return agentError("invalid_media_parameters", err.Error()), nil
	}
	w.addNode(n, sources.NodeIDs)
	if w.activeCall != nil {
		w.record(w.activeCall, map[string]any{"ok": true, "nodeId": n.ID, "status": "idle", "submitted": false})
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	return w.generateNode(n.ID)
}

type canvasAgentMediaReferences struct {
	NodeIDs []string
	Images  []string
	Videos  []string
	Audios  []string
}

func (w *canvasAgentWorker) resolveMediaReferences(nodeIDs, attachmentIDs []string) (canvasAgentMediaReferences, error) {
	result := canvasAgentMediaReferences{NodeIDs: []string{}, Images: []string{}, Videos: []string{}, Audios: []string{}}
	seenNodes, seenAttachments := map[string]bool{}, map[string]bool{}
	add := func(kind, url string) {
		if url == "" {
			return
		}
		switch kind {
		case "image", "panorama":
			result.Images = append(result.Images, url)
		case "video":
			result.Videos = append(result.Videos, url)
		case "audio":
			result.Audios = append(result.Audios, url)
		}
	}
	for _, nodeID := range nodeIDs {
		if seenNodes[nodeID] {
			return result, fmt.Errorf("重复的来源节点 %s", nodeID)
		}
		seenNodes[nodeID] = true
		node := w.node(nodeID)
		if node == nil {
			return result, fmt.Errorf("找不到来源节点 %s", nodeID)
		}
		result.NodeIDs = append(result.NodeIDs, nodeID)
		add(node.Type, node.URL)
	}
	for _, attachmentID := range attachmentIDs {
		if seenAttachments[attachmentID] {
			return result, fmt.Errorf("重复的附件 %s", attachmentID)
		}
		seenAttachments[attachmentID] = true
		ref, err := canvasAgentReference(w.doc, w.session, attachmentID, "attachment")
		if err != nil {
			return result, err
		}
		add(util.Clean(ref["type"]), util.Clean(ref["url"]))
	}
	return result, nil
}
func (w *canvasAgentWorker) validateMedia(n CanvasNode) error {
	caps := agentMap(agentMap(w.req.Generation["capabilities"])[n.Type])
	size, resolution := n.GenerationSize, n.GenerationResolution
	if n.Type == "image" {
		if limit := util.ToInt(caps["maxCount"], 15); n.GenerationCount < 1 || n.GenerationCount > limit {
			return fmt.Errorf("图片数量超出模型上限")
		}
		if limit := util.ToInt(caps["maxReferenceImages"], canvasDocumentMaxGenerationReferenceImages); len(n.GenerationReferenceURLs) > limit || len(n.GenerationReferenceURLs) > canvasDocumentMaxGenerationReferenceImages {
			return fmt.Errorf("参考图超出当前图片模型或画布节点上限")
		}
		if n.GenerationQuality != "" && !slices.Contains(agentStrings(caps["qualities"]), n.GenerationQuality) {
			return fmt.Errorf("模型不支持此画质")
		}
		if size == "" {
			return fmt.Errorf("请先确认图片尺寸")
		}
	}
	if n.Type == "video" {
		size = n.GenerationVideoSize
		resolution = n.GenerationVideoResolution
		if !slices.Contains(agentStrings(caps["sizes"]), size) {
			return fmt.Errorf("模型不支持此视频尺寸")
		}
		if n.GenerationVideoSeconds < 1 || n.GenerationVideoAudio == nil {
			return fmt.Errorf("请先确认视频时长和声音需求")
		}
		audio := util.Clean(caps["audioControl"])
		if audio == "none" && *n.GenerationVideoAudio || audio == "always" && !*n.GenerationVideoAudio {
			return fmt.Errorf("模型不支持此声音设置")
		}
	}
	if resolution != "" && !slices.Contains(agentStrings(caps["resolutions"]), resolution) {
		return fmt.Errorf("模型不支持此分辨率")
	}
	return nil
}

type canvasAgentGeneration struct {
	node      CanvasNode
	submitted CanvasDocument
	metadata  map[string]any
}

func (w *canvasAgentWorker) generateNode(id string) (map[string]any, error) {
	job, result, err := w.prepareGeneration(id)
	if err != nil || job == nil {
		return result, err
	}
	task, err := w.service.media(w.ctx, w.identity, job.node, job.metadata)
	return w.finishGeneration(job, task, err)
}

func (w *canvasAgentWorker) prepareGeneration(id string) (*canvasAgentGeneration, map[string]any, error) {
	n := w.node(id)
	if n == nil {
		return nil, w.canvasChangedResult("目标节点已被移除，未提交生成"), nil
	}
	if w.canvasChanged {
		result := w.canvasChangedResult("画布已变化，本次未发起新的生成请求，正在重新核对素材和参数")
		result["submitted"], result["taskId"] = false, n.TaskID
		return nil, result, nil
	}
	if slices.Contains(agentStrings(w.state["detachedTaskIds"]), n.TaskID) {
		result := w.canvasChangedResult("该节点的原生成任务已结束，但生成期间内容发生变化，原结果未覆盖节点。请先与用户确认如何处理，不要重复提交")
		result["taskId"], result["submitted"] = n.TaskID, true
		return nil, result, nil
	}
	if !slices.Contains([]string{"image", "video", "audio"}, n.Type) {
		return nil, agentError("invalid_media_node", "仅支持图片、视频和音频节点"), nil
	}
	if n.GenerationStatus == "success" && n.URL != "" {
		return nil, map[string]any{"ok": true, "nodeId": id, "status": "success", "taskId": n.TaskID}, nil
	}
	reviewNodeIDs := w.workflowReviewNodeIDs()
	if len(reviewNodeIDs) > 0 && (!slices.Contains(reviewNodeIDs, id) || !w.workflowReviewApproved(id)) {
		return nil, map[string]any{"ok": false, "nodeId": id, "submitted": false, "requiresUserReview": true, "message": "请先让用户审核对应系列提示词并明确确认，之后才能提交媒体生成"}, nil
	}
	if !w.autoMedia() {
		return nil, map[string]any{"ok": true, "nodeId": id, "status": "idle", "submitted": false, "message": "节点已保存，尚未提交媒体生成。"}, nil
	}
	previousTaskID, previousStatus := n.TaskID, n.GenerationStatus
	if n.TaskID == "" || n.GenerationStatus == "error" {
		n.TaskID = "canvas-agent-media-" + newCanvasProjectID()
	}
	n.GenerationStatus = "loading"
	n.GenerationError = ""
	taskID := n.TaskID
	pending := agentStrings(w.state["pendingTaskIds"])
	if !slices.Contains(pending, taskID) {
		w.state["pendingTaskIds"] = append(pending, taskID)
	}
	node := *n
	if !node.ExcludeUpstreamText {
		context := []string{}
		for _, connection := range w.doc.Connections {
			if connection.ToNodeID == id {
				if source := w.node(connection.FromNodeID); source != nil && source.Type == "text" && source.Prompt != "" {
					context = append(context, source.Prompt)
				}
			}
		}
		if len(context) > 0 {
			node.Prompt = strings.Join(context, "\n\n") + "\n\n" + node.Prompt
		}
	}
	if w.activeCall != nil {
		w.record(w.activeCall, map[string]any{"ok": true, "nodeId": id, "taskId": taskID, "status": "loading", "submitted": true})
	}
	beforeSubmission := cloneCanvasAgentDocument(w.doc)
	if err := w.save(); err != nil {
		return nil, nil, err
	}
	if w.canvasChanged || canvasAgentGenerationChanged(beforeSubmission, w.doc, id) {
		if previousTaskID != taskID {
			w.state["pendingTaskIds"] = slices.DeleteFunc(agentStrings(w.state["pendingTaskIds"]), func(id string) bool { return id == taskID })
		}
		if current := w.node(id); current != nil && current.TaskID == taskID {
			current.TaskID = previousTaskID
			if current.GenerationStatus == "loading" {
				current.GenerationStatus = firstAgentString(previousStatus, "idle")
			}
		}
		result := w.canvasChangedResult("目标节点或依赖素材已变化，未提交生成，正在重新核对")
		result["submitted"] = false
		result["taskId"] = previousTaskID
		return nil, result, nil
	}
	return &canvasAgentGeneration{node: node, submitted: cloneCanvasAgentDocument(w.doc), metadata: map[string]any{"relay_token_name": w.req.RelayTokens[node.Type], "generation_source": "canvas", "frontend_conversation_id": w.doc.ID}}, nil, nil
}

func (w *canvasAgentWorker) finishGeneration(job *canvasAgentGeneration, task map[string]any, err error) (map[string]any, error) {
	node, submitted := job.node, job.submitted
	id, taskID := node.ID, node.TaskID
	if w.ctx.Err() != nil {
		return nil, w.ctx.Err()
	}
	if saveErr := w.save(); saveErr != nil {
		return nil, saveErr
	}
	if canvasAgentGenerationChanged(submitted, w.doc, id) {
		w.state["pendingTaskIds"] = slices.DeleteFunc(agentStrings(w.state["pendingTaskIds"]), func(id string) bool { return id == taskID })
		w.state["detachedTaskIds"] = append(agentStrings(w.state["detachedTaskIds"]), taskID)
		if err == nil {
			w.state["completedTaskIds"] = append(agentStrings(w.state["completedTaskIds"]), taskID)
		}
		if current := w.node(id); current != nil && current.TaskID == taskID && current.GenerationStatus == "loading" {
			current.GenerationStatus = "idle"
			current.GenerationProgress = 0
		}
		result := w.canvasChangedResult("生成期间目标节点或依赖素材发生变化，已保留你的修改，原任务不会自动重试，结果未写回画布")
		result["taskId"], result["submitted"], result["resultAvailable"] = taskID, true, err == nil
		return result, nil
	}
	n := w.node(id)
	if err != nil {
		if w.ctx.Err() == nil {
			n.GenerationStatus = "error"
			n.GenerationError = err.Error()
			_ = w.save()
		}
		return nil, err
	}
	data := util.AsMapSlice(task["data"])
	mediaURL := func(item map[string]any) string {
		for _, key := range []string{"url", "video_url", "audio_url"} {
			if url := util.Clean(item[key]); url != "" {
				return url
			}
		}
		return ""
	}
	// Validate the whole result before touching node state, and always release the pending task.
	failEmpty := func(message string) (map[string]any, error) {
		n.GenerationStatus = "error"
		n.GenerationError = message
		w.state["pendingTaskIds"] = slices.DeleteFunc(agentStrings(w.state["pendingTaskIds"]), func(id string) bool { return id == taskID })
		return agentError("empty_media", message), nil
	}
	if len(data) == 0 {
		return failEmpty("任务没有返回媒体结果")
	}
	for _, item := range data {
		if mediaURL(item) == "" {
			return failEmpty("任务没有返回可用媒体地址")
		}
	}
	n.GenerationStatus = "success"
	n.GenerationProgress = 100
	sources := []string{}
	for _, edge := range w.doc.Connections {
		if edge.ToNodeID == id {
			sources = append(sources, edge.FromNodeID)
		}
	}
	for i, item := range data {
		url := mediaURL(item)
		if i == 0 {
			n.URL = url
			n.StorageKey = util.Clean(item["storageKey"])
			n.NaturalWidth = util.ToInt(item["width"], 0)
			n.NaturalHeight = util.ToInt(item["height"], 0)
		} else {
			child := *n
			child.ID = node.Type + "-" + newCanvasProjectID()
			child.URL = url
			child.StorageKey = util.Clean(item["storageKey"])
			child.Y += float64(i) * (child.Height + 72)
			w.addNode(child, sources)
		}
	}
	w.state["pendingTaskIds"] = slices.DeleteFunc(agentStrings(w.state["pendingTaskIds"]), func(id string) bool { return id == taskID })
	w.state["completedTaskIds"] = append(agentStrings(w.state["completedTaskIds"]), taskID)
	w.clearWorkflowReview([]string{id})
	return map[string]any{"ok": true, "nodeId": id, "taskId": taskID, "status": "success", "submitted": true}, nil
}
