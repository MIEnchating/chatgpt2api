package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

// Partial documents update only included bodies. Removing a session requires an
// explicit ID, so opening or saving one conversation cannot erase other ones.
func mergeCanvasPartialHistory(current, incoming json.RawMessage, deleted []string, updates []CanvasAgentSessionUpdate, expected []CanvasAgentSessionSummary) (json.RawMessage, error) {
	var stored, changed []json.RawMessage
	if len(current) > 0 {
		if err := json.Unmarshal(current, &stored); err != nil {
			return nil, err
		}
	}
	if len(incoming) > 0 {
		if err := json.Unmarshal(incoming, &changed); err != nil {
			return nil, err
		}
	}
	removed := make(map[string]bool, len(deleted))
	for _, id := range deleted {
		if strings.TrimSpace(id) == "" {
			return nil, invalidCanvasDocument("deleted history session id is required")
		}
		removed[id] = true
	}
	edits := make(map[string]json.RawMessage, len(changed))
	changedIDs := make([]string, len(changed))
	for index, body := range changed {
		summary, err := canvasAgentSessionMetadata(body)
		if err != nil || summary.ID == "" || edits[summary.ID] != nil || removed[summary.ID] {
			return nil, invalidCanvasDocument("partial history requires unique session ids and disjoint deletions")
		}
		edits[summary.ID] = body
		changedIDs[index] = summary.ID
	}
	metadata := make(map[string]CanvasAgentSessionUpdate, len(updates))
	for _, update := range updates {
		if update.ID == "" || strings.TrimSpace(update.ID) != update.ID || len(update.ID) > 128 || len(update.Changes) == 0 || metadata[update.ID].ID != "" || edits[update.ID] != nil || removed[update.ID] {
			return nil, invalidCanvasDocument("session metadata updates require unique existing ids and disjoint writes")
		}
		for key, raw := range update.Changes {
			var value string
			if (key != "title" && key != "engine" && key != "updatedAt") || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil || key == "engine" && value != "native" && value != "codex" {
				return nil, invalidCanvasDocument("session metadata update contains an invalid field")
			}
		}
		metadata[update.ID] = update
	}
	versions := make(map[string]string, len(expected))
	for _, summary := range expected {
		versions[summary.ID] = summary.ContentHash
	}
	known := make(map[string]bool, len(stored))
	storedIDs := make([]string, len(stored))
	for index, body := range stored {
		summary, err := canvasAgentSessionMetadata(body)
		if err != nil {
			return nil, err
		}
		known[summary.ID] = true
		storedIDs[index] = summary.ID
		if edits[summary.ID] == nil && !removed[summary.ID] && metadata[summary.ID].ID == "" {
			continue
		}
		if versions[summary.ID] == "" {
			return nil, invalidCanvasDocument("partial history requires the original session content hash")
		}
		contentHash, err := canvasAgentSessionContentHash(body)
		if err != nil {
			return nil, err
		}
		if versions[summary.ID] != contentHash {
			return nil, fmt.Errorf("%w: canvas history session changed", ErrCanvasRevisionConflict)
		}
	}
	for id := range metadata {
		if !known[id] {
			return nil, invalidCanvasDocument("session metadata update refers to a missing session")
		}
	}
	if len(changed) == 0 && len(deleted) == 0 && len(updates) == 0 && len(stored) > 0 {
		return current, nil
	}
	result := make([]json.RawMessage, 0, len(stored)+len(changed))
	for index, body := range changed {
		if !known[changedIDs[index]] {
			result = append(result, body)
		}
	}
	for index, body := range stored {
		id := storedIDs[index]
		if removed[id] {
			continue
		}
		if edit := edits[id]; edit != nil {
			body = edit
		}
		if update, ok := metadata[id]; ok {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(body, &fields); err != nil {
				return nil, err
			}
			for key, value := range update.Changes {
				fields[key] = value
			}
			var err error
			body, err = json.Marshal(fields)
			if err != nil {
				return nil, err
			}
		}
		result = append(result, body)
	}
	return json.Marshal(result)
}

// CanvasAgentHistoryView retains directory metadata and only requested bodies,
// plus the active conversation and any conversation whose run is being observed.
func CanvasAgentHistoryView(document CanvasDocument, keepIDs []string) (CanvasDocument, error) {
	return canvasAgentHistoryView(document, keepIDs, nil, nil, canvasVerifiedAgentHistory{})
}

