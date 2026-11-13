package service

import (
	"chatgpt2api/internal/util"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
)

func cloneCanvasAgentDocument(doc CanvasDocument) CanvasDocument {
	var clone CanvasDocument
	data, _ := json.Marshal(doc)
	_ = json.Unmarshal(data, &clone)
	return clone
}

// Apply only worker changes; concurrent user edits win field conflicts.
func mergeCanvasAgentDocument(base, edited, current CanvasDocument) CanvasDocument {
	edited = protectCanvasAgentGenerationResults(base, edited, current)
	toMap := func(doc CanvasDocument) map[string]any {
		data, _ := json.Marshal(doc)
		var value map[string]any
		_ = json.Unmarshal(data, &value)
		return value
	}
	b, e, c := toMap(base), toMap(edited), toMap(current)
	merged := mergeCanvasAgentFields(b, e, c)
	if !reflect.DeepEqual(b["agent_config"], e["agent_config"]) {
		merged["agent_config"] = mergeCanvasAgentFields(agentMap(b["agent_config"]), agentMap(e["agent_config"]), agentMap(c["agent_config"]))
	}
	for _, key := range []string{"nodes", "connections"} {
		merged[key] = mergeCanvasAgentEntities(b[key], e[key], c[key])
	}
	// Execution state belongs to the worker, never to browser snapshots.
	for _, key := range []string{"agent_run", "agent_sessions", "active_agent_session_id"} {
		if value, ok := e[key]; ok {
			merged[key] = value
		} else {
			delete(merged, key)
		}
	}
	if sessions, ok := merged["agent_sessions"]; ok {
		data, _ := json.Marshal(sessions)
		merged["agent_sessions"] = json.RawMessage(mergeCanvasAgentMessageQueues(data, current.AgentSessions))
	}
	data, _ := json.Marshal(merged)
	var result CanvasDocument
	_ = json.Unmarshal(data, &result)
	protectCanvasAgentMergedVideos(base, edited, current, &result)
	baseNodes, editedNodes, currentNodes := map[string]CanvasNode{}, map[string]CanvasNode{}, map[string]CanvasNode{}
	for _, node := range base.Nodes {
		baseNodes[node.ID] = node
	}
	for _, node := range edited.Nodes {
		editedNodes[node.ID] = node
	}
	for _, node := range current.Nodes {
		currentNodes[node.ID] = node
	}
	for i := range result.Nodes {
		node := &result.Nodes[i]
		before, worker, remote := baseNodes[node.ID], editedNodes[node.ID], currentNodes[node.ID]
		if node.ScriptProject == nil || before.ScriptProject == nil || worker.ScriptProject == nil || remote.ScriptProject == nil || before.ScriptProject.Confirmed || !worker.ScriptProject.Confirmed {
			continue
		}
		// A confirmation cannot approve content edited after the worker read it.
		if canvasScriptConfirmationFingerprint(before) != canvasScriptConfirmationFingerprint(remote) {
			node.ScriptProject.Confirmed = remote.ScriptProject.Confirmed
		}
	}
	ids := map[string]bool{}
	for _, node := range result.Nodes {
		ids[node.ID] = true
	}
	for i := range result.Nodes {
		if group := result.Nodes[i].GroupID; group != "" && !ids[group] {
			result.Nodes[i].GroupID = ""
		}
	}
	connections := result.Connections[:0]
	for _, edge := range result.Connections {
		if ids[edge.FromNodeID] && ids[edge.ToNodeID] {
			connections = append(connections, edge)
		}
	}
	result.Connections = connections
	return result
}

func mergeCanvasAgentFields(base, edited, current map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range current {
		result[key] = value
	}
	keys := map[string]bool{}
	for key := range base {
		keys[key] = true
	}
	for key := range edited {
		keys[key] = true
	}
	for key := range keys {
		before, was := base[key]
		after, has := edited[key]
		remote, exists := current[key]
		if was == has && reflect.DeepEqual(before, after) {
			continue
		}
		if key == "script_project" && was && has && exists {
			b, e, c := agentMap(before), agentMap(after), agentMap(remote)
			project := mergeCanvasAgentFields(b, e, c)
			for _, field := range []string{"shots", "assets"} {
				entities := mergeCanvasAgentEntities(b[field], e[field], c[field])
				ids := func(value any) []string {
					out := []string{}
					items, _ := value.([]any)
					for _, item := range items {
						out = append(out, util.Clean(agentMap(item)["id"]))
					}
					return out
				}
				if reflect.DeepEqual(ids(b[field]), ids(c[field])) {
					order := map[string]int{}
					for i, id := range ids(e[field]) {
						order[id] = i
					}
					slices.SortStableFunc(entities, func(a, b any) int {
						i, hasI := order[util.Clean(agentMap(a)["id"])]
						j, hasJ := order[util.Clean(agentMap(b)["id"])]
						if !hasI {
							i = len(order)
						}
						if !hasJ {
							j = len(order)
						}
						return i - j
					})
				}
				project[field] = entities
			}
			result[key] = project
			continue
		}
		if exists != was || !reflect.DeepEqual(remote, before) {
			continue
		}
		if has {
			result[key] = after
		} else {
			delete(result, key)
		}
	}
	return result
}

func mergeCanvasAgentEntities(base, edited, current any) []any {
	index := func(value any) map[string]map[string]any {
		result := map[string]map[string]any{}
		items, _ := value.([]any)
		for _, item := range items {
			entity, ok := item.(map[string]any)
			if ok {
				id, _ := entity["id"].(string)
				result[id] = entity
			}
		}
		return result
	}
	b, e, c := index(base), index(edited), index(current)
	result := []any{}
	items, _ := current.([]any)
	for _, item := range items {
		entity := item.(map[string]any)
		id := entity["id"].(string)
		if b[id] != nil && e[id] == nil && reflect.DeepEqual(b[id], entity) {
			continue
		}
		if b[id] != nil && e[id] != nil {
			result = append(result, mergeCanvasAgentFields(b[id], e[id], entity))
		} else {
			result = append(result, entity)
		}
	}
	additions, _ := edited.([]any)
	for _, item := range additions {
		entity := item.(map[string]any)
		id := entity["id"].(string)
		// Deleting a node while the worker runs must never resurrect it.
		if b[id] == nil && c[id] == nil {
			result = append(result, entity)
		}
	}
	return result
}

func (s *CanvasDocumentService) saveAgentChanges(owner string, base, edited CanvasDocument) (CanvasDocument, error) {
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		current, err := s.Project(owner, edited.ID)
		if err != nil {
			return CanvasDocument{}, err
		}
		if current.AgentRun == nil || edited.AgentRun == nil || current.AgentRun.ID != edited.AgentRun.ID {
			return CanvasDocument{}, ErrCanvasAgentBusy
		}
		next, err := s.saveAgent(owner, mergeCanvasAgentDocument(base, edited, current))
		if !errors.Is(err, ErrCanvasRevisionConflict) {
			return next, err
		}
	}
	return CanvasDocument{}, ErrCanvasRevisionConflict
}
