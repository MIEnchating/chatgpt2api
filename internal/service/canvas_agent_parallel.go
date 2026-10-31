package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
)

const canvasAgentGenerationConcurrency = 4

func canvasAgentWorkflowNodeReady(node CanvasNode) bool {
	return node.Type == "text" || node.URL != "" && node.GenerationStatus != "loading" && node.GenerationStatus != "error"
}

// Only media I/O is concurrent. The worker owns all document and session writes.
func (w *canvasAgentWorker) runWorkflowGenerations(order []string) ([]map[string]any, map[string]any, error) {
	ctx, cancel := context.WithCancel(w.ctx)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	type completion struct {
		job  *canvasAgentGeneration
		task map[string]any
		err  error
	}
	completed := make(chan completion, canvasAgentGenerationConcurrency)
	done, started := map[string]bool{}, map[string]bool{}
	results := []map[string]any{}
	var failure map[string]any
	active := 0
	for len(done) < len(order) || active > 0 {
		if err := w.ctx.Err(); err != nil {
			return results, failure, err
		}
		if err := w.save(); err != nil {
			return results, failure, err
		}
		if w.canvasChanged && failure == nil {
			failure = w.canvasChangedResult("画布已变化，已提交任务继续核对结果，尚未开始的工作流步骤暂停")
		}
		if failure == nil {
			for _, id := range order {
				if started[id] || active >= canvasAgentGenerationConcurrency {
					continue
				}
				n := w.node(id)
				if n == nil {
					failure = w.canvasChangedResult("工作流节点已被移除，后续步骤未执行")
					break
				}
				if canvasAgentWorkflowNodeReady(*n) {
					started[id], done[id] = true, true
					continue
				}
				ready := true
				for _, c := range w.doc.Connections {
					if c.ToNodeID == id && !done[c.FromNodeID] {
						ready = false
						break
					}
				}
				if !ready {
					continue
				}
				if err := w.bindWorkflowReferences(id); err != nil {
					failure = agentError("dependency_failed", err.Error())
					break
				}
				job, result, err := w.prepareGeneration(id)
				if err != nil {
					return results, failure, err
				}
				started[id] = true
				if job == nil {
					results = append(results, result)
					if result["ok"] != true {
						failure = result
						break
					}
					done[id] = true
					continue
				}
				w.generationTrace(job.node, "running", "已提交生成，完成后自动推进依赖此素材的步骤")
				active++
				workers.Add(1)
				go func(job *canvasAgentGeneration) {
					defer workers.Done()
					var task map[string]any
					var err error
					// A panic in media generation must still reach the main loop, or it would wait until ctx is cancelled.
					func() {
						defer func() {
							if recovered := recover(); recovered != nil {
								slog.Error("Canvas agent media generation panicked", "node_id", job.node.ID, "panic", recovered)
								err = fmt.Errorf("media generation panicked: %v", recovered)
							}
						}()
						task, err = w.service.media(ctx, w.identity, job.node, job.metadata)
					}()
					completed <- completion{job: job, task: task, err: err}
				}(job)
			}
		}
		if active == 0 {
			if failure != nil || len(done) == len(order) {
				break
			}
			return results, agentError("dependency_failed", "没有可执行的节点，请重新检查依赖关系"), nil
		}
		if err := w.save(); err != nil {
			return results, failure, err
		}
		var next completion
		select {
		case <-w.ctx.Done():
			return results, failure, w.ctx.Err()
		case next = <-completed:
		}
		active--
		result, err := w.finishGeneration(next.job, next.task, next.err)
		if err != nil {
			if w.ctx.Err() != nil {
				return results, failure, w.ctx.Err()
			}
			result = agentError("generation_failed", err.Error())
		}
		status := "success"
		if result["ok"] != true {
			status = "error"
			if result["code"] == "canvas_changed" {
				status = "changed"
			}
			if failure == nil {
				failure = result
			}
		} else {
			done[next.job.node.ID] = true
		}
		w.generationTrace(next.job.node, status, agentResultDetail(result))
		results = append(results, result)
		if w.activeCall != nil {
			w.record(w.activeCall, map[string]any{"ok": failure == nil, "nodeIds": order, "results": results, "status": "loading"})
		}
		if err := w.save(); err != nil {
			return results, failure, err
		}
	}
	return results, failure, nil
}

func (w *canvasAgentWorker) generationTrace(node CanvasNode, status, detail string) {
	w.trace(map[string]any{"id": "generation:" + node.TaskID, "type": "operation", "kind": "generate", "label": "正在生成" + firstAgentString(node.Title, "媒体"), "status": status, "detail": detail, "nodeId": node.ID})
}

func (w *canvasAgentWorker) bindWorkflowReferences(id string) error {
	n := w.node(id)
	for _, c := range w.doc.Connections {
		if c.ToNodeID != id {
			continue
		}
		source := w.node(c.FromNodeID)
		if source == nil {
			return fmt.Errorf("来源节点已被移除")
		}
		if source.Type == "text" {
			continue
		}
		if source.URL == "" {
			return fmt.Errorf("上游 %s 尚未完成，停止执行下游", source.Title)
		}
		var refs *[]string
		if n.Type == "image" && source.Type == "image" {
			refs = &n.GenerationReferenceURLs
		}
		if n.Type == "video" {
			switch source.Type {
			case "image":
				refs = &n.GenerationVideoReferenceImages
			case "video":
				refs = &n.GenerationVideoReferenceURLs
			case "audio":
				refs = &n.GenerationVideoReferenceAudio
			}
		}
		if refs != nil && !slices.Contains(*refs, source.URL) {
			*refs = append(*refs, source.URL)
		}
	}
	if err := w.validateMedia(*n); err != nil {
		return err
	}
	return nil
}

func canvasAgentRemovalIDs(nodes []CanvasNode, id string) map[string]bool {
	removed := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for _, n := range nodes {
			if !removed[n.ID] && (removed[n.GroupID] || removed[n.BatchRootID]) {
				removed[n.ID], changed = true, true
			}
			if removed[n.ID] {
				for _, child := range n.BatchChildIDs {
					if !removed[child] {
						removed[child], changed = true, true
					}
				}
			}
		}
	}
	return removed
}

func (w *canvasAgentWorker) deletionFingerprint(id string) string {
	ids := canvasAgentRemovalIDs(w.doc.Nodes, id)
	nodes := []CanvasNode{}
	for _, node := range w.doc.Nodes {
		if ids[node.ID] {
			nodes = append(nodes, canvasAgentContentNode(node))
		}
	}
	slices.SortFunc(nodes, func(a, b CanvasNode) int { return strings.Compare(a.ID, b.ID) })
	return fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(nodes))))
}
