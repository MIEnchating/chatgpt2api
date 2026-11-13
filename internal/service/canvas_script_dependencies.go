package service

import (
	"maps"
	"reflect"
	"slices"
	"strings"
)

// Reconcile script edits without discarding authored prompts or previous media.
func reconcileCanvasScriptProject(previous, project *CanvasScriptProject) {
	if previous == nil || project == nil {
		return
	}
	assetsChanged := map[string]bool{}
	for _, asset := range append(slices.Clone(previous.Assets), project.Assets...) {
		before := slices.IndexFunc(previous.Assets, func(a CanvasScriptAsset) bool { return a.ID == asset.ID })
		after := slices.IndexFunc(project.Assets, func(a CanvasScriptAsset) bool { return a.ID == asset.ID })
		assetsChanged[asset.ID] = before < 0 || after < 0 || previous.Assets[before] != project.Assets[after]
	}
	contentChanged := !slices.EqualFunc(previous.Shots, project.Shots, func(a, b CanvasScriptShot) bool { return a.ID == b.ID })
	movieChanged := contentChanged
	for i := range project.Shots {
		shot := &project.Shots[i]
		oldIndex := slices.IndexFunc(previous.Shots, func(s CanvasScriptShot) bool { return s.ID == shot.ID })
		if oldIndex < 0 {
			continue
		}
		old := previous.Shots[oldIndex]
		changed := old.Seconds != shot.Seconds || old.Description != shot.Description || old.Framing != shot.Framing || old.Lighting != shot.Lighting || old.Sound != shot.Sound || old.Camera != shot.Camera || !slices.Equal(old.AssetIDs, shot.AssetIDs) || !slices.EqualFunc(old.Dialogue, shot.Dialogue, func(a, b CanvasScriptDialogue) bool {
			return a.Kind == b.Kind && a.AssetID == b.AssetID && a.Text == b.Text
		})
		for _, id := range append(canvasScriptShotAssetIDs(old), canvasScriptShotAssetIDs(*shot)...) {
			changed = changed || assetsChanged[id]
		}
		frameChanged := shot.ImagePrompt != old.ImagePrompt || shot.ImageNodeID != old.ImageNodeID
		shot.ImagePromptOutdated = changed || old.ImagePromptOutdated && shot.ImagePrompt == old.ImagePrompt && shot.ImagePromptOutdated
		shot.VideoPromptOutdated = changed || old.VideoPromptOutdated && shot.VideoPrompt == old.VideoPrompt && shot.VideoPromptOutdated
		shot.ImageOutdated = shot.ImageNodeID != "" && shot.ImageNodeID == old.ImageNodeID && (old.ImageOutdated || changed || shot.ImagePrompt != old.ImagePrompt)
		shot.VideoOutdated = shot.VideoNodeID != "" && shot.VideoNodeID == old.VideoNodeID && (old.VideoOutdated || changed || frameChanged || shot.VideoPrompt != old.VideoPrompt)
		contentChanged = contentChanged || changed
		movieChanged = movieChanged || shot.VideoOutdated || shot.VideoNodeID != old.VideoNodeID
	}
	if contentChanged {
		project.Confirmed = false
	}
	project.MergedVideoOutdated = project.MergedVideoNodeID != "" && (movieChanged || previous.MergedVideoOutdated && project.MergedVideoNodeID == previous.MergedVideoNodeID)
}

