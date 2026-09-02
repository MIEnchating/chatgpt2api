package service

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	canvasWorkspaceDir                         = "canvas_workspaces"
	canvasActiveProjectDir                     = "canvas_active_projects"
	canvasDocumentVersion                      = 1
	canvasWorkspaceVersion                     = 1
	canvasWorkspaceMaxProjects                 = 24
	canvasWorkspaceMaxBytes                    = 12 << 20
	canvasDocumentMaxNodes                     = 500
	canvasDocumentMaxConnections               = 2000
	canvasDocumentMaxBytes                     = 2 << 20
	canvasDocumentMaxPrompt                    = 12000
	canvasDocumentMaxURL                       = 4096
	canvasDocumentMaxTitle                     = 200
	canvasDocumentMaxNodeDim                   = 20000
	canvasDocumentMaxGenerationReferenceImages = 14
	canvasDocumentMaxAgentMessages             = 100
	canvasDocumentMaxAgentSessions             = 24
	canvasDocumentMaxAgentDataBytes            = 512 << 10
	canvasWorkspaceSaveAttempts                = 3
)

var (
	ErrInvalidCanvasDocument  = errors.New("invalid canvas document")
	ErrCanvasRevisionConflict = errors.New("canvas revision conflict")
)

type CanvasRevisionConflictError struct {
	Expected int64
	Actual   int64
}

func (e CanvasRevisionConflictError) Error() string {
	return "画布已在其他设备更新，请刷新页面后再保存"
}

func (e CanvasRevisionConflictError) Unwrap() error {
	return ErrCanvasRevisionConflict
}

