package service

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	"chatgpt2api/internal/util"
)

func canvasScriptConfirmationFingerprint(node CanvasNode) string {
	if node.Type != "script" || node.ScriptProject == nil {
		return ""
	}
	project := *node.ScriptProject
	project.Confirmed, project.Step = false, 0
	return fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(map[string]any{"title": node.Title, "content": node.Prompt, "project": project}))))
}

// Script edits retain node identity and never alter media tasks or their inputs.
func (w *canvasAgentWorker) scriptTool(name string, args map[string]any) (map[string]any, error) {
	if name == "create_primary_script_node" || name == "create_script_node" {
		sources := agentStrings(args["sourceNodeIds"])
		if err := w.sourcesExist(sources); err != nil {
			return nil, err
		}
		node := w.newNode("script", util.Clean(args["title"]), util.Clean(args["content"]))
		node.Width, node.Height = 550, 600
		node.GenerationStatus = "success"
		node.ScriptProject = &CanvasScriptProject{Shots: []CanvasScriptShot{}, Assets: []CanvasScriptAsset{}}
		if name == "create_primary_script_node" && w.doc.AgentAutoTitlePending {
			w.doc.Title = util.Clean(args["projectTitle"])
		}
		w.addNode(node, sources)
		return map[string]any{"ok": true, "nodeId": node.ID, "node": agentNode(node, true)}, nil
	}
	node := w.node(util.Clean(args["nodeId"]))
	if node == nil || node.Type != "script" && node.Type != "text" {
		return agentError("invalid_node_type", "只能将现有文本主稿或脚本节点保存为结构化脚本"), nil
	}
	if node.GenerationStatus == "loading" || node.ScriptOperation != nil {
		return agentError("script_busy", "请先等待当前脚本或文本生成结束，再整理镜头"), nil
	}
	if name == "confirm_script_node" {
		if node.Type != "script" || node.ScriptProject == nil || len(node.ScriptProject.Shots) == 0 {
			return agentError("invalid_script", "请先保存完整结构化镜头，再核对并确认脚本"), nil
		}
		fingerprint := util.Clean(args["confirmationFingerprint"])
		if fingerprint == "" || fingerprint != canvasScriptConfirmationFingerprint(*node) {
			return w.canvasChangedResult("脚本已变化，请重新读取并核对当前脚本后确认"), nil
		}
		node.ScriptProject.Confirmed = true
		if err := w.save(); err != nil {
			return nil, err
		}
		node = w.node(util.Clean(args["nodeId"]))
		if node == nil || canvasScriptConfirmationFingerprint(*node) != fingerprint || !node.ScriptProject.Confirmed {
			return w.canvasChangedResult("确认期间脚本已变化，未确认旧版本，请重新读取当前脚本"), nil
		}
		return map[string]any{"ok": true, "nodeId": node.ID, "confirmed": true, "submitted": false}, nil
	}
	var project CanvasScriptProject
	input, valid := args["scriptProject"].(map[string]any)
	if err := json.Unmarshal([]byte(agentJSON(input)), &project); err != nil || !valid || input == nil {
		return agentError("invalid_script", "请提供完整的脚本镜头及素材结构"), nil
	}
	if project.Shots == nil {
		project.Shots = []CanvasScriptShot{}
	}
	if project.Assets == nil {
		project.Assets = []CanvasScriptAsset{}
	}
	for i := range project.Shots {
		project.Shots[i].QualityReview = nil
		if project.Shots[i].Dialogue == nil {
			project.Shots[i].Dialogue = []CanvasScriptDialogue{}
		}
		if project.Shots[i].AssetIDs == nil {
			project.Shots[i].AssetIDs = []string{}
		}
	}
	// Stable shot and asset IDs retain their existing bindings when editing content.
	if previous := node.ScriptProject; previous != nil {
		project.MergedVideoNodeID = previous.MergedVideoNodeID
		project.MergedVideoFingerprint = previous.MergedVideoFingerprint
		shotFields := util.AsMapSlice(input["shots"])
		for i := range project.Shots {
			for _, old := range previous.Shots {
				if project.Shots[i].ID != old.ID {
					continue
				}
				// Quality review belongs to the reviewer, not an agent's self-report.
				project.Shots[i].QualityReview = old.QualityReview
				if _, provided := shotFields[i]["image_prompt"]; !provided {
					project.Shots[i].ImagePrompt = old.ImagePrompt
				}
				if _, provided := shotFields[i]["video_prompt"]; !provided {
					project.Shots[i].VideoPrompt = old.VideoPrompt
				}
				if _, provided := shotFields[i]["image_prompt_outdated"]; !provided {
					project.Shots[i].ImagePromptOutdated = old.ImagePromptOutdated
				}
				if _, provided := shotFields[i]["video_prompt_outdated"]; !provided {
					project.Shots[i].VideoPromptOutdated = old.VideoPromptOutdated
				}
				if _, provided := shotFields[i]["source_node_id"]; !provided {
					project.Shots[i].SourceNodeID = old.SourceNodeID
				}
				if _, provided := shotFields[i]["image_node_id"]; !provided {
					project.Shots[i].ImageNodeID = old.ImageNodeID
				}
				if _, provided := shotFields[i]["video_node_id"]; !provided {
					project.Shots[i].VideoNodeID = old.VideoNodeID
				}
			}
		}
		assetFields := util.AsMapSlice(input["assets"])
		for i := range project.Assets {
			for _, old := range previous.Assets {
				_, provided := assetFields[i]["image_node_id"]
				if project.Assets[i].ID == old.ID && !provided {
					project.Assets[i].ImageNodeID = old.ImageNodeID
				}
			}
		}
	}
	reconcileCanvasScriptProject(node.ScriptProject, &project)

	next := *node
	next.Type, next.ScriptProject = "script", &project
	if err := validateCanvasScript(next); err != nil {
		return agentError("invalid_script", err.Error()), nil
	}
	media := map[string]bool{}
	for _, asset := range project.Assets {
		if err := w.scriptReference(asset.ImageNodeID, "image", next.ID); err != nil {
			return agentError("invalid_script_reference", err.Error()), nil
		}
	}
	for _, shot := range project.Shots {
		for kind, id := range map[string]string{"text": shot.SourceNodeID, "image": shot.ImageNodeID, "video": shot.VideoNodeID} {
			if err := w.scriptReference(id, kind, next.ID); err != nil {
				return agentError("invalid_script_reference", err.Error()), nil
			}
		}
		if shot.ImageNodeID != "" {
			media[shot.ImageNodeID] = true
		}
		if shot.VideoNodeID != "" {
			media[shot.VideoNodeID] = true
		}
	}
	if title := util.Clean(args["title"]); title != "" {
		next.Title = title
	}
	if content, exists := args["content"].(string); exists {
		next.Prompt = content
	}
	if node.Type == "text" {
		next.Width, next.Height = 550, 600
	}
	connections := canvasScriptConnections(node.ID, &project, node.ScriptProject, w.doc.Connections)
	if len(connections) > canvasDocumentMaxConnections {
		return agentError("invalid_script", "画布连线容量不足，请清理后重试"), nil
	}
	*node = next
	w.doc.Connections = connections
	return map[string]any{"ok": true, "nodeId": next.ID, "node": agentNode(next, true), "mediaNodeIds": slices.Sorted(maps.Keys(media)), "submitted": false}, nil
}

