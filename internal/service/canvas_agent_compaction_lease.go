package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"chatgpt2api/internal/storage"
)

const (
	canvasAgentWorkspaceLeaseDuration = 2 * time.Minute
	canvasAgentWorkspaceLeaseRenewal  = 20 * time.Second
)

var errCanvasAgentLeaseLost = errors.New("canvas agent lease was lost")

type canvasAgentWorkspaceLease struct {
	SessionID string `json:"session_id"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

func (s *CanvasDocumentService) acquireAgentCompactionLease(ownerID, projectID, sessionID string) (string, error) {
	ownerID, projectID, sessionID = strings.TrimSpace(ownerID), strings.TrimSpace(projectID), strings.TrimSpace(sessionID)
	if ownerID == "" || projectID == "" || sessionID == "" {
		return "", invalidCanvasDocument("canvas compaction lease requires an owner, project, and session")
	}
	token := uuid.NewString()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
		if err != nil {
			return "", err
		}
		index := canvasProjectIndex(workspace, projectID)
		if index < 0 {
			return "", invalidCanvasDocument("canvas project does not exist")
		}
		if run := workspace.Projects[index].AgentRun; run != nil && run.Status == "running" {
			return "", ErrCanvasAgentBusy
		}
		if lease, exists := workspace.AgentRunLeases[projectID]; exists && lease.ExpiresAt > time.Now().UnixMilli() {
			return "", ErrCanvasAgentBusy
		}
		if lease, exists := workspace.AgentCompactionLeases[projectID]; exists && lease.ExpiresAt > time.Now().UnixMilli() {
			return "", ErrCanvasAgentBusy
		}
		if workspace.AgentCompactionLeases == nil {
			workspace.AgentCompactionLeases = make(map[string]canvasAgentWorkspaceLease)
		}
		workspace.AgentCompactionLeases[projectID] = canvasAgentWorkspaceLease{
			SessionID: sessionID,
			Token:     token,
			ExpiresAt: time.Now().Add(canvasAgentWorkspaceLeaseDuration).UnixMilli(),
		}
		if err := saveStoredJSONBounded(s.store, canvasWorkspaceName(ownerID), workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return "", err
		}
		return token, nil
	}
	return "", storage.ErrConcurrentRowUpdate
}

func (s *CanvasDocumentService) renewAgentCompactionLease(ownerID, projectID, token string) error {
	return s.updateAgentCompactionLease(ownerID, projectID, token, true)
}

func (s *CanvasDocumentService) releaseAgentCompactionLease(ownerID, projectID, token string) error {
	return s.updateAgentCompactionLease(ownerID, projectID, token, false)
}

func (s *CanvasDocumentService) updateAgentCompactionLease(ownerID, projectID, token string, renew bool) error {
	ownerID, projectID, token = strings.TrimSpace(ownerID), strings.TrimSpace(projectID), strings.TrimSpace(token)
	if ownerID == "" || projectID == "" || token == "" {
		return invalidCanvasDocument("canvas compaction lease requires an owner, project, and token")
	}
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
		if err != nil {
			return err
		}
		lease, exists := workspace.AgentCompactionLeases[projectID]
		if !exists || lease.Token != token || lease.ExpiresAt <= time.Now().UnixMilli() {
			return errCanvasAgentLeaseLost
		}
		if renew {
			lease.ExpiresAt = time.Now().Add(canvasAgentWorkspaceLeaseDuration).UnixMilli()
			workspace.AgentCompactionLeases[projectID] = lease
		} else {
			delete(workspace.AgentCompactionLeases, projectID)
		}
		if err := saveStoredJSONBounded(s.store, canvasWorkspaceName(ownerID), workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

func (s *CanvasDocumentService) agentCompactionLeaseActive(ownerID, projectID string) (bool, error) {
	workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
	if err != nil {
		return false, err
	}
	lease, exists := workspace.AgentCompactionLeases[strings.TrimSpace(projectID)]
	return exists && lease.ExpiresAt > time.Now().UnixMilli(), nil
}

func (s *CanvasDocumentService) agentRunLeaseActive(ownerID, projectID string) (bool, error) {
	workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
	if err != nil {
		return false, err
	}
	lease, exists := workspace.AgentRunLeases[strings.TrimSpace(projectID)]
	return exists && lease.ExpiresAt > time.Now().UnixMilli(), nil
}

func (s *CanvasDocumentService) acquireAgentRunLease(ownerID, projectID, sessionID string) (string, error) {
	ownerID, projectID, sessionID = strings.TrimSpace(ownerID), strings.TrimSpace(projectID), strings.TrimSpace(sessionID)
	if ownerID == "" || projectID == "" || sessionID == "" {
		return "", invalidCanvasDocument("canvas agent lease requires an owner, project, and session")
	}
	token := uuid.NewString()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
		if err != nil {
			return "", err
		}
		if canvasProjectIndex(workspace, projectID) < 0 {
			return "", invalidCanvasDocument("canvas project does not exist")
		}
		if lease, exists := workspace.AgentRunLeases[projectID]; exists && lease.ExpiresAt > time.Now().UnixMilli() {
			return "", ErrCanvasAgentBusy
		}
		if lease, exists := workspace.AgentCompactionLeases[projectID]; exists && lease.ExpiresAt > time.Now().UnixMilli() {
			return "", ErrCanvasAgentBusy
		}
		if workspace.AgentRunLeases == nil {
			workspace.AgentRunLeases = make(map[string]canvasAgentWorkspaceLease)
		}
		workspace.AgentRunLeases[projectID] = canvasAgentWorkspaceLease{
			SessionID: sessionID,
			Token:     token,
			ExpiresAt: time.Now().Add(canvasAgentWorkspaceLeaseDuration).UnixMilli(),
		}
		if err := saveStoredJSONBounded(s.store, canvasWorkspaceName(ownerID), workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return "", err
		}
		return token, nil
	}
	return "", storage.ErrConcurrentRowUpdate
}

func (s *CanvasDocumentService) renewAgentRunLease(ownerID, projectID, token string) error {
	return s.updateAgentRunLease(ownerID, projectID, token, true)
}

func (s *CanvasDocumentService) releaseAgentRunLease(ownerID, projectID, token string) error {
	return s.updateAgentRunLease(ownerID, projectID, token, false)
}

func (s *CanvasDocumentService) updateAgentRunLease(ownerID, projectID, token string, renew bool) error {
	ownerID, projectID, token = strings.TrimSpace(ownerID), strings.TrimSpace(projectID), strings.TrimSpace(token)
	if ownerID == "" || projectID == "" || token == "" {
		return invalidCanvasDocument("canvas agent lease requires an owner, project, and token")
	}
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadCompactionLeaseWorkspace(ownerID)
		if err != nil {
			return err
		}
		lease, exists := workspace.AgentRunLeases[projectID]
		if !exists || lease.Token != token || lease.ExpiresAt <= time.Now().UnixMilli() {
			return errCanvasAgentLeaseLost
		}
		if renew {
			lease.ExpiresAt = time.Now().Add(canvasAgentWorkspaceLeaseDuration).UnixMilli()
			workspace.AgentRunLeases[projectID] = lease
		} else {
			delete(workspace.AgentRunLeases, projectID)
		}
		if err := saveStoredJSONBounded(s.store, canvasWorkspaceName(ownerID), workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

func (s *CanvasDocumentService) loadCompactionLeaseWorkspace(ownerID string) (canvasWorkspace, error) {
	if s.store == nil {
		return canvasWorkspace{}, fmt.Errorf("storage document backend is required")
	}
	raw, err := loadStoredJSONBounded(s.store, canvasWorkspaceName(ownerID))
	if err != nil {
		return canvasWorkspace{}, err
	}
	if raw == nil {
		return canvasWorkspace{}, invalidCanvasDocument("canvas workspace does not exist")
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return canvasWorkspace{}, err
	}
	var workspace canvasWorkspace
	if err := json.Unmarshal(data, &workspace); err != nil {
		return canvasWorkspace{}, err
	}
	return workspace, nil
}
