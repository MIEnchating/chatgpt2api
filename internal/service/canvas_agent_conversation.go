package service

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"chatgpt2api/internal/util"
)

var canvasAgentQuoteLines = regexp.MustCompile(`(?m)^[ \t]*>[^\n]*`)

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
	if w.doc.AgentRun.SDKState != "" || len(agentMap(w.state["pendingQuestion"])) > 0 || len(w.req.References) > 0 || len(w.req.SkillIDs) > 0 || w.req.MediaChoice != "" || w.req.historyReference != "" {
		return false
	}
	text := strings.ToLower(strings.TrimFunc(w.req.UserText, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("。！？!?.,，", r) }))
	return slices.Contains(canvasAgentConversation.Messages, text)
}

// Read-only requests are selected from explicit intent and unambiguous queries.
func canvasAgentReadOnlyRequest(text string) bool {
	text = canvasAgentHistoryMention.ReplaceAllString(text, "")
	text = strings.ToLower(strings.TrimSpace(text))
	for _, prefix := range []string{"只读：", "只读:", "read-only:", "只读分析：", "只读分析:"} {
		if strings.HasPrefix(text, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(text, prefix)) != ""
		}
	}
	text = strings.TrimRight(text, "。？！?!.,，")
	return slices.Contains([]string{
		"总结当前画布", "总结一下当前画布", "概览当前画布", "查看当前画布", "列出当前画布的节点",
		"画布里有哪些节点", "当前画布有哪些节点", "当前画布里有什么", "当前画布里有哪些素材",
		"总结选中的节点", "选中的节点有哪些", "what is on this canvas", "summarize this canvas", "list the canvas nodes",
	}, text)
}

var canvasAgentReadOnlyTools = []string{
	"get_canvas_summary", "query_canvas_nodes", "list_references", "get_reference", "get_selected_nodes",
	"get_node", "get_upstream_nodes", "get_downstream_nodes", "get_connected_nodes", "get_media_task_status", "get_generation_task",
	"search_agent_history", "get_agent_history_message",
	"review_canvas_nodes",
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
