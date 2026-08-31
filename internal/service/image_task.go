package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	TaskStatusQueued    = "queued"
	TaskStatusRunning   = "running"
	TaskStatusSuccess   = "success"
	TaskStatusError     = "error"
	TaskStatusCancelled = "cancelled"

	defaultImageTaskTimeout = 5 * time.Minute
	// Keep one browser restart or an administrator account from starting an
	// unbounded number of memory-heavy image outputs at once. Per-user limits
	// still apply independently below this process-wide ceiling.
	defaultGlobalImageTaskConcurrentUnits = 15

	imageOutputCallbackPayloadKey     = "image_output_callback"
	imageOutputSlotAcquirerPayloadKey = "image_output_slot_acquirer"
	// ImageOutputCompletionReleasePayloadKey keeps a request-wide lease until
	// the task's terminal state has been persisted.
	ImageOutputCompletionReleasePayloadKey = "image_output_completion_release"

	TextOutputCallbackPayloadKey = "text_output_callback"
	// VideoTaskProgressCallbackPayloadKey reports the normalized upstream
	// queue state without exposing a provider-specific status as our task state.
	VideoTaskProgressCallbackPayloadKey = "video_task_progress_callback"
	// VideoTaskTimeoutSecondsPayloadKey carries the minimum task lifetime
	// required by the immutable video contract snapshot.
	VideoTaskTimeoutSecondsPayloadKey = "video_task_timeout_seconds"

	imageTaskPersistenceRetryInitialDelay = 25 * time.Millisecond
	imageTaskPersistenceRetryMaxDelay     = 2 * time.Second
	imageTaskPersistenceWaitPollInterval  = 10 * time.Millisecond
	imageTaskPersistenceWaitTimeout       = 5 * time.Second
	imageTaskInsertMaxAttempts            = 8
	imageTaskRemotePollInterval           = 250 * time.Millisecond
	imageTaskRecoveryGrace                = time.Second
)

type ImageTaskHandler func(context.Context, Identity, map[string]any) (map[string]any, error)

type VideoTaskProgressUpdate struct {
	Status         string
	UpstreamStatus string
	Progress       int
	HasProgress    bool
}

type ImageOutputOptions struct {
	Format      string
	Compression *int
}

type ImageToolOptions struct {
	Moderation       string
	InputImageMask   string
	Stream           bool
	PartialImages    int
	PartialImagesSet bool
	ResponseFormat   string
}

type ImageTaskService struct {
	mu                   sync.RWMutex
	closeOnce            sync.Once
	closeErr             error
	taskWorkers          sync.WaitGroup
	persistenceWorkers   sync.WaitGroup
	remoteMonitorWorkers sync.WaitGroup
	store                storage.JSONDocumentBackend
	docName              string
	generation           ImageTaskHandler
	edit                 ImageTaskHandler
	chat                 ImageTaskHandler
	video                ImageTaskHandler
	audio                ImageTaskHandler
	retentionGetter      func() int
	taskTimeoutGetter    func() time.Duration
	userConcurrentLimit  func() int
	userRPMLimit         func() int
	tasks                map[string]map[string]any
	deletedTasks         map[string]string
	loadErr              error
	cancels              map[string]context.CancelFunc
	ownerSubmitTimes     map[string][]time.Time
	ownerRunningUnits    map[string]int
	globalRunningUnits   int
	creationUnitCond     *sync.Cond
	persistenceDirty     bool
	persistenceRetrying  bool
	remoteMonitorRunning bool
	persistenceStop      chan struct{}
	stopping             bool
	closed               bool
}

type ImageTaskLimitError struct {
	Message string
}

var ErrImageTaskServiceClosed = errors.New("image task service is closed")

func (e ImageTaskLimitError) Error() string {
	return e.Message
}

type ImageTaskPersistenceError struct {
	Err         error
	TaskStarted bool
}

func (e ImageTaskPersistenceError) Error() string {
	if e.TaskStarted {
		return "任务状态写入数据库失败，请刷新后重试"
	}
	return "任务写入数据库失败，未启动上游请求"
}

func (e ImageTaskPersistenceError) Unwrap() error {
	return e.Err
}

type ImageTaskLoadError struct {
	Err error
}

func (e ImageTaskLoadError) Error() string {
	return "任务数据库暂时不可用，请稍后重试"
}

func (e ImageTaskLoadError) Unwrap() error {
	return e.Err
}

func NewStoredImageTaskService(backend storage.Backend, generation ImageTaskHandler, edit ImageTaskHandler, chat ImageTaskHandler, retentionGetter func() int, limitGetters ...func() int) *ImageTaskService {
	return newImageTaskService(jsonDocumentStoreFromBackend(backend), generation, edit, chat, retentionGetter, limitGetters...)
}

func newImageTaskService(store storage.JSONDocumentBackend, generation ImageTaskHandler, edit ImageTaskHandler, chat ImageTaskHandler, retentionGetter func() int, limitGetters ...func() int) *ImageTaskService {
	s := &ImageTaskService{
		store:             store,
		docName:           "image_tasks.json",
		generation:        generation,
		edit:              edit,
		chat:              chat,
		retentionGetter:   retentionGetter,
		tasks:             map[string]map[string]any{},
		deletedTasks:      map[string]string{},
		cancels:           map[string]context.CancelFunc{},
		ownerSubmitTimes:  map[string][]time.Time{},
		ownerRunningUnits: map[string]int{},
		persistenceStop:   make(chan struct{}),
	}
	s.creationUnitCond = sync.NewCond(&s.mu)
	if len(limitGetters) > 0 {
		s.userConcurrentLimit = limitGetters[0]
	}
	if len(limitGetters) > 1 {
		s.userRPMLimit = limitGetters[1]
	}
	s.mu.Lock()
	s.tasks, s.loadErr = s.loadLocked()
	if s.loadErr == nil {
		if s.cleanupLocked() {
			_ = s.saveWithRetryLocked()
		}
	}
	s.mu.Unlock()
	return s
}

func (s *ImageTaskService) SetTaskTimeoutGetter(getter func() time.Duration) {
	if getter == nil {
		return
	}
	s.taskTimeoutGetter = getter
}

func (s *ImageTaskService) SetVideoHandler(handler ImageTaskHandler) {
	s.video = handler
}

func (s *ImageTaskService) SetAudioHandler(handler ImageTaskHandler) {
	s.audio = handler
}

// Close cancels active tasks and waits for all task, persistence, and monitor workers.
// Callers may close the shared storage backend after this method returns.
func (s *ImageTaskService) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.stopping = true
		close(s.persistenceStop)
		cancels := make([]context.CancelFunc, 0, len(s.cancels))
		for _, cancel := range s.cancels {
			cancels = append(cancels, cancel)
		}
		s.creationUnitCond.Broadcast()
		s.mu.Unlock()

		for _, cancel := range cancels {
			cancel()
		}
		s.taskWorkers.Wait()
		s.persistenceWorkers.Wait()
		s.remoteMonitorWorkers.Wait()

		s.mu.Lock()
		if s.persistenceDirty {
			if err := s.saveLocked(); err == nil {
				s.persistenceDirty = false
			} else {
				s.closeErr = fmt.Errorf("persist image tasks during close: %w", err)
			}
		}
		s.closed = true
		s.mu.Unlock()
	})
	return s.closeErr
}

func (s *ImageTaskService) SubmitGenerationWithOptions(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, n int, metadata map[string]any, options ImageOutputOptions, toolOptions ImageToolOptions, visibilityValues ...string) (map[string]any, error) {
	return s.submitImageWithMetadataAndOptions(ctx, identity, clientTaskID, prompt, model, size, quality, baseURL, n, metadata, "generate", nil, options, toolOptions, visibilityValues...)
}

func (s *ImageTaskService) SubmitEditWithOptions(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, images any, n int, metadata map[string]any, options ImageOutputOptions, toolOptions ImageToolOptions, visibilityValues ...string) (map[string]any, error) {
	return s.submitImageWithMetadataAndOptions(ctx, identity, clientTaskID, prompt, model, size, quality, baseURL, n, metadata, "edit", images, options, toolOptions, visibilityValues...)
}

