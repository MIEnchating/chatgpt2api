package service

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
)

func (s *CanvasAgentService) SetWorkflowService(workflows *WorkflowService) { s.workflows = workflows }

func (w *canvasAgentWorker) workflow(id string) (CreativeWorkflow, error) {
	if w.service.workflows == nil {
		return CreativeWorkflow{}, fmt.Errorf("工作流服务不可用")
	}
	items, err := w.service.workflows.List(canvasAgentOwner(w.identity))
	if err != nil {
		return CreativeWorkflow{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return CreativeWorkflow{}, ErrWorkflowNotFound
}
func (w *canvasAgentWorker) workflowTool(name string, args map[string]any) (map[string]any, error) {
	switch name {
	case "create_canvas_workflow":
		return w.createGroupedCanvasWorkflow(util.AsMapSlice(args["steps"]), util.Clean(args["groupTitle"]))
	case "run_canvas_workflow":
		return w.runCanvasWorkflow(agentStrings(args["nodeIds"]))
	case "list_workflows":
		if w.service.workflows == nil {
			return nil, fmt.Errorf("工作流服务不可用")
		}
		items, err := w.service.workflows.List(canvasAgentOwner(w.identity))
		if err != nil {
			return nil, err
		}
		out := []map[string]any{}
		keyword := strings.ToLower(util.Clean(args["keyword"]))
		for _, item := range items {
			if keyword != "" && !strings.Contains(strings.ToLower(item.Name+" "+item.Description), keyword) {
				continue
			}
			out = append(out, map[string]any{"id": item.ID, "name": item.Name, "description": item.Description, "mode": item.Mode, "revision": item.Revision, "editable": item.Editable})
		}
		return map[string]any{"ok": true, "workflows": out}, nil
	case "get_workflow":
		item, err := w.workflow(util.Clean(args["workflowId"]))
		return map[string]any{"ok": err == nil, "workflow": item}, err
	case "save_workflow":
		if w.service.workflows == nil {
			return nil, fmt.Errorf("工作流服务不可用")
		}
		item := CreativeWorkflow{Scope: "private"}
		if id := util.Clean(args["workflowId"]); id != "" {
			var err error
			item, err = w.workflow(id)
			if err != nil {
				return nil, err
			}
			if item.OwnerID != canvasAgentOwner(w.identity) || item.Scope != "private" {
				return nil, ErrWorkflowAccessDenied
			}
			if item.Revision != int64(util.ToInt(args["revision"], -1)) {
				return nil, fmt.Errorf("工作流已变化，请重新读取后修改")
			}
		}
		item.Name = util.Clean(args["name"])
		item.Description = util.Clean(args["description"])
		item.Mode = util.Clean(args["mode"])
		item.Config.PromptTemplate = util.Clean(args["promptTemplate"])
		item.Variables = []WorkflowVariable{}
		for _, v := range util.AsMapSlice(args["variables"]) {
			item.Variables = append(item.Variables, WorkflowVariable{Key: util.Clean(v["key"]), Label: util.Clean(v["label"]), Type: "text", Required: util.ToBool(v["required"]), DefaultValue: util.Clean(v["defaultValue"]), Options: []string{}})
		}
		saved, err := w.service.workflows.Save(canvasAgentOwner(w.identity), item)
		return map[string]any{"ok": err == nil, "workflowId": saved.ID, "revision": saved.Revision}, err
	case "run_saved_workflow":
		return w.runSavedWorkflow(args)
	}
	return nil, fmt.Errorf("未知工作流操作")
}

var agentWorkflowVariable = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}`)

func (w *canvasAgentWorker) runSavedWorkflow(args map[string]any) (map[string]any, error) {
	item, err := w.workflow(util.Clean(args["workflowId"]))
	if err != nil {
		return nil, err
	}
	entries := util.AsMapSlice(args["items"])
	if item.Mode == "single_image" && len(entries) != 1 {
		return nil, fmt.Errorf("此工作流只接受一份输入")
	}
	prompts := []string{}
	for _, entry := range entries {
		values := map[string]string{}
		known := map[string]WorkflowVariable{}
		for _, v := range item.Variables {
			known[v.Key] = v
			values[v.Key] = v.DefaultValue
		}
		seen := map[string]bool{}
		for _, v := range util.AsMapSlice(entry["values"]) {
			key := util.Clean(v["key"])
			if _, ok := known[key]; !ok || seen[key] {
				return nil, fmt.Errorf("未知或重复的工作流变量 %s", key)
			}
			seen[key] = true
			values[key] = util.Clean(v["value"])
		}
		for _, v := range item.Variables {
			if v.Required && strings.TrimSpace(values[v.Key]) == "" {
				return nil, fmt.Errorf("请先询问用户必填参数：%s", v.Label)
			}
		}
		missing := ""
		prompt := agentWorkflowVariable.ReplaceAllStringFunc(item.Config.PromptTemplate, func(match string) string {
			key := agentWorkflowVariable.FindStringSubmatch(match)[1]
			value, ok := values[key]
			if !ok {
				missing = key
			}
			return value
		})
		if missing != "" {
			return nil, fmt.Errorf("模板引用了未定义变量 %s", missing)
		}
		if prompt == "" {
			return nil, fmt.Errorf("工作流生成内容为空")
		}
		if item.Config.SystemPrompt != "" {
			prompt = item.Config.SystemPrompt + "\n" + prompt
		}
		if item.Config.NegativePrompt != "" {
			prompt += "\n避免：" + item.Config.NegativePrompt
		}
		prompts = append(prompts, prompt)
	}
	steps := []map[string]any{}
	for i, entry := range entries {
		references, referenceErr := w.resolveMediaReferences(agentStrings(entry["sourceNodeIds"]), agentStrings(entry["attachmentIds"]))
		if referenceErr != nil {
			return nil, referenceErr
		}
		if len(item.TemplateReferences) > 0 && len(references.Images) == 0 {
			return nil, fmt.Errorf("此工作流需要至少一张产品图片作为参考")
		}
		selectedReferences := item.TemplateReferences
		if item.Mode == "multi_image_series" {
			selectedReferences = item.TemplateReferences[:min(1, len(item.TemplateReferences))]
		}
		templateURLs := make([]string, 0, len(selectedReferences))
		for _, ref := range selectedReferences {
			templateURLs = append(templateURLs, ref.URL)
		}
		if len(templateURLs)+len(references.Images) > canvasDocumentMaxGenerationReferenceImages {
			return nil, fmt.Errorf("参考图超出当前画布节点上限 %d 张", canvasDocumentMaxGenerationReferenceImages)
		}
		prompt := prompts[i]
		if len(selectedReferences) > 0 {
			prompt = canvasAgentWorkflowReferencePrompt(prompt, selectedReferences, len(references.Images))
		}
		steps = append(steps, map[string]any{"key": fmt.Sprint(i), "type": "image", "title": firstAgentString(util.Clean(entry["title"]), item.Name), "prompt": prompt, "dependsOn": []string{}, "sourceNodeIds": references.NodeIDs, "attachmentIds": agentStrings(entry["attachmentIds"]), "templateReferenceURLs": templateURLs, "workflowReviewRequired": item.Mode == "multi_image_series" && item.SeriesConfig.ReviewRequired, "size": entry["size"], "count": entry["count"]})
	}
	created, err := w.createGroupedCanvasWorkflow(steps, item.Name)
	if err != nil || created["ok"] != true {
		return created, err
	}
	ids := agentStrings(created["nodeIds"])
	if item.Mode == "multi_image_series" && item.SeriesConfig.ReviewRequired {
		return created, nil
	}
	if !w.autoMedia() {
		return created, nil
	}
	result, err := w.runCanvasWorkflow(ids)
	if err == nil {
		_, err = w.service.workflows.TouchLastRun(canvasAgentOwner(w.identity), item.ID, util.NowISO())
	}
	return result, err
}

func canvasAgentWorkflowReferencePrompt(prompt string, templates []WorkflowTemplateReference, productCount int) string {
	templateNames := make([]string, 0, len(templates))
	for _, item := range templates {
		templateNames = append(templateNames, item.Name)
	}
	parts := []string{prompt, "参考图使用规则：", fmt.Sprintf("- 前 %d 张是风格模板图（%s），只参考版式、构图、色彩、光影与字体层级；不要复制模板中的旧商品、品牌、Logo、文案、价格或参数。", len(templates), strings.Join(templateNames, "、"))}
	if productCount > 0 {
		parts = append(parts, fmt.Sprintf("- 后 %d 张是本次新产品实拍图；商品的外观、颜色、材质、结构、包装与品牌信息以实拍图为准。", productCount), "- 把新产品自然融入模板的视觉体系，保持商品身份准确并生成全新画面。")
	}
	return strings.Join(parts, "\n\n")
}
func firstAgentString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (w *canvasAgentWorker) createGroupedCanvasWorkflow(steps []map[string]any, title string) (map[string]any, error) {
	result, err := w.createCanvasWorkflow(steps)
	if err != nil || title == "" || len(steps) < 2 {
		return result, err
	}
	if w.canvasChanged {
		return w.canvasChangedResult("画布已变化，新建节点已保留，分组前需要重新核对"), nil
	}
	group, err := w.tool(map[string]any{"name": "create_group", "arguments": map[string]any{"title": title, "nodeIds": result["nodeIds"]}})
	if err != nil {
		return nil, err
	}
	if group["ok"] != true {
		return group, nil
	}
	result["groupId"] = group["groupId"]
	if w.activeCall != nil {
		w.record(w.activeCall, result)
	}
	return result, w.save()
}

// Validate the complete graph before assigning it to the persisted document.
func (w *canvasAgentWorker) createCanvasWorkflow(steps []map[string]any) (map[string]any, error) {
	nodes := []CanvasNode{}
	keys := map[string]string{}
	deps := map[string][]string{}
	sources := map[string][]string{}
	externalRefs := map[string]canvasAgentMediaReferences{}
	origin := w.newNode("text", "", "")
	for i, step := range steps {
		key := util.Clean(step["key"])
		kind := util.Clean(step["type"])
		if key == "" || keys[key] != "" {
			return nil, fmt.Errorf("工作流步骤 key 为空或重复")
		}
		n := w.newNode(kind, util.Clean(step["title"]), util.Clean(step["prompt"]))
		n.X = origin.X + float64(i%3)*440
		n.Y = origin.Y + float64(i/3)*440
		references, err := w.resolveMediaReferences(agentStrings(step["sourceNodeIds"]), agentStrings(step["attachmentIds"]))
		if err != nil {
			return nil, err
		}
		sources[key] = references.NodeIDs
		externalRefs[key] = references
		switch kind {
		case "text":
			n.GenerationStatus = "success"
			n.FontSize = 14
		case "image":
			n.GenerationModel = util.Clean(w.req.Generation["imageModel"])
			n.GenerationSize = util.Clean(step["size"])
			n.GenerationCount = util.ToInt(step["count"], 0)
			n.GenerationResolution = util.Clean(step["resolution"])
			n.GenerationReferenceURLs = append(agentStrings(step["templateReferenceURLs"]), references.Images...)
			if n.GenerationModel == "" {
				return nil, fmt.Errorf("请配置图片模型")
			}
		case "video":
			n.GenerationVideoModel = util.Clean(w.req.Generation["videoModel"])
			n.GenerationVideoSize = util.Clean(step["size"])
			n.GenerationVideoSeconds = util.ToInt(step["seconds"], 0)
			n.GenerationVideoResolution = util.Clean(step["resolution"])
			n.GenerationVideoReferenceMode = "reference"
			n.GenerationVideoReferenceImages = references.Images
			n.GenerationVideoReferenceURLs = references.Videos
			n.GenerationVideoReferenceAudio = references.Audios
			if audio, ok := step["generateAudio"].(bool); ok {
				n.GenerationVideoAudio = &audio
			}
			if n.GenerationVideoModel == "" {
				return nil, fmt.Errorf("请配置视频模型")
			}
		case "audio":
			n.GenerationAudioModel = util.Clean(w.req.Generation["audioModel"])
			n.GenerationAudioVoice = firstAgentString(util.Clean(step["voice"]), util.Clean(w.req.Generation["audioVoice"]))
			n.GenerationAudioFormat = util.Clean(w.req.Generation["audioFormat"])
			n.GenerationAudioSpeed = 1
			if n.GenerationAudioModel == "" {
				return nil, fmt.Errorf("请配置音频模型")
			}
		default:
			return nil, fmt.Errorf("不支持此工作流节点类型")
		}
		if kind != "text" {
			if err := w.validateMedia(n); err != nil {
				return nil, err
			}
		}
		if _, err := normalizeCanvasNode(n); err != nil {
			return nil, err
		}
		keys[key] = n.ID
		deps[key] = agentStrings(step["dependsOn"])
		nodes = append(nodes, n)
	}
	connections := []CanvasConnection{}
	workflowConnections := []CanvasConnection{}
	for key, dependencies := range deps {
		seen := map[string]bool{}
		for _, dependency := range dependencies {
			if keys[dependency] == "" || dependency == key || seen[dependency] {
				return nil, fmt.Errorf("工作流依赖不存在、重复或自引用")
			}
			seen[dependency] = true
			connection := CanvasConnection{ID: newCanvasProjectID(), FromNodeID: keys[dependency], ToNodeID: keys[key]}
			connections = append(connections, connection)
			workflowConnections = append(workflowConnections, connection)
		}
	}
	for key, nodeIDs := range sources {
		for _, nodeID := range nodeIDs {
			connections = append(connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: nodeID, ToNodeID: keys[key]})
		}
	}
	ids := []string{}
	for _, n := range nodes {
		ids = append(ids, n.ID)
	}
	workflowReviewNodeIDs := []string{}
	for i, step := range steps {
		if step["workflowReviewRequired"] == true {
			workflowReviewNodeIDs = append(workflowReviewNodeIDs, nodes[i].ID)
		}
	}
	if _, err := agentWorkflowOrder(ids, nodes, workflowConnections); err != nil {
		return nil, err
	}
	before := w.doc
	w.doc.Nodes = append(slices.Clone(w.doc.Nodes), nodes...)
	w.doc.Connections = append(slices.Clone(w.doc.Connections), connections...)
	result := map[string]any{"ok": true, "nodeIds": ids, "nodes": nodes, "submitted": false, "message": "工作流已搭建，尚未提交媒体生成"}
	previousReview := w.state["pendingWorkflowReview"]
	if len(workflowReviewNodeIDs) > 0 {
		allReviewNodeIDs := agentStrings(agentMap(previousReview)["nodeIds"])
		for _, id := range workflowReviewNodeIDs {
			if !slices.Contains(allReviewNodeIDs, id) {
				allReviewNodeIDs = append(allReviewNodeIDs, id)
			}
		}
		w.state["pendingWorkflowReview"] = map[string]any{"nodeIds": allReviewNodeIDs}
		result["requiresUserReview"] = true
		result["message"] = "系列提示词已放入画布，请逐项审核并确认后再生成"
	}
	if w.activeCall != nil {
		w.record(w.activeCall, result)
	}
	if err := w.save(); err != nil {
		w.doc = before
		if previousReview == nil {
			delete(w.state, "pendingWorkflowReview")
		} else {
			w.state["pendingWorkflowReview"] = previousReview
		}
		return nil, err
	}
	return result, nil
}
func agentWorkflowOrder(ids []string, nodes []CanvasNode, connections []CanvasConnection) ([]string, error) {
	known := map[string]bool{}
	for _, n := range nodes {
		known[n.ID] = true
	}
	visited := map[string]int{}
	ordered := []string{}
	var visit func(string) error
	visit = func(id string) error {
		if !known[id] {
			return fmt.Errorf("找不到工作流节点 %s", id)
		}
		if visited[id] == 1 {
			return fmt.Errorf("工作流存在循环依赖")
		}
		if visited[id] == 2 {
			return nil
		}
		visited[id] = 1
		for _, c := range connections {
			if c.ToNodeID == id {
				if err := visit(c.FromNodeID); err != nil {
					return err
				}
			}
		}
		visited[id] = 2
		ordered = append(ordered, id)
		return nil
	}
	for _, id := range ids {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}
func (w *canvasAgentWorker) runCanvasWorkflow(ids []string) (map[string]any, error) {
	order, err := agentWorkflowOrder(ids, w.doc.Nodes, w.doc.Connections)
	if err != nil {
		return nil, err
	}
	if review := agentMap(w.state["pendingWorkflowReview"]); len(review) > 0 {
		reviewIDs := w.workflowReviewNodeIDs()
		hasReviewedTarget := false
		for _, id := range order {
			node := w.node(id)
			if canvasAgentWorkflowNodeReady(*node) {
				continue
			}
			if !slices.Contains(reviewIDs, id) {
				return map[string]any{"ok": false, "nodeIds": []string{id}, "submitted": false, "requiresUserReview": true, "message": "工作流包含未绑定到已审核系列提示词的媒体节点，未提交生成"}, nil
			}
			hasReviewedTarget = true
			if !w.workflowReviewApproved(id) {
				return map[string]any{"ok": false, "nodeIds": []string{id}, "submitted": false, "requiresUserReview": true, "message": "系列提示词尚未获得用户明确确认或审核后内容已改变，已保留节点且未提交生成"}, nil
			}
		}
		if !hasReviewedTarget {
			return map[string]any{"ok": false, "nodeIds": reviewIDs, "submitted": false, "requiresUserReview": true, "message": "请在确认系列提示词后执行对应的系列工作流节点"}, nil
		}
	}
	for _, id := range order {
		n := w.node(id)
		if !slices.Contains([]string{"text", "image", "video", "audio"}, n.Type) {
			return nil, fmt.Errorf("工作流包含不支持执行的节点 %s", n.Title)
		}
		if !canvasAgentWorkflowNodeReady(*n) {
			if err := w.validateMedia(*n); err != nil {
				return nil, err
			}
		}
	}
	if !w.autoMedia() {
		if err := w.save(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "nodeIds": order, "submitted": false, "message": "流程已就绪，等待媒体生成授权"}, nil
	}
	results, failure, err := w.runWorkflowGenerations(order)
	if err != nil {
		return nil, err
	}
	if failure != nil {
		failure["results"] = results
		return failure, nil
	}
	w.clearWorkflowReview(order)
	if err := w.save(); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "nodeIds": order, "results": results, "status": "success"}, nil
}

func (w *canvasAgentWorker) clearWorkflowReview(nodeIDs []string) {
	selected := map[string]bool{}
	for _, id := range nodeIDs {
		selected[id] = true
	}
	review := agentMap(w.state["pendingWorkflowReview"])
	remaining := slices.DeleteFunc(agentStrings(review["nodeIds"]), func(id string) bool { return selected[id] })
	if len(remaining) == 0 {
		delete(w.state, "pendingWorkflowReview")
	} else {
		w.state["pendingWorkflowReview"] = map[string]any{"nodeIds": remaining}
	}
	approvedPrompts := agentMap(w.state["approvedWorkflowReviewPrompts"])
	for id := range selected {
		delete(approvedPrompts, id)
	}
	if len(approvedPrompts) == 0 {
		delete(w.state, "approvedWorkflowReviewPrompts")
	} else {
		w.state["approvedWorkflowReviewPrompts"] = approvedPrompts
	}
}

func canvasAgentWorkflowReviewApproved(answer string) bool {
	answer = strings.TrimSpace(strings.ToLower(answer))
	answer = strings.NewReplacer(" ", "", "\t", "", "\n", "", "。", "", "！", "", "？", "", ",", "", "，", "", ".", "", "!", "", "?", "").Replace(answer)
	if answer == "" || containsAny(answer, "暂不", "稍后", "等等", "暂缓", "取消", "拒绝", "不生成", "不确认", "不通过", "先别", "先不", "修改", "不满意", "不同意", "还要改") {
		return false
	}
	if slices.Contains([]string{"确认", "通过", "同意", "批准", "开始", "可以", "好的", "好", "是", "是的", "yes", "ok", "okay"}, answer) {
		return true
	}
	return containsAny(answer, "确认", "通过", "同意", "批准", "没问题", "可以", "开始", "继续") && containsAny(answer, "审核", "提示词", "方案", "生成")
}

func (w *canvasAgentWorker) workflowReviewNodeIDs() []string {
	review := agentMap(w.state["pendingWorkflowReview"])
	nodeIDs := []string{}
	for _, id := range agentStrings(review["nodeIds"]) {
		if w.node(id) != nil && !slices.Contains(nodeIDs, id) {
			nodeIDs = append(nodeIDs, id)
		}
	}
	if len(nodeIDs) == 0 {
		delete(w.state, "pendingWorkflowReview")
		delete(w.state, "approvedWorkflowReviewPrompts")
	} else if !slices.Equal(nodeIDs, agentStrings(review["nodeIds"])) {
		w.state["pendingWorkflowReview"] = map[string]any{"nodeIds": nodeIDs}
		approved := agentMap(w.state["approvedWorkflowReviewPrompts"])
		for id := range approved {
			if !slices.Contains(nodeIDs, id) {
				delete(approved, id)
			}
		}
		if len(approved) == 0 {
			delete(w.state, "approvedWorkflowReviewPrompts")
		}
	}
	return nodeIDs
}

func (w *canvasAgentWorker) workflowReviewUnapprovedIDs() []string {
	unapproved := []string{}
	for _, id := range w.workflowReviewNodeIDs() {
		if !w.workflowReviewApproved(id) {
			unapproved = append(unapproved, id)
		}
	}
	return unapproved
}

func (w *canvasAgentWorker) workflowReviewApproved(id string) bool {
	node := w.node(id)
	if node == nil {
		return false
	}
	approved := util.Clean(agentMap(w.state["approvedWorkflowReviewPrompts"])[id])
	if approved == "" {
		return false
	}
	return approved == canvasAgentWorkflowFingerprint(*node)
}

func canvasAgentWorkflowFingerprint(node CanvasNode) string {
	content := agentJSON(map[string]any{
		"title": node.Title, "prompt": node.Prompt,
		"referenceURLs": node.GenerationReferenceURLs,
		"size":          node.GenerationSize, "quality": node.GenerationQuality,
		"resolution": node.GenerationResolution, "count": node.GenerationCount,
		"model": node.GenerationModel,
	})
	digest := sha256.Sum256([]byte(content))
	return hex.EncodeToString(digest[:])
}

func (w *canvasAgentWorker) approveWorkflowReview(nodeIDs []string) []string {
	pending := w.workflowReviewNodeIDs()
	approved := agentMap(w.state["approvedWorkflowReviewPrompts"])
	approvedIDs := []string{}
	for _, id := range nodeIDs {
		if !slices.Contains(pending, id) {
			continue
		}
		if node := w.node(id); node != nil {
			approved[id] = canvasAgentWorkflowFingerprint(*node)
			approvedIDs = append(approvedIDs, id)
		}
	}
	if len(approved) > 0 {
		w.state["approvedWorkflowReviewPrompts"] = approved
	}
	return approvedIDs
}
