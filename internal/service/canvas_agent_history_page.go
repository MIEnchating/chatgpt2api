package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/util"
)

type CanvasAgentHistoryPage struct {
	Sessions   []CanvasAgentSessionSummary `json:"sessions"`
	Revision   int64                       `json:"revision"`
	NextCursor string                      `json:"next_cursor,omitempty"`
}

type canvasAgentHistoryCursor struct {
	ProjectID string `json:"project_id"`
	Revision  int64  `json:"revision"`
	Offset    int    `json:"offset"`
}

// AgentHistoryPage reads the session index without loading message bodies.
// Cursors are bound to the project revision, preventing skipped or repeated
// records when another browser changes the history between pages.
func (s *CanvasDocumentService) AgentHistoryPage(ownerID, projectID, cursor string, limit int) (CanvasAgentHistoryPage, error) {
	if limit < 1 || limit > 50 {
		return CanvasAgentHistoryPage{}, invalidCanvasDocument("history page size must be between 1 and 50")
	}
	position := canvasAgentHistoryCursor{}
	if cursor != "" {
		if len(cursor) > 2048 {
			return CanvasAgentHistoryPage{}, invalidCanvasDocument("invalid canvas history cursor")
		}
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || len(data) > 1024 || json.Unmarshal(data, &position) != nil || position.ProjectID != strings.TrimSpace(projectID) || position.Revision < 0 || position.Offset < 1 {
			return CanvasAgentHistoryPage{}, invalidCanvasDocument("invalid canvas history cursor")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	document, reference, err := s.agentHistoryIndexLocked(ownerID, projectID)
	if err != nil {
		return CanvasAgentHistoryPage{}, err
	}
	if cursor != "" && position.Revision != document.Revision {
		return CanvasAgentHistoryPage{}, CanvasRevisionConflictError{Expected: position.Revision, Actual: document.Revision}
	}
	if position.Offset > len(reference.Sessions) {
		return CanvasAgentHistoryPage{}, invalidCanvasDocument("canvas history cursor is out of range")
	}
	end := min(position.Offset+limit, len(reference.Sessions))
	page := CanvasAgentHistoryPage{Sessions: make([]CanvasAgentSessionSummary, 0, end-position.Offset), Revision: document.Revision}
	for _, session := range reference.Sessions[position.Offset:end] {
		page.Sessions = append(page.Sessions, session.CanvasAgentSessionSummary)
	}
	if end < len(reference.Sessions) {
		data, _ := json.Marshal(canvasAgentHistoryCursor{ProjectID: document.ID, Revision: document.Revision, Offset: end})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return page, nil
}

// AgentHistorySession loads only the selected session's immutable blocks.
func (s *CanvasDocumentService) AgentHistorySession(ownerID, projectID, sessionID string, revision int64) (json.RawMessage, error) {
	if strings.TrimSpace(sessionID) == "" || revision < 0 {
		return nil, invalidCanvasDocument("history session id and revision are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	document, reference, err := s.agentHistoryIndexLocked(ownerID, projectID)
	if err != nil {
		return nil, err
	}
	if revision != document.Revision {
		return nil, CanvasRevisionConflictError{Expected: revision, Actual: document.Revision}
	}
	for _, item := range reference.Sessions {
		if item.ID != sessionID {
			continue
		}
		return s.agentHistorySessionBodyLocked(ownerID, projectID, document, item)
	}
	return nil, invalidCanvasDocument("canvas history session does not exist")
}

func (s *CanvasDocumentService) agentHistorySessionBodyLocked(ownerID, projectID string, document CanvasDocument, item canvasAgentSessionReference) (json.RawMessage, error) {
	// Old inline/envelope history is upgraded on save. Its selected body
	// is available in the hydrated document during this read.
	if len(document.AgentSessions) > 0 {
		var sessions []json.RawMessage
		if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
			return nil, err
		}
		for _, session := range sessions {
			summary, err := canvasAgentSessionSummary(session)
			if err != nil {
				return nil, err
			}
			if summary.ID == item.ID {
				return session, nil
			}
		}
	}
	prefix := fmt.Sprintf("canvas_agent_history/%x/", sha256.Sum256([]byte(util.Clean(ownerID))))
	data, err := loadCanvasAgentHistoryBlock(s.store, prefix, document.ID, item.Block)
	if err != nil {
		if errors.Is(err, errCanvasAgentHistoryChunkMissing) {
			current, _, readErr := s.agentHistoryIndexLocked(ownerID, projectID)
			if readErr != nil {
				return nil, readErr
			}
			if current.Revision != document.Revision {
				return nil, CanvasRevisionConflictError{Expected: document.Revision, Actual: current.Revision}
			}
		}
		return nil, err
	}
	summary, err := canvasAgentSessionSummary(data)
	if err != nil || !sameCanvasAgentSessionSummary(item.CanvasAgentSessionSummary, summary) {
		return nil, fmt.Errorf("canvas agent session index integrity check failed")
	}
	return json.RawMessage(data), nil
}

type CanvasAgentHistoryMatch struct {
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
	MessageID string `json:"message_id"`
	Role      string `json:"role"`
	Snippet   string `json:"snippet"`
}

type CanvasAgentHistorySearchPage struct {
	Matches    []CanvasAgentHistoryMatch `json:"matches"`
	Revision   int64                     `json:"revision"`
	NextCursor string                    `json:"next_cursor,omitempty"`
}

type canvasAgentSearchCursor struct {
	ProjectID string `json:"project_id"`
	Query     string `json:"query"`
	Role      string `json:"role,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Revision  int64  `json:"revision"`
	Session   int    `json:"session"`
	Message   int    `json:"message"`
}

type CanvasAgentHistorySearch struct {
	Query, Role, SessionID, Cursor string
	Limit                          int
}

// Search the visible transcript using the session versions in the current directory.
func (s *CanvasDocumentService) SearchAgentHistory(ctx context.Context, ownerID, projectID string, search CanvasAgentHistorySearch) (CanvasAgentHistorySearchPage, error) {
	query, cursor, limit := strings.ToLower(strings.TrimSpace(search.Query)), search.Cursor, search.Limit
	if len(query) == 0 || utf8.RuneCountInString(query) > 160 || limit < 1 || limit > 50 ||
		len(search.SessionID) > 128 || search.Role != "" && search.Role != "user" && search.Role != "assistant" {
		return CanvasAgentHistorySearchPage{}, invalidCanvasDocument("无效的对话搜索范围")
	}
	position := canvasAgentSearchCursor{ProjectID: strings.TrimSpace(projectID), Query: query, Role: search.Role, SessionID: search.SessionID}
	if cursor != "" {
		if len(cursor) > 2048 {
			return CanvasAgentHistorySearchPage{}, invalidCanvasDocument("无效的搜索游标")
		}
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		next := canvasAgentSearchCursor{}
		if err != nil || json.Unmarshal(raw, &next) != nil || next.ProjectID != position.ProjectID ||
			next.Query != query || next.Role != search.Role || next.SessionID != search.SessionID || next.Revision < 0 || next.Session < 0 || next.Message < 0 {
			return CanvasAgentHistorySearchPage{}, invalidCanvasDocument("无效的搜索游标")
		}
		position = next
	}
	s.mu.Lock()
	document, reference, err := s.agentHistoryIndexLocked(ownerID, projectID)
	s.mu.Unlock()
	if err != nil {
		return CanvasAgentHistorySearchPage{}, err
	}
	if cursor != "" && position.Revision != document.Revision {
		return CanvasAgentHistorySearchPage{}, CanvasRevisionConflictError{Expected: position.Revision, Actual: document.Revision}
	}
	page := CanvasAgentHistorySearchPage{Matches: make([]CanvasAgentHistoryMatch, 0, limit), Revision: document.Revision}
	position.Revision = document.Revision
	if position.Session >= len(reference.Sessions) && cursor != "" {
		return CanvasAgentHistorySearchPage{}, invalidCanvasDocument("搜索游标超出范围")
	}
	for index := position.Session; index < len(reference.Sessions); index++ {
		if err = ctx.Err(); err != nil {
			return CanvasAgentHistorySearchPage{}, err
		}
		// The session directory is ordered by the workspace. Search newest entries first.
		item := reference.Sessions[len(reference.Sessions)-1-index]
		if item.MessageCount == 0 || search.SessionID != "" && item.ID != search.SessionID {
			continue
		}
		messages, err := s.agentSearchMessages(ownerID, projectID, document, item)
		if err != nil {
			return CanvasAgentHistorySearchPage{}, err
		}
		offset := 0
		if index == position.Session {
			offset = position.Message
		}
		if offset > len(messages) {
			return CanvasAgentHistorySearchPage{}, invalidCanvasDocument("搜索游标超出范围")
		}
		for i := offset; i < len(messages); i++ {
			message := messages[len(messages)-1-i]
			if message.ID == "" || message.Role != "user" && message.Role != "assistant" || search.Role != "" && message.Role != search.Role {
				continue
			}
			snippet := canvasAgentSearchSnippet(message.Text, message.Folded, query)
			if snippet == "" {
				continue
			}
			if len(page.Matches) == limit {
				position.Session, position.Message = index, i
				data, _ := json.Marshal(position)
				page.NextCursor = base64.RawURLEncoding.EncodeToString(data)
				return page, nil
			}
			page.Matches = append(page.Matches, CanvasAgentHistoryMatch{SessionID: item.ID, Title: item.Title, MessageID: message.ID, Role: message.Role, Snippet: snippet})
		}
	}
	return page, nil
}

func canvasAgentSearchSnippet(text, folded, query string) string {
	index := strings.Index(folded, query)
	if index < 0 {
		return ""
	}
	position := utf8.RuneCountInString(folded[:index])
	runes := []rune(text)
	start := max(0, position-36)
	end := min(len(runes), max(start+120, position+utf8.RuneCountInString(query)+24))
	snippet := strings.Join(strings.Fields(string(runes[start:end])), " ")
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(runes) {
		snippet += "…"
	}
	return snippet
}

func (s *CanvasDocumentService) agentHistoryIndexLocked(ownerID, projectID string) (CanvasDocument, canvasAgentHistoryReference, error) {
	ownerID, projectID = util.Clean(ownerID), strings.TrimSpace(projectID)
	if ownerID == "" || projectID == "" {
		return CanvasDocument{}, canvasAgentHistoryReference{}, invalidCanvasDocument("canvas owner and project id are required")
	}
	if s.store == nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, fmt.Errorf("storage document backend is required")
	}
	raw, err := loadStoredJSONBounded(s.store, canvasWorkspaceName(ownerID))
	if err != nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, err
	}
	if raw == nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, invalidCanvasDocument("canvas project does not exist")
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, err
	}
	var workspace canvasWorkspace
	if err := json.Unmarshal(data, &workspace); err != nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, err
	}
	index := canvasProjectIndex(workspace, projectID)
	if index < 0 {
		return CanvasDocument{}, canvasAgentHistoryReference{}, invalidCanvasDocument("canvas project does not exist")
	}
	document := workspace.Projects[index]
	reference := workspace.AgentHistories[projectID]
	if workspace.Version >= 4 && reference.Bytes == 0 && len(reference.Chunks) == 0 && len(document.AgentSessions) == 0 {
		return document, reference, nil
	}
	// Migrate only after a successful write. A read of old data remains read-only.
	legacy := canvasWorkspace{Projects: []CanvasDocument{document}, AgentHistories: map[string]canvasAgentHistoryReference{}}
	if _, exists := workspace.AgentHistories[projectID]; exists {
		legacy.AgentHistories[projectID] = reference
	}
	if err := s.loadAgentHistoriesLocked(ownerID, &legacy); err != nil {
		return CanvasDocument{}, canvasAgentHistoryReference{}, err
	}
	document = legacy.Projects[0]
	var sessions []json.RawMessage
	if len(document.AgentSessions) > 0 {
		if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
			return CanvasDocument{}, canvasAgentHistoryReference{}, err
		}
	}
	reference = canvasAgentHistoryReference{}
	for _, session := range sessions {
		summary, err := canvasAgentSessionSummary(session)
		if err != nil {
			return CanvasDocument{}, canvasAgentHistoryReference{}, err
		}
		reference.Sessions = append(reference.Sessions, canvasAgentSessionReference{CanvasAgentSessionSummary: summary})
	}
	return document, reference, nil
}
