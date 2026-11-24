package service

import (
	"encoding/json"
	"reflect"
	"strings"

	"chatgpt2api/internal/util"
)

type canvasAgentChange struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Action string `json:"action"`
	Label  string `json:"label"`
}

type canvasAgentChangeSummary struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Removed int `json:"removed"`
	Total   int `json:"total"`
}

func preserveCanvasAgentMessageMetadata(session, previous map[string]json.RawMessage) error {
	if err := preserveCanvasAgentQueuedHistoryReferences(session, previous); err != nil {
		return err
	}
	raw := session["messages"]
	if len(raw) == 0 {
		return nil
	}
	var messages, saved []map[string]json.RawMessage
	if json.Unmarshal(raw, &messages) != nil {
		return invalidCanvasDocument("canvas agent messages are invalid")
	}
	_ = json.Unmarshal(previous["messages"], &saved)
	metadata := make(map[string]map[string]json.RawMessage, len(saved))
	for _, message := range saved {
		var id string
		_ = json.Unmarshal(message["id"], &id)
		if id != "" {
			metadata[id] = message
		}
	}
	dirty := false
	for _, message := range messages {
		var id string
		_ = json.Unmarshal(message["id"], &id)
		for _, field := range []string{"canvasChanges", "canvasChangeSummary", "readOnly", "modelAttempts", "workflowRuns", "feedback", "historyReference", "goalMediaRestricted"} {
			if data := metadata[id][field]; len(data) > 0 {
				message[field] = data
				dirty = true
			} else if _, exists := message[field]; exists {
				delete(message, field)
				dirty = true
			}
		}
	}
	if dirty {
		var err error
		session["messages"], err = json.Marshal(messages)
		return err
	}
	return nil
}

func preserveCanvasAgentQueuedHistoryReferences(session, previous map[string]json.RawMessage) error {
	var queue, savedQueue map[string]json.RawMessage
	if len(session["messageQueue"]) == 0 {
		return nil
	}
	if err := json.Unmarshal(session["messageQueue"], &queue); err != nil {
		return err
	}
	_ = json.Unmarshal(previous["messageQueue"], &savedQueue)
	messages := queue["messages"]
	if err := preserveCanvasAgentHistoryReferences(queue, savedQueue, true); err != nil {
		return err
	}
	if !reflect.DeepEqual(messages, queue["messages"]) {
		session["messageQueue"], _ = json.Marshal(queue)
	}
	return nil
}

func preserveCanvasAgentHistoryReferences(current, previous map[string]json.RawMessage, matchText bool) error {
	if len(current["messages"]) == 0 {
		return nil
	}
	var messages, saved []map[string]json.RawMessage
	if err := json.Unmarshal(current["messages"], &messages); err != nil {
		return err
	}
	_ = json.Unmarshal(previous["messages"], &saved)
	type messageKey struct{ id, text string }
	key := func(message map[string]json.RawMessage) messageKey {
		if matchText {
			return messageKey{string(message["id"]), string(message["text"])}
		}
		return messageKey{id: string(message["id"])}
	}
	snapshots := make(map[messageKey]json.RawMessage)
	for _, item := range saved {
		if history := item["historyReference"]; len(item["id"]) > 0 && len(history) > 0 {
			snapshots[key(item)] = history
		}
	}
	changed := false
	for _, item := range messages {
		history, exists := item["historyReference"]
		stored := snapshots[key(item)]
		if len(stored) > 0 && string(stored) != string(history) {
			item["historyReference"] = stored
			changed = true
		} else if len(stored) == 0 && exists {
			delete(item, "historyReference")
			changed = true
		}
	}
	if changed {
		current["messages"], _ = json.Marshal(messages)
	}
	return nil
}

