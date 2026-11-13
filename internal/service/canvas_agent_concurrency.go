package service

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"

	"chatgpt2api/internal/util"
)

var errCanvasAgentEditing = errors.New("画布状态持续变化，本轮未执行旧指令。已保存进度，稍后可以继续任务")

func (w *canvasAgentWorker) missingCanvasReferences(args map[string]any) bool {
	for _, key := range []string{"nodeId", "scriptNodeId", "fromNodeId", "toNodeId"} {
		if id := util.Clean(args[key]); id != "" && w.node(id) == nil {
			return true
		}
	}
	for _, key := range []string{"nodeIds", "sourceNodeIds", "approvedNodeIds", "referenceNodeIds"} {
		for _, id := range agentStrings(args[key]) {
			if w.node(id) == nil {
				return true
			}
		}
	}
	for _, key := range []string{"steps", "items"} {
		for _, item := range util.AsMapSlice(args[key]) {
			if w.missingCanvasReferences(item) {
				return true
			}
		}
	}
	return false
}

// Layout and automatically populated media metadata do not change generation content.
func canvasAgentContentNode(n CanvasNode) CanvasNode {
	if normalized, err := normalizeCanvasNode(n); err == nil {
		n = normalized
	}
	n.X, n.Y, n.Width, n.Height, n.ScaleX, n.ScaleY, n.Angle = 0, 0, 0, 0, 0, 0, 0
	n.FontSize, n.NaturalWidth, n.NaturalHeight = 0, 0, 0
	n.Bytes, n.DurationMS, n.ThumbnailURL = 0, 0, ""
	n.MediaMetadata, n.MediaSilentClips, n.MediaProbeError = nil, 0, ""
	n.FreeResize, n.BatchExpanded = false, nil
	n.GenerationError = ""
	n.GenerationStartedAt, n.GenerationProgress = 0, 0
	if n.ScriptProject != nil {
		project := *n.ScriptProject
		project.Step = 0
		project.Shots = slices.Clone(project.Shots)
		for i := range project.Shots {
			project.Shots[i].Color = ""
		}
		n.ScriptProject = &project
	}
	return n
}

func canvasAgentContentChanged(before, after CanvasDocument) bool {
	index := func(doc CanvasDocument) map[string]CanvasNode {
		out := make(map[string]CanvasNode, len(doc.Nodes))
		for _, n := range doc.Nodes {
			out[n.ID] = canvasAgentContentNode(n)
		}
		return out
	}
	edges := func(doc CanvasDocument) map[string]CanvasConnection {
		out := make(map[string]CanvasConnection, len(doc.Connections))
		for _, c := range doc.Connections {
			out[c.ID] = c
		}
		return out
	}
	return canvasAgentConfiguredVideoModel(before) != canvasAgentConfiguredVideoModel(after) || !reflect.DeepEqual(index(before), index(after)) || !reflect.DeepEqual(edges(before), edges(after))
}

func canvasAgentLayoutChanged(before, after CanvasDocument) bool {
	index := func(doc CanvasDocument) map[string][7]float64 {
		out := make(map[string][7]float64, len(doc.Nodes))
		for _, n := range doc.Nodes {
			out[n.ID] = [7]float64{n.X, n.Y, n.Width, n.Height, n.ScaleX, n.ScaleY, n.Angle}
		}
		return out
	}
	return !reflect.DeepEqual(index(before), index(after))
}

func (w *canvasAgentWorker) canvasChangedResult(message string) map[string]any {
	w.canvasChanged = true
	result := agentError("canvas_changed", message)
	result["recoverable"] = true
	result["nextAction"] = "此状态仅说明当前画布与执行快照不一致，无法确定变化来源，不得据此声称用户修改了画布。先重新读取相关节点和已有任务，核对实际输入及结果是否写回，再调整计划；不恢复已删除节点、不覆盖当前内容、不重复提交已有媒体任务。不受影响且已获授权的步骤直接继续；只有实际覆盖冲突、重新付费生成或必需素材存在歧义时才使用 ask_user_question 合并询问，不向用户索要内部 ID。"
	return result
}

// Check the target and its upstream dependencies again after asynchronous work.
func canvasAgentGenerationChanged(before, after CanvasDocument, id string) bool {
	return canvasAgentContentChanged(canvasAgentGenerationContext(before, id), canvasAgentGenerationContext(after, id))
}