func (s *ImageTaskService) SubmitChatWithMetadata(ctx context.Context, identity Identity, clientTaskID, prompt, model string, messages any, metadata map[string]any, nValues ...int) (map[string]any, error) {
	return s.submitChatWithMetadata(ctx, identity, clientTaskID, prompt, model, messages, metadata, nValues...)
}

func (s *ImageTaskService) SubmitVideo(ctx context.Context, identity Identity, clientTaskID, prompt, model, size string, seconds int, resolution string, generateAudio, watermark bool, referenceMode string, images, videos, audios any, metadata map[string]any) (map[string]any, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	if seconds != -1 && (seconds < 1 || seconds > 3600) {
		return nil, fmt.Errorf("视频时长必须在 1 到 3600 秒之间")
	}
	payload := map[string]any{
		"client_task_id": clientTaskID,
		"prompt":         prompt,
		"model":          strings.TrimSpace(model),
		"size":           strings.TrimSpace(size),
		"seconds":        seconds,
		"resolution":     strings.TrimSpace(resolution),
		"generate_audio": generateAudio,
		"watermark":      watermark,
		"reference_mode": strings.TrimSpace(referenceMode),
		"visibility":     ImageVisibilityPrivate,
		"n":              1,
	}
	if images != nil {
		payload["reference_image_urls"] = images
	}
	if videos != nil {
		payload["reference_video_urls"] = videos
	}
	if audios != nil {
		payload["reference_audio_urls"] = audios
	}
	mergeTaskRoutingMetadata(payload, metadata)
	return s.submit(ctx, identity, clientTaskID, "video", payload)
}

func (s *ImageTaskService) SubmitAudio(ctx context.Context, identity Identity, clientTaskID string, request map[string]any, metadata map[string]any) (map[string]any, error) {
	payload := util.CopyMap(request)
	input := firstNonEmpty(strings.TrimSpace(util.Clean(payload["input"])), strings.TrimSpace(util.Clean(payload["prompt"])))
	if input == "" {
		return nil, fmt.Errorf("input is required")
	}
	payload["client_task_id"] = clientTaskID
	payload["input"] = input
	payload["prompt"] = input
	payload["model"] = strings.TrimSpace(util.Clean(payload["model"]))
	payload["visibility"] = ImageVisibilityPrivate
	payload["n"] = 1
	mergeTaskRoutingMetadata(payload, metadata)
	return s.submit(ctx, identity, clientTaskID, "audio", payload)
}

func (s *ImageTaskService) submitChatWithMetadata(ctx context.Context, identity Identity, clientTaskID, prompt, model string, messages any, metadata map[string]any, nValues ...int) (map[string]any, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	if len(util.AsMapSlice(messages)) == 0 {
		return nil, fmt.Errorf("messages are required")
	}
	n := 1
	if len(nValues) > 0 {
		n = normalizedImageTaskCount(nValues[0], model)
	}
	payload := map[string]any{"prompt": prompt, "model": model, "messages": messages, "n": n, "visibility": ImageVisibilityPrivate}
	mergeChatTaskMetadata(payload, metadata)
	return s.submit(ctx, identity, clientTaskID, "chat", payload)
}

func mergeChatTaskMetadata(payload map[string]any, metadata map[string]any) {
	mergeTaskRoutingMetadata(payload, metadata)
	if tools := util.AsMapSlice(metadata["tools"]); len(tools) > 0 {
		payload["tools"] = tools
	}
	if choice, ok := metadata["tool_choice"]; ok && choice != nil {
		payload["tool_choice"] = choice
	}
}

func (s *ImageTaskService) submitImageWithMetadataAndOptions(ctx context.Context, identity Identity, clientTaskID, prompt, model, size, quality, baseURL string, n int, metadata map[string]any, mode string, images any, options ImageOutputOptions, toolOptions ImageToolOptions, visibilityValues ...string) (map[string]any, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	visibility, err := imageTaskVisibility(visibilityValues...)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{"prompt": prompt, "model": model, "n": normalizedImageTaskCount(n, model), "size": size, "quality": quality, "base_url": baseURL, "visibility": visibility}
	if images != nil {
		payload["images"] = images
	}
	mergeImageTaskMetadata(payload, metadata)
	mergeImageOutputOptions(payload, options)
	mergeImageToolOptions(payload, toolOptions)
	return s.submit(ctx, identity, clientTaskID, mode, payload)
}

func (s *ImageTaskService) ListTasksWithError(identity Identity, taskIDs []string) (map[string]any, error) {
	owner := ownerID(identity)
	requested := make([]string, 0, len(taskIDs))
	for _, id := range taskIDs {
		if id = strings.TrimSpace(id); id != "" {
			requested = append(requested, id)
		}
	}
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	recovered := s.recoverUnfinishedLocked()
	if s.cleanupLocked() || recovered {
		_ = s.saveWithRetryLocked()
	}
	items := make([]map[string]any, 0)
	missing := make([]string, 0)
	if len(requested) == 0 {
		for _, task := range s.tasks {
			if task["owner_id"] == owner {
				items = append(items, publicTask(task))
			}
		}
		sort.Slice(items, func(i, j int) bool { return util.Clean(items[i]["updated_at"]) > util.Clean(items[j]["updated_at"]) })
	} else {
		for _, id := range requested {
			task := s.tasks[taskKey(owner, id)]
			if task == nil {
				missing = append(missing, id)
			} else {
				items = append(items, publicTask(task))
			}
		}
	}
	s.mu.Unlock()
	return map[string]any{"items": items, "missing_ids": missing}, nil
}

func (s *ImageTaskService) CancelTask(identity Identity, clientTaskID string) (map[string]any, error) {
	taskID := strings.TrimSpace(clientTaskID)
	if taskID == "" {
		return nil, fmt.Errorf("client_task_id is required")
	}
	key := taskKey(ownerID(identity), taskID)
	var cancel context.CancelFunc
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if s.recoverUnfinishedLocked() {
		_ = s.saveWithRetryLocked()
	}
	task := s.tasks[key]
	if task == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("creation task not found")
	}
	if isActiveTaskStatus(util.Clean(task["status"])) {
		task["status"] = TaskStatusCancelled
		task["error"] = "任务已终止"
		mode := util.Clean(task["mode"])
		if mode == "generate" || mode == "edit" {
			task["output_statuses"] = cancelledImageOutputStatuses(task)
		}
		if task["data"] == nil {
			task["data"] = []any{}
		}
		bumpImageTaskRevision(task)
		cancel = s.cancels[key]
		delete(s.cancels, key)
		saveErr := s.saveWithRetryLocked()
		result := publicTask(task)
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if saveErr != nil {
			return result, ImageTaskPersistenceError{Err: saveErr, TaskStarted: true}
		}
		return result, nil
	}
	result := publicTask(task)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return result, nil
}

// DeleteTasks permanently removes terminal tasks owned by the caller. Active
// tasks are deliberately preserved so clearing history cannot interrupt work.
func (s *ImageTaskService) DeleteTasks(identity Identity, taskIDs []string) (map[string]any, error) {
	owner := ownerID(identity)
	requested := make([]string, 0, len(taskIDs))
	seen := make(map[string]struct{}, len(taskIDs))
	for _, id := range taskIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		requested = append(requested, id)
	}
	if len(requested) == 0 {
		return map[string]any{"deleted_ids": []string{}, "active_ids": []string{}, "missing_ids": []string{}}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		return nil, ImageTaskLoadError{Err: err}
	}

	deleted := make([]string, 0, len(requested))
	active := make([]string, 0)
	missing := make([]string, 0)
	deletedAt := util.NowISO()
	for _, id := range requested {
		key := taskKey(owner, id)
		task := s.tasks[key]
		if task == nil {
			missing = append(missing, id)
			continue
		}
		if isActiveTaskStatus(util.Clean(task["status"])) {
			active = append(active, id)
			continue
		}
		delete(s.tasks, key)
		s.deletedTasks[key] = deletedAt
		deleted = append(deleted, id)
	}
	if len(deleted) > 0 {
		if err := s.saveWithRetryLocked(); err != nil {
			return nil, ImageTaskPersistenceError{Err: err, TaskStarted: true}
		}
	}
	return map[string]any{"deleted_ids": deleted, "active_ids": active, "missing_ids": missing}, nil
}

