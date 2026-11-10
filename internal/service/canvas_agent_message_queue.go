package service

import (
	"encoding/json"
	"strings"
)

// A queue is browser-owned; model history and receipts remain worker-owned.
func mergeCanvasAgentMessageQueues(current, incoming json.RawMessage) json.RawMessage {
	var stored, edited []map[string]any
	if json.Unmarshal(current, &stored) != nil || json.Unmarshal(incoming, &edited) != nil {
		return current
	}
	for _, session := range stored {
		id, ok := session["id"].(string)
		if !ok {
			continue
		}
		for _, edit := range edited {
			editedID, ok := edit["id"].(string)
			if !ok || id != editedID {
				continue
			}
			if queue, ok := edit["messageQueue"]; ok {
				session["messageQueue"] = queue
			}
			break
		}
	}
	data, _ := json.Marshal(stored)
	return data
}

func validateCanvasAgentMessageQueue(value any) bool {
	queue, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if _, ok = queue["paused"].(bool); !ok {
		return false
	}
	messages, ok := queue["messages"].([]any)
	if !ok || len(messages) > 16 {
		return false
	}
	ids := map[string]bool{}
	for _, value := range messages {
		message, ok := value.(map[string]any)
		if !ok {
			return false
		}
		id, idOK := message["id"].(string)
		text, textOK := message["text"].(string)
		_, dateOK := message["createdAt"].(string)
		references, refsOK := message["references"].([]any)
		if !idOK || id == "" || len(id) > 128 || ids[id] || !textOK || strings.TrimSpace(text) == "" || len(text) > canvasDocumentMaxPrompt || !dateOK || !refsOK || len(references) > 50 {
			return false
		}
		for _, reference := range references {
			ref, ok := reference.(map[string]any)
			if !ok {
				return false
			}
			if _, ok = ref["id"].(string); !ok {
				return false
			}
			if _, ok = ref["title"].(string); !ok {
				return false
			}
			if _, ok = ref["type"].(string); !ok {
				return false
			}
		}
		ids[id] = true
	}
	if steering, exists := queue["steeringId"]; exists {
		id, ok := steering.(string)
		if !ok || !ids[id] {
			return false
		}
	}
	return true
}
