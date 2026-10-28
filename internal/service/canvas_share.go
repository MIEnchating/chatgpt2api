package service

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

var ErrCanvasShareNotFound = errors.New("分享不存在或已取消")

type CanvasShare struct {
	Token string `json:"token"`
}

type canvasShareIndex struct {
	OwnerID   string `json:"owner_id"`
	ProjectID string `json:"project_id"`
}

// CanvasShare reads or changes the owner's share. The workspace is authoritative;
// an index entry alone never grants access, including after a failed write.
func (s *CanvasDocumentService) CanvasShare(ownerID, projectID, action string) (CanvasShare, error) {
	ownerID, projectID = util.Clean(ownerID), util.Clean(projectID)
	if ownerID == "" || projectID == "" {
		return CanvasShare{}, invalidCanvasDocument("owner and project are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return CanvasShare{}, err
		}
		if canvasProjectIndex(workspace, projectID) < 0 {
			return CanvasShare{}, ErrCanvasShareNotFound
		}
		token := workspace.Shares[projectID]
		switch action {
		case "get":
			return CanvasShare{Token: token}, nil
		case "create":
			if token != "" {
				return CanvasShare{Token: token}, nil
			}
			var entropy [32]byte
			if _, err := rand.Read(entropy[:]); err != nil {
				return CanvasShare{}, err
			}
			token = hex.EncodeToString(entropy[:])
			if err := s.store.SaveJSONDocument(canvasShareIndexName(token), canvasShareIndex{OwnerID: ownerID, ProjectID: projectID}); err != nil {
				return CanvasShare{}, err
			}
			if workspace.Shares == nil {
				workspace.Shares = make(map[string]string)
			}
			workspace.Shares[projectID] = token
		case "revoke":
			if token == "" {
				return CanvasShare{}, nil
			}
			delete(workspace.Shares, projectID)
		default:
			return CanvasShare{}, invalidCanvasDocument("invalid share action")
		}
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if action == "create" {
				_ = s.store.DeleteJSONDocument(canvasShareIndexName(token))
			}
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				continue
			}
			return CanvasShare{}, err
		}
		if action == "revoke" {
			_ = s.store.DeleteJSONDocument(canvasShareIndexName(token))
			return CanvasShare{}, nil
		}
		return CanvasShare{Token: token}, nil
	}
	return CanvasShare{}, storage.ErrConcurrentRowUpdate
}

func canvasShareIndexName(token string) string {
	return "canvas_shares/" + util.SHA256Hex(token) + ".json"
}

// SharedCanvas resolves a capability without exposing workspace or owner metadata.
// Callers must project the document before returning it to an unauthenticated user.
func (s *CanvasDocumentService) SharedCanvas(token string) (CanvasDocument, string, error) {
	if len(token) != 64 {
		return CanvasDocument{}, "", ErrCanvasShareNotFound
	}
	if _, err := hex.DecodeString(token); err != nil {
		return CanvasDocument{}, "", ErrCanvasShareNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.store.LoadJSONDocument(canvasShareIndexName(token))
	if err != nil {
		return CanvasDocument{}, "", err
	}
	if raw == nil {
		return CanvasDocument{}, "", ErrCanvasShareNotFound
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return CanvasDocument{}, "", err
	}
	var index canvasShareIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return CanvasDocument{}, "", err
	}
	workspace, err := s.loadWorkspaceLocked(index.OwnerID)
	if err != nil {
		return CanvasDocument{}, "", err
	}
	i := canvasProjectIndex(workspace, index.ProjectID)
	if i < 0 || workspace.Shares[index.ProjectID] != token {
		return CanvasDocument{}, "", ErrCanvasShareNotFound
	}
	return workspace.Projects[i], index.OwnerID, nil
}

// PublicCanvasDocument uses an allowlist so future private fields stay private.
func PublicCanvasDocument(document CanvasDocument, token string) CanvasDocument {
	nodes := make([]CanvasNode, 0, len(document.Nodes))
	for _, node := range document.Nodes {
		public := CanvasNode{
			ID: node.ID, Type: node.Type, X: node.X, Y: node.Y, Width: node.Width, Height: node.Height,
			ScaleX: node.ScaleX, ScaleY: node.ScaleY, Angle: node.Angle, FontSize: node.FontSize,
			Title: node.Title, Prompt: node.Prompt, GroupID: node.GroupID,
			BatchRootID: node.BatchRootID, BatchChildIDs: node.BatchChildIDs, BatchPrimaryID: node.BatchPrimaryID, BatchExpanded: node.BatchExpanded,
		}
		if node.URL != "" || node.StorageKey != "" {
			public.URL = "/api/canvas-shares/" + token + "/media?node_id=" + url.QueryEscape(node.ID)
		}
		nodes = append(nodes, public)
	}
	return CanvasDocument{Version: document.Version, ID: document.ID, Revision: document.Revision, Title: document.Title,
		Background: document.Background, Nodes: nodes, Connections: document.Connections, Viewport: document.Viewport}
}

func CanvasShareStorageObjectID(node CanvasNode) string {
	if id := canvasStorageObjectIDFromReference(node.StorageKey); id != "" {
		return id
	}
	return canvasStorageObjectIDFromReference(node.URL)
}

func CanvasShareRemoteURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != "" && parsed.User == nil && !strings.ContainsAny(value, "\r\n")
}