func (s *ImageTaskService) submit(ctx context.Context, identity Identity, clientTaskID, mode string, payload map[string]any) (map[string]any, error) {
	taskID := strings.TrimSpace(clientTaskID)
	if taskID == "" {
		return nil, fmt.Errorf("client_task_id is required")
	}
	owner := ownerID(identity)
	key := taskKey(owner, taskID)
	now := util.NowISO()
	s.mu.Lock()
	if s.stopping || s.closed {
		s.mu.Unlock()
		return nil, ErrImageTaskServiceClosed
	}
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if err := s.refreshTasksLocked(); err != nil {
		s.mu.Unlock()
		return nil, ImageTaskLoadError{Err: err}
	}
	if s.recoverUnfinishedLocked() {
		_ = s.saveWithRetryLocked()
	}
	cleaned := s.cleanupLocked()
	if existing := s.tasks[key]; existing != nil {
		if cleaned {
			_ = s.saveWithRetryLocked()
		}
		result := publicTask(existing)
		s.mu.Unlock()
		return result, nil
	}
	count := taskCount(mode, payload)
	submittedAt := time.Now()
	if err := s.checkUserTaskLimitsLocked(identity, owner, submittedAt); err != nil {
		if cleaned {
			_ = s.saveWithRetryLocked()
		}
		s.mu.Unlock()
		return nil, err
	}
	taskCtx, cancel := context.WithCancel(context.Background())
	outputFormat := normalizeOptionalImageOutputFormat(util.Clean(payload["output_format"]))
	task := map[string]any{"id": taskID, "owner_id": owner, "status": TaskStatusQueued, "mode": mode, "model": firstNonEmpty(util.Clean(payload["model"]), util.ImageModelAuto), "size": util.Clean(payload["size"]), "quality": util.Clean(payload["quality"]), "visibility": util.Clean(payload["visibility"]), "count": count, "revision": 1, "created_at": now, "updated_at": now}
	if mode == "video" {
		for _, key := range []string{"seconds", "resolution", "generate_audio", "watermark"} {
			if payload[key] != nil {
				task[key] = payload[key]
			}
		}
		if timeoutSeconds := util.ToInt(payload[VideoTaskTimeoutSecondsPayloadKey], 0); timeoutSeconds > 0 {
			task[VideoTaskTimeoutSecondsPayloadKey] = timeoutSeconds
		}
	} else if mode == "audio" {
		for _, key := range []string{"voice", "response_format", "speed", "instructions"} {
			if payload[key] != nil {
				task[key] = payload[key]
			}
		}
	}
	if workflowContext := util.StringMap(payload["workflow_context"]); len(workflowContext) > 0 {
		task["workflow_context"] = workflowContext
	}
	if outputFormat != "" {
		task["output_format"] = outputFormat
	}
	if mode == "generate" || mode == "edit" {
		task["output_statuses"] = initialImageOutputStatuses(count)
	}
	if SupportsImageOutputCompression(outputFormat) {
		if compression, ok := normalizedImageOutputCompressionValue(payload["output_compression"]); ok {
			task["output_compression"] = compression
		}
	}
	mergePublicImageToolTaskFields(task, payload)
	s.tasks[key] = task
	s.cancels[key] = cancel
	existing, inserted, err := s.persistNewTaskLocked(key)
	if err != nil {
		delete(s.tasks, key)
		delete(s.cancels, key)
		s.rollbackUserSubmitTimeLocked(owner, submittedAt)
		s.mu.Unlock()
		cancel()
		return nil, ImageTaskPersistenceError{Err: err}
	}
	if !inserted {
		delete(s.cancels, key)
		s.rollbackUserSubmitTimeLocked(owner, submittedAt)
		result := publicTask(existing)
		s.mu.Unlock()
		cancel()
		return result, nil
	}
	result := publicTask(s.tasks[key])
	s.taskWorkers.Add(1)
	s.startRemoteMonitorLocked()
	s.mu.Unlock()
	go func() {
		defer s.taskWorkers.Done()
		s.runTask(taskCtx, key, mode, identity, payload)
	}()
	return result, nil
}

func (s *ImageTaskService) runTask(ctx context.Context, key, mode string, identity Identity, payload map[string]any) {
	defer s.removeTaskCancel(key)
	runCtx, cancel := context.WithTimeout(ctx, s.taskTimeout(mode, payload))
	defer cancel()

	handler := s.generation
	if mode == "edit" {
		handler = s.edit
	} else if mode == "chat" {
		handler = s.chat
	} else if mode == "video" {
		handler = s.video
	} else if mode == "audio" {
		handler = s.audio
	}
	if mode == "generate" || mode == "edit" {
		payload[imageOutputCallbackPayloadKey] = func(data []map[string]any) {
			if len(data) == 0 {
				return
			}
			s.updateImageTaskPartialData(key, data)
		}
		payload[imageOutputSlotAcquirerPayloadKey] = func(ctx context.Context, index int) (func(), error) {
			units := 1
			if index <= 0 {
				units = taskCount(mode, payload)
			}
			release, err := s.AcquireCreationUnits(ctx, identity, units)
			if err != nil {
				return nil, err
			}
			if !s.activateImageTaskOutput(key, index) {
				release()
				return nil, context.Canceled
			}
			return release, nil
		}
	} else if mode == "chat" || mode == "video" || mode == "audio" {
		release, err := s.AcquireCreationUnit(runCtx, identity)
		if err != nil {
			status := TaskStatusError
			message := err.Error()
			if ctx.Err() != nil {
				status = TaskStatusCancelled
				message = "任务已终止"
			} else if runCtx.Err() == context.DeadlineExceeded {
				if mode == "video" {
					message = "视频生成超时，请稍后重试"
				} else if mode == "audio" {
					message = "音频生成超时，请稍后重试"
				} else {
					message = "图片生成超时，请稍后重试或降低分辨率"
				}
			}
			s.updateActiveTask(key, map[string]any{"status": status, "error": message, "data": []any{}})
			return
		}
		if mode != "video" && !s.ensureTaskRunning(key) {
			release()
			return
		}
		if mode == "video" {
			payload[VideoTaskProgressCallbackPayloadKey] = func(update VideoTaskProgressUpdate) {
				s.updateVideoTaskProgress(key, update)
			}
		}
		payload[TextOutputCallbackPayloadKey] = func(text string) {
			if strings.TrimSpace(text) == "" {
				return
			}
			s.updateTextTaskPartialData(key, text)
		}
		defer release()
	}
	if handler == nil {
		s.updateActiveTask(key, map[string]any{"status": TaskStatusError, "error": "任务处理器未配置", "data": []any{}})
		return
	}
	result, err := handler(runCtx, identity, payload)
	completionRelease, _ := payload[ImageOutputCompletionReleasePayloadKey].(func())
	if completionRelease != nil {
		defer func() {
			s.waitForPersistence(imageTaskPersistenceWaitTimeout)
			completionRelease()
		}()
	}
	if err != nil {
		status := TaskStatusError
		message := err.Error()
		if ctx.Err() != nil {
			status = TaskStatusCancelled
			message = "任务已终止"
		} else if runCtx.Err() == context.DeadlineExceeded {
			if mode == "video" {
				message = "视频生成超时，请稍后重试"
			} else if mode == "audio" {
				message = "音频生成超时，请稍后重试"
			} else {
				message = "图片生成超时，请稍后重试或降低分辨率"
			}
		}
		data := taskResultData(result)
		outputType := util.Clean(result["output_type"])
		if outputType == "text" && len(data) == 0 && ctx.Err() == nil && runCtx.Err() != context.DeadlineExceeded {
			if text := util.Clean(result["message"]); text != "" {
				data = []map[string]any{{"text_response": text}}
				status = TaskStatusSuccess
				message = ""
			}
		}
		updates := map[string]any{"status": status, "error": message, "data": data}
		if outputType != "" {
			updates["output_type"] = outputType
		}
		if mode == "generate" || mode == "edit" {
			updates["output_statuses"] = finalImageOutputStatuses(taskCount(mode, payload), data, status)
		}
		s.updateActiveTask(key, updates)
		return
	}
	data := util.AsMapSlice(result["data"])
	outputType := util.Clean(result["output_type"])
	if outputType == "text" && len(data) == 0 {
		if text := util.Clean(result["message"]); text != "" {
			data = []map[string]any{{"text_response": text}}
		}
	}
	if len(data) == 0 {
		fallback := "任务没有返回图片数据，请检查上游返回、模型参数和日志详情"
		if mode == "video" {
			fallback = "视频任务没有返回可播放结果，请检查上游返回和日志详情"
		} else if mode == "audio" {
			fallback = "音频任务没有返回可播放结果，请检查上游返回和日志详情"
		}
		message := firstNonEmpty(util.Clean(result["message"]), fallback)
		updates := map[string]any{"status": TaskStatusError, "error": message, "data": []any{}}
		if mode == "generate" || mode == "edit" {
			updates["output_statuses"] = finalImageOutputStatuses(taskCount(mode, payload), nil, TaskStatusError)
		}
		if outputType != "" {
			updates["output_type"] = outputType
		}
		s.updateActiveTask(key, updates)
		return
	}
	updates := map[string]any{"status": TaskStatusSuccess, "data": data, "error": ""}
	if mode == "generate" || mode == "edit" {
		updates["output_statuses"] = finalImageOutputStatuses(taskCount(mode, payload), data, TaskStatusError)
	}
	if outputType != "" {
		updates["output_type"] = outputType
	}
	s.updateActiveTask(key, updates)
}

