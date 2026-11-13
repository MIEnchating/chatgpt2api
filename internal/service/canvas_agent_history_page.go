package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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
				if summary.ID == sessionID {
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
				if current.Revision != revision {
					return nil, CanvasRevisionConflictError{Expected: revision, Actual: current.Revision}
				}
			}
			return nil, err
		}
		summary, err := canvasAgentSessionSummary(data)
		if err != nil || summary != item.CanvasAgentSessionSummary {
			return nil, fmt.Errorf("canvas agent session index integrity check failed")
		}
		return json.RawMessage(data), nil
	}
	return nil, invalidCanvasDocument("canvas history session does not exist")
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
