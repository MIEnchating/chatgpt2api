package service

import (
	"errors"
	"reflect"

	"chatgpt2api/internal/util"
)

var errCanvasAgentEditing = errors.New("画布持续变化，本轮未执行旧指令。已保存进度，完成编辑后可以继续任务")

func (w *canvasAgentWorker) missingCanvasReferences(args map[string]any) bool {
	for _, key := range []string{"nodeId", "fromNodeId", "toNodeId"} {
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

// Layout changes do not invalidate the content used by the model or generation.
func canvasAgentContentNode(n CanvasNode) CanvasNode {
	if normalized, err := normalizeCanvasNode(n); err == nil {
		n = normalized
	}
	n.X, n.Y, n.Width, n.Height, n.ScaleX, n.ScaleY, n.Angle = 0, 0, 0, 0, 0, 0, 0
	n.FontSize, n.NaturalWidth, n.NaturalHeight = 0, 0, 0
	n.FreeResize, n.BatchExpanded = false, nil
	n.GenerationError = ""
	n.GenerationStartedAt, n.GenerationProgress = 0, 0
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
	return !reflect.DeepEqual(index(before), index(after)) || !reflect.DeepEqual(edges(before), edges(after))
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
	result["nextAction"] = "重新读取当前画布并调整计划；不要重建用户删除的节点，不要覆盖用户修改，不要重复提交已提交的媒体任务。必需素材缺失且无法判断替代方案时，使用 ask_user_question，以名称和内容说明选项，允许自由输入，不向用户索要内部 ID。"
	return result
}

// Check the target and its upstream dependencies again after asynchronous work.
func canvasAgentGenerationChanged(before, after CanvasDocument, id string) bool {
	dependency := func(doc CanvasDocument) CanvasDocument {
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
	return canvasAgentContentChanged(dependency(before), dependency(after))
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