func finalImageOutputStatuses(count int, data []map[string]any, status string) []string {
	statuses := initialImageOutputStatuses(count)
	if len(statuses) == 0 {
		return statuses
	}
	fallback := status
	if fallback != TaskStatusCancelled {
		fallback = TaskStatusError
	}
	for index := range statuses {
		statuses[index] = fallback
	}
	for index, item := range data {
		if index >= len(statuses) {
			break
		}
		if hasImageTaskOutputData(item) {
			statuses[index] = TaskStatusSuccess
		}
	}
	return statuses
}

func cancelledImageOutputStatuses(task map[string]any) []string {
	count := storedImageOutputCount(task)
	statuses := normalizedImageOutputStatuses(util.Clean(task["mode"]), count, task["output_statuses"])
	for index, status := range statuses {
		if isActiveTaskStatus(status) {
			statuses[index] = TaskStatusCancelled
		}
	}
	return statuses
}

func (s *ImageTaskService) taskTimeout(mode string, payload map[string]any) time.Duration {
	timeout := defaultImageTaskTimeout
	if s.taskTimeoutGetter == nil {
		return videoTaskTimeoutOverride(mode, payload, timeout)
	}
	if configured := s.taskTimeoutGetter(); configured > 0 {
		timeout = configured
	}
	return videoTaskTimeoutOverride(mode, payload, timeout)
}

func videoTaskTimeoutOverride(mode string, payload map[string]any, fallback time.Duration) time.Duration {
	if mode != "video" {
		return fallback
	}
	seconds := util.ToInt(payload[VideoTaskTimeoutSecondsPayloadKey], 0)
	if seconds <= 0 {
		return fallback
	}
	required := time.Duration(seconds) * time.Second
	if required > fallback {
		return required
	}
	return fallback
}

func (s *ImageTaskService) checkUserTaskLimitsLocked(identity Identity, owner string, now time.Time) error {
	if identity.Role != AuthRoleUser {
		return nil
	}
	if limit := s.userRPMLimitValue(); limit > 0 {
		cutoff := now.Add(-time.Minute)
		times := s.ownerSubmitTimes[owner]
		kept := times[:0]
		for _, item := range times {
			if item.After(cutoff) {
				kept = append(kept, item)
			}
		}
		if len(kept) >= limit {
			s.ownerSubmitTimes[owner] = kept
			return ImageTaskLimitError{Message: fmt.Sprintf("用户 RPM 速率限制已达到（每分钟最多 %d 次）", limit)}
		}
		s.ownerSubmitTimes[owner] = append(kept, now)
	}
	return nil
}

func (s *ImageTaskService) rollbackUserSubmitTimeLocked(owner string, submittedAt time.Time) {
	times := s.ownerSubmitTimes[owner]
	if len(times) == 0 || !times[len(times)-1].Equal(submittedAt) {
		return
	}
	times = times[:len(times)-1]
	if len(times) == 0 {
		delete(s.ownerSubmitTimes, owner)
		return
	}
	s.ownerSubmitTimes[owner] = times
}

func (s *ImageTaskService) userConcurrentLimitValue() int {
	if s.userConcurrentLimit == nil {
		return 0
	}
	limit := s.userConcurrentLimit()
	if limit < 1 {
		return 0
	}
	return limit
}

func (s *ImageTaskService) AcquireCreationUnit(ctx context.Context, identity Identity) (func(), error) {
	return s.AcquireCreationUnits(ctx, identity, 1)
}

func (s *ImageTaskService) AcquireCreationUnits(ctx context.Context, identity Identity, units int) (func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if units < 1 {
		units = 1
	}
	if units > defaultGlobalImageTaskConcurrentUnits {
		return nil, ImageTaskLimitError{Message: fmt.Sprintf("任务需要 %d 个并发额度，超过系统并发上限 %d", units, defaultGlobalImageTaskConcurrentUnits)}
	}
	limitOwner := identity.Role == AuthRoleUser
	owner := ownerID(identity)
	stopContextWake := context.AfterFunc(ctx, func() {
		s.mu.Lock()
		s.creationUnitCond.Broadcast()
		s.mu.Unlock()
	})
	defer stopContextWake()
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		if s.stopping || s.closed {
			return nil, ErrImageTaskServiceClosed
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		limit := 0
		if limitOwner {
			limit = s.userConcurrentLimitValue()
		}
		if limitOwner && limit > 0 && units > limit {
			return nil, ImageTaskLimitError{Message: fmt.Sprintf("任务需要 %d 个并发额度，超过用户并发上限 %d", units, limit)}
		}
		ownerAvailable := !limitOwner || limit <= 0 || s.ownerRunningUnits[owner]+units <= limit
		globalAvailable := s.globalRunningUnits+units <= defaultGlobalImageTaskConcurrentUnits
		if ownerAvailable && globalAvailable {
			s.globalRunningUnits += units
			if limitOwner {
				s.ownerRunningUnits[owner] += units
			}
			released := false
			return func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if released {
					return
				}
				released = true
				if s.globalRunningUnits <= units {
					s.globalRunningUnits = 0
				} else {
					s.globalRunningUnits -= units
				}
				if limitOwner {
					if s.ownerRunningUnits[owner] <= units {
						delete(s.ownerRunningUnits, owner)
					} else {
						s.ownerRunningUnits[owner] -= units
					}
				}
				s.creationUnitCond.Broadcast()
			}, nil
		}
		s.creationUnitCond.Wait()
	}
}

func (s *ImageTaskService) ensureTaskRunning(key string) bool {
	return s.activateTaskRunning(key, 0, false)
}

func (s *ImageTaskService) activateImageTaskOutput(key string, index int) bool {
	return s.activateTaskRunning(key, index, true)
}

func (s *ImageTaskService) activateTaskRunning(key string, outputIndex int, activateImageOutput bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.refreshTasksLocked()
	task := s.tasks[key]
	if task == nil {
		return false
	}
	status := util.Clean(task["status"])
	if status != TaskStatusQueued && status != TaskStatusRunning {
		return false
	}
	count := storedImageOutputCount(task)
	statuses := normalizedImageOutputStatuses(util.Clean(task["mode"]), count, task["output_statuses"])
	if activateImageOutput && len(statuses) > 0 {
		if outputIndex > count {
			return false
		}
	}
	changed := false
	becameRunning := false
	if status == TaskStatusQueued {
		task["status"] = TaskStatusRunning
		task["error"] = ""
		changed = true
		becameRunning = true
	}
	if activateImageOutput && len(statuses) > 0 {
		if outputIndex <= 0 {
			for index := range statuses {
				if statuses[index] == TaskStatusQueued {
					statuses[index] = TaskStatusRunning
					changed = true
				}
			}
		} else if isActiveTaskStatus(statuses[outputIndex-1]) && statuses[outputIndex-1] != TaskStatusRunning {
			statuses[outputIndex-1] = TaskStatusRunning
			changed = true
		}
	}
	if !changed {
		return true
	}
	if len(statuses) > 0 {
		task["output_statuses"] = statuses
	}
	bumpImageTaskRevision(task)
	if becameRunning {
		_ = s.saveWithRetryLocked()
	}
	return true
}

