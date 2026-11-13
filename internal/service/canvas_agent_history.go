package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"chatgpt2api/internal/storage"
)

const canvasAgentHistoryChunkBytes = 64 << 10

var errCanvasAgentHistoryChunkMissing = errors.New("canvas agent history chunk is missing; saved history was not replaced")

// History is persisted independently of canvas geometry. Immutable chunks are
// written before the workspace CAS publishes their manifest, so a failed save
// cannot replace a committed transcript with a partial or empty one.
type canvasAgentHistoryReference struct {
	Chunks          []string                      `json:"chunks,omitempty"`
	Bytes           int                           `json:"bytes,omitempty"`
	Sessions        []canvasAgentSessionReference `json:"sessions,omitempty"`
	SessionsPresent bool                          `json:"sessions_present,omitempty"`
	Messages        *canvasAgentHistoryBlock      `json:"messages,omitempty"`
}

type canvasAgentHistoryBlock struct {
	Chunks []string `json:"chunks"`
	Bytes  int      `json:"bytes"`
}

type CanvasAgentSessionSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	CreatedAt    string `json:"created_at,omitempty"`
	UpdatedAt    string `json:"updated_at,omitempty"`
	MessageCount int    `json:"message_count"`
	ContentHash  string `json:"content_hash"`
}

type CanvasAgentSessionUpdate struct {
	ID      string                     `json:"id"`
	Changes map[string]json.RawMessage `json:"changes"`
}

type canvasAgentSessionReference struct {
	CanvasAgentSessionSummary
	Block canvasAgentHistoryBlock `json:"block"`
}

type canvasAgentHistory struct {
	Sessions json.RawMessage      `json:"sessions,omitempty"`
	Messages []CanvasAgentMessage `json:"messages,omitempty"`
}

type canvasAgentHistoryChunk struct {
	Data []byte `json:"data"`
}

// Read-scoped evidence permits reuse only after every referenced chunk and
// session summary was verified. It is never persisted or shared across reads.
type canvasVerifiedAgentHistory struct {
	reference    canvasAgentHistoryReference
	sessionsHash [sha256.Size]byte
	messagesHash [sha256.Size]byte
}

func canvasAgentHistoryChunkName(ownerID, projectID, hash string) string {
	owner := sha256.Sum256([]byte(ownerID))
	project := sha256.Sum256([]byte(projectID))
	return fmt.Sprintf("canvas_agent_history/%x/%x/%s.json", owner, project, hash)
}

func (s *CanvasDocumentService) publishAgentHistoriesLocked(ownerID string, workspace canvasWorkspace) error {
	store, ok := s.store.(storage.JSONDocumentPruningBackend)
	if !ok {
		return fmt.Errorf("canvas history requires transactional document pruning")
	}
	var retained []string
	for projectID, reference := range workspace.AgentHistories {
		for _, hash := range canvasAgentHistoryHashes(reference) {
			retained = append(retained, canvasAgentHistoryChunkName(ownerID, projectID, hash))
		}
	}
	prefix := fmt.Sprintf("canvas_agent_history/%x/", sha256.Sum256([]byte(ownerID)))
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(taskStorageTimeout.Load()))
	defer cancel()
	return store.SaveJSONDocumentAndPrune(ctx, canvasWorkspaceName(ownerID), workspace, prefix, retained)
}

func (s *CanvasDocumentService) saveAgentHistoryBlockLocked(ownerID, projectID string, data []byte) (canvasAgentHistoryBlock, error) {
	reference := canvasAgentHistoryBlock{Bytes: len(data)}
	for start := 0; start < len(data); start += canvasAgentHistoryChunkBytes {
		part := data[start:min(start+canvasAgentHistoryChunkBytes, len(data))]
		hash := fmt.Sprintf("%x", sha256.Sum256(part))
		name := canvasAgentHistoryChunkName(ownerID, projectID, hash)
		raw, err := loadStoredJSONBounded(s.store, name)
		if err != nil {
			return canvasAgentHistoryBlock{}, fmt.Errorf("read canvas agent history chunk: %w", err)
		}
		if raw == nil {
			err = saveStoredJSONBounded(s.store, name, canvasAgentHistoryChunk{Data: part})
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				// Another writer may have inserted the same immutable content.
				raw, err = loadStoredJSONBounded(s.store, name)
			}
			if err != nil {
				return canvasAgentHistoryBlock{}, fmt.Errorf("save canvas agent history chunk: %w", err)
			}
		}
		if raw != nil {
			chunk, err := decodeCanvasAgentHistoryChunk(raw, hash)
			if err != nil || !bytes.Equal(chunk, part) {
				return canvasAgentHistoryBlock{}, fmt.Errorf("canvas agent history chunk integrity check failed")
			}
		}
		reference.Chunks = append(reference.Chunks, hash)
	}
	return reference, nil
}