// The save boundary covers browser edits, agent tools, and recovered task results.
func reconcileCanvasScriptDependencies(previous CanvasDocument, next *CanvasDocument) {
	reconcileCanvasScriptMediaReferences(previous, next)
	before := make(map[string]CanvasNode, len(previous.Nodes))
	after := make(map[string]CanvasNode, len(next.Nodes))
	for _, node := range previous.Nodes {
		before[node.ID] = node
	}
	next.Nodes = slices.Clone(next.Nodes)
	for i := range next.Nodes {
		node := &next.Nodes[i]
		old, exists := before[node.ID]
		if exists && (old.URL != node.URL || old.StorageKey != node.StorageKey) && reflect.DeepEqual(old.MediaMetadata, node.MediaMetadata) {
			node.MediaMetadata = nil
			node.MediaProbeError = ""
			node.MediaSilentClips = 0
		}
		after[node.ID] = *node
	}
	for i := range next.Nodes {
		node := &next.Nodes[i]
		if node.ScriptProject == nil {
			continue
		}
		project := *node.ScriptProject
		project.Shots = slices.Clone(project.Shots)
		old := before[node.ID].ScriptProject
		reconcileCanvasScriptProject(old, &project)
		if old != nil {
			consumed := func(id string) bool {
				n, exists := before[id]
				return exists && (n.URL != "" || n.TaskID != "" || n.GenerationStatus == "loading" || n.GenerationStatus == "success")
			}
			unsubmitted := func(id string) bool {
				n := after[id]
				return !consumed(id) && n.URL == "" && n.TaskID == "" && n.GenerationStatus != "loading" && n.GenerationStatus != "success"
			}
			for j := range project.Shots {
				shot := &project.Shots[j]
				// Empty planned nodes have no generated result to replace.
				if unsubmitted(shot.ImageNodeID) {
					shot.ImageOutdated = false
				}
				if unsubmitted(shot.VideoNodeID) {
					shot.VideoOutdated = false
				}
				for _, asset := range project.Assets {
					if !slices.Contains(canvasScriptShotAssetIDs(*shot), asset.ID) {
						continue
					}
					b, had := before[asset.ImageNodeID]
					a, has := after[asset.ImageNodeID]
					if !had || has && b.URL == a.URL && b.StorageKey == a.StorageKey && b.Prompt == a.Prompt {
						continue
					}
					shot.ImageOutdated = shot.ImageOutdated || consumed(shot.ImageNodeID)
					shot.VideoOutdated = shot.VideoOutdated || consumed(shot.VideoNodeID)
					project.MergedVideoOutdated = project.MergedVideoNodeID != ""
				}
				b, had := before[shot.ImageNodeID]
				a := after[shot.ImageNodeID]
				if had && (b.URL != a.URL || b.StorageKey != a.StorageKey || b.Prompt != a.Prompt) {
					shot.VideoOutdated = shot.VideoOutdated || consumed(shot.VideoNodeID)
					project.MergedVideoOutdated = project.MergedVideoNodeID != ""
				}
				b, had = before[shot.VideoNodeID]
				a = after[shot.VideoNodeID]
				if had && (b.URL != a.URL || b.StorageKey != a.StorageKey || b.Prompt != a.Prompt) && project.MergedVideoNodeID == old.MergedVideoNodeID {
					project.MergedVideoOutdated = project.MergedVideoNodeID != ""
				}
			}
		}
		if !reflect.DeepEqual(node.ScriptProject, &project) {
			node.ScriptProject = &project
		}
		if old != nil {
			next.Connections = canvasScriptConnections(node.ID, &project, old, next.Connections)
			next.Connections = slices.DeleteFunc(next.Connections, func(edge CanvasConnection) bool {
				_, from := after[edge.FromNodeID]
				_, to := after[edge.ToNodeID]
				return !from || !to
			})
		}
	}
}

// Script roles own their reference slots; unrelated authored references stay intact.
func reconcileCanvasScriptMediaReferences(previous CanvasDocument, next *CanvasDocument) {
	before, after := map[string]CanvasNode{}, map[string]CanvasNode{}
	for _, node := range previous.Nodes {
		before[node.ID] = node
	}
	for _, node := range next.Nodes {
		after[node.ID] = node
	}
	urls, frames := map[string]map[string][]string{}, map[string]map[string][]string{}
	add := func(target map[string]map[string][]string, output, old, current string) {
		if old == "" {
			return
		}
		if target[output] == nil {
			target[output] = map[string][]string{}
		}
		values := target[output][old]
		if current != "" && !slices.Contains(values, current) {
			values = append(values, current)
		}
		target[output][old] = values
	}
	for _, node := range next.Nodes {
		project, old := node.ScriptProject, before[node.ID].ScriptProject
		if project == nil || old == nil {
			continue
		}
		for _, shot := range project.Shots {
			index := slices.IndexFunc(old.Shots, func(s CanvasScriptShot) bool { return s.ID == shot.ID })
			if index < 0 {
				continue
			}
			oldShot := old.Shots[index]
			for _, output := range []string{shot.ImageNodeID, shot.VideoNodeID} {
				if output == "" {
					continue
				}
				pairs := [][2]string{}
				if output == shot.VideoNodeID {
					pairs = append(pairs, [2]string{oldShot.ImageNodeID, shot.ImageNodeID})
				}
				for _, asset := range old.Assets {
					if !slices.Contains(canvasScriptShotAssetIDs(oldShot), asset.ID) {
						continue
					}
					current := ""
					if slices.Contains(canvasScriptShotAssetIDs(shot), asset.ID) {
						if i := slices.IndexFunc(project.Assets, func(a CanvasScriptAsset) bool { return a.ID == asset.ID }); i >= 0 {
							current = project.Assets[i].ImageNodeID
						}
					}
					pairs = append(pairs, [2]string{asset.ImageNodeID, current})
				}
				for _, pair := range pairs {
					add(urls, output, strings.TrimSpace(before[pair[0]].URL), strings.TrimSpace(after[pair[1]].URL))
					add(frames, output, pair[0], pair[1])
				}
			}
		}
	}
	next.Nodes = slices.Clone(next.Nodes)
	for i := range next.Nodes {
		node := &next.Nodes[i]
		if urls[node.ID] == nil {
			continue
		}
		replace := func(values []string) []string {
			if values == nil {
				return nil
			}
			result := []string{}
			for _, value := range values {
				current, managed := urls[node.ID][strings.TrimSpace(value)]
				if !managed {
					current = []string{value}
				}
				for _, item := range current {
					if !slices.Contains(result, item) {
						result = append(result, item)
					}
				}
			}
			return result
		}
		frame := func(id string) string {
			values, managed := frames[node.ID][id]
			if !managed || slices.Contains(values, id) {
				return id
			}
			if len(values) == 1 {
				return values[0]
			}
			return ""
		}
		if node.Type == "video" {
			node.GenerationVideoReferenceImages = replace(node.GenerationVideoReferenceImages)
			node.GenerationVideoFirstFrameNodeID = frame(node.GenerationVideoFirstFrameNodeID)
			node.GenerationVideoLastFrameNodeID = frame(node.GenerationVideoLastFrameNodeID)
			if node.GenerationVideoLastFrameURL != "" {
				values := replace([]string{node.GenerationVideoLastFrameURL})
				node.GenerationVideoLastFrameURL = ""
				if len(values) > 0 {
					node.GenerationVideoLastFrameURL = values[0]
				}
			}
		} else if node.Type == "image" {
			node.GenerationReferenceURLs = replace(node.GenerationReferenceURLs)
		}
	}
}

