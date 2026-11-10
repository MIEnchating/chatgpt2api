package service

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	"chatgpt2api/internal/util"
)

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
	var project CanvasScriptProject
	input, valid := args["scriptProject"].(map[string]any)
	if err := json.Unmarshal([]byte(agentJSON(input)), &project); err != nil || !valid || input == nil {
		return agentError("invalid_script", "请提供完整的脚本镜头及资产结构"), nil
	}
	if project.Shots == nil {
		project.Shots = []CanvasScriptShot{}
	}
	if project.Assets == nil {
		project.Assets = []CanvasScriptAsset{}
	}
	for i := range project.Shots {
		if project.Shots[i].Dialogue == nil {
			project.Shots[i].Dialogue = []CanvasScriptDialogue{}
		}
		if project.Shots[i].AssetIDs == nil {
			project.Shots[i].AssetIDs = []string{}
		}
	}
	// Stable shot and asset IDs retain their existing bindings when editing content.
	if previous := node.ScriptProject; previous != nil {
		shotFields := util.AsMapSlice(input["shots"])
		for i := range project.Shots {
			for _, old := range previous.Shots {
				if project.Shots[i].ID != old.ID {
					continue
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
	// Asset settings are script inputs; shot media retain their output edges.
	connections := slices.Clone(w.doc.Connections)
	inputs, previous := map[string]bool{}, map[string]bool{}
	for _, asset := range project.Assets {
		if asset.ImageNodeID != "" {
			inputs[asset.ImageNodeID] = true
		}
	}
	if node.ScriptProject != nil {
		for _, asset := range node.ScriptProject.Assets {
			previous[asset.ImageNodeID] = true
		}
	}
	connections = slices.DeleteFunc(connections, func(edge CanvasConnection) bool {
		if edge.ToNodeID == node.ID && previous[edge.FromNodeID] && !inputs[edge.FromNodeID] {
			return true
		}
		return edge.FromNodeID == node.ID && previous[edge.ToNodeID] && !inputs[edge.ToNodeID] && !media[edge.ToNodeID]
	})
	for _, asset := range project.Assets {
		id := asset.ImageNodeID
		if id == "" {
			continue
		}
		incoming := slices.ContainsFunc(connections, func(edge CanvasConnection) bool {
			return edge.FromNodeID == id && edge.ToNodeID == node.ID
		})
		reverse := slices.IndexFunc(connections, func(edge CanvasConnection) bool {
			return edge.FromNodeID == node.ID && edge.ToNodeID == id
		})
		if reverse >= 0 {
			if incoming {
				connections = slices.Delete(connections, reverse, reverse+1)
			} else {
				connections[reverse].FromNodeID, connections[reverse].ToNodeID = id, node.ID
			}
		} else if !incoming {
			connections = append(connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: id, ToNodeID: node.ID})
		}
	}
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