func canvasAgentHistoryHashes(reference canvasAgentHistoryReference) []string {
	hashes := slices.Clone(reference.Chunks)
	for _, session := range reference.Sessions {
		hashes = append(hashes, session.Block.Chunks...)
	}
	if reference.Messages != nil {
		hashes = append(hashes, reference.Messages.Chunks...)
	}
	return hashes
}

func (s *CanvasDocumentService) saveAgentHistoryLocked(ownerID string, document CanvasDocument) (canvasAgentHistoryReference, error) {
	var sessions []json.RawMessage
	if len(document.AgentSessions) > 0 {
		if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
			return canvasAgentHistoryReference{}, err
		}
	}
	reference := canvasAgentHistoryReference{SessionsPresent: len(document.AgentSessions) > 0}
	for _, session := range sessions {
		summary, err := canvasAgentSessionSummary(session)
		if err != nil {
			return canvasAgentHistoryReference{}, err
		}
		block, err := s.saveAgentHistoryBlockLocked(ownerID, document.ID, session)
		if err != nil {
			return canvasAgentHistoryReference{}, err
		}
		reference.Sessions = append(reference.Sessions, canvasAgentSessionReference{CanvasAgentSessionSummary: summary, Block: block})
	}
	if len(document.AgentMessages) > 0 {
		data, err := json.Marshal(document.AgentMessages)
		if err != nil {
			return canvasAgentHistoryReference{}, err
		}
		block, err := s.saveAgentHistoryBlockLocked(ownerID, document.ID, data)
		if err != nil {
			return canvasAgentHistoryReference{}, err
		}
		reference.Messages = &block
	}
	return reference, nil
}

func canvasAgentSessionSummary(session json.RawMessage) (CanvasAgentSessionSummary, error) {
	summary, err := canvasAgentSessionMetadata(session)
	if err != nil {
		return CanvasAgentSessionSummary{}, err
	}
	summary.ContentHash, err = canvasAgentSessionContentHash(session)
	return summary, err
}

func canvasAgentSessionContentHash(session json.RawMessage) (string, error) {
	var canonical bytes.Buffer
	if err := json.Compact(&canonical, session); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(canonical.Bytes())), nil
}