func canvasScriptConnections(scriptID string, project, previous *CanvasScriptProject, connections []CanvasConnection) []CanvasConnection {
	next := slices.Clone(connections)
	inputs, oldInputs, outputs, oldOutputs := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, asset := range project.Assets {
		if asset.ImageNodeID != "" {
			inputs[asset.ImageNodeID] = true
		}
	}
	for _, shot := range project.Shots {
		outputs[shot.ImageNodeID], outputs[shot.VideoNodeID] = true, true
	}
	if previous != nil {
		for _, asset := range previous.Assets {
			if asset.ImageNodeID != "" {
				oldInputs[asset.ImageNodeID] = true
			}
		}
		for _, shot := range previous.Shots {
			oldOutputs[shot.ImageNodeID], oldOutputs[shot.VideoNodeID] = true, true
		}
	}
	next = slices.DeleteFunc(next, func(e CanvasConnection) bool {
		return e.ToNodeID == scriptID && oldInputs[e.FromNodeID] && !inputs[e.FromNodeID] || e.FromNodeID == scriptID && (oldInputs[e.ToNodeID] || oldOutputs[e.ToNodeID]) && !inputs[e.ToNodeID] && !outputs[e.ToNodeID]
	})
	connect := func(from, to string) {
		if from != "" && to != "" && from != to && !slices.ContainsFunc(next, func(e CanvasConnection) bool { return e.FromNodeID == from && e.ToNodeID == to }) {
			next = append(next, CanvasConnection{ID: newCanvasProjectID(), FromNodeID: from, ToNodeID: to})
		}
	}
	for _, id := range slices.Sorted(maps.Keys(inputs)) {
		reverse := slices.IndexFunc(next, func(e CanvasConnection) bool { return e.FromNodeID == scriptID && e.ToNodeID == id })
		if reverse < 0 {
			connect(id, scriptID)
			continue
		}
		if slices.ContainsFunc(next, func(e CanvasConnection) bool { return e.FromNodeID == id && e.ToNodeID == scriptID }) {
			next = slices.Delete(next, reverse, reverse+1)
		} else {
			next[reverse].FromNodeID, next[reverse].ToNodeID = id, scriptID
		}
	}
	refs := map[string]map[string]bool{}
	for _, shot := range project.Shots {
		for _, output := range []string{shot.ImageNodeID, shot.VideoNodeID} {
			if output == "" {
				continue
			}
			if refs[output] == nil {
				refs[output] = map[string]bool{}
			}
			for _, asset := range project.Assets {
				if slices.Contains(canvasScriptShotAssetIDs(shot), asset.ID) && asset.ImageNodeID != "" {
					refs[output][asset.ImageNodeID] = true
				}
			}
			if output == shot.VideoNodeID && shot.ImageNodeID != "" {
				refs[output][shot.ImageNodeID] = true
			}
		}
	}
	for _, output := range slices.Sorted(maps.Keys(refs)) {
		sources := refs[output]
		next = slices.DeleteFunc(next, func(e CanvasConnection) bool {
			return e.ToNodeID == output && (inputs[e.FromNodeID] || oldInputs[e.FromNodeID] || oldOutputs[e.FromNodeID]) && !sources[e.FromNodeID] && e.FromNodeID != scriptID
		})
		if !inputs[output] {
			connect(scriptID, output)
		}
		for _, source := range slices.Sorted(maps.Keys(sources)) {
			connect(source, output)
		}
	}
	return next
}