type CanvasViewport struct {
	Zoom float64 `json:"zoom"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type CanvasCameraControl struct {
	Enabled     bool    `json:"enabled"`
	Camera      string  `json:"camera,omitempty"`
	Lens        string  `json:"lens,omitempty"`
	FocalLength float64 `json:"focal_length,omitempty"`
	Aperture    float64 `json:"aperture,omitempty"`
}

type CanvasNode struct {
	ID                                   string               `json:"id"`
	Type                                 string               `json:"type"`
	X                                    float64              `json:"x"`
	Y                                    float64              `json:"y"`
	Width                                float64              `json:"width"`
	Height                               float64              `json:"height"`
	FontSize                             int                  `json:"font_size,omitempty"`
	NaturalWidth                         int                  `json:"natural_width,omitempty"`
	NaturalHeight                        int                  `json:"natural_height,omitempty"`
	Bytes                                int64                `json:"bytes,omitempty"`
	FreeResize                           bool                 `json:"free_resize,omitempty"`
	ScaleX                               float64              `json:"scale_x"`
	ScaleY                               float64              `json:"scale_y"`
	Angle                                float64              `json:"angle,omitempty"`
	URL                                  string               `json:"url,omitempty"`
	StorageKey                           string               `json:"storage_key,omitempty"`
	ThumbnailURL                         string               `json:"thumbnail_url,omitempty"`
	Title                                string               `json:"title,omitempty"`
	Prompt                               string               `json:"prompt,omitempty"`
	ComposerContent                      *string              `json:"composer_content,omitempty"`
	ExcludeUpstreamText                  bool                 `json:"exclude_upstream_text,omitempty"`
	GroupID                              string               `json:"group_id,omitempty"`
	TaskID                               string               `json:"task_id,omitempty"`
	GenerationModel                      string               `json:"generation_model,omitempty"`
	GenerationSize                       string               `json:"generation_size,omitempty"`
	GenerationResolution                 string               `json:"generation_resolution,omitempty"`
	GenerationQuality                    string               `json:"generation_quality,omitempty"`
	GenerationCount                      int                  `json:"generation_count,omitempty"`
	GenerationOutputFormat               string               `json:"generation_output_format,omitempty"`
	GenerationOutputCompression          *int                 `json:"generation_output_compression,omitempty"`
	GenerationStream                     *bool                `json:"generation_stream,omitempty"`
	GenerationPartialImages              int                  `json:"generation_partial_images,omitempty"`
	GenerationSnapToMultiple16           *bool                `json:"generation_snap_to_multiple_16,omitempty"`
	GenerationResponseFormatB64JSON      bool                 `json:"generation_response_format_b64_json,omitempty"`
	GenerationCodexCLICompatibility      bool                 `json:"generation_codex_cli_compatibility,omitempty"`
	GenerationStatus                     string               `json:"generation_status,omitempty"`
	GenerationStartedAt                  int64                `json:"generation_started_at,omitempty"`
	GenerationProgress                   float64              `json:"generation_progress,omitempty"`
	GenerationError                      string               `json:"generation_error,omitempty"`
	GenerationType                       string               `json:"generation_type,omitempty"`
	GenerationReferenceURLs              []string             `json:"generation_reference_urls,omitempty"`
	GenerationVideoModel                 string               `json:"generation_video_model,omitempty"`
	GenerationVideoSize                  string               `json:"generation_video_size,omitempty"`
	GenerationVideoSeconds               int                  `json:"generation_video_seconds,omitempty"`
	GenerationVideoResolution            string               `json:"generation_video_resolution,omitempty"`
	GenerationVideoAudio                 *bool                `json:"generation_video_audio,omitempty"`
	GenerationVideoWatermark             *bool                `json:"generation_video_watermark,omitempty"`
	GenerationVideoReferenceMode         string               `json:"generation_video_reference_mode,omitempty"`
	GenerationVideoReferenceImages       []string             `json:"generation_video_reference_image_urls,omitempty"`
	GenerationVideoReferenceURLs         []string             `json:"generation_video_reference_urls,omitempty"`
	GenerationVideoReferenceAudio        []string             `json:"generation_video_reference_audio_urls,omitempty"`
	GenerationVideoFirstFrameNodeID      string               `json:"generation_video_first_frame_node_id,omitempty"`
	GenerationVideoLastFrameNodeID       string               `json:"generation_video_last_frame_node_id,omitempty"`
	GenerationMode                       string               `json:"generation_mode,omitempty"`
	GenerationTextModel                  string               `json:"generation_text_model,omitempty"`
	GenerationAudioModel                 string               `json:"generation_audio_model,omitempty"`
	GenerationAudioVoice                 string               `json:"generation_audio_voice,omitempty"`
	GenerationAudioFormat                string               `json:"generation_audio_format,omitempty"`
	GenerationAudioSpeed                 float64              `json:"generation_audio_speed,omitempty"`
	GenerationAudioInstructions          string               `json:"generation_audio_instructions,omitempty"`
	GenerationAudioGrokVoice             string               `json:"generation_audio_grok_voice,omitempty"`
	GenerationAudioGrokLanguage          string               `json:"generation_audio_grok_language,omitempty"`
	GenerationAudioGrokFormat            string               `json:"generation_audio_grok_format,omitempty"`
	GenerationAudioGrokSpeed             float64              `json:"generation_audio_grok_speed,omitempty"`
	GenerationAudioGLMVoice              string               `json:"generation_audio_glm_voice,omitempty"`
	GenerationAudioGLMFormat             string               `json:"generation_audio_glm_format,omitempty"`
	GenerationAudioGLMSpeed              float64              `json:"generation_audio_glm_speed,omitempty"`
	GenerationAudioMiMoVoice             string               `json:"generation_audio_mimo_voice,omitempty"`
	GenerationAudioMiMoFormat            string               `json:"generation_audio_mimo_format,omitempty"`
	GenerationAudioMiMoVoiceDesignPrompt string               `json:"generation_audio_mimo_voice_design_prompt,omitempty"`
	GenerationAudioMiMoVoiceCloneNodeID  string               `json:"generation_audio_mimo_voice_clone_node_id,omitempty"`
	GenerationAudioGeminiVoice           string               `json:"generation_audio_gemini_voice,omitempty"`
	AudioTaskID                          string               `json:"audio_task_id,omitempty"`
	AudioTaskResultID                    string               `json:"audio_task_result_id,omitempty"`
	DurationMS                           int64                `json:"duration_ms,omitempty"`
	MimeType                             string               `json:"mime_type,omitempty"`
	PanoramaSourcePrompt                 string               `json:"panorama_source_prompt,omitempty"`
	PanoramaFinalPrompt                  string               `json:"panorama_final_prompt,omitempty"`
	PanoramaProjection                   string               `json:"panorama_projection,omitempty"`
	DirectorProject                      json.RawMessage      `json:"director_project,omitempty"`
	CameraControl                        *CanvasCameraControl `json:"camera_control,omitempty"`
	BatchChildIDs                        []string             `json:"batch_child_ids,omitempty"`
	BatchRootID                          string               `json:"batch_root_id,omitempty"`
	BatchPrimaryID                       string               `json:"batch_primary_id,omitempty"`
	BatchExpanded                        *bool                `json:"batch_expanded,omitempty"`
	CreatedAt                            string               `json:"created_at,omitempty"`
}

type CanvasConnection struct {
	ID         string `json:"id"`
	FromNodeID string `json:"from_node_id"`
	ToNodeID   string `json:"to_node_id"`
}

type CanvasAgentMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type CanvasAgentPanel struct {
	Open  bool `json:"open"`
	Width int  `json:"width"`
}

type CanvasDocument struct {
	Version               int                  `json:"version"`
	ID                    string               `json:"id"`
	Revision              int64                `json:"revision"`
	Title                 string               `json:"title"`
	Background            string               `json:"background"`
	ShowImageInfo         bool                 `json:"show_image_info,omitempty"`
	Nodes                 []CanvasNode         `json:"nodes"`
	Connections           []CanvasConnection   `json:"connections"`
	AgentMessages         []CanvasAgentMessage `json:"agent_messages,omitempty"`
	AgentSessions         json.RawMessage      `json:"agent_sessions,omitempty"`
	ActiveAgentSessionID  string               `json:"active_agent_session_id,omitempty"`
	AgentConfig           json.RawMessage      `json:"agent_config,omitempty"`
	AgentPanel            *CanvasAgentPanel    `json:"agent_panel,omitempty"`
	AgentAutoTitlePending bool                 `json:"agent_auto_title_pending,omitempty"`
	PendingAgentRequest   json.RawMessage      `json:"pending_agent_request,omitempty"`
	Viewport              CanvasViewport       `json:"viewport"`
	CreatedAt             string               `json:"created_at,omitempty"`
	UpdatedAt             string               `json:"updated_at,omitempty"`
}

type CanvasProjectSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	NodeCount int    `json:"node_count"`
	Revision  int64  `json:"revision"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type CanvasWorkspaceResult struct {
	Document        CanvasDocument         `json:"document"`
	Projects        []CanvasProjectSummary `json:"projects"`
	ActiveProjectID string                 `json:"active_project_id"`
}

type canvasWorkspace struct {
	Version                       int              `json:"version"`
	Generation                    int64            `json:"generation"`
	ActiveProjectID               string           `json:"active_project_id"`
	Projects                      []CanvasDocument `json:"projects"`
	PendingStorageObjectDeletions []string         `json:"pending_storage_object_deletions,omitempty"`
	storedActiveID                string
}

type canvasActiveProject struct {
	Version                  int    `json:"version"`
	ProjectID                string `json:"project_id"`
	WorkspaceActiveProjectID string `json:"workspace_active_project_id"`
}

type CanvasDocumentService struct {
	mu                     sync.Mutex
	store                  storage.JSONDocumentBackend
	storageObjectValidator func(ownerID, objectID string) error
}

func NewCanvasDocumentService(backend storage.Backend, validators ...func(ownerID, objectID string) error) *CanvasDocumentService {
	service := &CanvasDocumentService{store: jsonDocumentStoreFromBackend(backend)}
	if len(validators) > 0 {
		service.storageObjectValidator = validators[0]
	}
	return service
}

func DefaultCanvasDocument() CanvasDocument {
	now := util.NowISO()
	return CanvasDocument{
		Version:               canvasDocumentVersion,
		ID:                    newCanvasProjectID(),
		Title:                 "我的画布",
		Background:            "dots",
		AgentPanel:            &CanvasAgentPanel{Width: 390},
		AgentAutoTitlePending: true,
		Nodes:                 []CanvasNode{},
		Connections:           []CanvasConnection{},
		Viewport:              CanvasViewport{Zoom: 1},
		CreatedAt:             now,
		UpdatedAt:             now,
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

// Project returns one project without changing the workspace's active project.
// It is used by the canvas library for project-specific export and deep links.
func (s *CanvasDocumentService) Project(ownerID, projectID string) (CanvasDocument, error) {
	ownerID = util.Clean(ownerID)
	projectID = util.Clean(projectID)
	if ownerID == "" {
		return CanvasDocument{}, invalidCanvasDocument("owner_id is required")
	}
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
	index := canvasProjectIndex(workspace, projectID)
	if index < 0 {
		return CanvasDocument{}, invalidCanvasDocument("canvas project does not exist")
	}
	return workspace.Projects[index], nil
}

// ReferencesStorageObject reports whether any persisted project for one owner
// still contains the storage key or its authenticated content URL.
func (s *CanvasDocumentService) ReferencesStorageObject(ownerID, storageKey string) (bool, error) {
	ownerID = util.Clean(ownerID)
	storageKey = strings.TrimSpace(storageKey)
	if ownerID == "" || storageObjectIDFromKey(storageKey) == "" {
		return false, nil
	}
	if s.store == nil {
		return false, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.store.LoadJSONDocument(canvasWorkspaceName(ownerID))
	if err != nil || raw == nil {
		return false, err
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return false, err
	}
	var workspace canvasWorkspace
	if err := json.Unmarshal(data, &workspace); err != nil {
		return false, err
	}
	workspace, err = normalizeCanvasWorkspace(workspace)
	if err != nil {
		return false, err
	}
	for _, document := range workspace.Projects {
		if canvasDocumentReferencesStorageObject(document, storageKey) {
			return true, nil
		}
	}
	return false, nil
}

// ReserveStorageObjectDeletion fences canvas writes through the same durable
// workspace CAS used by SaveAtRevision. Across service instances, either a
// reference save wins first or the deletion fence does; the loser reloads and
// observes the winning state.
func (s *CanvasDocumentService) ReserveStorageObjectDeletion(ownerID, objectID string) error {
	ownerID = util.Clean(ownerID)
	objectID = strings.TrimSpace(objectID)
	if ownerID == "" || objectID == "" {
		return errors.New("canvas owner and storage object id are required")
	}
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return err
		}
		storageKey := "server:" + objectID
		for _, document := range workspace.Projects {
			if canvasDocumentReferencesStorageObject(document, storageKey) {
				return fmt.Errorf("%w by a canvas project: %q", ErrStorageObjectInUse, objectID)
			}
		}
		if canvasStorageObjectIDListContains(workspace.PendingStorageObjectDeletions, objectID) {
			return nil
		}
		workspace.PendingStorageObjectDeletions = append(workspace.PendingStorageObjectDeletions, objectID)
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

// CompleteStorageObjectDeletion removes a fence only after the object record
// is gone. Canvas writes that race this CAS reload the workspace and validate
// the now-missing object before they can commit.
func (s *CanvasDocumentService) CompleteStorageObjectDeletion(ownerID, objectID string) error {
	ownerID = util.Clean(ownerID)
	objectID = strings.TrimSpace(objectID)
	if ownerID == "" || objectID == "" {
		return errors.New("canvas owner and storage object id are required")
	}
	if s.store == nil {
		return fmt.Errorf("storage document backend is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return err
		}
		remaining := make([]string, 0, len(workspace.PendingStorageObjectDeletions))
		for _, pendingID := range workspace.PendingStorageObjectDeletions {
			if pendingID != objectID {
				remaining = append(remaining, pendingID)
			}
		}
		if len(remaining) == len(workspace.PendingStorageObjectDeletions) {
			return nil
		}
		workspace.PendingStorageObjectDeletions = remaining
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

func canvasDocumentReferencesStorageObject(document CanvasDocument, storageKey string) bool {
	objectID := storageObjectIDFromKey(storageKey)
	return objectID != "" && canvasStorageObjectIDListContains(canvasDocumentStorageObjectIDs(document), objectID)
}

func canvasDocumentStorageObjectIDs(document CanvasDocument) []string {
	ids := make(map[string]struct{})
	add := func(value string) {
		if objectID := canvasStorageObjectIDFromReference(value); objectID != "" {
			ids[objectID] = struct{}{}
		}
	}
	for _, node := range document.Nodes {
		add(node.StorageKey)
		add(node.URL)
		add(node.ThumbnailURL)
		for _, values := range [][]string{node.GenerationReferenceURLs, node.GenerationVideoReferenceImages, node.GenerationVideoReferenceURLs, node.GenerationVideoReferenceAudio} {
			for _, value := range values {
				add(value)
			}
		}
		collectCanvasRawJSONStorageObjectIDs(node.DirectorProject, add)
	}
	collectCanvasRawJSONStorageObjectIDs(document.AgentSessions, add)
	collectCanvasRawJSONStorageObjectIDs(document.AgentConfig, add)
	collectCanvasRawJSONStorageObjectIDs(document.PendingAgentRequest, add)

	result := make([]string, 0, len(ids))
	for objectID := range ids {
		result = append(result, objectID)
	}
	sort.Strings(result)
	return result
}

func canvasStorageObjectIDFromReference(value string) string {
	value = strings.TrimSpace(value)
	if objectID := storageObjectIDFromKey(value); objectID != "" {
		return objectID
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	const prefix = "/api/files/"
	if !strings.HasPrefix(parsed.Path, prefix) {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, prefix), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "content" {
		return ""
	}
	return strings.TrimSpace(parts[0])
}

func collectCanvasRawJSONStorageObjectIDs(raw json.RawMessage, add func(string)) {
	if len(raw) == 0 {
		return
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return
	}
	var visit func(any)
	visit = func(candidate any) {
		switch typed := candidate.(type) {
		case string:
			add(typed)
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			for _, item := range typed {
				visit(item)
			}
		}
	}
	visit(value)
}

func canvasStorageObjectIDListContains(ids []string, target string) bool {
	for _, objectID := range ids {
		if objectID == target {
			return true
		}
	}
	return false
}

func (s *CanvasDocumentService) SaveAtRevision(ownerID string, input CanvasDocument) (CanvasDocument, error) {
	expected := input.Revision
	return s.save(ownerID, input, &expected)
}

func (s *CanvasDocumentService) save(ownerID string, input CanvasDocument, expectedRevision *int64) (CanvasDocument, error) {
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
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
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
		if expectedRevision != nil && *expectedRevision != current.Revision {
			return CanvasDocument{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: current.Revision}
		}
		candidate := normalized
		candidate.ID = current.ID
		candidate.CreatedAt = current.CreatedAt
		candidate.Revision = current.Revision + 1
		candidate.UpdatedAt = util.NowISO()
		if err := s.validateStorageObjectReferencesLocked(ownerID, workspace, candidate); err != nil {
			return CanvasDocument{}, err
		}
		workspace.Projects[projectIndex] = candidate
		workspace.ActiveProjectID = candidate.ID
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			if expectedRevision != nil && errors.Is(err, storage.ErrConcurrentRowUpdate) {
				return CanvasDocument{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: -1}
			}
			return CanvasDocument{}, err
		}
		return candidate, nil
	}
	return CanvasDocument{}, fmt.Errorf("failed to save canvas workspace")
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
	now := util.NowISO()
	normalized.ID = newCanvasProjectID()
	normalized.Revision = 0
	normalized.CreatedAt = now
	normalized.UpdatedAt = now
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return CanvasWorkspaceResult{}, err
		}
		if canvasProjectIndex(workspace, normalized.ID) >= 0 {
			workspace.ActiveProjectID = normalized.ID
			return canvasWorkspaceResult(workspace), nil
		}
		if len(workspace.Projects) >= canvasWorkspaceMaxProjects {
			return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project limit reached")
		}
		if err := s.validateStorageObjectReferencesLocked(ownerID, workspace, normalized); err != nil {
			return CanvasWorkspaceResult{}, err
		}
		workspace.Projects = append([]CanvasDocument{normalized}, workspace.Projects...)
		workspace.ActiveProjectID = normalized.ID
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			return CanvasWorkspaceResult{}, err
		}
		return canvasWorkspaceResult(workspace), nil
	}
	return CanvasWorkspaceResult{}, fmt.Errorf("failed to import canvas workspace")
}

func (s *CanvasDocumentService) ClearAtRevision(ownerID, projectID string, expectedRevision int64) (CanvasDocument, error) {
	return s.clear(ownerID, projectID, &expectedRevision)
}

func (s *CanvasDocumentService) clear(ownerID, projectID string, expectedRevision *int64) (CanvasDocument, error) {
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
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return CanvasDocument{}, err
		}
		projectIndex := canvasProjectIndex(workspace, projectID)
		if projectIndex < 0 {
			return CanvasDocument{}, invalidCanvasDocument("canvas project does not exist")
		}
		current := workspace.Projects[projectIndex]
		if expectedRevision != nil && *expectedRevision != current.Revision {
			return CanvasDocument{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: current.Revision}
		}
		cleared := DefaultCanvasDocument()
		cleared.ID = current.ID
		cleared.Title = current.Title
		cleared.Background = current.Background
		cleared.AgentAutoTitlePending = current.AgentAutoTitlePending
		cleared.Viewport = current.Viewport
		cleared.CreatedAt = current.CreatedAt
		cleared.Revision = current.Revision + 1
		workspace.Projects[projectIndex] = cleared
		workspace.ActiveProjectID = cleared.ID
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			if expectedRevision != nil && errors.Is(err, storage.ErrConcurrentRowUpdate) {
				return CanvasDocument{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: -1}
			}
			return CanvasDocument{}, err
		}
		return cleared, nil
	}
	return CanvasDocument{}, fmt.Errorf("failed to clear canvas workspace")
}