func recordCanvasAgentChanges(before CanvasDocument, saved *CanvasDocument) error {
	if reflect.DeepEqual(before.Nodes, saved.Nodes) && reflect.DeepEqual(before.Connections, saved.Connections) {
		return nil
	}
	run := saved.AgentRun
	sessions, session, err := agentSession(*saved, run.SessionID)
	if err != nil {
		return err
	}
	for _, msg := range util.AsMapSlice(session["messages"]) {
		if msg["id"] != run.AssistantID {
			continue
		}
		changes := map[string]canvasAgentChange{}
		order := []string{}
		for _, row := range util.AsMapSlice(msg["canvasChanges"]) {
			change := canvasAgentChange{ID: util.Clean(row["id"]), Kind: util.Clean(row["kind"]), Action: util.Clean(row["action"]), Label: util.Clean(row["label"])}
			key := change.Kind + ":" + change.ID
			if _, exists := changes[key]; !exists {
				order = append(order, key)
			}
			changes[key] = change
		}
		record := func(id, kind, action, label string) {
			key := kind + ":" + id
			previous, exists := changes[key]
			if exists && previous.Action == "added" && action == "removed" {
				delete(changes, key)
				return
			}
			if exists && previous.Action == "added" {
				action = "added"
			} else if exists && previous.Action == "removed" && action == "added" {
				action = "updated"
			}
			if !exists {
				order = append(order, key)
			}
			changes[key] = canvasAgentChange{ID: id, Kind: kind, Action: action, Label: label}
		}
		previousNodes, nextNodes := map[string]CanvasNode{}, map[string]CanvasNode{}
		for _, node := range before.Nodes {
			previousNodes[node.ID] = node
		}
		for _, node := range saved.Nodes {
			nextNodes[node.ID] = node
			if previous, ok := previousNodes[node.ID]; !ok {
				record(node.ID, "node", "added", firstAgentString(node.Title, node.Type))
			} else if !reflect.DeepEqual(previous, node) {
				record(node.ID, "node", "updated", firstAgentString(node.Title, node.Type))
			}
		}
		for _, node := range before.Nodes {
			if _, exists := nextNodes[node.ID]; !exists {
				record(node.ID, "node", "removed", firstAgentString(node.Title, node.Type))
			}
		}
		previousEdges, nextEdges := map[string]CanvasConnection{}, map[string]CanvasConnection{}
		edgeLabel := func(edge CanvasConnection, nodes map[string]CanvasNode) string {
			return strings.Join([]string{firstAgentString(nodes[edge.FromNodeID].Title, "节点"), firstAgentString(nodes[edge.ToNodeID].Title, "节点")}, " → ")
		}
		for _, edge := range before.Connections {
			previousEdges[edge.ID] = edge
		}
		for _, edge := range saved.Connections {
			nextEdges[edge.ID] = edge
			if previous, ok := previousEdges[edge.ID]; !ok {
				record(edge.ID, "connection", "added", edgeLabel(edge, nextNodes))
			} else if previous != edge {
				record(edge.ID, "connection", "updated", edgeLabel(edge, nextNodes))
			}
		}
		for _, edge := range before.Connections {
			if _, exists := nextEdges[edge.ID]; !exists {
				record(edge.ID, "connection", "removed", edgeLabel(edge, previousNodes))
			}
		}
		rows := make([]canvasAgentChange, 0, len(changes))
		for _, key := range order {
			if change, ok := changes[key]; ok {
				rows = append(rows, change)
				delete(changes, key)
			}
		}
		summary := canvasAgentChangeSummary{Total: len(rows)}
		for _, change := range rows {
			switch change.Action {
			case "added":
				summary.Added++
			case "updated":
				summary.Updated++
			case "removed":
				summary.Removed++
			}
		}
		msg["canvasChanges"] = rows
		if summary.Total == 0 {
			delete(msg, "canvasChangeSummary")
		} else {
			msg["canvasChangeSummary"] = summary
		}
		saved.AgentSessions, err = json.Marshal(sessions)
		return err
	}
	return nil
}
