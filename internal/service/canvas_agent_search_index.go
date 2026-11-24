package service

import (
	"container/list"
	"encoding/json"
	"strings"
	"sync"

	"chatgpt2api/internal/util"
)

const (
	canvasAgentSearchIndexMaxBytes    = 16 << 20
	canvasAgentSearchIndexMaxSessions = 512
)

type canvasAgentSearchMessage struct {
	ID     string `json:"id"`
	Role   string `json:"role"`
	Text   string `json:"text"`
	Folded string `json:"-"`
}

type canvasAgentSearchKey struct {
	owner, project, session, hash string
}

type canvasAgentSearchEntry struct {
	key      canvasAgentSearchKey
	messages []canvasAgentSearchMessage
	bytes    int
}

// The index is disposable. The workspace directory selects which exact,
// owner-scoped session versions are visible on every search.
type canvasAgentSearchIndex struct {
	mu      sync.Mutex
	order   list.List
	entries map[canvasAgentSearchKey]*list.Element
	bytes   int
}

func (s *CanvasDocumentService) agentSearchMessages(owner, project string, document CanvasDocument, item canvasAgentSessionReference) ([]canvasAgentSearchMessage, error) {
	key := canvasAgentSearchKey{util.Clean(owner), document.ID, item.ID, item.ContentHash}
	index := &s.agentSearchIndex
	index.mu.Lock()
	if element := index.entries[key]; element != nil {
		index.order.MoveToFront(element)
		messages := element.Value.(canvasAgentSearchEntry).messages
		index.mu.Unlock()
		return messages, nil
	}
	index.mu.Unlock()

	s.mu.Lock()
	raw, err := s.agentHistorySessionBodyLocked(owner, project, document, item)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var session struct {
		Messages []canvasAgentSearchMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &session); err != nil {
		return nil, err
	}
	// Preserve the original positions used by search cursors.
	entry := canvasAgentSearchEntry{key: key, messages: session.Messages, bytes: 64 * cap(session.Messages)}
	for i := range entry.messages {
		message := &entry.messages[i]
		if message.ID == "" || message.Role != "user" && message.Role != "assistant" {
			*message = canvasAgentSearchMessage{}
			continue
		}
		message.Folded = strings.ToLower(message.Text)
		entry.bytes += len(message.ID) + len(message.Role) + len(message.Text) + len(message.Folded)
	}
	if key.hash == "" || entry.bytes > canvasAgentSearchIndexMaxBytes {
		return entry.messages, nil
	}
	index.mu.Lock()
	defer index.mu.Unlock()
	if index.entries == nil {
		index.entries = make(map[canvasAgentSearchKey]*list.Element)
	}
	if previous := index.entries[key]; previous != nil {
		index.order.MoveToFront(previous)
		return previous.Value.(canvasAgentSearchEntry).messages, nil
	}
	index.entries[key] = index.order.PushFront(entry)
	index.bytes += entry.bytes
	for index.order.Len() > canvasAgentSearchIndexMaxSessions || index.bytes > canvasAgentSearchIndexMaxBytes {
		oldest := index.order.Back()
		item := oldest.Value.(canvasAgentSearchEntry)
		index.bytes -= item.bytes
		delete(index.entries, item.key)
		index.order.Remove(oldest)
	}
	return entry.messages, nil
}