func (s *CanvasDocumentService) UpdateProject(ownerID, action, projectID, title string) (CanvasWorkspaceResult, error) {
	return s.updateProject(ownerID, action, projectID, title, nil)
}

func (s *CanvasDocumentService) UpdateProjectAtRevision(ownerID, action, projectID, title string, expectedRevision int64) (CanvasWorkspaceResult, error) {
	return s.updateProject(ownerID, action, projectID, title, &expectedRevision)
}

func (s *CanvasDocumentService) updateProject(ownerID, action, projectID, title string, expectedRevision *int64) (CanvasWorkspaceResult, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("owner_id is required")
	}
	if s.store == nil {
		return CanvasWorkspaceResult{}, fmt.Errorf("storage document backend is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	action = strings.ToLower(strings.TrimSpace(action))
	if action != "create" && action != "activate" && action != "rename" && action != "delete" {
		return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project action is invalid")
	}
	project := DefaultCanvasDocument()
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		workspace, err := s.loadWorkspaceLocked(ownerID)
		if err != nil {
			return CanvasWorkspaceResult{}, err
		}
		switch action {
		case "create":
			if canvasProjectIndex(workspace, project.ID) >= 0 {
				workspace.ActiveProjectID = project.ID
				return canvasWorkspaceResult(workspace), nil
			}
			if len(workspace.Projects) >= canvasWorkspaceMaxProjects {
				return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project limit reached")
			}
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
			projectID = strings.TrimSpace(projectID)
			if err := s.saveActiveProjectLocked(ownerID, projectID, workspace.storedActiveID); err != nil {
				if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
					continue
				}
				return CanvasWorkspaceResult{}, err
			}
			workspace.ActiveProjectID = projectID
			return canvasWorkspaceResult(workspace), nil
		case "rename":
			index := canvasProjectIndex(workspace, projectID)
			title = strings.TrimSpace(title)
			if index < 0 {
				return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
			}
			if expectedRevision != nil && workspace.Projects[index].Revision != *expectedRevision {
				return CanvasWorkspaceResult{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: workspace.Projects[index].Revision}
			}
			if title == "" || len(title) > canvasDocumentMaxTitle {
				return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas title is invalid")
			}
			workspace.Projects[index].Title = title
			workspace.Projects[index].AgentAutoTitlePending = false
			workspace.Projects[index].Revision++
			workspace.Projects[index].UpdatedAt = util.NowISO()
		case "delete":
			index := canvasProjectIndex(workspace, projectID)
			if index < 0 {
				return CanvasWorkspaceResult{}, invalidCanvasDocument("canvas project does not exist")
			}
			if expectedRevision != nil && workspace.Projects[index].Revision != *expectedRevision {
				return CanvasWorkspaceResult{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: workspace.Projects[index].Revision}
			}
			workspace.Projects = append(workspace.Projects[:index], workspace.Projects[index+1:]...)
			if workspace.ActiveProjectID == projectID {
				if len(workspace.Projects) > 0 {
					workspace.ActiveProjectID = workspace.Projects[0].ID
				} else {
					workspace.ActiveProjectID = ""
				}
			}
		}
		if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < canvasWorkspaceSaveAttempts {
				continue
			}
			if expectedRevision != nil && errors.Is(err, storage.ErrConcurrentRowUpdate) {
				return CanvasWorkspaceResult{}, CanvasRevisionConflictError{Expected: *expectedRevision, Actual: -1}
			}
			return CanvasWorkspaceResult{}, err
		}
		return canvasWorkspaceResult(workspace), nil
	}
	return CanvasWorkspaceResult{}, fmt.Errorf("failed to update canvas workspace")
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
		workspace, err = normalizeCanvasWorkspace(workspace)
		if err != nil {
			return canvasWorkspace{}, err
		}
		workspace.storedActiveID = workspace.ActiveProjectID
		activeProjectID, err := s.loadActiveProjectLocked(ownerID, workspace.storedActiveID)
		if err != nil {
			return canvasWorkspace{}, err
		}
		if canvasProjectIndex(workspace, activeProjectID) >= 0 {
			workspace.ActiveProjectID = activeProjectID
		}
		return workspace, nil
	}

	document := DefaultCanvasDocument()
	workspace := canvasWorkspace{
		Version:         canvasWorkspaceVersion,
		ActiveProjectID: document.ID,
		Projects:        []CanvasDocument{document},
		storedActiveID:  document.ID,
	}
	if err := s.saveWorkspaceLocked(ownerID, &workspace); err != nil {
		if errors.Is(err, storage.ErrConcurrentRowUpdate) {
			return s.loadWorkspaceLocked(ownerID)
		}
		return canvasWorkspace{}, err
	}
	return workspace, nil
}