// A save receipt can omit cached active/run bodies whose hashes were already
// acknowledged. Explicitly submitted bodies always return after reconciliation.
func canvasAgentHistoryView(document CanvasDocument, keepIDs []string, acknowledged map[string]string, updates []CanvasAgentSessionUpdate, verified canvasVerifiedAgentHistory) (CanvasDocument, error) {
	var sessions []json.RawMessage
	summaries := make([]CanvasAgentSessionSummary, 0)
	if sha256.Sum256(document.AgentSessions) == verified.sessionsHash {
		// These summaries were verified against every immutable block in this
		// read. Copy the directory so callers cannot mutate that evidence.
		for _, session := range verified.reference.Sessions {
			summaries = append(summaries, session.CanvasAgentSessionSummary)
		}
	} else {
		if len(document.AgentSessions) > 0 {
			if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
				return CanvasDocument{}, err
			}
		}
		for _, body := range sessions {
			summary, err := canvasAgentSessionSummary(body)
			if err != nil {
				return CanvasDocument{}, err
			}
			summaries = append(summaries, summary)
		}
	}
	keep := make(map[string]bool, len(keepIDs)+2)
	for _, id := range keepIDs {
		keep[id] = true
	}
	accepted := make(map[string]bool, len(updates))
	for _, update := range updates {
		accepted[update.ID] = true
	}
	active := document.ActiveAgentSessionID
	if active == "" && len(summaries) > 0 {
		active = summaries[0].ID
	}
	selectedIndexes := make([]int, 0)
	for index, summary := range summaries {
		current := summary.ID == active || document.AgentRun != nil && summary.ID == document.AgentRun.SessionID
		if keep[summary.ID] || current && !accepted[summary.ID] && (acknowledged == nil || acknowledged[summary.ID] != summary.ContentHash) {
			selectedIndexes = append(selectedIndexes, index)
		}
	}
	selected := make([]json.RawMessage, 0, len(selectedIndexes))
	if len(selectedIndexes) > 0 {
		if sessions == nil {
			if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
				return CanvasDocument{}, err
			}
		}
		for _, index := range selectedIndexes {
			selected = append(selected, sessions[index])
		}
	}
	document.AgentSessions, _ = json.Marshal(selected)
	document.AgentSessionSummaries = summaries
	document.AgentSessionUpdates = updates
	document.AgentHistoryPartial = true
	document.DeletedAgentSessionIDs = nil
	document.ActiveAgentSessionID = active
	return document, nil
}

type CanvasHistoryScope string

const (
	CanvasHistoryFull   CanvasHistoryScope = "full"
	CanvasHistoryActive CanvasHistoryScope = "active"
	CanvasHistoryEditor CanvasHistoryScope = "editor"
)

// EditorWorkspace opens geometry and the active transcript directly from the
// manifest. Other projects and inactive transcripts never load their chunks.
func (s *CanvasDocumentService) EditorWorkspace(ownerID, projectID string, keepIDs []string) (CanvasWorkspaceResult, error) {
	return s.readProjectWorkspace(ownerID, projectID, keepIDs, CanvasHistoryActive, false, nil)
}

// ProjectWorkspace loads the requested project's complete history once, without
// loading other projects' history or changing the persisted active project.
func (s *CanvasDocumentService) ProjectWorkspace(ownerID, projectID string) (CanvasWorkspaceResult, error) {
	return s.readProjectWorkspace(ownerID, projectID, nil, CanvasHistoryFull, false, nil)
}

// ActivateProjectWorkspace remembers the selected project only after its requested
// history has loaded successfully. It never reads another project's history.
func (s *CanvasDocumentService) ActivateProjectWorkspace(ownerID, projectID string, partial bool) (CanvasWorkspaceResult, error) {
	scope := CanvasHistoryFull
	if partial {
		scope = CanvasHistoryActive
	}
	return s.readProjectWorkspace(ownerID, projectID, nil, scope, true, nil)
}