func (w *canvasAgentWorker) scriptReference(id, kind, scriptID string) error {
	if id == "" {
		return nil
	}
	node := w.node(id)
	if id == scriptID || node == nil || node.Type != kind {
		return fmt.Errorf("脚本引用 %s 不存在、类型不符或引用了脚本自身，请读取当前画布后重新关联", id)
	}
	return nil
}

type canvasAgentScriptBinding struct {
	ScriptNodeID string
	AssetID      string
	ShotID       string
}

// Validate ownership before creating a node so invalid bindings leave no orphans.
func (w *canvasAgentWorker) scriptBinding(kind string, args map[string]any, sources []string) (canvasAgentScriptBinding, error) {
	binding := canvasAgentScriptBinding{util.Clean(args["scriptNodeId"]), util.Clean(args["assetId"]), util.Clean(args["shotId"])}
	if binding == (canvasAgentScriptBinding{}) {
		if kind == "text" || kind == "image" || kind == "video" {
			for _, node := range w.doc.Nodes {
				if node.ScriptProject == nil {
					continue
				}
				if slices.Contains(sources, node.ID) {
					return binding, fmt.Errorf("脚本生成必须提供 scriptNodeId 和 assetId 或 shotId，创建时同步关联素材或镜头")
				}
				for _, shot := range node.ScriptProject.Shots {
					if shot.SourceNodeID != "" && slices.Contains(sources, shot.SourceNodeID) {
						return binding, fmt.Errorf("镜头生成必须提供 scriptNodeId 和 shotId")
					}
				}
			}
		}
		return binding, nil
	}
	if binding.ScriptNodeID == "" || (binding.AssetID == "") == (binding.ShotID == "") {
		return binding, fmt.Errorf("请提供 scriptNodeId，并且只指定 assetId 或 shotId 中的一项")
	}
	script := w.node(binding.ScriptNodeID)
	if script == nil || script.Type != "script" || script.ScriptProject == nil {
		return binding, fmt.Errorf("找不到结构化脚本，请读取当前画布后重新关联")
	}
	if script.GenerationStatus == "loading" || script.ScriptOperation != nil {
		return binding, fmt.Errorf("请先等待脚本整理完成")
	}
	if binding.AssetID != "" {
		if kind != "image" {
			return binding, fmt.Errorf("脚本素材只能关联图片节点")
		}
		for _, asset := range script.ScriptProject.Assets {
			if asset.ID == binding.AssetID {
				if asset.ImageNodeID != "" {
					return binding, fmt.Errorf("素材已有图片关联，请读取并复用原节点；替换时先明确更新脚本关联")
				}
				return binding, nil
			}
		}
		return binding, fmt.Errorf("脚本中不存在指定素材")
	}
	if kind != "text" && kind != "image" && kind != "video" {
		return binding, fmt.Errorf("镜头只能关联文本、图片或视频节点")
	}
	for _, shot := range script.ScriptProject.Shots {
		if shot.ID == binding.ShotID {
			id := map[string]string{"text": shot.SourceNodeID, "image": shot.ImageNodeID, "video": shot.VideoNodeID}[kind]
			if id != "" {
				return binding, fmt.Errorf("镜头已有同类节点关联，请读取并复用原节点；替换时先明确更新脚本关联")
			}
			return binding, nil
		}
	}
	return binding, fmt.Errorf("脚本中不存在指定镜头")
}