func (s *ImageTaskService) userRPMLimitValue() int {
	if s.userRPMLimit == nil {
		return 0
	}
	limit := s.userRPMLimit()
	if limit < 1 {
		return 0
	}
	return limit
}

func (s *ImageTaskService) updateActiveTask(key string, updates map[string]any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.refreshTasksLocked()
	task := s.tasks[key]
	if task == nil {
		return false
	}
	if !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	for k, v := range updates {
		task[k] = v
	}
	bumpImageTaskRevision(task)
	_ = s.saveWithRetryLocked()
	return true
}

func (s *ImageTaskService) updateVideoTaskProgress(key string, update VideoTaskProgressUpdate) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.refreshTasksLocked()
	task := s.tasks[key]
	if task == nil || util.Clean(task["mode"]) != "video" || !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	changed := false
	currentStatus := util.Clean(task["status"])
	if update.Status == TaskStatusRunning && currentStatus != TaskStatusRunning {
		task["status"] = TaskStatusRunning
		task["error"] = ""
		changed = true
	}
	if upstreamStatus := strings.TrimSpace(update.UpstreamStatus); upstreamStatus != "" && util.Clean(task["upstream_status"]) != upstreamStatus {
		task["upstream_status"] = upstreamStatus
		changed = true
	}
	if update.HasProgress {
		progress := update.Progress
		if progress < 0 {
			progress = 0
		} else if progress > 100 {
			progress = 100
		}
		if util.ToInt(task["progress"], -1) != progress {
			task["progress"] = progress
			changed = true
		}
	}
	if !changed {
		return true
	}
	bumpImageTaskRevision(task)
	_ = s.saveWithRetryLocked()
	return true
}

func (s *ImageTaskService) updateImageTaskPartialData(key string, data []map[string]any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.tasks[key]
	if task == nil || !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	mergedData, dataChanged := mergeImageTaskPartialData(util.AsMapSlice(task["data"]), data)
	count := storedImageOutputCount(task)
	statuses := normalizedImageOutputStatuses(util.Clean(task["mode"]), count, task["output_statuses"])
	statusesChanged := false
	for index, item := range mergedData {
		if index >= len(statuses) {
			break
		}
		if hasImageTaskOutputData(item) && isActiveTaskStatus(statuses[index]) {
			statuses[index] = "success"
			statusesChanged = true
		}
	}
	if !dataChanged && !statusesChanged {
		return true
	}
	if dataChanged {
		task["data"] = mergedData
	}
	if statusesChanged {
		task["output_statuses"] = statuses
	}
	bumpImageTaskRevision(task)
	return true
}

func (s *ImageTaskService) updateTextTaskPartialData(key, text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.tasks[key]
	if task == nil || !isActiveTaskStatus(util.Clean(task["status"])) {
		return false
	}
	currentData := util.AsMapSlice(task["data"])
	if util.Clean(task["output_type"]) == "text" && len(currentData) == 1 && util.Clean(currentData[0]["text_response"]) == text {
		return true
	}
	task["output_type"] = "text"
	task["data"] = []map[string]any{{"text_response": text}}
	bumpImageTaskRevision(task)
	return true
}

func (s *ImageTaskService) removeTaskCancel(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cancels, key)
}

func (s *ImageTaskService) loadLocked() (map[string]map[string]any, error) {
	raw, err := loadStoredJSON(s.store, s.docName)
	if err != nil {
		return map[string]map[string]any{}, err
	}
	if obj, ok := raw.(map[string]any); ok {
		for _, item := range util.AsMapSlice(obj["deleted_tasks"]) {
			id := util.Clean(item["id"])
			owner := util.Clean(item["owner_id"])
			if id == "" || owner == "" {
				continue
			}
			key := taskKey(owner, id)
			deletedAt := firstNonEmpty(util.Clean(item["deleted_at"]), util.NowISO())
			if current := s.deletedTasks[key]; current == "" || parseTaskTime(deletedAt).After(parseTaskTime(current)) {
				s.deletedTasks[key] = deletedAt
			}
		}
		raw = obj["tasks"]
	}
	tasks := map[string]map[string]any{}
	for _, item := range anyList(raw) {
		task, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := util.Clean(task["id"])
		owner := util.Clean(task["owner_id"])
		if id == "" || owner == "" {
			continue
		}
		status := util.Clean(task["status"])
		if status != TaskStatusQueued && status != TaskStatusRunning && status != TaskStatusSuccess && status != TaskStatusError && status != TaskStatusCancelled {
			status = TaskStatusError
		}
		mode := "generate"
		if task["mode"] == "edit" {
			mode = "edit"
		} else if task["mode"] == "chat" {
			mode = "chat"
		} else if task["mode"] == "video" {
			mode = "video"
		} else if task["mode"] == "audio" {
			mode = "audio"
		}
		count := taskCount(mode, task)
		visibility, _ := NormalizeImageVisibility(util.Clean(task["visibility"]))
		outputFormat := normalizeOptionalImageOutputFormat(util.Clean(task["output_format"]))
		revision := util.ToInt(task["revision"], 1)
		if revision < 1 {
			revision = 1
		}
		now := util.NowISO()
		normalized := map[string]any{"id": id, "owner_id": owner, "status": status, "mode": mode, "model": firstNonEmpty(util.Clean(task["model"]), util.ImageModelAuto), "size": util.Clean(task["size"]), "quality": util.Clean(task["quality"]), "visibility": visibility, "count": count, "revision": revision, "created_at": firstNonEmpty(util.Clean(task["created_at"]), now), "updated_at": firstNonEmpty(util.Clean(task["updated_at"]), util.Clean(task["created_at"]), now)}
		mergeMediaTaskFields(normalized, task, mode)
		if workflowContext := util.StringMap(task["workflow_context"]); len(workflowContext) > 0 {
			normalized["workflow_context"] = workflowContext
		}
		if outputFormat != "" {
			normalized["output_format"] = outputFormat
		}
		if SupportsImageOutputCompression(outputFormat) {
			if compression, ok := normalizedImageOutputCompressionValue(task["output_compression"]); ok {
				normalized["output_compression"] = compression
			}
		}
		if data := util.AsMapSlice(task["data"]); data != nil {
			normalized["data"] = data
		}
		if statuses := normalizedImageOutputStatuses(mode, count, task["output_statuses"]); len(statuses) > 0 {
			normalized["output_statuses"] = statuses
		}
		if errText := util.Clean(task["error"]); errText != "" {
			normalized["error"] = errText
		}
		if outputType := util.Clean(task["output_type"]); outputType != "" {
			normalized["output_type"] = outputType
		}
		key := taskKey(owner, id)
		if _, deleted := s.deletedTasks[key]; !deleted {
			tasks[key] = normalized
		}
	}
	return tasks, nil
}

func (s *ImageTaskService) ensureLoadedLocked() error {
	if s.loadErr == nil {
		return nil
	}
	tasks, err := s.loadLocked()
	if err != nil {
		s.loadErr = err
		return err
	}
	s.tasks = tasks
	s.loadErr = nil
	recovered := s.recoverUnfinishedLocked()
	if s.cleanupLocked() || recovered {
		_ = s.saveWithRetryLocked()
	}
	return nil
}

func (s *ImageTaskService) refreshTasksLocked() error {
	remoteTasks, err := s.loadLocked()
	if err != nil {
		return err
	}
	s.tasks = mergeImageTaskMaps(remoteTasks, s.tasks)
	return nil
}

func (s *ImageTaskService) startRemoteMonitorLocked() {
	if s.store == nil || s.remoteMonitorRunning || s.stopping || s.closed {
		return
	}
	s.remoteMonitorRunning = true
	s.remoteMonitorWorkers.Add(1)
	go func() {
		defer s.remoteMonitorWorkers.Done()
		s.monitorRemoteCancellations()
	}()
}