func (s *CanvasDocumentService) loadActiveProjectLocked(ownerID, workspaceActiveProjectID string) (string, error) {
	raw, err := s.store.LoadJSONDocument(canvasActiveProjectName(ownerID))
	if err != nil || raw == nil {
		return "", err
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return "", err
	}
	var active canvasActiveProject
	if err := json.Unmarshal(data, &active); err != nil {
		return "", err
	}
	if active.Version != canvasWorkspaceVersion || strings.TrimSpace(active.WorkspaceActiveProjectID) != workspaceActiveProjectID {
		return "", nil
	}
	return strings.TrimSpace(active.ProjectID), nil
}

func (s *CanvasDocumentService) saveActiveProjectLocked(ownerID, projectID, workspaceActiveProjectID string) error {
	return s.store.SaveJSONDocument(canvasActiveProjectName(ownerID), canvasActiveProject{
		Version:                  canvasWorkspaceVersion,
		ProjectID:                strings.TrimSpace(projectID),
		WorkspaceActiveProjectID: strings.TrimSpace(workspaceActiveProjectID),
	})
}

func (s *CanvasDocumentService) saveWorkspaceLocked(ownerID string, workspace *canvasWorkspace) error {
	if workspace == nil {
		return invalidCanvasDocument("canvas workspace is required")
	}
	workspace.Generation++
	if workspace.Generation <= 0 {
		return invalidCanvasDocument("canvas workspace generation is invalid")
	}
	normalized, err := normalizeCanvasWorkspace(*workspace)
	if err != nil {
		return err
	}
	if err := s.store.SaveJSONDocument(canvasWorkspaceName(ownerID), normalized); err != nil {
		return err
	}
	*workspace = normalized
	return nil
}