// Diagnose conflicts using field names only, without exposing prompts or media URLs.
func canvasAgentGenerationChanges(before, after CanvasDocument, id string) []string {
	index := func(doc CanvasDocument) map[string]any {
		result := map[string]any{}
		for _, node := range canvasAgentGenerationContext(doc, id).Nodes {
			var fields map[string]any
			_ = json.Unmarshal([]byte(agentJSON(canvasAgentContentNode(node))), &fields)
			for key, value := range fields {
				result[node.ID+"."+key] = value
			}
		}
		for _, edge := range canvasAgentGenerationContext(doc, id).Connections {
			result["connection."+edge.ID] = edge
		}
		return result
	}
	left, right := index(before), index(after)
	keys := map[string]bool{}
	for key := range left {
		keys[key] = true
	}
	for key := range right {
		keys[key] = true
	}
	changed := []string{}
	for key := range keys {
		a, had := left[key]
		b, has := right[key]
		if had != has || !reflect.DeepEqual(a, b) {
			changed = append(changed, key)
		}
	}
	slices.Sort(changed)
	return changed
}

func canvasAgentGenerationContext(doc CanvasDocument, id string) CanvasDocument {
	ids := map[string]bool{}
	var visit func(string)
	visit = func(id string) {
		if ids[id] {
			return
		}
		ids[id] = true
		for _, c := range doc.Connections {
			if c.ToNodeID == id {
				visit(c.FromNodeID)
			}
		}
	}
	visit(id)
	out := CanvasDocument{}
	for _, n := range doc.Nodes {
		if ids[n.ID] {
			// Names and grouping remain instruction boundaries, but do not alter media inputs.
			n.Title, n.GroupID = "", ""
			// Reviews describe an existing result, not inputs to an in-flight task.
			if n.ScriptProject != nil {
				project := *n.ScriptProject
				project.MergedVideoNodeID, project.MergedVideoFingerprint, project.MergedVideoOutdated = "", "", false
				project.Shots = slices.Clone(project.Shots)
				for i := range project.Shots {
					project.Shots[i].QualityReview = nil
				}
				n.ScriptProject = &project
			}
			out.Nodes = append(out.Nodes, n)
		}
	}
	for _, c := range doc.Connections {
		if ids[c.ToNodeID] {
			out.Connections = append(out.Connections, c)
		}
	}
	return out
}

// The final optimistic save must also reject results whose inputs changed after
// the worker's last read, including additional outputs from the same task.
func protectCanvasAgentGenerationResults(base, edited, current CanvasDocument) CanvasDocument {
	baseNodes := map[string]CanvasNode{}
	for _, n := range base.Nodes {
		baseNodes[n.ID] = n
	}
	conflicts := map[string]bool{}
	for _, n := range edited.Nodes {
		before, exists := baseNodes[n.ID]
		if exists && n.TaskID != "" && n.GenerationStatus == "success" && n.URL != before.URL && canvasAgentGenerationChanged(base, current, n.ID) {
			conflicts[n.TaskID] = true
		}
	}
	if len(conflicts) == 0 {
		return edited
	}
	edited = cloneCanvasAgentDocument(edited)
	nodes := edited.Nodes[:0]
	for _, n := range edited.Nodes {
		if conflicts[n.TaskID] {
			before, exists := baseNodes[n.ID]
			if !exists {
				continue
			}
			n = before
			n.GenerationStatus, n.GenerationProgress = "idle", 0
		}
		nodes = append(nodes, n)
	}
	edited.Nodes = nodes
	return edited
}

func canvasAgentDiscardedGenerationTasks(base, edited, saved CanvasDocument) []string {
	before, after := map[string]CanvasNode{}, map[string]CanvasNode{}
	for _, n := range base.Nodes {
		before[n.ID] = n
	}
	for _, n := range saved.Nodes {
		after[n.ID] = n
	}
	tasks := []string{}
	for _, n := range edited.Nodes {
		if n.TaskID != "" && n.GenerationStatus == "success" && n.URL != "" && before[n.ID].URL != n.URL && after[n.ID].URL != n.URL {
			tasks = append(tasks, n.TaskID)
		}
	}
	return tasks
}

// Persist intent boundaries so restoring an approved SDK call cannot overwrite
// edits made while its worker was offline. Agent progress does not affect them.
func canvasAgentIntentFingerprints(doc CanvasDocument) (string, string) {
	nodes := map[string]CanvasNode{}
	layout := map[string][7]float64{}
	edges := map[string]CanvasConnection{}
	for _, node := range doc.Nodes {
		nodes[node.ID] = canvasAgentContentNode(node)
		layout[node.ID] = [7]float64{node.X, node.Y, node.Width, node.Height, node.ScaleX, node.ScaleY, node.Angle}
	}
	for _, edge := range doc.Connections {
		edges[edge.ID] = edge
	}
	content := fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(map[string]any{"nodes": nodes, "connections": edges, "videoModel": canvasAgentConfiguredVideoModel(doc)}))))
	positions := fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(layout))))
	return content, positions
}

func canvasAgentGenerationInputFingerprint(doc CanvasDocument, id string) string {
	content, _ := canvasAgentIntentFingerprints(canvasAgentGenerationContext(doc, id))
	return content
}