func (s *ImageTaskService) monitorRemoteCancellations() {
	ticker := time.NewTicker(imageTaskRemotePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.persistenceStop:
			s.mu.Lock()
			s.remoteMonitorRunning = false
			s.mu.Unlock()
			return
		case <-ticker.C:
		}
		s.mu.Lock()
		if s.stopping || s.closed || len(s.cancels) == 0 {
			s.remoteMonitorRunning = false
			s.mu.Unlock()
			return
		}
		remoteTasks, err := s.loadLocked()
		if err != nil {
			s.mu.Unlock()
			continue
		}
		s.tasks = mergeImageTaskMaps(remoteTasks, s.tasks)
		cancels := make([]context.CancelFunc, 0)
		for key, cancel := range s.cancels {
			remoteTask := remoteTasks[key]
			if remoteTask != nil && isActiveTaskStatus(util.Clean(remoteTask["status"])) {
				continue
			}
			delete(s.cancels, key)
			cancels = append(cancels, cancel)
		}
		s.mu.Unlock()
		for _, cancel := range cancels {
			cancel()
		}
	}
}

func (s *ImageTaskService) saveLocked() error {
	err := s.persistLocked()
	if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
		return err
	}

	remoteTasks, loadErr := s.loadLocked()
	if loadErr != nil {
		return fmt.Errorf("reload image tasks after concurrent update: %w", loadErr)
	}
	s.tasks = mergeImageTaskMaps(remoteTasks, s.tasks)
	s.cleanupLocked()
	return s.persistLocked()
}

// persistNewTaskLocked claims a client task ID through the shared task document.
// A concurrent writer that already persisted the same owner/task pair wins the
// claim; this instance returns that task without starting a duplicate request.
func (s *ImageTaskService) persistNewTaskLocked(key string) (map[string]any, bool, error) {
	for attempt := 0; attempt < imageTaskInsertMaxAttempts; attempt++ {
		err := s.persistLocked()
		if err == nil {
			s.persistenceDirty = false
			return nil, true, nil
		}
		if !errors.Is(err, storage.ErrConcurrentRowUpdate) {
			s.markPersistenceDirtyLocked()
			return nil, false, err
		}

		remoteTasks, loadErr := s.loadLocked()
		if loadErr != nil {
			s.markPersistenceDirtyLocked()
			return nil, false, fmt.Errorf("reload image tasks while claiming task: %w", loadErr)
		}
		localTasks := s.tasks
		s.tasks = remoteTasks
		s.cleanupLocked()
		remoteTasks = s.tasks
		s.tasks = localTasks

		if existing := remoteTasks[key]; existing != nil {
			localWithoutClaim := make(map[string]map[string]any, len(localTasks))
			for localKey, task := range localTasks {
				if localKey != key {
					localWithoutClaim[localKey] = task
				}
			}
			s.tasks = mergeImageTaskMaps(remoteTasks, localWithoutClaim)
			s.cleanupLocked()
			return s.tasks[key], false, nil
		}

		s.tasks = mergeImageTaskMaps(remoteTasks, localTasks)
		s.cleanupLocked()
	}

	err := fmt.Errorf("%w: claim image task %q after %d attempts", storage.ErrConcurrentRowUpdate, key, imageTaskInsertMaxAttempts)
	s.markPersistenceDirtyLocked()
	return nil, false, err
}

func (s *ImageTaskService) persistLocked() error {
	items := make([]map[string]any, 0, len(s.tasks))
	for _, task := range s.tasks {
		item := util.CopyMap(task)
		// Active data can contain multi-megabyte base64 previews; the terminal transition persists final output.
		status := util.Clean(item["status"])
		if isActiveTaskStatus(status) {
			delete(item, "data")
		} else if data, ok := item["data"]; ok {
			if normalized := util.AsMapSlice(data); normalized != nil {
				item["data"] = imageTaskDataForPersistence(normalized)
			} else {
				delete(item, "data")
			}
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return util.Clean(items[i]["updated_at"]) > util.Clean(items[j]["updated_at"]) })
	deletedItems := make([]map[string]any, 0, len(s.deletedTasks))
	for key, deletedAt := range s.deletedTasks {
		separator := strings.LastIndex(key, ":")
		if separator < 1 || separator == len(key)-1 {
			continue
		}
		owner, id := key[:separator], key[separator+1:]
		deletedItems = append(deletedItems, map[string]any{"owner_id": owner, "id": id, "deleted_at": deletedAt})
	}
	sort.Slice(deletedItems, func(i, j int) bool {
		return util.Clean(deletedItems[i]["deleted_at"]) > util.Clean(deletedItems[j]["deleted_at"])
	})
	value := map[string]any{"tasks": items, "deleted_tasks": deletedItems}
	if s.store != nil {
		return s.store.SaveJSONDocument(s.docName, value)
	}
	return fmt.Errorf("storage document backend is required")
}

func mergeImageTaskMaps(remote, local map[string]map[string]any) map[string]map[string]any {
	merged := make(map[string]map[string]any, len(remote)+len(local))
	for key, task := range remote {
		merged[key] = util.CopyMap(task)
	}
	for key, task := range local {
		previous := merged[key]
		if previous == nil || imageTaskSnapshotNewer(task, previous) {
			merged[key] = util.CopyMap(task)
		}
	}
	return merged
}

func imageTaskSnapshotNewer(candidate, current map[string]any) bool {
	candidateTerminal := !isActiveTaskStatus(util.Clean(candidate["status"]))
	currentTerminal := !isActiveTaskStatus(util.Clean(current["status"]))
	if candidateTerminal != currentTerminal {
		return candidateTerminal
	}
	candidateRevision := int64(util.ToInt(candidate["revision"], 0))
	currentRevision := int64(util.ToInt(current["revision"], 0))
	if candidateRevision != currentRevision {
		return candidateRevision > currentRevision
	}
	candidateUpdatedAt := parseTaskTime(candidate["updated_at"])
	currentUpdatedAt := parseTaskTime(current["updated_at"])
	if !candidateUpdatedAt.Equal(currentUpdatedAt) {
		return candidateUpdatedAt.After(currentUpdatedAt)
	}
	// The caller's snapshot contains the mutation that triggered this save.
	return true
}

// saveWithRetryLocked performs the foreground write and ensures that a transient
// failure is retried by at most one service-level worker. The worker always
// serializes the latest in-memory state instead of replaying a stale snapshot.
func (s *ImageTaskService) saveWithRetryLocked() error {
	if s.closed {
		return ErrImageTaskServiceClosed
	}
	err := s.saveLocked()
	if err == nil {
		s.persistenceDirty = false
		return nil
	}
	s.markPersistenceDirtyLocked()
	return err
}

func (s *ImageTaskService) markPersistenceDirtyLocked() {
	s.persistenceDirty = true
	if s.store != nil && !s.persistenceRetrying && !s.stopping {
		s.persistenceRetrying = true
		s.persistenceWorkers.Add(1)
		go func() {
			defer s.persistenceWorkers.Done()
			s.retryPersistence()
		}()
	}
}

func (s *ImageTaskService) retryPersistence() {
	delay := imageTaskPersistenceRetryInitialDelay
	for {
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-s.persistenceStop:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			s.mu.Lock()
			s.persistenceRetrying = false
			s.mu.Unlock()
			return
		}

		s.mu.Lock()
		if s.stopping || s.closed || !s.persistenceDirty {
			s.persistenceRetrying = false
			s.mu.Unlock()
			return
		}
		err := s.saveLocked()
		if err == nil {
			s.persistenceDirty = false
			s.persistenceRetrying = false
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()

		if delay < imageTaskPersistenceRetryMaxDelay {
			delay *= 2
			if delay > imageTaskPersistenceRetryMaxDelay {
				delay = imageTaskPersistenceRetryMaxDelay
			}
		}
	}
}