func normalizeCanvasWorkspace(workspace canvasWorkspace) (canvasWorkspace, error) {
	workspace.Version = canvasWorkspaceVersion
	if workspace.Generation < 0 {
		return canvasWorkspace{}, invalidCanvasDocument("canvas workspace generation is invalid")
	}
	pendingDeletions := make([]string, 0, len(workspace.PendingStorageObjectDeletions))
	seenPendingDeletion := make(map[string]struct{}, len(workspace.PendingStorageObjectDeletions))
	for _, objectID := range workspace.PendingStorageObjectDeletions {
		objectID = strings.TrimSpace(objectID)
		if objectID == "" {
			continue
		}
		if _, exists := seenPendingDeletion[objectID]; exists {
			continue
		}
		seenPendingDeletion[objectID] = struct{}{}
		pendingDeletions = append(pendingDeletions, objectID)
	}
	workspace.PendingStorageObjectDeletions = pendingDeletions
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
	if len(workspace.Projects) == 0 {
		workspace.ActiveProjectID = ""
	} else if _, exists := seen[workspace.ActiveProjectID]; !exists {
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

func (s *CanvasDocumentService) validateStorageObjectReferencesLocked(ownerID string, workspace canvasWorkspace, document CanvasDocument) error {
	objectIDs := canvasDocumentStorageObjectIDs(document)
	for _, objectID := range objectIDs {
		if canvasStorageObjectIDListContains(workspace.PendingStorageObjectDeletions, objectID) {
			return invalidCanvasDocument(fmt.Sprintf("storage object %q is pending deletion", objectID))
		}
		if s.storageObjectValidator != nil {
			if err := s.storageObjectValidator(ownerID, objectID); err != nil {
				return invalidCanvasDocument(fmt.Sprintf("storage object %q is unavailable", objectID))
			}
		}
	}
	return nil
}

func canvasWorkspaceResult(workspace canvasWorkspace) CanvasWorkspaceResult {
	if len(workspace.Projects) == 0 {
		return CanvasWorkspaceResult{Document: CanvasDocument{}, Projects: []CanvasProjectSummary{}, ActiveProjectID: ""}
	}
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
			Revision:  project.Revision,
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
	if len(input.AgentMessages) > canvasDocumentMaxAgentMessages {
		return CanvasDocument{}, invalidCanvasDocument("canvas contains too many agent messages")
	}
	for index := range input.AgentMessages {
		message := input.AgentMessages[index]
		message.ID = strings.TrimSpace(message.ID)
		message.Role = strings.ToLower(strings.TrimSpace(message.Role))
		message.Content = strings.TrimSpace(message.Content)
		message.CreatedAt = strings.TrimSpace(message.CreatedAt)
		if message.ID == "" || len(message.ID) > 128 || message.Role != "user" && message.Role != "assistant" || message.Content == "" || len(message.Content) > canvasDocumentMaxPrompt {
			return CanvasDocument{}, invalidCanvasDocument("canvas agent message is invalid")
		}
		input.AgentMessages[index] = message
	}
	input.ActiveAgentSessionID = strings.TrimSpace(input.ActiveAgentSessionID)
	if len(input.ActiveAgentSessionID) > 128 {
		return CanvasDocument{}, invalidCanvasDocument("active canvas agent session id is too long")
	}
	if err := validateCanvasAgentJSON(input.AgentSessions, true); err != nil {
		return CanvasDocument{}, err
	}
	if err := validateCanvasAgentJSON(input.AgentConfig, false); err != nil {
		return CanvasDocument{}, err
	}
	if input.AgentPanel == nil {
		input.AgentPanel = &CanvasAgentPanel{Width: 390}
	} else if input.AgentPanel.Width < 320 || input.AgentPanel.Width > 760 {
		return CanvasDocument{}, invalidCanvasDocument("canvas agent panel width is invalid")
	}
	if err := validateCanvasPendingAgentRequest(input.PendingAgentRequest); err != nil {
		return CanvasDocument{}, err
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
		if node.GroupID != "" {
			group, exists := nodeByID[node.GroupID]
			if !exists || group.Type != "group" {
				return CanvasDocument{}, invalidCanvasDocument("node group does not exist")
			}
		}
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
		fromNode := nodeByID[connection.FromNodeID]
		toNode := nodeByID[connection.ToNodeID]
		if fromNode.Type == "group" || toNode.Type == "group" {
			return CanvasDocument{}, invalidCanvasDocument("group nodes cannot be connected")
		}
		if fromNode.Type == "director" || toNode.Type == "director" {
			other := fromNode
			if other.Type == "director" {
				other = toNode
			}
			if other.Type != "image" && other.Type != "panorama" {
				return CanvasDocument{}, invalidCanvasDocument("director nodes only accept image or panorama connections")
			}
		}
		if fromNode.Type == "config" && toNode.Type == "config" {
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

func validateCanvasAgentJSON(value json.RawMessage, sessions bool) error {
	if len(value) == 0 || string(value) == "null" {
		return nil
	}
	if len(value) > canvasDocumentMaxAgentDataBytes || !json.Valid(value) {
		return invalidCanvasDocument("canvas agent data is invalid")
	}
	if sessions {
		var items []json.RawMessage
		if err := json.Unmarshal(value, &items); err != nil || len(items) > canvasDocumentMaxAgentSessions {
			return invalidCanvasDocument("canvas agent sessions are invalid")
		}
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(value, &object); err != nil {
		return invalidCanvasDocument("canvas agent config is invalid")
	}
	return nil
}

func validateCanvasPendingAgentRequest(value json.RawMessage) error {
	if len(value) == 0 || string(value) == "null" {
		return nil
	}
	if len(value) > canvasDocumentMaxAgentDataBytes || !json.Valid(value) {
		return invalidCanvasDocument("canvas pending agent request is invalid")
	}
	var request struct {
		Prompt string            `json:"prompt"`
		Assets []json.RawMessage `json:"assets"`
	}
	if err := json.Unmarshal(value, &request); err != nil || strings.TrimSpace(request.Prompt) == "" || len(request.Prompt) > canvasDocumentMaxPrompt || len(request.Assets) > 50 {
		return invalidCanvasDocument("canvas pending agent request is invalid")
	}
	for _, asset := range request.Assets {
		if len(asset) == 0 || !json.Valid(asset) || string(asset) == "null" {
			return invalidCanvasDocument("canvas pending agent request is invalid")
		}
	}
	return nil
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
	if node.Type != "image" && node.Type != "video" && node.Type != "text" && node.Type != "config" && node.Type != "audio" && node.Type != "panorama" && node.Type != "director" && node.Type != "group" {
		return CanvasNode{}, invalidCanvasDocument("node type must be image, video, audio, panorama, director, group, text, or config")
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
	node.GroupID = strings.TrimSpace(node.GroupID)
	node.TaskID = strings.TrimSpace(node.TaskID)
	node.GenerationModel = strings.TrimSpace(node.GenerationModel)
	node.GenerationSize = strings.ToLower(strings.TrimSpace(node.GenerationSize))
	node.GenerationResolution = strings.ToLower(strings.TrimSpace(node.GenerationResolution))
	node.GenerationQuality = strings.ToLower(strings.TrimSpace(node.GenerationQuality))
	node.GenerationOutputFormat = strings.ToLower(strings.TrimSpace(node.GenerationOutputFormat))
	node.GenerationStatus = strings.ToLower(strings.TrimSpace(node.GenerationStatus))
	node.GenerationError = strings.TrimSpace(node.GenerationError)
	node.GenerationType = strings.ToLower(strings.TrimSpace(node.GenerationType))
	node.GenerationVideoModel = strings.TrimSpace(node.GenerationVideoModel)
	node.GenerationVideoSize = strings.ToLower(strings.TrimSpace(node.GenerationVideoSize))
	node.GenerationVideoResolution = strings.ToLower(strings.TrimSpace(node.GenerationVideoResolution))
	node.GenerationVideoReferenceMode = strings.ToLower(strings.TrimSpace(node.GenerationVideoReferenceMode))
	node.GenerationVideoFirstFrameNodeID = strings.TrimSpace(node.GenerationVideoFirstFrameNodeID)
	node.GenerationVideoLastFrameNodeID = strings.TrimSpace(node.GenerationVideoLastFrameNodeID)
	node.GenerationMode = strings.ToLower(strings.TrimSpace(node.GenerationMode))
	node.GenerationTextModel = strings.TrimSpace(node.GenerationTextModel)
	node.GenerationAudioModel = strings.TrimSpace(node.GenerationAudioModel)
	node.GenerationAudioVoice = strings.TrimSpace(node.GenerationAudioVoice)
	node.GenerationAudioFormat = strings.ToLower(strings.TrimSpace(node.GenerationAudioFormat))
	node.GenerationAudioInstructions = strings.TrimSpace(node.GenerationAudioInstructions)
	node.GenerationAudioGrokVoice = strings.TrimSpace(node.GenerationAudioGrokVoice)
	node.GenerationAudioGrokLanguage = strings.TrimSpace(node.GenerationAudioGrokLanguage)
	node.GenerationAudioGrokFormat = strings.ToLower(strings.TrimSpace(node.GenerationAudioGrokFormat))
	node.GenerationAudioGLMVoice = strings.TrimSpace(node.GenerationAudioGLMVoice)
	node.GenerationAudioGLMFormat = strings.ToLower(strings.TrimSpace(node.GenerationAudioGLMFormat))
	node.GenerationAudioMiMoVoice = strings.TrimSpace(node.GenerationAudioMiMoVoice)
	node.GenerationAudioMiMoFormat = strings.ToLower(strings.TrimSpace(node.GenerationAudioMiMoFormat))
	node.GenerationAudioMiMoVoiceDesignPrompt = strings.TrimSpace(node.GenerationAudioMiMoVoiceDesignPrompt)
	node.GenerationAudioMiMoVoiceCloneNodeID = strings.TrimSpace(node.GenerationAudioMiMoVoiceCloneNodeID)
	node.GenerationAudioGeminiVoice = strings.TrimSpace(node.GenerationAudioGeminiVoice)
	node.AudioTaskID = strings.TrimSpace(node.AudioTaskID)
	node.AudioTaskResultID = strings.TrimSpace(node.AudioTaskResultID)
	node.MimeType = strings.ToLower(strings.TrimSpace(node.MimeType))
	node.PanoramaSourcePrompt = strings.TrimSpace(node.PanoramaSourcePrompt)
	node.PanoramaFinalPrompt = strings.TrimSpace(node.PanoramaFinalPrompt)
	node.PanoramaProjection = strings.ToLower(strings.TrimSpace(node.PanoramaProjection))
	node.BatchRootID = strings.TrimSpace(node.BatchRootID)
	node.BatchPrimaryID = strings.TrimSpace(node.BatchPrimaryID)
	node.CreatedAt = strings.TrimSpace(node.CreatedAt)
	for index := range node.GenerationReferenceURLs {
		node.GenerationReferenceURLs[index] = strings.TrimSpace(node.GenerationReferenceURLs[index])
	}
	for index := range node.GenerationVideoReferenceURLs {
		node.GenerationVideoReferenceURLs[index] = strings.TrimSpace(node.GenerationVideoReferenceURLs[index])
	}
	for index := range node.GenerationVideoReferenceImages {
		node.GenerationVideoReferenceImages[index] = strings.TrimSpace(node.GenerationVideoReferenceImages[index])
	}
	for index := range node.GenerationVideoReferenceAudio {
		node.GenerationVideoReferenceAudio[index] = strings.TrimSpace(node.GenerationVideoReferenceAudio[index])
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
	if len(node.GenerationAudioInstructions) > canvasDocumentMaxPrompt || len(node.GenerationAudioMiMoVoiceDesignPrompt) > canvasDocumentMaxPrompt || len(node.PanoramaSourcePrompt) > canvasDocumentMaxPrompt || len(node.PanoramaFinalPrompt) > canvasDocumentMaxPrompt {
		return CanvasNode{}, invalidCanvasDocument("node media generation text is too long")
	}
	if node.GenerationMode != "" && node.GenerationMode != "image" && node.GenerationMode != "text" && node.GenerationMode != "video" && node.GenerationMode != "audio" {
		return CanvasNode{}, invalidCanvasDocument("node generation mode is invalid")
	}
	if node.Type == "config" && node.GenerationMode == "text" && (node.GenerationTextModel == "" || len(node.GenerationTextModel) > 256) {
		return CanvasNode{}, invalidCanvasDocument("text node generation model is invalid")
	}
	if len(node.GenerationVideoFirstFrameNodeID) > 128 || len(node.GenerationVideoLastFrameNodeID) > 128 {
		return CanvasNode{}, invalidCanvasDocument("video node frame references are invalid")
	}
	if node.Type == "audio" || node.Type == "config" && node.GenerationMode == "audio" {
		if node.GenerationAudioModel == "" || len(node.GenerationAudioModel) > 256 {
			return CanvasNode{}, invalidCanvasDocument("audio node generation model is invalid")
		}
		if len(node.GenerationAudioVoice) > 256 || len(node.GenerationAudioGrokVoice) > 256 || len(node.GenerationAudioGLMVoice) > 256 || len(node.GenerationAudioMiMoVoice) > 256 || len(node.GenerationAudioGeminiVoice) > 256 {
			return CanvasNode{}, invalidCanvasDocument("audio node generation voice is invalid")
		}
		if node.GenerationAudioVoice != "" && !validCanvasOpenAITTSVoice(node.GenerationAudioVoice) {
			return CanvasNode{}, invalidCanvasDocument("audio node generation voice is invalid")
		}
		if node.GenerationAudioFormat != "" && node.GenerationAudioFormat != "mp3" && node.GenerationAudioFormat != "wav" && node.GenerationAudioFormat != "opus" && node.GenerationAudioFormat != "aac" && node.GenerationAudioFormat != "flac" && node.GenerationAudioFormat != "pcm" {
			return CanvasNode{}, invalidCanvasDocument("audio node generation format is invalid")
		}
		if !validCanvasOptionalRange(node.GenerationAudioSpeed, 0.25, 4) {
			return CanvasNode{}, invalidCanvasDocument("audio node generation speed is invalid")
		}
		if node.GenerationAudioGrokLanguage != "" && !validCanvasGrokTTSLanguage(node.GenerationAudioGrokLanguage) {
			return CanvasNode{}, invalidCanvasDocument("audio node Grok language is invalid")
		}
		if node.GenerationAudioGrokFormat != "" && node.GenerationAudioGrokFormat != "mp3" && node.GenerationAudioGrokFormat != "wav" {
			return CanvasNode{}, invalidCanvasDocument("audio node Grok format is invalid")
		}
		if !validCanvasOptionalRange(node.GenerationAudioGrokSpeed, 0.7, 1.5) {
			return CanvasNode{}, invalidCanvasDocument("audio node Grok speed is invalid")
		}
		if node.GenerationAudioGLMFormat != "" && node.GenerationAudioGLMFormat != "wav" && node.GenerationAudioGLMFormat != "pcm" {
			return CanvasNode{}, invalidCanvasDocument("audio node GLM format is invalid")
		}
		if node.GenerationAudioGLMVoice != "" && !validCanvasGLMTTSVoice(node.GenerationAudioGLMVoice) {
			return CanvasNode{}, invalidCanvasDocument("audio node GLM voice is invalid")
		}
		if !validCanvasOptionalRange(node.GenerationAudioGLMSpeed, 0.5, 2) {
			return CanvasNode{}, invalidCanvasDocument("audio node GLM speed is invalid")
		}
		if node.GenerationAudioMiMoFormat != "" && node.GenerationAudioMiMoFormat != "wav" && node.GenerationAudioMiMoFormat != "mp3" {
			return CanvasNode{}, invalidCanvasDocument("audio node MiMo format is invalid")
		}
		if node.GenerationAudioMiMoVoice != "" && !validCanvasMiMoTTSVoice(node.GenerationAudioMiMoVoice) {
			return CanvasNode{}, invalidCanvasDocument("audio node MiMo voice is invalid")
		}
		if node.GenerationAudioGeminiVoice != "" && !validCanvasGeminiTTSVoice(node.GenerationAudioGeminiVoice) {
			return CanvasNode{}, invalidCanvasDocument("audio node Gemini voice is invalid")
		}
		if len(node.GenerationAudioMiMoVoiceCloneNodeID) > 256 || len(node.AudioTaskID) > 256 || len(node.AudioTaskResultID) > 256 {
			return CanvasNode{}, invalidCanvasDocument("audio node task metadata is invalid")
		}
	}
	if node.DurationMS < 0 || node.DurationMS > 24*60*60*1000 {
		return CanvasNode{}, invalidCanvasDocument("node media duration is invalid")
	}
	if node.Type == "panorama" && node.PanoramaProjection != "" && node.PanoramaProjection != "equirectangular" {
		return CanvasNode{}, invalidCanvasDocument("panorama projection is invalid")
	}
	if len(node.DirectorProject) > 512<<10 || len(node.MimeType) > 128 {
		return CanvasNode{}, invalidCanvasDocument("node media metadata is too large")
	}
	if len(node.DirectorProject) > 0 && !json.Valid(node.DirectorProject) {
		return CanvasNode{}, invalidCanvasDocument("director project is invalid")
	}
	if node.CameraControl != nil {
		node.CameraControl.Camera = strings.TrimSpace(node.CameraControl.Camera)
		node.CameraControl.Lens = strings.TrimSpace(node.CameraControl.Lens)
		if len(node.CameraControl.Camera) > 128 || len(node.CameraControl.Lens) > 128 || !finiteCanvasNumber(node.CameraControl.FocalLength) || !finiteCanvasNumber(node.CameraControl.Aperture) || node.CameraControl.FocalLength < 0 || node.CameraControl.FocalLength > 2000 || node.CameraControl.Aperture < 0 || node.CameraControl.Aperture > 128 {
			return CanvasNode{}, invalidCanvasDocument("node camera control is invalid")
		}
	}
	if len(node.GenerationModel) > 256 {
		return CanvasNode{}, invalidCanvasDocument("node generation model is invalid")
	}
	if node.Type == "video" || node.Type == "config" && node.GenerationMode == "video" {
		if node.GenerationVideoModel == "" || len(node.GenerationVideoModel) > 256 {
			return CanvasNode{}, invalidCanvasDocument("video node generation model is invalid")
		}
		if len(node.GenerationVideoSize) > 64 {
			return CanvasNode{}, invalidCanvasDocument("video node generation size is invalid")
		}
		if node.GenerationVideoSeconds < 1 || node.GenerationVideoSeconds > 3600 {
			return CanvasNode{}, invalidCanvasDocument("video node generation duration is invalid")
		}
		if len(node.GenerationVideoResolution) > 64 {
			return CanvasNode{}, invalidCanvasDocument("video node generation resolution is invalid")
		}
		if node.GenerationVideoReferenceMode != "" && node.GenerationVideoReferenceMode != "first-frame" && node.GenerationVideoReferenceMode != "reference" {
			return CanvasNode{}, invalidCanvasDocument("video node generation reference mode is invalid")
		}
	}
	if len(node.GenerationSize) > 64 || len(node.GenerationResolution) > 16 {
		return CanvasNode{}, invalidCanvasDocument("node generation size is invalid")
	}
	if node.GenerationQuality != "" && node.GenerationQuality != "low" && node.GenerationQuality != "medium" && node.GenerationQuality != "high" {
		return CanvasNode{}, invalidCanvasDocument("node generation quality is invalid")
	}
	if node.GenerationCount < 0 || node.GenerationCount > 15 {
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
	if node.GenerationStartedAt < 0 {
		return CanvasNode{}, invalidCanvasDocument("node generation start time is invalid")
	}
	if !finiteCanvasNumber(node.GenerationProgress) || node.GenerationProgress < 0 || node.GenerationProgress > 100 {
		return CanvasNode{}, invalidCanvasDocument("node generation progress is invalid")
	}
	if len(node.GenerationError) > 4096 {
		return CanvasNode{}, invalidCanvasDocument("node generation error is too long")
	}
	if node.GenerationType != "" && node.GenerationType != "generation" && node.GenerationType != "edit" {
		return CanvasNode{}, invalidCanvasDocument("node generation type is invalid")
	}
	if len(node.GenerationReferenceURLs) > canvasDocumentMaxGenerationReferenceImages {
		return CanvasNode{}, invalidCanvasDocument("node has too many generation reference images")
	}
	for _, referenceURL := range node.GenerationReferenceURLs {
		if referenceURL == "" || len(referenceURL) > canvasDocumentMaxURL {
			return CanvasNode{}, invalidCanvasDocument("node generation reference image is invalid")
		}
	}
	if len(node.GenerationVideoReferenceURLs) > 3 {
		return CanvasNode{}, invalidCanvasDocument("node has too many generation reference videos")
	}
	for _, referenceURL := range node.GenerationVideoReferenceURLs {
		if referenceURL == "" || len(referenceURL) > canvasDocumentMaxURL {
			return CanvasNode{}, invalidCanvasDocument("node generation reference video is invalid")
		}
	}
	if len(node.GenerationVideoReferenceImages) > 9 {
		return CanvasNode{}, invalidCanvasDocument("node has too many generation reference images")
	}
	for _, referenceURL := range node.GenerationVideoReferenceImages {
		if referenceURL == "" || len(referenceURL) > canvasDocumentMaxURL {
			return CanvasNode{}, invalidCanvasDocument("node generation reference image is invalid")
		}
	}
	if len(node.GenerationVideoReferenceAudio) > 3 {
		return CanvasNode{}, invalidCanvasDocument("node has too many generation reference audio files")
	}
	for _, referenceURL := range node.GenerationVideoReferenceAudio {
		if referenceURL == "" || len(referenceURL) > canvasDocumentMaxURL {
			return CanvasNode{}, invalidCanvasDocument("node generation reference audio is invalid")
		}
	}
	if len(node.GroupID) > 128 || node.GroupID == node.ID || node.Type == "group" && node.GroupID != "" {
		return CanvasNode{}, invalidCanvasDocument("node group relationship is invalid")
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

func validCanvasOpenAITTSVoice(value string) bool {
	return canvasStringIn(value, "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar")
}

func validCanvasGLMTTSVoice(value string) bool {
	return canvasStringIn(value, "tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo")
}

func validCanvasMiMoTTSVoice(value string) bool {
	return canvasStringIn(value, "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean")
}

func validCanvasGrokTTSLanguage(value string) bool {
	return canvasStringIn(value, "auto", "en", "zh", "ja", "ko", "fr", "de", "hi", "id", "it", "ru", "tr", "vi", "bn", "pt-BR", "pt-PT", "es-MX", "es-ES", "ar-EG", "ar-SA", "ar-AE")
}

func validCanvasGeminiTTSVoice(value string) bool {
	return canvasStringIn(value, "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat")
}

func canvasStringIn(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func validCanvasOptionalRange(value, minimum, maximum float64) bool {
	return finiteCanvasNumber(value) && (value == 0 || value >= minimum && value <= maximum)
}

func canvasNodeIDListContains(ids []string, target string) bool {
	for _, id := range ids {
		if id == target {
			return true
		}
	}
	return false
}

func canvasWorkspaceName(ownerID string) string {
	return canvasWorkspaceDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func canvasActiveProjectName(ownerID string) string {
	return canvasActiveProjectDir + "/" + util.SHA256Hex(ownerID) + ".json"
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