func (w *canvasAgentWorker) bindScriptNode(binding canvasAgentScriptBinding, node CanvasNode) {
	if binding.ScriptNodeID == "" {
		return
	}
	script := w.node(binding.ScriptNodeID)
	project := *script.ScriptProject
	project.Assets, project.Shots = slices.Clone(project.Assets), slices.Clone(project.Shots)
	from, to := script.ID, node.ID
	if binding.AssetID != "" {
		for i := range project.Assets {
			if project.Assets[i].ID == binding.AssetID {
				project.Assets[i].ImageNodeID = node.ID
				material := w.node(node.ID)
				scale := min(1.0, 240/material.Width, 240/material.Height)
				material.Width, material.Height = material.Width*scale, material.Height*scale
				material.X, material.Y = script.X-2*(240+36)-84+float64(i%2)*276, script.Y+float64(i/2)*276
				for {
					collision := false
					for _, other := range w.doc.Nodes {
						if other.ID == material.ID || other.Type == "group" {
							continue
						}
						if material.X < other.X+other.Width && material.X+material.Width > other.X && material.Y < other.Y+other.Height+36 && material.Y+material.Height+36 > other.Y {
							material.Y = other.Y + other.Height + 36
							collision = true
						}
					}
					if !collision {
						break
					}
				}
			}
		}
		from, to = node.ID, script.ID
	} else {
		for i := range project.Shots {
			shot := &project.Shots[i]
			if shot.ID != binding.ShotID {
				continue
			}
			w.placeScriptShotNode(script, &project, i, w.node(node.ID))
			switch node.Type {
			case "text":
				shot.SourceNodeID = node.ID
			case "image":
				shot.ImageNodeID, shot.ImagePrompt, shot.ImageOutdated, shot.ImagePromptOutdated = node.ID, node.Prompt, false, false
			case "video":
				shot.VideoNodeID, shot.VideoPrompt, shot.VideoOutdated, shot.VideoPromptOutdated = node.ID, node.Prompt, false, false
			}
		}
	}
	script.ScriptProject = &project
	// An asset is an input to the script, never an output of it.
	w.doc.Connections = slices.DeleteFunc(w.doc.Connections, func(edge CanvasConnection) bool {
		return edge.FromNodeID == to && edge.ToNodeID == from
	})
	if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == from && edge.ToNodeID == to }) {
		w.doc.Connections = append(w.doc.Connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: from, ToNodeID: to})
	}
}

