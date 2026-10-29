package service

import (
	"encoding/json"
	"errors"
	"reflect"
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
	data, _ := json.Marshal(merged)
	var result CanvasDocument
	_ = json.Unmarshal(data, &result)
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