func (s *ImageTaskService) waitForPersistence(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		s.mu.RLock()
		dirty := s.persistenceDirty
		stopping := s.stopping
		s.mu.RUnlock()
		if !dirty {
			return true
		}
		if stopping {
			return false
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}
		delay := imageTaskPersistenceWaitPollInterval
		if remaining < delay {
			delay = remaining
		}
		timer := time.NewTimer(delay)
		<-timer.C
	}
}

func imageTaskDataForPersistence(data []map[string]any) []map[string]any {
	result := make([]map[string]any, len(data))
	for index, item := range data {
		if item == nil || isImageTaskPreviewData(item) {
			// Preserve the output slot without retaining a potentially large preview.
			result[index] = map[string]any{}
			continue
		}
		result[index] = util.CopyMap(item)
		delete(result[index], "preview")
	}
	return result
}

func (s *ImageTaskService) recoverUnfinishedLocked() bool {
	changed := false
	now := time.Now()
	for _, task := range s.tasks {
		cutoff := now.Add(-s.taskTimeout(util.Clean(task["mode"]), task) - imageTaskRecoveryGrace)
		if (task["status"] == TaskStatusQueued || task["status"] == TaskStatusRunning) && parseTaskTime(task["updated_at"]).Before(cutoff) {
			task["status"] = TaskStatusError
			task["error"] = "服务已重启或任务执行实例已失联，未完成的任务已中断"
			mode := util.Clean(task["mode"])
			if mode == "generate" || mode == "edit" {
				task["output_statuses"] = finalImageOutputStatuses(storedImageOutputCount(task), nil, TaskStatusError)
			}
			bumpImageTaskRevision(task)
			changed = true
		}
	}
	return changed
}

func (s *ImageTaskService) cleanupLocked() bool {
	days := 30
	if s.retentionGetter != nil {
		days = s.retentionGetter()
	}
	if days < 1 {
		days = 1
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	removed := false
	for key, task := range s.tasks {
		status := task["status"]
		if status != TaskStatusSuccess && status != TaskStatusError && status != TaskStatusCancelled {
			continue
		}
		if parseTaskTime(task["updated_at"]).Before(cutoff) {
			delete(s.tasks, key)
			removed = true
		}
	}
	for key, deletedAt := range s.deletedTasks {
		if parseTaskTime(deletedAt).Before(cutoff) {
			delete(s.deletedTasks, key)
			removed = true
		}
	}
	return removed
}

func mergeMediaTaskFields(target, source map[string]any, mode string) {
	if mode == "video" {
		for _, key := range []string{"seconds", "resolution", "generate_audio", "watermark"} {
			if source[key] != nil {
				target[key] = source[key]
			}
		}
		if upstreamStatus := strings.TrimSpace(util.Clean(source["upstream_status"])); upstreamStatus != "" {
			target["upstream_status"] = upstreamStatus
		}
		if progress := util.ToInt(source["progress"], -1); progress >= 0 && progress <= 100 {
			target["progress"] = progress
		}
		return
	}
	if mode == "audio" {
		for _, key := range []string{"voice", "response_format", "speed", "instructions"} {
			if source[key] != nil {
				target[key] = source[key]
			}
		}
	}
}

func publicTask(task map[string]any) map[string]any {
	mode := util.Clean(task["mode"])
	item := map[string]any{"id": task["id"], "status": task["status"], "mode": task["mode"], "model": task["model"], "size": task["size"], "count": taskCount(mode, task), "revision": task["revision"], "created_at": task["created_at"], "updated_at": task["updated_at"]}
	if quality := util.Clean(task["quality"]); quality != "" {
		item["quality"] = quality
	}
	if format := normalizeOptionalImageOutputFormat(util.Clean(task["output_format"])); format != "" {
		item["output_format"] = format
	}
	if SupportsImageOutputCompression(util.Clean(item["output_format"])) {
		if compression, ok := normalizedImageOutputCompressionValue(task["output_compression"]); ok {
			item["output_compression"] = compression
		}
	}
	mergePublicImageToolTaskFields(item, task)
	mergeMediaTaskFields(item, task, mode)
	if workflowContext := util.StringMap(task["workflow_context"]); len(workflowContext) > 0 {
		item["workflow_context"] = workflowContext
	}
	if statuses := util.AsStringSlice(task["output_statuses"]); len(statuses) > 0 {
		item["output_statuses"] = append([]string(nil), statuses...)
	}
	if task["data"] != nil {
		item["data"] = task["data"]
	}
	if util.Clean(task["error"]) != "" {
		item["error"] = task["error"]
	}
	if util.Clean(task["output_type"]) != "" {
		item["output_type"] = task["output_type"]
	}
	if visibility := util.Clean(task["visibility"]); visibility != "" {
		item["visibility"] = visibility
	}
	return item
}

func imageTaskVisibility(values ...string) (string, error) {
	if len(values) == 0 {
		return ImageVisibilityPrivate, nil
	}
	return NormalizeImageVisibility(values[0])
}

func ownerID(identity Identity) string {
	if owner := util.Clean(identity.OwnerID); owner != "" {
		return owner
	}
	if id := util.Clean(identity.ID); id != "" {
		return id
	}
	return "anonymous"
}

func taskKey(owner, id string) string {
	return owner + ":" + id
}

func normalizedImageTaskCount(n int, model string) int {
	if n < 1 {
		return 1
	}
	limit := util.MaxImageOutputCount(model)
	if n > limit {
		return limit
	}
	return n
}

func imageTaskCount(payload map[string]any) int {
	model := util.Clean(payload["model"])
	if payload["n"] == nil {
		return normalizedImageTaskCount(util.ToInt(payload["count"], 1), model)
	}
	return normalizedImageTaskCount(util.ToInt(payload["n"], 1), model)
}

func taskCount(mode string, payload map[string]any) int {
	return imageTaskCount(payload)
}

func storedImageOutputCount(task map[string]any) int {
	return imageTaskCount(task)
}

func initialImageOutputStatuses(count int) []string {
	if count < 1 {
		count = 1
	}
	statuses := make([]string, count)
	for index := range statuses {
		statuses[index] = "queued"
	}
	return statuses
}

func normalizedImageOutputStatuses(mode string, count int, value any) []string {
	if mode != "generate" && mode != "edit" {
		return nil
	}
	if count < 1 {
		count = 1
	}
	source := util.AsStringSlice(value)
	statuses := make([]string, count)
	for index := range statuses {
		status := "queued"
		if index < len(source) {
			switch source[index] {
			case TaskStatusQueued, TaskStatusRunning, TaskStatusSuccess, TaskStatusError, TaskStatusCancelled:
				status = source[index]
			}
		}
		statuses[index] = status
	}
	return statuses
}

func hasImageTaskOutputData(item map[string]any) bool {
	if item == nil || isImageTaskPreviewData(item) {
		return false
	}
	return util.Clean(item["b64_json"]) != "" || util.Clean(item["url"]) != "" || util.Clean(item["text_response"]) != ""
}

func isImageTaskPreviewData(item map[string]any) bool {
	return item != nil && util.ToBool(item["preview"])
}

func mergeImageTaskMetadata(payload map[string]any, metadata map[string]any) {
	if len(metadata) == 0 {
		return
	}
	mergeTaskRoutingMetadata(payload, metadata)
	if workflowContext := util.StringMap(metadata["workflow_context"]); len(workflowContext) > 0 {
		payload["workflow_context"] = workflowContext
	}
	if source := NormalizeImageGenerationSource(util.Clean(metadata["generation_source"])); source != "" {
		payload["generation_source"] = source
	}
	if apiMode := strings.ToLower(strings.TrimSpace(util.Clean(metadata["api_mode"]))); apiMode == "images" || apiMode == "responses" || apiMode == "chat" {
		payload["api_mode"] = apiMode
	}
	if preset := NormalizeImageResolutionPreset(util.Clean(metadata["image_resolution"])); preset != "" {
		payload["image_resolution"] = preset
	}
	if requestedSize := strings.TrimSpace(util.Clean(metadata["requested_size"])); requestedSize != "" {
		payload["requested_size"] = requestedSize
	}
	for _, key := range []string{"aspect_ratio", "ratio"} {
		if value := strings.TrimSpace(util.Clean(metadata[key])); value != "" {
			payload[key] = value
		}
	}
	if util.ToBool(metadata["share_prompt_parameters"]) {
		payload["share_prompt_parameters"] = true
		if util.ToBool(metadata["share_reference_images"]) {
			payload["share_reference_images"] = true
		}
	}
	if conversationID := util.Clean(metadata["frontend_conversation_id"]); conversationID != "" {
		payload["frontend_conversation_id"] = conversationID
	}
	if fallback := normalizedFallbackReferenceImage(metadata["fallback_reference_image"]); len(fallback) > 0 {
		payload["fallback_reference_image"] = fallback
	}
}

func normalizedFallbackReferenceImage(value any) map[string]any {
	raw := util.StringMap(value)
	if len(raw) == 0 {
		return nil
	}
	fallback := map[string]any{}
	for _, key := range []string{"path", "url", "b64_json", "outputFormat"} {
		if text := strings.TrimSpace(util.Clean(raw[key])); text != "" {
			fallback[key] = text
		}
	}
	return fallback
}

func mergeTaskRoutingMetadata(payload map[string]any, metadata map[string]any) {
	if snapshot, ok := metadata["video_contract_snapshot"]; ok && snapshot != nil {
		payload["video_contract_snapshot"] = snapshot
	}
	if timeoutSeconds := util.ToInt(metadata[VideoTaskTimeoutSecondsPayloadKey], 0); timeoutSeconds > 0 {
		payload[VideoTaskTimeoutSecondsPayloadKey] = timeoutSeconds
	}
	if tokenGroup := strings.TrimSpace(util.Clean(metadata["token_group"])); tokenGroup != "" {
		payload["token_group"] = tokenGroup
	}
	if tokenName := strings.TrimSpace(util.Clean(metadata["token_name"])); tokenName != "" {
		payload["token_name"] = tokenName
	}
	if generationMode := strings.TrimSpace(util.Clean(metadata["generation_mode"])); generationMode != "" {
		payload["generation_mode"] = generationMode
	}
	for _, key := range []string{"provider", "image_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		if value := strings.TrimSpace(util.Clean(metadata[key])); value != "" {
			payload[key] = value
		}
	}
	for _, key := range []string{"first_frame_url", "last_frame_url"} {
		if value := strings.TrimSpace(util.Clean(metadata[key])); value != "" {
			payload[key] = value
		}
	}
	for _, key := range []string{"preset", "mode"} {
		if value, ok := metadata[key]; ok {
			payload[key] = value
		}
	}
}