// Check every referenced asset before assigning a task ID or submitting media.
func (w *canvasAgentWorker) prepareScriptGeneration(id string) map[string]any {
	node := w.node(id)
	if node.Type != "image" && node.Type != "video" {
		return nil
	}
	references := []string{}
	bound := false
	for _, script := range w.doc.Nodes {
		if script.ScriptProject == nil {
			continue
		}
		project := script.ScriptProject
		for _, shot := range project.Shots {
			if node.Type == "image" && shot.ImageNodeID != id || node.Type == "video" && shot.VideoNodeID != id {
				continue
			}
			bound = true
			if !project.Confirmed {
				return agentError("script_not_confirmed", "请先确认脚本镜头，再提交镜头生成")
			}
			if node.Type == "image" && shot.ImagePromptOutdated || node.Type == "video" && shot.VideoPromptOutdated {
				return agentError("script_prompts_outdated", "脚本内容已变化，原提示词已保留；请更新或核对提示词后再生成")
			}
			if node.Type == "image" && shot.ImageOutdated || node.Type == "video" && shot.VideoOutdated {
				return agentError("script_media_outdated", "脚本已修改，旧成品待更新；请明确创建并关联新成品后再生成")
			}
			if node.Type == "video" && shot.ImageNodeID != "" {
				image := w.node(shot.ImageNodeID)
				if image == nil || image.Type != "image" || image.URL == "" || image.GenerationStatus == "loading" || image.GenerationStatus == "error" {
					return agentError("script_assets_not_ready", "镜头关联的分镜图片尚不可用，请先完成或重新关联分镜图片")
				}
				if !slices.Contains(references, image.ID) {
					references = append(references, image.ID)
				}
			}
			for _, assetID := range canvasScriptShotAssetIDs(shot) {
				index := slices.IndexFunc(project.Assets, func(asset CanvasScriptAsset) bool { return asset.ID == assetID })
				if index < 0 {
					return agentError("script_assets_not_ready", "镜头引用的脚本素材不存在，请先核对脚本")
				}
				asset := project.Assets[index]
				image := w.node(asset.ImageNodeID)
				if image == nil || image.Type != "image" || image.URL == "" || image.GenerationStatus == "loading" || image.GenerationStatus == "error" {
					return agentError("script_assets_not_ready", fmt.Sprintf("镜头所需素材「%s」尚无可用设定图，请先生成或关联图片并等待成功", asset.Name))
				}
				if !slices.Contains(references, image.ID) {
					references = append(references, image.ID)
				}
			}
		}
	}
	if !bound {
		for _, script := range w.doc.Nodes {
			if script.ScriptProject != nil && slices.ContainsFunc(script.ScriptProject.Assets, func(asset CanvasScriptAsset) bool { return asset.ImageNodeID == id }) {
				return nil
			}
		}
		sources := []string{}
		for _, edge := range w.doc.Connections {
			if edge.ToNodeID == id {
				sources = append(sources, edge.FromNodeID)
			}
		}
		if _, err := w.scriptBinding(node.Type, map[string]any{}, sources); err != nil {
			return agentError("invalid_script_binding", "该生成节点尚未关联脚本素材或镜头，请先用 update_script_node 关联已有节点")
		}
	}
	if len(references) == 0 {
		return nil
	}
	next := *node
	next.GenerationReferenceURLs = slices.Clone(node.GenerationReferenceURLs)
	next.GenerationVideoReferenceImages = slices.Clone(node.GenerationVideoReferenceImages)
	connections := slices.Clone(w.doc.Connections)
	for _, ref := range references {
		urls := &next.GenerationReferenceURLs
		if node.Type == "video" {
			urls = &next.GenerationVideoReferenceImages
		}
		if url := w.node(ref).URL; !slices.Contains(*urls, url) {
			*urls = append(*urls, url)
		}
		if !slices.ContainsFunc(connections, func(edge CanvasConnection) bool { return edge.FromNodeID == ref && edge.ToNodeID == id }) {
			connections = append(connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: ref, ToNodeID: id})
		}
	}
	if err := w.validateMedia(next); err != nil {
		return agentError("invalid_media_parameters", err.Error())
	}
	if len(connections) > canvasDocumentMaxConnections {
		return agentError("invalid_script", "画布连线容量不足，请清理后重试")
	}
	*node, w.doc.Connections = next, connections
	return nil
}

