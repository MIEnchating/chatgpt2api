package service

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	canvasDocumentDir            = "canvas_documents"
	canvasWorkspaceDir           = "canvas_workspaces"
	canvasDocumentVersion        = 1
	canvasWorkspaceVersion       = 1
	canvasWorkspaceMaxProjects   = 24
	canvasWorkspaceMaxBytes      = 12 << 20
	canvasDocumentMaxNodes       = 500
	canvasDocumentMaxConnections = 2000
	canvasDocumentMaxBytes       = 2 << 20
	canvasDocumentMaxPrompt      = 12000
	canvasDocumentMaxURL         = 4096
	canvasDocumentMaxTitle       = 200
	canvasDocumentMaxNodeDim     = 20000
)

var ErrInvalidCanvasDocument = errors.New("invalid canvas document")

type CanvasViewport struct {
	Zoom float64 `json:"zoom"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type CanvasNode struct {
	ID                          string   `json:"id"`
	Type                        string   `json:"type"`
	X                           float64  `json:"x"`
	Y                           float64  `json:"y"`
	Width                       float64  `json:"width"`
	Height                      float64  `json:"height"`
	FontSize                    int      `json:"font_size,omitempty"`
	NaturalWidth                int      `json:"natural_width,omitempty"`
	NaturalHeight               int      `json:"natural_height,omitempty"`
	FreeResize                  bool     `json:"free_resize,omitempty"`
	ScaleX                      float64  `json:"scale_x"`
	ScaleY                      float64  `json:"scale_y"`
	Angle                       float64  `json:"angle,omitempty"`
	URL                         string   `json:"url,omitempty"`
	ThumbnailURL                string   `json:"thumbnail_url,omitempty"`
	Title                       string   `json:"title,omitempty"`
	Prompt                      string   `json:"prompt,omitempty"`
	ComposerContent             *string  `json:"composer_content,omitempty"`
	ParentID                    string   `json:"parent_id,omitempty"`
	TaskID                      string   `json:"task_id,omitempty"`
	GenerationSize              string   `json:"generation_size,omitempty"`
	GenerationResolution        string   `json:"generation_resolution,omitempty"`
	GenerationQuality           string   `json:"generation_quality,omitempty"`
	GenerationCount             int      `json:"generation_count,omitempty"`
	GenerationOutputFormat      string   `json:"generation_output_format,omitempty"`
	GenerationOutputCompression *int     `json:"generation_output_compression,omitempty"`
	GenerationStream            *bool    `json:"generation_stream,omitempty"`
	GenerationPartialImages     int      `json:"generation_partial_images,omitempty"`
	GenerationStatus            string   `json:"generation_status,omitempty"`
	GenerationError             string   `json:"generation_error,omitempty"`
	GenerationType              string   `json:"generation_type,omitempty"`
	GenerationReferenceURLs     []string `json:"generation_reference_urls,omitempty"`
	BatchChildIDs               []string `json:"batch_child_ids,omitempty"`
	BatchRootID                 string   `json:"batch_root_id,omitempty"`
	BatchPrimaryID              string   `json:"batch_primary_id,omitempty"`
	BatchExpanded               *bool    `json:"batch_expanded,omitempty"`
	CreatedAt                   string   `json:"created_at,omitempty"`
}

type CanvasConnection struct {
	ID         string `json:"id"`
	FromNodeID string `json:"from_node_id"`
	ToNodeID   string `json:"to_node_id"`
}

type CanvasDocument struct {
	Version     int                `json:"version"`
	ID          string             `json:"id"`
	Revision    int64              `json:"revision"`
	Title       string             `json:"title"`
	Background  string             `json:"background"`
	Nodes       []CanvasNode       `json:"nodes"`
	Connections []CanvasConnection `json:"connections"`
	Viewport    CanvasViewport     `json:"viewport"`
	CreatedAt   string             `json:"created_at,omitempty"`
	UpdatedAt   string             `json:"updated_at,omitempty"`
}

type CanvasProjectSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	NodeCount int    `json:"node_count"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type CanvasWorkspaceResult struct {
	Document        CanvasDocument         `json:"document"`
	Projects        []CanvasProjectSummary `json:"projects"`
	ActiveProjectID string                 `json:"active_project_id"`
}

type canvasWorkspace struct {
	Version         int              `json:"version"`
	ActiveProjectID string           `json:"active_project_id"`
	Projects        []CanvasDocument `json:"projects"`
}

type CanvasDocumentService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewCanvasDocumentService(backend storage.Backend) *CanvasDocumentService {
	return &CanvasDocumentService{store: jsonDocumentStoreFromBackend(backend)}
}

func DefaultCanvasDocument() CanvasDocument {
	now := util.NowISO()
	return CanvasDocument{
		Version:     canvasDocumentVersion,
		ID:          newCanvasProjectID(),
		Title:       "我的画布",
		Background:  "dots",
		Nodes:       []CanvasNode{},
		Connections: []CanvasConnection{},
		Viewport:    CanvasViewport{Zoom: 1},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func (s *CanvasDocumentService) Workspace(ownerID string) (CanvasWorkspaceResult, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasWorkspaceResult{}, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.loadWorkspaceLocked(ownerID)
	if err != nil {
		return CanvasWorkspaceResult{}, err
	}
	return canvasWorkspaceResult(workspace), nil
}

func (s *CanvasDocumentService) Load(ownerID string) (CanvasDocument, error) {
	workspace, err := s.Workspace(ownerID)
	return workspace.Document, err
}

func (s *CanvasDocumentService) Save(ownerID string, input CanvasDocument) (CanvasDocument, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasDocument{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasDocument{}, fmt.Errorf("storage document backend is required")
	}
	normalized, err := normalizeCanvasDocument(input)
	if err != nil {
		return CanvasDocument{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.loadWorkspaceLocked(ownerID)
	if err != nil {
		return CanvasDocument{}, err
	}
	projectIndex := activeCanvasProjectIndex(workspace)
	if input.ID != "" {
		projectIndex = canvasProjectIndex(workspace, input.ID)
	}
	if projectIndex < 0 {
		return CanvasDocument{}, invalidCanvasDocument("canvas project does not exist")
	}
	current := workspace.Projects[projectIndex]
	normalized.ID = current.ID
	normalized.CreatedAt = current.CreatedAt
	normalized.Revision = current.Revision + 1
	normalized.UpdatedAt = util.NowISO()
	workspace.Projects[projectIndex] = normalized
	workspace.ActiveProjectID = normalized.ID
	if err := s.saveWorkspaceLocked(ownerID, workspace); err != nil {
		return CanvasDocument{}, err
	}
	return normalized, nil
}

func (s *CanvasDocumentService) Import(ownerID string, input CanvasDocument) (CanvasWorkspaceResult, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasWorkspaceResult{}, fmt.Errorf("storage document backend is required")
	}
	normalized, err := normalizeCanvasDocument(input)
	if err != nil {
		return CanvasWorkspaceResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.loadWorkspaceLocked(ownerID)
	if err != nil {
		return CanvasWorkspaceResult{}, err
	}
	if len(workspace.Projects) >= canvasWorkspaceMaxProjects {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project limit reached")
	}
	now := util.NowISO()
	normalized.ID = newCanvasProjectID()
	normalized.Revision = 0
	normalized.CreatedAt = now
	normalized.UpdatedAt = now
	workspace.Projects = append([]CanvasDocument{normalized}, workspace.Projects...)
	workspace.ActiveProjectID = normalized.ID
	if err := s.saveWorkspaceLocked(ownerID, workspace); err != nil {
		return CanvasWorkspaceResult{}, err
	}
	return canvasWorkspaceResult(workspace), nil
}

func (s *CanvasDocumentService) Clear(ownerID, projectID string) (CanvasDocument, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasDocument{}, invalidCanvasDocument("owner_id is required")
	}
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return CanvasDocument{}, invalidCanvasDocument("canvas project id is required")
	}
	if s.store == nil {
		return CanvasDocument{}, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.loadWorkspaceLocked(ownerID)
	if err != nil {
		return CanvasDocument{}, err
	}
	projectIndex := canvasProjectIndex(workspace, projectID)
	if projectIndex < 0 {
		return CanvasDocument{}, invalidCanvasDocument("canvas project does not exist")
	}
	current := workspace.Projects[projectIndex]
	cleared := DefaultCanvasDocument()
	cleared.ID = current.ID
	cleared.Title = current.Title
	cleared.Background = current.Background
	cleared.Viewport = current.Viewport
	cleared.CreatedAt = current.CreatedAt
	cleared.Revision = current.Revision + 1
	workspace.Projects[projectIndex] = cleared
	workspace.ActiveProjectID = cleared.ID
	if err := s.saveWorkspaceLocked(ownerID, workspace); err != nil {
		return CanvasDocument{}, err
	}
	return cleared, nil
}

func (s *CanvasDocumentService) UpdateProject(ownerID, action, projectID, title string) (CanvasWorkspaceResult, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasWorkspaceResult{}, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.loadWorkspaceLocked(ownerID)
	if err != nil {
		return CanvasWorkspaceResult{}, err
	}
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "create":
		if len(workspace.Projects) >= canvasWorkspaceMaxProjects {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project limit reached")
		}
		project := DefaultCanvasDocument()
		project.Title = strings.TrimSpace(title)
		if project.Title == "" {
			project.Title = fmt.Sprintf("无限画布 %d", len(workspace.Projects)+1)
		}
		workspace.Projects = append([]CanvasDocument{project}, workspace.Projects...)
		workspace.ActiveProjectID = project.ID
	case "activate":
		if canvasProjectIndex(workspace, projectID) < 0 {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
		}
		workspace.ActiveProjectID = strings.TrimSpace(projectID)
	case "rename":
		index := canvasProjectIndex(workspace, projectID)
		title = strings.TrimSpace(title)
		if index < 0 {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
		}
		if title == "" || len(title) > canvasDocumentMaxTitle {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas title is invalid")
		}
		workspace.Projects[index].Title = title
		workspace.Projects[index].UpdatedAt = util.NowISO()
	case "delete":
		index := canvasProjectIndex(workspace, projectID)
		if index < 0 {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
		}
		workspace.Projects = append(workspace.Projects[:index], workspace.Projects[index+1:]...)
		if len(workspace.Projects) == 0 {
			workspace.Projects = []CanvasDocument{DefaultCanvasDocument()}
		}
		if workspace.ActiveProjectID == projectID {
			workspace.ActiveProjectID = workspace.Projects[0].ID
		}
	default:
		return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project action is invalid")
	}
	if err := s.saveWorkspaceLocked(ownerID, workspace); err != nil {
		return CanvasWorkspaceResult{}, err
	}
	return canvasWorkspaceResult(workspace), nil
}

func (s *CanvasDocumentService) loadWorkspaceLocked(ownerID string) (canvasWorkspace, error) {
	raw, err := s.store.LoadJSONDocument(canvasWorkspaceName(ownerID))
	if err != nil {
		return canvasWorkspace{}, err
	}
	if raw != nil {
		data, err := json.Marshal(raw)
		if err != nil {
			return canvasWorkspace{}, err
		}
		var workspace canvasWorkspace
		if err := json.Unmarshal(data, &workspace); err != nil {
			return canvasWorkspace{}, err
		}
		return normalizeCanvasWorkspace(workspace)
	}

	legacyRaw, err := s.store.LoadJSONDocument(canvasDocumentName(ownerID))
	if err != nil {
		return canvasWorkspace{}, err
	}
	document := DefaultCanvasDocument()
	if legacyRaw != nil {
		data, err := json.Marshal(legacyRaw)
		if err != nil {
			return canvasWorkspace{}, err
		}
		if err := json.Unmarshal(data, &document); err != nil {
			return canvasWorkspace{}, err
		}
		document, err = normalizeCanvasDocument(document)
		if err != nil {
			return canvasWorkspace{}, err
		}
	}
	workspace := canvasWorkspace{
		Version:         canvasWorkspaceVersion,
		ActiveProjectID: document.ID,
		Projects:        []CanvasDocument{document},
	}
	if err := s.saveWorkspaceLocked(ownerID, workspace); err != nil {
		return canvasWorkspace{}, err
	}
	return workspace, nil
}

func (s *CanvasDocumentService) saveWorkspaceLocked(ownerID string, workspace canvasWorkspace) error {
	normalized, err := normalizeCanvasWorkspace(workspace)
	if err != nil {
		return err
	}
	return s.store.SaveJSONDocument(canvasWorkspaceName(ownerID), normalized)
}

func normalizeCanvasWorkspace(workspace canvasWorkspace) (canvasWorkspace, error) {
	workspace.Version = canvasWorkspaceVersion
	if len(workspace.Projects) == 0 {
		workspace.Projects = []CanvasDocument{DefaultCanvasDocument()}
	}
	if len(workspace.Projects) > canvasWorkspaceMaxProjects {
		return canvasWorkspace{}, invalidCanvasDocument("canvas contains too many projects")
	}
	seen := make(map[string]struct{}, len(workspace.Projects))
	for index := range workspace.Projects {
		document, err := normalizeCanvasDocument(workspace.Projects[index])
		if err != nil {
			return canvasWorkspace{}, err
		}
		if _, exists := seen[document.ID]; exists {
			return canvasWorkspace{}, invalidCanvasDocument("canvas contains duplicate project ids")
		}
		seen[document.ID] = struct{}{}
		workspace.Projects[index] = document
	}
	if _, exists := seen[workspace.ActiveProjectID]; !exists {
		workspace.ActiveProjectID = workspace.Projects[0].ID
	}
	data, err := json.Marshal(workspace)
	if err != nil {
		return canvasWorkspace{}, err
	}
	if len(data) > canvasWorkspaceMaxBytes {
		return canvasWorkspace{}, invalidCanvasDocument("canvas workspace is too large")
	}
	return workspace, nil
}

func canvasWorkspaceResult(workspace canvasWorkspace) CanvasWorkspaceResult {
	index := activeCanvasProjectIndex(workspace)
	if index < 0 {
		index = 0
	}
	projects := make([]CanvasProjectSummary, 0, len(workspace.Projects))
	for _, project := range workspace.Projects {
		projects = append(projects, CanvasProjectSummary{
			ID:        project.ID,
			Title:     project.Title,
			NodeCount: len(project.Nodes),
			CreatedAt: project.CreatedAt,
			UpdatedAt: project.UpdatedAt,
		})
	}
	return CanvasWorkspaceResult{
		Document:        workspace.Projects[index],
		Projects:        projects,
		ActiveProjectID: workspace.Projects[index].ID,
	}
}

func activeCanvasProjectIndex(workspace canvasWorkspace) int {
	return canvasProjectIndex(workspace, workspace.ActiveProjectID)
}

func canvasProjectIndex(workspace canvasWorkspace, projectID string) int {
	projectID = strings.TrimSpace(projectID)
	for index := range workspace.Projects {
		if workspace.Projects[index].ID == projectID {
			return index
		}
	}
	return -1
}

func normalizeCanvasDocument(input CanvasDocument) (CanvasDocument, error) {
	input.Version = canvasDocumentVersion
	input.ID = strings.TrimSpace(input.ID)
	if input.ID == "" {
		input.ID = newCanvasProjectID()
	}
	if len(input.ID) > 128 {
		return CanvasDocument{}, invalidCanvasDocument("canvas project id is too long")
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" {
		input.Title = "我的画布"
	}
	if len(input.Title) > canvasDocumentMaxTitle {
		return CanvasDocument{}, invalidCanvasDocument("title is too long")
	}
	input.Background = strings.ToLower(strings.TrimSpace(input.Background))
	switch input.Background {
	case "dots", "grid", "plain":
	default:
		input.Background = "dots"
	}
	input.CreatedAt = strings.TrimSpace(input.CreatedAt)
	if input.CreatedAt == "" {
		input.CreatedAt = util.NowISO()
	}
	input.UpdatedAt = strings.TrimSpace(input.UpdatedAt)
	if input.UpdatedAt == "" {
		input.UpdatedAt = input.CreatedAt
	}
	if len(input.Nodes) > canvasDocumentMaxNodes {
		return CanvasDocument{}, invalidCanvasDocument("canvas contains too many nodes")
	}
	if len(input.Connections) > canvasDocumentMaxConnections {
		return CanvasDocument{}, invalidCanvasDocument("canvas contains too many connections")
	}
	input.Viewport = normalizeCanvasViewport(input.Viewport)
	seen := make(map[string]struct{}, len(input.Nodes))
	for index := range input.Nodes {
		node, err := normalizeCanvasNode(input.Nodes[index])
		if err != nil {
			return CanvasDocument{}, err
		}
		if _, exists := seen[node.ID]; exists {
			return CanvasDocument{}, invalidCanvasDocument("canvas contains duplicate node ids")
		}
		seen[node.ID] = struct{}{}
		input.Nodes[index] = node
	}
	nodeByID := make(map[string]CanvasNode, len(input.Nodes))
	for _, node := range input.Nodes {
		nodeByID[node.ID] = node
	}
	for _, node := range input.Nodes {
		if node.BatchRootID != "" {
			root, exists := nodeByID[node.BatchRootID]
			if !exists || !canvasNodeIDListContains(root.BatchChildIDs, node.ID) {
				return CanvasDocument{}, invalidCanvasDocument("batch child root does not exist")
			}
		}
		for _, childID := range node.BatchChildIDs {
			child, exists := nodeByID[childID]
			if !exists || child.BatchRootID != node.ID {
				return CanvasDocument{}, invalidCanvasDocument("batch root child does not exist")
			}
		}
		if node.BatchPrimaryID != "" && !canvasNodeIDListContains(node.BatchChildIDs, node.BatchPrimaryID) {
			return CanvasDocument{}, invalidCanvasDocument("batch primary image is invalid")
		}
	}
	if len(input.Connections) == 0 {
		for _, node := range input.Nodes {
			if node.ParentID != "" {
				input.Connections = append(input.Connections, CanvasConnection{ID: "connection-" + node.ID, FromNodeID: node.ParentID, ToNodeID: node.ID})
			}
		}
	}
	connectionIDs := make(map[string]struct{}, len(input.Connections))
	connectionPairs := make(map[string]struct{}, len(input.Connections))
	for index := range input.Connections {
		connection := input.Connections[index]
		connection.ID = strings.TrimSpace(connection.ID)
		connection.FromNodeID = strings.TrimSpace(connection.FromNodeID)
		connection.ToNodeID = strings.TrimSpace(connection.ToNodeID)
		if connection.ID == "" || len(connection.ID) > 128 {
			return CanvasDocument{}, invalidCanvasDocument("connection id is required")
		}
		if connection.FromNodeID == "" || connection.ToNodeID == "" || connection.FromNodeID == connection.ToNodeID {
			return CanvasDocument{}, invalidCanvasDocument("connection endpoints are invalid")
		}
		if _, exists := seen[connection.FromNodeID]; !exists {
			return CanvasDocument{}, invalidCanvasDocument("connection source does not exist")
		}
		if _, exists := seen[connection.ToNodeID]; !exists {
			return CanvasDocument{}, invalidCanvasDocument("connection target does not exist")
		}
		if nodeByID[connection.FromNodeID].Type == "config" && nodeByID[connection.ToNodeID].Type == "config" {
			return CanvasDocument{}, invalidCanvasDocument("configuration nodes cannot be connected")
		}
		if _, exists := connectionIDs[connection.ID]; exists {
			return CanvasDocument{}, invalidCanvasDocument("canvas contains duplicate connection ids")
		}
		pair := connection.FromNodeID + "\x00" + connection.ToNodeID
		if _, exists := connectionPairs[pair]; exists {
			return CanvasDocument{}, invalidCanvasDocument("canvas contains duplicate connections")
		}
		connectionIDs[connection.ID] = struct{}{}
		connectionPairs[pair] = struct{}{}
		input.Connections[index] = connection
	}
	for index := range input.Nodes {
		input.Nodes[index].ParentID = ""
	}
	if input.Nodes == nil {
		input.Nodes = []CanvasNode{}
	}
	if input.Connections == nil {
		input.Connections = []CanvasConnection{}
	}
	data, err := json.Marshal(input)
	if err != nil {
		return CanvasDocument{}, err
	}
	if len(data) > canvasDocumentMaxBytes {
		return CanvasDocument{}, invalidCanvasDocument("canvas document is too large")
	}
	return input, nil
}

func normalizeCanvasViewport(viewport CanvasViewport) CanvasViewport {
	if !finiteCanvasNumber(viewport.Zoom) || viewport.Zoom < 0.05 || viewport.Zoom > 10 {
		viewport.Zoom = 1
	}
	if !finiteCanvasNumber(viewport.X) {
		viewport.X = 0
	}
	if !finiteCanvasNumber(viewport.Y) {
		viewport.Y = 0
	}
	return viewport
}

func normalizeCanvasNode(node CanvasNode) (CanvasNode, error) {
	node.ID = strings.TrimSpace(node.ID)
	if node.ID == "" || len(node.ID) > 128 {
		return CanvasNode{}, invalidCanvasDocument("node id is required")
	}
	node.Type = strings.ToLower(strings.TrimSpace(node.Type))
	if node.Type != "image" && node.Type != "text" && node.Type != "config" {
		return CanvasNode{}, invalidCanvasDocument("node type must be image, text, or config")
	}
	if !finiteCanvasNumber(node.X) || !finiteCanvasNumber(node.Y) || math.Abs(node.X) > 1e7 || math.Abs(node.Y) > 1e7 {
		return CanvasNode{}, invalidCanvasDocument("node position is invalid")
	}
	if !finiteCanvasNumber(node.Width) || !finiteCanvasNumber(node.Height) || node.Width <= 0 || node.Height <= 0 || node.Width > canvasDocumentMaxNodeDim || node.Height > canvasDocumentMaxNodeDim {
		return CanvasNode{}, invalidCanvasDocument("node size is invalid")
	}
	if node.NaturalWidth < 0 || node.NaturalHeight < 0 || node.NaturalWidth > 65535 || node.NaturalHeight > 65535 {
		return CanvasNode{}, invalidCanvasDocument("node natural size is invalid")
	}
	if node.FontSize != 0 && (node.FontSize < 10 || node.FontSize > 32) {
		return CanvasNode{}, invalidCanvasDocument("node font size is invalid")
	}
	if !finiteCanvasNumber(node.ScaleX) || node.ScaleX <= 0 || node.ScaleX > 20 {
		node.ScaleX = 1
	}
	if !finiteCanvasNumber(node.ScaleY) || node.ScaleY <= 0 || node.ScaleY > 20 {
		node.ScaleY = 1
	}
	if !finiteCanvasNumber(node.Angle) {
		node.Angle = 0
	}
	node.URL = strings.TrimSpace(node.URL)
	node.ThumbnailURL = strings.TrimSpace(node.ThumbnailURL)
	node.Title = strings.TrimSpace(node.Title)
	node.Prompt = strings.TrimSpace(node.Prompt)
	if node.ComposerContent != nil {
		composerContent := strings.TrimSpace(*node.ComposerContent)
		node.ComposerContent = &composerContent
	}
	node.ParentID = strings.TrimSpace(node.ParentID)
	node.TaskID = strings.TrimSpace(node.TaskID)
	node.GenerationSize = strings.ToLower(strings.TrimSpace(node.GenerationSize))
	node.GenerationResolution = strings.ToLower(strings.TrimSpace(node.GenerationResolution))
	node.GenerationQuality = strings.ToLower(strings.TrimSpace(node.GenerationQuality))
	node.GenerationOutputFormat = strings.ToLower(strings.TrimSpace(node.GenerationOutputFormat))
	node.GenerationStatus = strings.ToLower(strings.TrimSpace(node.GenerationStatus))
	node.GenerationError = strings.TrimSpace(node.GenerationError)
	node.GenerationType = strings.ToLower(strings.TrimSpace(node.GenerationType))
	node.BatchRootID = strings.TrimSpace(node.BatchRootID)
	node.BatchPrimaryID = strings.TrimSpace(node.BatchPrimaryID)
	node.CreatedAt = strings.TrimSpace(node.CreatedAt)
	for index := range node.GenerationReferenceURLs {
		node.GenerationReferenceURLs[index] = strings.TrimSpace(node.GenerationReferenceURLs[index])
	}
	for index := range node.BatchChildIDs {
		node.BatchChildIDs[index] = strings.TrimSpace(node.BatchChildIDs[index])
	}
	if len(node.URL) > canvasDocumentMaxURL || len(node.ThumbnailURL) > canvasDocumentMaxURL {
		return CanvasNode{}, invalidCanvasDocument("node image url is too long")
	}
	if len(node.Title) > canvasDocumentMaxTitle || len(node.Prompt) > canvasDocumentMaxPrompt || node.ComposerContent != nil && len(*node.ComposerContent) > canvasDocumentMaxPrompt {
		return CanvasNode{}, invalidCanvasDocument("node text is too long")
	}
	if len(node.GenerationSize) > 64 || len(node.GenerationResolution) > 16 {
		return CanvasNode{}, invalidCanvasDocument("node generation size is invalid")
	}
	if node.GenerationQuality != "" && node.GenerationQuality != "low" && node.GenerationQuality != "medium" && node.GenerationQuality != "high" {
		return CanvasNode{}, invalidCanvasDocument("node generation quality is invalid")
	}
	if node.GenerationCount < 0 || node.GenerationCount > 10 {
		return CanvasNode{}, invalidCanvasDocument("node generation count is invalid")
	}
	if node.GenerationOutputFormat != "" && node.GenerationOutputFormat != "png" && node.GenerationOutputFormat != "jpeg" && node.GenerationOutputFormat != "webp" {
		return CanvasNode{}, invalidCanvasDocument("node generation output format is invalid")
	}
	if (node.GenerationOutputCompression != nil && (*node.GenerationOutputCompression < 0 || *node.GenerationOutputCompression > 100)) || node.GenerationPartialImages < 0 || node.GenerationPartialImages > 3 {
		return CanvasNode{}, invalidCanvasDocument("node generation output settings are invalid")
	}
	if node.GenerationStatus != "" && node.GenerationStatus != "idle" && node.GenerationStatus != "loading" && node.GenerationStatus != "success" && node.GenerationStatus != "error" {
		return CanvasNode{}, invalidCanvasDocument("node generation status is invalid")
	}
	if len(node.GenerationError) > 4096 {
		return CanvasNode{}, invalidCanvasDocument("node generation error is too long")
	}
	if node.GenerationType != "" && node.GenerationType != "generate" && node.GenerationType != "edit" {
		return CanvasNode{}, invalidCanvasDocument("node generation type is invalid")
	}
	if len(node.GenerationReferenceURLs) > 4 {
		return CanvasNode{}, invalidCanvasDocument("node has too many generation reference images")
	}
	for _, referenceURL := range node.GenerationReferenceURLs {
		if referenceURL == "" || len(referenceURL) > canvasDocumentMaxURL {
			return CanvasNode{}, invalidCanvasDocument("node generation reference image is invalid")
		}
	}
	if len(node.BatchChildIDs) > 10 || len(node.BatchRootID) > 128 || len(node.BatchPrimaryID) > 128 {
		return CanvasNode{}, invalidCanvasDocument("node batch relationship is invalid")
	}
	batchChildIDs := make(map[string]struct{}, len(node.BatchChildIDs))
	for _, childID := range node.BatchChildIDs {
		if childID == "" || len(childID) > 128 || childID == node.ID {
			return CanvasNode{}, invalidCanvasDocument("node batch child is invalid")
		}
		if _, exists := batchChildIDs[childID]; exists {
			return CanvasNode{}, invalidCanvasDocument("node batch contains duplicate children")
		}
		batchChildIDs[childID] = struct{}{}
	}
	if node.BatchRootID == node.ID || node.BatchPrimaryID == node.ID {
		return CanvasNode{}, invalidCanvasDocument("node batch relationship is invalid")
	}
	return node, nil
}

func canvasNodeIDListContains(ids []string, target string) bool {
	for _, id := range ids {
		if id == target {
			return true
		}
	}
	return false
}

func canvasDocumentName(ownerID string) string {
	return canvasDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func canvasWorkspaceName(ownerID string) string {
	return canvasWorkspaceDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func newCanvasProjectID() string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return "canvas-" + hex.EncodeToString(bytes[:])
	}
	return "canvas-" + util.SHA256Hex(util.NowISO())[:24]
}

func finiteCanvasNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func invalidCanvasDocument(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidCanvasDocument, message)
}