func mergeImageOutputOptions(payload map[string]any, options ImageOutputOptions) {
	if strings.TrimSpace(options.Format) == "" {
		delete(payload, "output_format")
		delete(payload, "output_compression")
		return
	}
	format := NormalizeImageOutputFormat(options.Format)
	if format == "" {
		return
	}
	payload["output_format"] = format
	if !SupportsImageOutputCompression(format) || options.Compression == nil {
		delete(payload, "output_compression")
		return
	}
	compression := *options.Compression
	if compression < 0 {
		compression = 0
	} else if compression > 100 {
		compression = 100
	}
	payload["output_compression"] = compression
}

func mergeImageToolOptions(payload map[string]any, options ImageToolOptions) {
	for key, value := range map[string]string{
		"moderation":       NormalizeImageModeration(options.Moderation),
		"input_image_mask": options.InputImageMask,
	} {
		if strings.TrimSpace(value) != "" {
			payload[key] = strings.TrimSpace(value)
		}
	}
	if options.Stream {
		payload["stream"] = true
		partialImages := 1
		if options.PartialImagesSet || options.PartialImages != 0 {
			partialImages = options.PartialImages
		}
		if partialImages >= 0 && partialImages <= 3 {
			payload["partial_images"] = partialImages
		}
	}
	if strings.EqualFold(strings.TrimSpace(options.ResponseFormat), "b64_json") {
		payload["response_format"] = "b64_json"
	}
}

func mergePublicImageToolTaskFields(target, source map[string]any) {
	for _, key := range []string{"moderation"} {
		if value := util.Clean(source[key]); value != "" {
			target[key] = value
		}
	}
	if util.ToBool(source["stream"]) {
		target["stream"] = true
		if partialImages, ok := normalizedPublicImagePartialImages(source["partial_images"]); ok {
			target["partial_images"] = partialImages
		}
	}
}

func NormalizeImageOutputFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", "png":
		return "png"
	case "jpg", "jpeg":
		return "jpeg"
	case "webp":
		return "webp"
	default:
		return "png"
	}
}

func normalizeOptionalImageOutputFormat(format string) string {
	if strings.TrimSpace(format) == "" {
		return ""
	}
	return NormalizeImageOutputFormat(format)
}

func SupportsImageOutputCompression(format string) bool {
	format = NormalizeImageOutputFormat(format)
	return format == "jpeg" || format == "webp"
}

func NormalizeImageModeration(moderation string) string {
	switch strings.ToLower(strings.TrimSpace(moderation)) {
	case "auto", "low":
		return strings.ToLower(strings.TrimSpace(moderation))
	default:
		return ""
	}
}

func normalizedPublicImagePartialImages(value any) (int, bool) {
	partialImages := util.ToInt(value, 0)
	if partialImages < 0 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func normalizedImageOutputCompressionValue(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression := util.ToInt(value, -1)
	if compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func taskResultData(result map[string]any) []map[string]any {
	if result == nil {
		return []map[string]any{}
	}
	data := util.AsMapSlice(result["data"])
	if data == nil {
		return []map[string]any{}
	}
	return cloneTaskData(data)
}

func cloneTaskData(items []map[string]any) []map[string]any {
	if len(items) == 0 {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item == nil {
			out = append(out, map[string]any{})
			continue
		}
		out = append(out, util.CopyMap(item))
	}
	return out
}

func mergeImageTaskPartialData(current, incoming []map[string]any) ([]map[string]any, bool) {
	targetLen := len(current)
	for index, item := range incoming {
		if imageTaskPartialItemHasValue(item) && index+1 > targetLen {
			targetLen = index + 1
		}
	}
	if targetLen == 0 {
		return cloneTaskData(current), false
	}

	merged := cloneTaskData(current)
	for len(merged) < targetLen {
		merged = append(merged, map[string]any{})
	}
	changed := len(merged) != len(current)
	for index, item := range incoming {
		if index >= len(merged) || !imageTaskPartialItemHasValue(item) {
			continue
		}
		if merged[index] == nil {
			merged[index] = map[string]any{}
		}
		incomingPreview := isImageTaskPreviewData(item)
		if incomingPreview && hasImageTaskOutputData(merged[index]) {
			// A delayed preview must never replace a completed output.
			continue
		}
		if !incomingPreview && hasImageTaskOutputData(item) {
			if _, exists := merged[index]["preview"]; exists {
				delete(merged[index], "preview")
				changed = true
			}
		}
		for key, value := range item {
			if key == "preview" && !incomingPreview {
				continue
			}
			if !imageTaskPartialValuePresent(value) {
				continue
			}
			if reflect.DeepEqual(merged[index][key], value) {
				continue
			}
			merged[index][key] = value
			changed = true
		}
	}
	return merged, changed
}

func imageTaskPartialItemHasValue(item map[string]any) bool {
	for _, value := range item {
		if imageTaskPartialValuePresent(value) {
			return true
		}
	}
	return false
}

func imageTaskPartialValuePresent(value any) bool {
	if value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}

func bumpImageTaskRevision(task map[string]any) {
	if task == nil {
		return
	}
	revision := int64(util.ToInt(task["revision"], 0))
	if revision < 0 {
		revision = 0
	}
	nextRevision := revision + 1
	if clockRevision := time.Now().UTC().UnixMicro(); clockRevision > nextRevision {
		nextRevision = clockRevision
	}
	task["revision"] = nextRevision
	task["updated_at"] = util.NowISO()
}

func isActiveTaskStatus(status string) bool {
	return status == TaskStatusQueued || status == TaskStatusRunning
}

func parseTaskTime(value any) time.Time {
	text := util.Clean(value)
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05.999999", "2006-01-02T15:04:05", time.RFC3339Nano} {
		if t, err := time.Parse(layout, text); err == nil {
			return t
		}
	}
	return time.Unix(0, 0)
}