func (s *CanvasDocumentService) readProjectWorkspace(ownerID, projectID string, keepIDs []string, scope CanvasHistoryScope, activate bool, agentActive func(string) bool) (CanvasWorkspaceResult, error) {
	ownerID, projectID = util.Clean(ownerID), strings.TrimSpace(projectID)
	if activate && projectID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project id is required")
	}
	partial := scope == CanvasHistoryActive || scope == CanvasHistoryEditor
	if ownerID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasWorkspaceResult{}, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		raw, err := loadStoredJSONBounded(s.store, canvasWorkspaceName(ownerID))
		if err != nil {
			return CanvasWorkspaceResult{}, err
		}
		var workspace canvasWorkspace
		if raw == nil {
			workspace, err = s.loadWorkspaceLocked(ownerID)
			if err != nil {
				return CanvasWorkspaceResult{}, err
			}
		} else {
			data, err := json.Marshal(raw)
			if err != nil {
				return CanvasWorkspaceResult{}, err
			}
			if err := json.Unmarshal(data, &workspace); err != nil {
				return CanvasWorkspaceResult{}, err
			}
		}
		if projectID != "" {
			workspace.ActiveProjectID = projectID
		} else {
			active, err := s.loadActiveProjectLocked(ownerID, workspace.Generation)
			if err != nil {
				return CanvasWorkspaceResult{}, err
			}
			if canvasProjectIndex(workspace, active) >= 0 {
				workspace.ActiveProjectID = active
			}
		}
		index := activeCanvasProjectIndex(workspace)
		if index < 0 {
			if projectID != "" {
				return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
			}
			return canvasWorkspaceResult(workspace), nil
		}
		document := workspace.Projects[index]
		reference, exists := workspace.AgentHistories[document.ID]
		legacy := workspace.Version < 4 || !exists || reference.Bytes != 0 || len(reference.Chunks) > 0
		deferred := false
		if legacy || !partial {
			target := canvasWorkspace{Version: workspace.Version, Projects: []CanvasDocument{document}, AgentHistories: map[string]canvasAgentHistoryReference{}}
			if exists {
				target.AgentHistories[document.ID] = reference
			}
			err = s.loadAgentHistoriesLocked(ownerID, &target)
			if err == nil && partial {
				document, err = CanvasAgentHistoryView(target.Projects[0], keepIDs)
			} else if err == nil {
				document, err = normalizeCanvasDocument(target.Projects[0])
			}
		} else {
			// Leave closed editors on the directory unless they need the history to resume a run.
			deferred = scope == CanvasHistoryEditor && len(keepIDs) == 0 && len(document.PendingAgentRequest) == 0 && reference.Messages == nil &&
				(document.AgentPanel == nil || !document.AgentPanel.Open) && (agentActive == nil || !agentActive(document.ID)) &&
				(document.AgentRun == nil || document.AgentRun.Status != "running" && slices.ContainsFunc(reference.Sessions, func(session canvasAgentSessionReference) bool {
					return session.ID == document.AgentRun.SessionID
				}))
			document.AgentHistoryPartial = true
			document.AgentSessionSummaries = make([]CanvasAgentSessionSummary, 0, len(reference.Sessions))
			var selected []json.RawMessage
			if len(reference.Sessions) > 0 && !slices.ContainsFunc(reference.Sessions, func(session canvasAgentSessionReference) bool {
				return session.ID == document.ActiveAgentSessionID
			}) {
				document.ActiveAgentSessionID = reference.Sessions[0].ID
			}
			prefix := fmt.Sprintf("canvas_agent_history/%x/", sha256.Sum256([]byte(ownerID)))
			keep := make(map[string]bool, len(keepIDs))
			for _, id := range keepIDs {
				keep[id] = true
			}
			for _, session := range reference.Sessions {
				document.AgentSessionSummaries = append(document.AgentSessionSummaries, session.CanvasAgentSessionSummary)
				if deferred || !keep[session.ID] && session.ID != document.ActiveAgentSessionID && (document.AgentRun == nil || session.ID != document.AgentRun.SessionID) {
					continue
				}
				var body []byte
				body, err = loadCanvasAgentHistoryBlock(s.store, prefix, document.ID, session.Block)
				if err != nil {
					break
				}
				summary, summaryErr := canvasAgentSessionSummary(body)
				if summaryErr != nil || summary != session.CanvasAgentSessionSummary {
					err = fmt.Errorf("canvas agent session index integrity check failed")
					break
				}
				selected = append(selected, body)
			}
			if err == nil && reference.Messages != nil {
				var body []byte
				body, err = loadCanvasAgentHistoryBlock(s.store, prefix, document.ID, *reference.Messages)
				if err == nil {
					err = json.Unmarshal(body, &document.AgentMessages)
				}
			}
			if selected == nil {
				selected = []json.RawMessage{}
			}
			document.AgentSessions, _ = json.Marshal(selected)
		}
		if err == nil {
			if activate {
				if err := s.saveActiveProjectLocked(ownerID, projectID, workspace.Generation); err != nil {
					if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
						continue
					}
					return CanvasWorkspaceResult{}, err
				}
			}
			workspace.Projects[index] = document
			result := canvasWorkspaceResult(workspace)
			result.historyDeferred = deferred
			return result, nil
		}
		if !errors.Is(err, errCanvasAgentHistoryChunkMissing) {
			return CanvasWorkspaceResult{}, err
		}
		latest, readErr := loadStoredJSONBounded(s.store, canvasWorkspaceName(ownerID))
		if readErr != nil {
			return CanvasWorkspaceResult{}, readErr
		}
		before, _ := json.Marshal(raw)
		after, _ := json.Marshal(latest)
		if bytes.Equal(before, after) {
			return CanvasWorkspaceResult{}, err
		}
	}
	return CanvasWorkspaceResult{}, fmt.Errorf("canvas history changed repeatedly during reading: %w", storage.ErrConcurrentRowUpdate)
}