func canvasScriptShotAssetIDs(shot CanvasScriptShot) []string {
	ids := slices.Clone(shot.AssetIDs)
	for _, line := range shot.Dialogue {
		if line.AssetID != "" && !slices.Contains(ids, line.AssetID) {
			ids = append(ids, line.AssetID)
		}
	}
	return ids
}

func detachCanvasScriptNodes(project *CanvasScriptProject, removed map[string]bool) *CanvasScriptProject {
	if project == nil {
		return nil
	}
	next := *project
	next.Assets, next.Shots = slices.Clone(project.Assets), slices.Clone(project.Shots)
	if removed[next.MergedVideoNodeID] {
		next.MergedVideoNodeID, next.MergedVideoFingerprint = "", ""
	}
	for i := range next.Assets {
		if removed[next.Assets[i].ImageNodeID] {
			next.Assets[i].ImageNodeID = ""
		}
	}
	for i := range next.Shots {
		shot := &next.Shots[i]
		for _, id := range canvasScriptShotAssetIDs(*shot) {
			if slices.ContainsFunc(project.Assets, func(asset CanvasScriptAsset) bool { return asset.ID == id && removed[asset.ImageNodeID] }) {
				shot.ImageOutdated, shot.VideoOutdated = shot.ImageNodeID != "", shot.VideoNodeID != ""
				shot.ImagePromptOutdated, shot.VideoPromptOutdated = true, true
				next.Confirmed = false
			}
		}
		if removed[shot.SourceNodeID] {
			shot.SourceNodeID = ""
		}
		if removed[shot.ImageNodeID] {
			shot.ImageNodeID, shot.ImageOutdated = "", false
		}
		if removed[shot.VideoNodeID] {
			shot.VideoNodeID, shot.VideoOutdated = "", false
		}
	}
	return &next
}
