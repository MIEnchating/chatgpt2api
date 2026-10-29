package service

import (
	"encoding/json"
	"slices"
	"strings"
	"unicode"

	"chatgpt2api/internal/util"
)

var canvasAgentConversation struct {
	Messages []string `json:"messages"`
	Prompt   string   `json:"prompt"`
}

func init() {
	data, err := canvasAgentAssets.ReadFile("canvas_agent_assets/conversation.json")
	if err != nil {
		panic(err)
	}
	if err = json.Unmarshal(data, &canvasAgentConversation); err != nil {
		panic(err)
	}
}
func (w *canvasAgentWorker) isConversation() bool {
	if w.doc.AgentRun.SDKState != "" || len(agentMap(w.state["pendingQuestion"])) > 0 || len(w.req.References) > 0 || len(w.req.SkillIDs) > 0 || w.req.MediaChoice != "" {
		return false
	}
	text := strings.ToLower(strings.TrimFunc(w.req.UserText, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("。！？!?.,，", r) }))
	return slices.Contains(canvasAgentConversation.Messages, text)
}
func (w *canvasAgentWorker) conversationMessages() []map[string]any {
	// Keep a bounded conversational tail without tool output or media payloads.
	messages := []map[string]any{}
	for _, message := range util.AsMapSlice(w.session["messages"]) {
		role := util.Clean(message["role"])
		if role != "user" && role != "assistant" || message["id"] == w.req.AssistantID {
			continue
		}
		content := []rune(util.Clean(message["text"]))
		if len(content) == 0 {
			continue
		}
		messages = append(messages, map[string]any{"role": role, "content": string(content[:min(len(content), 1200)])})
	}
	if len(messages) > 6 {
		messages = messages[len(messages)-6:]
	}
	if len(messages) == 0 || messages[len(messages)-1]["role"] != "user" || messages[len(messages)-1]["content"] != w.req.UserText {
		messages = append(messages, map[string]any{"role": "user", "content": w.req.UserText})
	}
	return messages
}
