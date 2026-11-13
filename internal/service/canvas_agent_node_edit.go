package service

import (
	"fmt"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
)

// Update inputs atomically without replacing identity, outputs or task receipts.
func (w *canvasAgentWorker) updateNode(args map[string]any) (map[string]any, error) {
	node := w.node(util.Clean(args["nodeId"]))
	if node == nil {
		return w.canvasChangedResult("目标节点已不存在，请重新读取画布"), nil
	}
	if len(args) == 1 {
		return agentError("invalid_node_update", "请提供要修改的标题、提示词、生成参数或来源"), nil
	}
	if node.GenerationStatus == "loading" || node.ScriptOperation != nil {
		return agentError("node_busy", "节点正在生成，请先等待原任务完成，再原位修改"), nil
	}
	next := *node
	if title, ok := args["title"].(string); ok {
		next.Title = title
	}
	if prompt, ok := args["prompt"].(string); ok {
		if !slices.Contains([]string{"text", "script", "image", "video", "audio"}, node.Type) {
			return agentError("invalid_node_type", "此节点不能修改提示词"), nil
		}
		next.Prompt = prompt
	}
	generation := agentMap(args["generation"])
	if err := w.updateNodeGeneration(&next, generation); err != nil {
		return agentError("invalid_media_parameters", err.Error()), nil
	}
	_, sourcesProvided := args["sourceNodeIds"]
	_, attachmentsProvided := args["attachmentIds"]
	connections := slices.Clone(w.doc.Connections)
	if sourcesProvided || attachmentsProvided {
		ids := agentStrings(args["sourceNodeIds"])
		if !sourcesProvided {
			for _, edge := range connections {
				if edge.ToNodeID == node.ID {
					ids = append(ids, edge.FromNodeID)
				}
			}
		}
		for _, id := range ids {
			source := w.node(id)
			if id == node.ID || source == nil || source.Type == "group" {
				return agentError("invalid_reference", "来源不能是节点自身、分组或其他画布的节点"), nil
			}
		}
		refs, err := w.resolveMediaReferences(ids, agentStrings(args["attachmentIds"]))
		if err != nil {
			return agentError("invalid_reference", err.Error()), nil
		}
		switch node.Type {
		case "image":
			if len(refs.Videos)+len(refs.Audios) > 0 {
				return agentError("invalid_reference", "图片节点只接受图片或文本来源"), nil
			}
			next.GenerationReferenceURLs = refs.Images
		case "video":
			next.GenerationVideoReferenceImages = refs.Images
			next.GenerationVideoReferenceURLs = refs.Videos
			next.GenerationVideoReferenceAudio = refs.Audios
		case "text", "script", "audio":
			if attachmentsProvided {
				return agentError("invalid_reference", "此节点不支持媒体参考附件"), nil
			}
		default:
			return agentError("invalid_node_type", "此节点不支持修改来源"), nil
		}
		if sourcesProvided {
			connections = slices.DeleteFunc(connections, func(edge CanvasConnection) bool {
				return edge.ToNodeID == node.ID && !slices.Contains(ids, edge.FromNodeID)
			})
			for _, id := range ids {
				if !slices.ContainsFunc(connections, func(edge CanvasConnection) bool { return edge.FromNodeID == id && edge.ToNodeID == node.ID }) {
					connections = append(connections, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: id, ToNodeID: node.ID})
				}
			}
		}
	}
	if len(generation) > 0 || (sourcesProvided || attachmentsProvided) && slices.Contains([]string{"image", "video", "audio"}, node.Type) {
		if err := w.validateMedia(next); err != nil {
			return agentError("invalid_media_parameters", err.Error()), nil
		}
		if _, ok := generation["size"]; ok {
			canvasAgentFitEmptyMediaFrame(&next)
		}
	}
	if _, err := normalizeCanvasNode(next); err != nil {
		return agentError("invalid_node_update", err.Error()), nil
	}
	// Successful outputs remain available, but cannot be silently reused as the
	// result of changed inputs. The existing confirmation gate owns regeneration.
	before, after := canvasAgentGenerationContext(w.doc, node.ID), cloneCanvasAgentDocument(w.doc)
	for i := range after.Nodes {
		if after.Nodes[i].ID == node.ID {
			after.Nodes[i] = next
		}
	}
	after.Connections = connections
	if node.TaskID != "" && node.GenerationStatus == "success" && canvasAgentGenerationChanged(before, after, node.ID) && !slices.Contains(agentStrings(w.state["detachedTaskIds"]), node.TaskID) {
		w.state["detachedTaskIds"] = append(agentStrings(w.state["detachedTaskIds"]), node.TaskID)
	}
	*node = next
	w.doc.Connections = connections
	return map[string]any{"ok": true, "nodeId": node.ID, "node": agentNode(next, true), "submitted": false, "message": "已原位保存；未新建节点或提交生成，原素材与任务记录保留。"}, nil
}

func (w *canvasAgentWorker) updateNodeGeneration(node *CanvasNode, patch map[string]any) error {
	allowed := map[string]string{
		"image": "model size resolution quality count",
		"video": "model size resolution seconds generateAudio referenceMode videoParameters",
		"audio": "model voice format speed instructions",
	}
	for key := range patch {
		if !slices.Contains(strings.Fields(allowed[node.Type]), key) {
			return fmt.Errorf("%s 节点不支持参数 %s", node.Type, key)
		}
	}
	if model, ok := patch["model"].(string); ok && (model == "" || model != util.Clean(w.req.Generation[node.Type+"Model"])) {
		return fmt.Errorf("只能使用当前配置的%s模型，请先核对 get_generation_config", node.Type)
	}
	for key, value := range patch {
		switch node.Type + "." + key {
		case "image.model":
			node.GenerationModel = util.Clean(value)
		case "image.size":
			node.GenerationSize = util.Clean(value)
		case "image.resolution":
			node.GenerationResolution = util.Clean(value)
		case "image.quality":
			node.GenerationQuality = util.Clean(value)
		case "image.count":
			node.GenerationCount = util.ToInt(value, 0)
		case "video.model":
			node.GenerationVideoModel = util.Clean(value)
		case "video.size":
			node.GenerationVideoSize = util.Clean(value)
		case "video.resolution":
			node.GenerationVideoResolution = util.Clean(value)
		case "video.seconds":
			node.GenerationVideoSeconds = util.ToInt(value, 0)
		case "video.generateAudio":
			audio := value.(bool)
			node.GenerationVideoAudio = &audio
		case "video.referenceMode":
			node.GenerationVideoReferenceMode = util.Clean(value)
		case "video.videoParameters":
			parameters, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf("videoParameters 必须是对象")
			}
			caps := agentMap(agentMap(w.req.Generation["capabilities"])["video"])
			normalized, err := normalizeCanvasAgentVideoParameters(caps, parameters)
			if err != nil {
				return err
			}
			node.GenerationVideoParameters = normalized
		case "audio.model":
			node.GenerationAudioModel = util.Clean(value)
		case "audio.voice":
			node.GenerationAudioVoice = util.Clean(value)
		case "audio.format":
			node.GenerationAudioFormat = util.Clean(value)
		case "audio.speed":
			node.GenerationAudioSpeed = value.(float64)
		case "audio.instructions":
			node.GenerationAudioInstructions = util.Clean(value)
		}
	}
	return nil
}