func canvasAgentSessionMetadata(session json.RawMessage) (CanvasAgentSessionSummary, error) {
	var item struct {
		ID        string            `json:"id"`
		Title     string            `json:"title"`
		CreatedAt string            `json:"createdAt"`
		UpdatedAt string            `json:"updatedAt"`
		Messages  []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(session, &item); err != nil {
		return CanvasAgentSessionSummary{}, err
	}
	return CanvasAgentSessionSummary{ID: item.ID, Title: item.Title, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt, MessageCount: len(item.Messages)}, nil
}

func decodeCanvasAgentHistoryChunk(raw any, hash string) ([]byte, error) {
	chunk, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid canvas agent history chunk")
	}
	encoded, ok := chunk["data"].(string)
	if !ok {
		return nil, fmt.Errorf("invalid canvas agent history chunk data")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > canvasAgentHistoryChunkBytes || fmt.Sprintf("%x", sha256.Sum256(data)) != hash {
		return nil, fmt.Errorf("canvas agent history chunk integrity check failed")
	}
	return data, nil
}

func (s *CanvasDocumentService) loadAgentHistoriesLocked(ownerID string, workspace *canvasWorkspace) error {
	return loadCanvasAgentHistories(s.store, fmt.Sprintf("canvas_agent_history/%x/", sha256.Sum256([]byte(ownerID))), workspace)
}

func loadCanvasAgentHistories(store storage.JSONDocumentBackend, prefix string, workspace *canvasWorkspace) error {
	workspace.verifiedAgentHistories = make(map[string]canvasVerifiedAgentHistory)
	for index := range workspace.Projects {
		document := &workspace.Projects[index]
		reference, exists := workspace.AgentHistories[document.ID]
		if !exists {
			continue
		}
		if len(document.AgentSessions) > 0 || len(document.AgentMessages) > 0 {
			return fmt.Errorf("invalid canvas agent history manifest")
		}
		if reference.Bytes != 0 || len(reference.Chunks) > 0 {
			// Version 2 stored one envelope for the entire project's history.
			// Read it completely; the next successful save publishes session records.
			if len(reference.Sessions) > 0 || reference.Messages != nil || reference.SessionsPresent {
				return fmt.Errorf("mixed canvas agent history formats")
			}
			data, err := loadCanvasAgentHistoryBlock(store, prefix, document.ID, canvasAgentHistoryBlock{Chunks: reference.Chunks, Bytes: reference.Bytes})
			if err != nil {
				return err
			}
			var history canvasAgentHistory
			if err := json.Unmarshal(data, &history); err != nil {
				return fmt.Errorf("decode canvas agent history: %w", err)
			}
			document.AgentSessions, document.AgentMessages = history.Sessions, history.Messages
			continue
		}
		if reference.SessionsPresent || len(reference.Sessions) > 0 {
			sessions := make([]json.RawMessage, 0, len(reference.Sessions))
			for _, item := range reference.Sessions {
				data, err := loadCanvasAgentHistoryBlock(store, prefix, document.ID, item.Block)
				if err != nil {
					return err
				}
				summary, err := canvasAgentSessionSummary(data)
				// Version 3 indexed metadata without a content hash. Its body is
				// fully verified before a successful save publishes version 4.
				if item.ContentHash == "" && workspace.Version < 4 {
					item.ContentHash = summary.ContentHash
				}
				if err != nil || summary != item.CanvasAgentSessionSummary {
					return fmt.Errorf("canvas agent session index integrity check failed")
				}
				sessions = append(sessions, data)
			}
			document.AgentSessions, _ = json.Marshal(sessions)
		}
		if reference.Messages != nil {
			data, err := loadCanvasAgentHistoryBlock(store, prefix, document.ID, *reference.Messages)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(data, &document.AgentMessages); err != nil {
				return err
			}
		}
		if workspace.Version >= canvasWorkspaceVersion {
			messages, err := json.Marshal(document.AgentMessages)
			if err != nil {
				return err
			}
			workspace.verifiedAgentHistories[document.ID] = canvasVerifiedAgentHistory{
				reference: reference, sessionsHash: sha256.Sum256(document.AgentSessions), messagesHash: sha256.Sum256(messages),
			}
		}
	}
	workspace.AgentHistories = nil
	return nil
}

func loadCanvasAgentHistoryBlock(store storage.JSONDocumentBackend, prefix, projectID string, reference canvasAgentHistoryBlock) ([]byte, error) {
	if reference.Bytes < 1 || len(reference.Chunks) != (reference.Bytes-1)/canvasAgentHistoryChunkBytes+1 {
		return nil, fmt.Errorf("invalid canvas agent history block manifest")
	}
	chunks := make([][]byte, 0, len(reference.Chunks))
	total := 0
	for _, hash := range reference.Chunks {
		if decoded, err := hex.DecodeString(hash); err != nil || len(decoded) != sha256.Size {
			return nil, fmt.Errorf("invalid canvas agent history chunk identifier")
		}
		name := fmt.Sprintf("%s%x/%s.json", prefix, sha256.Sum256([]byte(projectID)), hash)
		raw, err := loadStoredJSONBounded(store, name)
		if err != nil {
			return nil, fmt.Errorf("load canvas agent history: %w", err)
		}
		if raw == nil {
			return nil, errCanvasAgentHistoryChunkMissing
		}
		chunk, err := decodeCanvasAgentHistoryChunk(raw, hash)
		if err != nil {
			return nil, err
		}
		if len(chunk) > reference.Bytes-total {
			return nil, fmt.Errorf("canvas agent history length does not match its manifest")
		}
		chunks = append(chunks, chunk)
		total += len(chunk)
	}
	if total != reference.Bytes {
		return nil, fmt.Errorf("canvas agent history length does not match its manifest")
	}
	return bytes.Join(chunks, nil), nil
}

// The persisted workspace contains only manifests, while callers and exports
// keep the complete transcript through the existing canvas document API.
func (s *CanvasDocumentService) archiveAgentHistoriesLocked(ownerID string, workspace canvasWorkspace) (canvasWorkspace, error) {
	stored := workspace
	stored.verifiedAgentHistories = nil
	stored.Projects = slices.Clone(workspace.Projects)
	stored.AgentHistories = make(map[string]canvasAgentHistoryReference)
	for index := range stored.Projects {
		document := &stored.Projects[index]
		if len(document.AgentSessions) == 0 && len(document.AgentMessages) == 0 {
			continue
		}
		if verified, ok := workspace.verifiedAgentHistories[document.ID]; ok {
			messages, err := json.Marshal(document.AgentMessages)
			if err != nil {
				return canvasWorkspace{}, err
			}
			if sha256.Sum256(document.AgentSessions) == verified.sessionsHash && sha256.Sum256(messages) == verified.messagesHash {
				stored.AgentHistories[document.ID] = verified.reference
				document.AgentSessions, document.AgentMessages = nil, nil
				continue
			}
		}
		reference, err := s.saveAgentHistoryLocked(ownerID, *document)
		if err != nil {
			return canvasWorkspace{}, err
		}
		stored.AgentHistories[document.ID] = reference
		document.AgentSessions, document.AgentMessages = nil, nil
	}
	return stored, nil
}
