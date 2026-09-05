package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
	"chatgpt2api/internal/videocontract"
	"golang.org/x/net/html"
)

const (
	maxVideoContractDocumentBytes      = 8 << 20
	maxVideoContractDocumentCharacters = 180_000
	maxVideoContractImportJSONBytes    = 2 << 20
	videoContractDocumentFetchTimeout  = 45 * time.Second
	videoContractGenerationAttempts    = 3
	videoContractUpstreamAttempts      = 3
	videoContractImportProgressType    = "application/x-ndjson"
	videoContractImportHeartbeat       = 5 * time.Second
)

type videoModelContractMutation struct {
	Contract   protocol.VideoModelContract `json:"contract"`
	Enabled    bool                        `json:"enabled"`
	ExistingID string                      `json:"existing_id"`
}

type videoModelContractPreviewRequest struct {
	Contract       protocol.VideoModelContract `json:"contract"`
	ExistingID     string                      `json:"existing_id"`
	Input          map[string]any              `json:"input"`
	SubmitResponse map[string]any              `json:"submit_response"`
	QueryResponse  map[string]any              `json:"query_response"`
}

type videoModelContractTransferDocument struct {
	Version   int                                        `json:"version"`
	Contracts []videocontract.ImportedVideoModelContract `json:"contracts"`
}

type managedVideoModelContractResponse struct {
	ID             string                       `json:"id"`
	Contract       protocol.VideoModelContract  `json:"contract"`
	Draft          *protocol.VideoModelContract `json:"draft,omitempty"`
	DraftEnabled   *bool                        `json:"draft_enabled,omitempty"`
	Enabled        bool                         `json:"enabled"`
	Revision       int                          `json:"revision"`
	CreatedAt      string                       `json:"created_at"`
	UpdatedAt      string                       `json:"updated_at"`
	DraftUpdatedAt string                       `json:"draft_updated_at,omitempty"`
}

func (a *App) handleAdminVideoModelContracts(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}
	base := "/api/admin/video-model-contracts"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			a.writeAdminVideoModelContracts(w, nil)
		case http.MethodPost:
			body, bodyOK := decodeVideoModelContractMutation(w, r)
			if !bodyOK {
				return
			}
			item, err := a.videoContracts.Create(body.Contract, body.Enabled)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			a.writeAdminVideoModelContracts(w, &item)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	if r.URL.Path == base+"/import" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		a.handleVideoModelContractImport(w, r, identity)
		return
	}
	if r.URL.Path == base+"/import-json" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		a.handleVideoModelContractJSONImport(w, r)
		return
	}
	if r.URL.Path == base+"/preview" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		a.handleVideoModelContractPreview(w, r)
		return
	}

	parts := splitPath(r.URL.Path)
	if (len(parts) != 4 && len(parts) != 5) || parts[0] != "api" || parts[1] != "admin" || parts[2] != "video-model-contracts" {
		http.NotFound(w, r)
		return
	}
	id := strings.TrimSpace(parts[3])
	if len(parts) == 5 {
		a.handleVideoModelContractAction(w, r, id, strings.TrimSpace(parts[4]))
		return
	}
	if id == "validate" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, bodyOK := decodeVideoModelContractMutation(w, r)
		if !bodyOK {
			return
		}
		contract, err := a.videoContracts.ValidateCandidate(body.ExistingID, body.Contract)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"valid": true, "contract": contract})
		return
	}

	switch r.Method {
	case http.MethodPut:
		body, bodyOK := decodeVideoModelContractMutation(w, r)
		if !bodyOK {
			return
		}
		item, err := a.videoContracts.Update(id, body.Contract, body.Enabled)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, item)
	case http.MethodPatch:
		body, bodyOK := decodeVideoModelContractMutation(w, r)
		if !bodyOK {
			return
		}
		item, err := a.videoContracts.SetEnabled(id, body.Enabled)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, item)
	case http.MethodDelete:
		deleted, err := a.videoContracts.Delete(id)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to delete video model contract")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, nil)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleVideoModelContractAction(w http.ResponseWriter, r *http.Request, id, action string) {
	switch action {
	case "draft":
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, ok := decodeVideoModelContractMutation(w, r)
		if !ok {
			return
		}
		item, err := a.videoContracts.SaveDraft(id, body.Contract, body.Enabled)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, item)
	case "publish":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, ok := decodeVideoModelContractMutation(w, r)
		if !ok {
			return
		}
		item, err := a.videoContracts.Publish(id, &body.Contract, &body.Enabled)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, item)
	case "versions":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		versions, err := a.videoContracts.Versions(id)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load video model contract versions")
			return
		}
		if versions == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"versions": versions})
	case "rollback":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Revision int `json:"revision"`
		}
		if err := decodeStrictJSON(r.Body, &body); err != nil || body.Revision < 1 {
			util.WriteError(w, http.StatusBadRequest, "invalid video model contract revision")
			return
		}
		item, err := a.videoContracts.Rollback(id, body.Revision)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "video model contract not found")
			return
		}
		a.writeAdminVideoModelContracts(w, item)
	default:
		http.NotFound(w, r)
	}
}

func (a *App) handleVideoModelContractPreview(w http.ResponseWriter, r *http.Request) {
	var body videoModelContractPreviewRequest
	if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 2<<20), &body); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid video model contract preview body")
		return
	}
	contract, err := a.videoContracts.ValidateCandidate(body.ExistingID, body.Contract)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	input := body.Input
	if input == nil {
		input = map[string]any{}
	}
	model := strings.TrimSpace(util.Clean(input["model"]))
	if model == "" {
		for _, candidate := range contract.Models {
			if !strings.Contains(candidate, "*") {
				model = candidate
				break
			}
		}
	}
	if model == "" || !protocol.VideoContractMatchesModel(contract, model) {
		util.WriteError(w, http.StatusBadRequest, "请输入能命中当前契约的示例模型 ID")
		return
	}
	input["model"] = model
	createPath, queryPath, err := videoContractDriverPaths(contract, input)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	result := map[string]any{
		"request": map[string]any{
			"method": "POST", "create_path": createPath, "query_path": queryPath,
			"body": declaredVideoContractRequestPayload(input, contract), "transport": contract.Transport,
		},
	}
	if len(body.SubmitResponse) > 0 {
		result["submit"] = map[string]any{
			"task_id": videoContractFirstString(body.SubmitResponse, contract.Polling.TaskIDFields),
			"error":   videoContractErrorMessage(body.SubmitResponse, contract),
		}
	}
	if len(body.QueryResponse) > 0 {
		status := videoRelayTaskStatusForContract(body.QueryResponse, contract)
		progress, hasProgress := videoContractProgressForContract(body.QueryResponse, contract)
		query := map[string]any{
			"status": status,
			"error":  videoContractErrorMessage(body.QueryResponse, contract),
		}
		if hasProgress {
			query["progress"] = progress
		}
		if status == "completed" && contract.Artifact.Mode == "response_url" {
			query["result_url"] = videoResultURLForContract(body.QueryResponse, "https://relay.example.com", contract)
		}
		result["query"] = query
	}
	util.WriteJSON(w, http.StatusOK, result)
}

func (a *App) handleVideoModelContractJSONImport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxVideoContractImportJSONBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var document videoModelContractTransferDocument
	if err := decoder.Decode(&document); err != nil {
		util.WriteError(w, http.StatusBadRequest, "导入文件不是有效的视频模型契约 JSON")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		util.WriteError(w, http.StatusBadRequest, "导入文件只能包含一个 JSON 对象")
		return
	}
	if document.Version != 4 {
		util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("不支持的契约导入版本 %d", document.Version))
		return
	}
	created, updated, err := a.videoContracts.Import(document.Contracts)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := a.videoContracts.List()
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load video model contracts")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"items": managedVideoModelContractResponses(items), "imported": created + updated, "created": created, "updated": updated,
	})
}

type videoContractImportSource struct {
	Type     string                     `json:"type"`
	Name     string                     `json:"name"`
	Warnings []string                   `json:"-"`
	Site     *videoContractDocumentSite `json:"-"`
}

type videoContractImportResponse struct {
	Contracts []protocol.VideoModelContract `json:"contracts"`
	Source    videoContractImportSource     `json:"source"`
	Warnings  []string                      `json:"warnings"`
	Model     string                        `json:"model"`
}

type videoContractImportProgressEvent struct {
	Stage              string                       `json:"stage"`
	Message            string                       `json:"message"`
	Attempt            int                          `json:"attempt,omitempty"`
	MaxAttempts        int                          `json:"max_attempts,omitempty"`
	RequestAttempt     int                          `json:"request_attempt,omitempty"`
	MaxRequestAttempts int                          `json:"max_request_attempts,omitempty"`
	ElapsedSeconds     int                          `json:"elapsed_seconds"`
	ReceivedCharacters int                          `json:"received_characters,omitempty"`
	Result             *videoContractImportResponse `json:"result,omitempty"`
}

type videoContractImportProgressWriter struct {
	encoder            *json.Encoder
	flusher            http.Flusher
	mu                 sync.Mutex
	startedAt          time.Time
	lastActivityAt     time.Time
	attempt            int
	maxAttempts        int
	requestAttempt     int
	maxRequestAttempts int
}

func newVideoContractImportProgressWriter(w http.ResponseWriter) *videoContractImportProgressWriter {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil
	}
	w.Header().Set("Content-Type", videoContractImportProgressType+"; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	now := time.Now()
	return &videoContractImportProgressWriter{encoder: json.NewEncoder(w), flusher: flusher, startedAt: now, lastActivityAt: now}
}

func (w *videoContractImportProgressWriter) write(event videoContractImportProgressEvent) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	if w.startedAt.IsZero() {
		w.startedAt = now
	}
	if w.lastActivityAt.IsZero() {
		w.lastActivityAt = now
	}
	event.ElapsedSeconds = max(event.ElapsedSeconds, int(now.Sub(w.startedAt).Seconds()))
	if event.Stage == "heartbeat" {
		event.Attempt = w.attempt
		event.MaxAttempts = w.maxAttempts
		event.RequestAttempt = w.requestAttempt
		event.MaxRequestAttempts = w.maxRequestAttempts
		waitingSeconds := max(1, int(now.Sub(w.lastActivityAt).Seconds()))
		event.Message = fmt.Sprintf("上游暂未返回新数据，已等待 %d 秒；本站连接正常", waitingSeconds)
	} else {
		w.lastActivityAt = now
		if event.Attempt > 0 {
			w.attempt = event.Attempt
			w.maxAttempts = event.MaxAttempts
		}
		if event.RequestAttempt > 0 {
			w.requestAttempt = event.RequestAttempt
			w.maxRequestAttempts = event.MaxRequestAttempts
		}
	}
	if err := w.encoder.Encode(event); err == nil {
		w.flusher.Flush()
	}
}

func (w *videoContractImportProgressWriter) startHeartbeat(ctx context.Context, interval time.Duration) func() {
	if w == nil {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				w.write(videoContractImportProgressEvent{Stage: "heartbeat", Message: "正在等待分析模型响应"})
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

func (a *App) handleVideoModelContractImport(w http.ResponseWriter, r *http.Request, identity service.Identity) {
	if r.ContentLength > maxVideoContractDocumentBytes+(1<<20) {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "文档不能超过 8 MB")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxVideoContractDocumentBytes+(1<<20))
	if err := r.ParseMultipartForm(maxVideoContractDocumentBytes + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "文档上传格式错误或文件超过 8 MB")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	sourceType := strings.ToLower(strings.TrimSpace(r.FormValue("source_type")))
	var (
		content  string
		source   videoContractImportSource
		warnings = make([]string, 0)
		err      error
	)
	switch sourceType {
	case "file":
		content, source, err = readVideoContractUpload(r)
	case "url":
		content, source, err = fetchVideoContractDocument(r.Context(), strings.TrimSpace(r.FormValue("url")))
	default:
		err = errors.New("请选择文档或链接")
	}
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	preferences, err := a.imagePreferences.Preferences(identityScope(identity))
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "读取个人模型设置失败")
		return
	}
	model := firstNonEmpty(strings.TrimSpace(r.FormValue("model")), preferences.DefaultTextModel, a.config.DefaultTextModel(), firstString(a.config.TextModels(), a.defaultChatModel()))
	if allowedPersonalModel(model, a.config.TextModels()) == "" {
		util.WriteError(w, http.StatusBadRequest, "文本模型不可用")
		return
	}
	tokenName := firstNonEmpty(strings.TrimSpace(r.FormValue("token_name")), firstString(preferences.DefaultTextRelayTokens, ""))
	var progressWriter *videoContractImportProgressWriter
	if strings.Contains(strings.ToLower(r.Header.Get("Accept")), videoContractImportProgressType) {
		progressWriter = newVideoContractImportProgressWriter(w)
		stopHeartbeat := progressWriter.startHeartbeat(r.Context(), videoContractImportHeartbeat)
		defer stopHeartbeat()
	}
	reportProgress := func(event videoContractImportProgressEvent) {
		progressWriter.write(event)
	}
	if source.Site != nil {
		reportProgress(videoContractImportProgressEvent{Stage: "planning_documents", Message: fmt.Sprintf("发现 %d 个候选页面，正在由分析模型选择契约所需文档", len(source.Site.links))})
		selected, planErr := a.planVideoContractDocumentPages(r.Context(), identity, model, tokenName, content, source.Site.links)
		if planErr != nil {
			if progressWriter != nil {
				progressWriter.write(videoContractImportProgressEvent{Stage: "failed", Message: planErr.Error()})
				return
			}
			a.writeCreationTaskSubmitError(w, planErr)
			return
		}
		reportProgress(videoContractImportProgressEvent{Stage: "reading_documents", Message: fmt.Sprintf("分析模型选择了 %d 个页面，正在读取文档正文", len(selected))})
		fetchCtx, cancelFetch := context.WithTimeout(r.Context(), videoContractDocumentFetchTimeout)
		content, source, err = fetchSelectedVideoContractDocuments(fetchCtx, content, source, selected, service.SafeMediaProxyHTTPClient())
		cancelFetch()
		if err != nil {
			if progressWriter != nil {
				progressWriter.write(videoContractImportProgressEvent{Stage: "failed", Message: err.Error()})
				return
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	warnings = append(warnings, source.Warnings...)
	content, truncated := truncateVideoContractDocument(content)
	if strings.TrimSpace(content) == "" {
		if progressWriter != nil {
			progressWriter.write(videoContractImportProgressEvent{Stage: "failed", Message: "文档中没有可分析的文本内容"})
			return
		}
		util.WriteError(w, http.StatusBadRequest, "文档中没有可分析的文本内容")
		return
	}
	if truncated {
		warnings = append(warnings, fmt.Sprintf("文档内容较长，仅分析了前 %d 个字符", maxVideoContractDocumentCharacters))
	}
	reportProgress(videoContractImportProgressEvent{
		Stage:   "document_ready",
		Message: fmt.Sprintf("文档读取完成，共 %d 个字符", utf8.RuneCountInString(content)),
	})
	contracts, err := a.generateVideoModelContracts(r.Context(), identity, model, tokenName, source, content, reportProgress)
	if err != nil {
		if progressWriter != nil {
			progressWriter.write(videoContractImportProgressEvent{Stage: "failed", Message: err.Error()})
			return
		}
		a.writeCreationTaskSubmitError(w, err)
		return
	}
	for _, contract := range contracts {
		warnings = append(warnings, a.videoContractImportConflictWarnings(contract)...)
	}
	response := videoContractImportResponse{Contracts: contracts, Source: source, Warnings: uniqueTrimmedWarningStrings(warnings), Model: model}
	if progressWriter != nil {
		progressWriter.write(videoContractImportProgressEvent{Stage: "completed", Message: fmt.Sprintf("已生成 %d 份契约草稿", len(contracts)), Result: &response})
		return
	}
	util.WriteJSON(w, http.StatusOK, response)
}

func readVideoContractUpload(r *http.Request) (string, videoContractImportSource, error) {
	if r.MultipartForm == nil {
		return "", videoContractImportSource{}, errors.New("请选择要分析的文档")
	}
	headers := r.MultipartForm.File["file"]
	if len(headers) != 1 {
		return "", videoContractImportSource{}, errors.New("请选择一个文档")
	}
	header := headers[0]
	if header.Size > maxVideoContractDocumentBytes {
		return "", videoContractImportSource{}, errors.New("文档不能超过 8 MB")
	}
	file, err := header.Open()
	if err != nil {
		return "", videoContractImportSource{}, errors.New("读取上传文档失败")
	}
	defer file.Close()
	data, err := readLimitedVideoContractDocument(file)
	if err != nil {
		return "", videoContractImportSource{}, err
	}
	name := filepath.Base(strings.TrimSpace(header.Filename))
	if name == "" || name == "." {
		name = "上传文档"
	}
	contentType := header.Header.Get("Content-Type")
	content, err := extractVideoContractDocument(data, name, contentType)
	return content, videoContractImportSource{Type: "file", Name: name}, err
}

func fetchVideoContractDocument(parent context.Context, value string) (string, videoContractImportSource, error) {
	if !isPublicReferenceURL(value) {
		return "", videoContractImportSource{}, errors.New("请输入公网可访问的 HTTP 或 HTTPS 链接")
	}
	ctx, cancel := context.WithTimeout(parent, videoContractDocumentFetchTimeout)
	defer cancel()
	return fetchVideoContractDocumentSet(ctx, value, service.SafeMediaProxyHTTPClient())
}

func readLimitedVideoContractDocument(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxVideoContractDocumentBytes+1))
	if err != nil {
		return nil, errors.New("读取文档内容失败")
	}
	if len(data) > maxVideoContractDocumentBytes {
		return nil, errors.New("文档不能超过 8 MB")
	}
	return data, nil
}

func videoContractDocumentResponseName(response *http.Response, parsed *url.URL) string {
	if disposition := response.Header.Get("Content-Disposition"); disposition != "" {
		if _, params, err := mime.ParseMediaType(disposition); err == nil {
			if name := filepath.Base(strings.TrimSpace(params["filename"])); name != "" && name != "." {
				return name
			}
		}
	}
	if parsed != nil {
		if name := filepath.Base(strings.TrimSpace(parsed.Path)); name != "" && name != "." && name != "/" {
			return name
		}
		return parsed.Hostname()
	}
	return "链接文档"
}

func extractVideoContractDocument(data []byte, name, rawContentType string) (string, error) {
	extension := strings.ToLower(filepath.Ext(name))
	contentType, _, _ := mime.ParseMediaType(rawContentType)
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if extension == ".pdf" || contentType == "application/pdf" {
		return "", errors.New("暂不支持 PDF，请转换为 DOCX、TXT、Markdown、JSON、YAML 或提供网页链接")
	}
	if extension == ".docx" || contentType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		return extractDOCXText(data)
	}
	if extension == ".html" || extension == ".htm" || contentType == "text/html" || contentType == "application/xhtml+xml" {
		return extractHTMLText(data)
	}
	if isSupportedVideoContractTextDocument(extension, contentType) {
		if !utf8.Valid(data) {
			return "", errors.New("文档不是有效的 UTF-8 文本")
		}
		return strings.TrimSpace(string(data)), nil
	}
	return "", errors.New("不支持该文档格式，请使用 DOCX、TXT、Markdown、JSON、YAML 或 HTML")
}

func isSupportedVideoContractTextDocument(extension, contentType string) bool {
	switch extension {
	case ".txt", ".md", ".markdown", ".json", ".yaml", ".yml":
		return true
	}
	return strings.HasPrefix(contentType, "text/") || contentType == "application/json" || contentType == "application/yaml" || contentType == "application/x-yaml"
}

func extractDOCXText(data []byte) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", errors.New("DOCX 文档格式无效")
	}
	var text strings.Builder
	for _, entry := range archive.File {
		name := strings.ToLower(entry.Name)
		if name != "word/document.xml" && !strings.HasPrefix(name, "word/header") && !strings.HasPrefix(name, "word/footer") && name != "word/footnotes.xml" && name != "word/endnotes.xml" {
			continue
		}
		reader, openErr := entry.Open()
		if openErr != nil {
			return "", errors.New("读取 DOCX 文本失败")
		}
		decodeErr := appendWordprocessingText(&text, io.LimitReader(reader, maxVideoContractDocumentBytes+1))
		_ = reader.Close()
		if decodeErr != nil {
			return "", errors.New("读取 DOCX 文本失败")
		}
		if text.Len() > maxVideoContractDocumentBytes {
			return "", errors.New("DOCX 解压后的文本过大")
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		return "", errors.New("DOCX 文档中没有可读取的文本")
	}
	return strings.TrimSpace(text.String()), nil
}

func appendWordprocessingText(output *strings.Builder, reader io.Reader) error {
	decoder := xml.NewDecoder(reader)
	inText := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "t":
				inText = true
			case "tab":
				output.WriteByte('\t')
			case "br", "cr":
				output.WriteByte('\n')
			}
		case xml.EndElement:
			if value.Name.Local == "t" {
				inText = false
			}
			if value.Name.Local == "p" {
				output.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				output.Write(value)
			}
		}
	}
}

func extractHTMLText(data []byte) (string, error) {
	document, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("HTML 文档格式无效")
	}
	var text strings.Builder
	var walk func(*html.Node, bool)
	walk = func(node *html.Node, skipped bool) {
		if node.Type == html.ElementNode {
			switch strings.ToLower(node.Data) {
			case "script", "style", "noscript", "svg", "canvas":
				skipped = true
			case "br", "p", "div", "section", "article", "header", "footer", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6":
				if !skipped {
					text.WriteByte('\n')
				}
			}
		}
		if node.Type == html.TextNode && !skipped {
			value := strings.Join(strings.Fields(node.Data), " ")
			if value != "" {
				text.WriteString(value)
				text.WriteByte(' ')
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child, skipped)
		}
	}
	walk(document, false)
	return strings.TrimSpace(text.String()), nil
}

func truncateVideoContractDocument(content string) (string, bool) {
	content = strings.TrimSpace(content)
	if utf8.RuneCountInString(content) <= maxVideoContractDocumentCharacters {
		return content, false
	}
	runes := []rune(content)
	return strings.TrimSpace(string(runes[:maxVideoContractDocumentCharacters])), true
}

func (a *App) generateVideoModelContracts(ctx context.Context, identity service.Identity, model, tokenName string, source videoContractImportSource, content string, reportProgress func(videoContractImportProgressEvent)) ([]protocol.VideoModelContract, error) {
	userMessage := "文档名称：" + source.Name + "\n\n<document>\n" + content + "\n</document>"
	messages := []map[string]any{
		{"role": "system", "content": videoContractImportSystemPrompt},
		{"role": "user", "content": userMessage},
	}
	payload := map[string]any{
		"model":                 model,
		"messages":              messages,
		"temperature":           0.1,
		"max_completion_tokens": 12_288,
		"response_format":       videoContractImportResponseFormat(),
		"stream":                true,
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "gpt-5") {
		payload["reasoning_effort"] = "low"
	}
	if tokenName != "" {
		payload["token_name"] = tokenName
	}
	ctx, _ = protocol.WithAccountUsageTracker(ctx)
	start := time.Now()
	model = strings.TrimSpace(model)
	requestCapture := auditRequestCapture{args: map[string]any{
		"model":       model,
		"source_type": source.Type,
		"source_name": source.Name,
		"characters":  utf8.RuneCountInString(content),
	}}
	reportProgress(videoContractImportProgressEvent{Stage: "preparing", Message: "正在解析个人文本 Key 并选择上游 API"})
	if err := a.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
		a.logCall(ctx, identity, "视频契约文档分析", http.MethodPost, "/api/admin/video-model-contracts/import", model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), nil, requestCapture)
		return nil, err
	}
	upstreamName := "已配置的上游 API"
	if parsed, parseErr := url.Parse(a.relayBaseURLFromPayload(payload)); parseErr == nil && parsed.Hostname() != "" {
		upstreamName = parsed.Hostname()
	}
	reportProgress(videoContractImportProgressEvent{
		Stage:   "preparing",
		Message: fmt.Sprintf("已选择模型 %s，使用 %s，目标上游 %s", model, firstNonEmpty(tokenName, "默认文本 Key"), upstreamName),
	})
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	var lastGenerationError error
	for attempt := 0; attempt < videoContractGenerationAttempts; attempt++ {
		payload["messages"] = messages
		var result map[string]any
		var relayErr error
		for requestAttempt := 0; requestAttempt < videoContractUpstreamAttempts; requestAttempt++ {
			receivedCharacters := 0
			lastReportedCharacters := 0
			lastReportedAt := time.Time{}
			payload[service.TextOutputCallbackPayloadKey] = func(text string) {
				receivedCharacters = utf8.RuneCountInString(text)
				now := time.Now()
				if lastReportedCharacters > 0 && receivedCharacters-lastReportedCharacters < 256 && now.Sub(lastReportedAt) < time.Second {
					return
				}
				lastReportedCharacters = receivedCharacters
				lastReportedAt = now
				reportProgress(videoContractImportProgressEvent{
					Stage: "receiving", Message: fmt.Sprintf("正在接收第 %d 轮模型输出，已收到 %d 个字符", attempt+1, receivedCharacters),
					Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
					RequestAttempt: requestAttempt + 1, MaxRequestAttempts: videoContractUpstreamAttempts,
					ReceivedCharacters: receivedCharacters,
				})
			}
			reportProgress(videoContractImportProgressEvent{
				Stage: "generating", Message: fmt.Sprintf("第 %d 轮请求已发送，正在等待上游返回首个数据块", attempt+1),
				Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
				RequestAttempt: requestAttempt + 1, MaxRequestAttempts: videoContractUpstreamAttempts,
			})
			var stream *protocol.StreamResult
			result, stream, relayErr = a.relayChatCompletions(ctx, payload)
			if stream != nil {
				reportProgress(videoContractImportProgressEvent{
					Stage: "upstream_connected", Message: "上游流式连接已建立，正在接收模型输出",
					Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
					RequestAttempt: requestAttempt + 1, MaxRequestAttempts: videoContractUpstreamAttempts,
				})
				result, relayErr = collectRelayChatTaskStream(payload, stream)
			}
			if relayErr == nil {
				break
			}
			relayErr = normalizeVideoContractRelayError(relayErr)
			if !retryableVideoContractRelayError(relayErr) || requestAttempt+1 >= videoContractUpstreamAttempts {
				break
			}
			reportProgress(videoContractImportProgressEvent{
				Stage: "retrying", Message: fmt.Sprintf("上游请求失败：%s；正在自动重试", relayErr.Error()),
				Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
				RequestAttempt: requestAttempt + 2, MaxRequestAttempts: videoContractUpstreamAttempts,
			})
		}
		if relayErr != nil {
			a.logCall(ctx, identity, "视频契约文档分析", http.MethodPost, "/api/admin/video-model-contracts/import", model, start, "failed", protocolErrorHTTPStatus(relayErr), relayErr.Error(), nil, requestCapture)
			return nil, relayErr
		}
		data := chatCompletionTaskData(result)
		text := strings.TrimSpace(util.Clean(data["text_response"]))
		reportProgress(videoContractImportProgressEvent{
			Stage: "validating", Message: fmt.Sprintf("第 %d 轮输出接收完成，共 %d 个字符；正在校验 JSON 与契约字段", attempt+1, utf8.RuneCountInString(text)),
			Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
			ReceivedCharacters: utf8.RuneCountInString(text),
		})
		if text == "" {
			lastGenerationError = errors.New("模型没有返回契约 JSON")
		} else {
			contracts, decodeErr := decodeGeneratedVideoModelContracts(text, content)
			if decodeErr == nil {
				a.logCall(ctx, identity, "视频契约文档分析", http.MethodPost, "/api/admin/video-model-contracts/import", model, start, "success", http.StatusOK, "", nil, requestCapture)
				return contracts, nil
			}
			lastGenerationError = decodeErr
		}
		if attempt+1 < videoContractGenerationAttempts {
			repairMessage := "首次提取未通过业务校验：" + lastGenerationError.Error() + "。重新阅读原始文档，只修正该错误及其关联字段，并返回完整的 contracts 对象。不要复用首次输出，不要增加文档未明确出现的模型或能力。"
			reportProgress(videoContractImportProgressEvent{
				Stage: "repairing", Message: fmt.Sprintf("第 %d 轮校验未通过：%s；正在把错误反馈给模型", attempt+1, lastGenerationError.Error()),
				Attempt: attempt + 1, MaxAttempts: videoContractGenerationAttempts,
			})
			messages = append(messages, map[string]any{
				"role":    "user",
				"content": repairMessage,
			})
		}
	}
	err := protocol.HTTPError{Status: http.StatusBadGateway, Message: lastGenerationError.Error()}
	a.logCall(ctx, identity, "视频契约文档分析", http.MethodPost, "/api/admin/video-model-contracts/import", model, start, "failed", http.StatusBadGateway, err.Error(), nil, requestCapture)
	return nil, err
}

func normalizeVideoContractRelayError(err error) error {
	if err == nil {
		return nil
	}
	status := protocolErrorHTTPStatus(err)
	message := strings.ToLower(strings.TrimSpace(err.Error()))
	if status == 524 || strings.Contains(message, "origin web server did not respond to cloudflare") {
		return protocol.HTTPError{Status: 524, Message: "上游 API 在 Cloudflare 允许时间内没有返回数据（HTTP 524）"}
	}
	return err
}

func retryableVideoContractRelayError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	status := protocolErrorHTTPStatus(err)
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= http.StatusInternalServerError
}

func decodeGeneratedVideoModelContracts(content, sourceDocument string) ([]protocol.VideoModelContract, error) {
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end < start {
		return nil, errors.New("模型返回内容不是有效的契约集合 JSON，请重试")
	}
	jsonContent := content[start : end+1]
	decoder := json.NewDecoder(strings.NewReader(jsonContent))
	decoder.DisallowUnknownFields()
	var document struct {
		Contracts []json.RawMessage `json:"contracts"`
	}
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("模型返回的契约集合无效: %s，请重试", describeVideoContractJSONError(err))
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("模型返回了多个 JSON 对象，请重试")
	}
	if len(document.Contracts) == 0 {
		return nil, errors.New("模型返回的契约集合为空，请重试")
	}
	if len(document.Contracts) > 100 {
		return nil, errors.New("模型返回的契约数量超过 100 份，请重试")
	}

	contracts := make([]protocol.VideoModelContract, 0, len(document.Contracts))
	problems := make([]string, 0)
	for index, raw := range document.Contracts {
		normalizedRaw, err := normalizeGeneratedVideoContractRuleMaps(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("第 %d 份契约无效: %s", index+1, err.Error()))
			continue
		}
		contract, err := decodeGeneratedVideoModelContractJSON(normalizedRaw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("第 %d 份契约无效: %s", index+1, err.Error()))
			continue
		}
		modelMissing := false
		for _, model := range contract.Models {
			if !videoModelIDAppearsInDocument(sourceDocument, model) {
				problems = append(problems, fmt.Sprintf("第 %d 份契约的模型 %q 未在原始文档中出现，请删除臆造模型", index+1, model))
				modelMissing = true
			}
		}
		if modelMissing {
			continue
		}
		contracts = append(contracts, contract)
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "；"))
	}
	contracts = mergeEquivalentGeneratedVideoModelContracts(contracts)
	if err := protocol.ValidateVideoContracts(contracts); err != nil {
		return nil, fmt.Errorf("生成的契约集合存在冲突: %w", err)
	}
	return contracts, nil
}

func mergeEquivalentGeneratedVideoModelContracts(contracts []protocol.VideoModelContract) []protocol.VideoModelContract {
	merged := make([]protocol.VideoModelContract, 0, len(contracts))
	for _, contract := range contracts {
		comparison := contract
		comparison.Name = ""
		comparison.Models = nil
		mergedIntoExisting := false
		for index := range merged {
			existingComparison := merged[index]
			existingComparison.Name = ""
			existingComparison.Models = nil
			if !reflect.DeepEqual(existingComparison, comparison) {
				continue
			}
			seen := make(map[string]struct{}, len(merged[index].Models))
			for _, model := range merged[index].Models {
				seen[strings.ToLower(model)] = struct{}{}
			}
			additional := 0
			for _, model := range contract.Models {
				if _, ok := seen[strings.ToLower(model)]; !ok {
					additional++
				}
			}
			if len(merged[index].Models)+additional > 20 {
				continue
			}
			for _, model := range contract.Models {
				modelKey := strings.ToLower(model)
				if _, ok := seen[modelKey]; ok {
					continue
				}
				seen[modelKey] = struct{}{}
				merged[index].Models = append(merged[index].Models, model)
			}
			mergedIntoExisting = true
			break
		}
		if !mergedIntoExisting {
			merged = append(merged, contract)
		}
	}
	return merged
}

func videoModelIDAppearsInDocument(document, model string) bool {
	document = strings.ToLower(document)
	model = strings.ToLower(strings.TrimSpace(model))
	if model == "" {
		return false
	}
	for offset := 0; offset <= len(document)-len(model); {
		index := strings.Index(document[offset:], model)
		if index < 0 {
			return false
		}
		index += offset
		beforeOK := index == 0 || !isVideoModelIDByte(document[index-1])
		after := index + len(model)
		afterOK := after == len(document) || !isVideoModelIDByte(document[after])
		if beforeOK && afterOK {
			return true
		}
		offset = index + 1
	}
	return false
}

func isVideoModelIDByte(value byte) bool {
	return value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9' ||
		value == '.' || value == '_' || value == '-' || value == '/' || value == ':'
}

func decodeGeneratedVideoModelContractJSON(data []byte) (protocol.VideoModelContract, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return protocol.VideoModelContract{}, errors.New(describeVideoContractJSONError(err))
	}
	for _, field := range []string{
		"name", "models", "priority", "driver", "transport", "artifact",
		"capability", "validation", "generation", "rules", "request", "polling",
	} {
		value := bytes.TrimSpace(fields[field])
		if len(value) == 0 || bytes.Equal(value, []byte("null")) {
			return protocol.VideoModelContract{}, fmt.Errorf("缺少新版字段 %s", field)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var contract protocol.VideoModelContract
	if err := decoder.Decode(&contract); err != nil {
		return protocol.VideoModelContract{}, errors.New(describeVideoContractJSONError(err))
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return protocol.VideoModelContract{}, errors.New("契约中包含多个 JSON 对象")
	}
	contract = normalizeGeneratedVideoContractRuleUI(contract)
	contract = normalizeGeneratedVideoContractModeMaterials(contract)
	normalized, err := protocol.NormalizeVideoModelContract(contract)
	if err != nil {
		return protocol.VideoModelContract{}, fmt.Errorf("未通过校验: %w", err)
	}
	return normalized, nil
}

func normalizeGeneratedVideoContractRuleUI(contract protocol.VideoModelContract) protocol.VideoModelContract {
	for index := range contract.Rules {
		ruleUI := &contract.Rules[index].UI
		hidden := make(map[string]struct{}, len(ruleUI.Hide))
		for _, field := range ruleUI.Hide {
			hidden[strings.ToLower(strings.TrimSpace(field))] = struct{}{}
		}
		filtered := ruleUI.Disable[:0]
		for _, field := range ruleUI.Disable {
			if _, exists := hidden[strings.ToLower(strings.TrimSpace(field))]; !exists {
				filtered = append(filtered, field)
			}
		}
		ruleUI.Disable = filtered
	}
	return contract
}

func normalizeGeneratedVideoContractModeMaterials(contract protocol.VideoModelContract) protocol.VideoModelContract {
	zero := protocol.VideoModelMaterialRange{}
	for index := range contract.Generation.Modes {
		materials := &contract.Generation.Modes[index].Materials
		switch strings.ToLower(strings.TrimSpace(contract.Generation.Modes[index].Kind)) {
		case "text":
			materials.FirstFrame = zero
			materials.LastFrame = zero
			materials.Image = zero
			materials.Video = zero
			materials.Audio = zero
		case "image":
			materials.Image = zero
			materials.Video = zero
			materials.Audio = zero
		case "reference":
			materials.FirstFrame = zero
			materials.LastFrame = zero
		default:
			continue
		}

		ranges := []protocol.VideoModelMaterialRange{
			materials.FirstFrame,
			materials.LastFrame,
			materials.Image,
			materials.Video,
			materials.Audio,
		}
		materialMin := 0
		materialMax := 0
		largestMax := 0
		for _, item := range ranges {
			materialMin += item.Min
			materialMax += item.Max
			largestMax = max(largestMax, item.Max)
		}
		if materialMax == 0 {
			materials.Total = zero
			continue
		}
		materials.Total.Min = min(max(materials.Total.Min, materialMin), materialMax)
		minimumTotalMax := max(largestMax, materialMin, materials.Total.Min)
		materials.Total.Max = min(max(materials.Total.Max, minimumTotalMax), materialMax)
	}
	return contract
}

func describeVideoContractJSONError(err error) string {
	var syntaxError *json.SyntaxError
	if errors.As(err, &syntaxError) {
		return fmt.Sprintf("JSON 语法错误（第 %d 字节）", syntaxError.Offset)
	}
	var typeError *json.UnmarshalTypeError
	if errors.As(err, &typeError) {
		field := strings.TrimSpace(typeError.Field)
		if field == "" {
			field = "根节点"
		}
		return fmt.Sprintf("字段 %q 类型错误：收到 %s，需要 %s", field, typeError.Value, typeError.Type)
	}
	const unknownFieldPrefix = "json: unknown field "
	if message := strings.TrimSpace(err.Error()); strings.HasPrefix(message, unknownFieldPrefix) {
		return "包含未知字段 " + strings.TrimPrefix(message, unknownFieldPrefix)
	}
	return "JSON 结构错误：" + strings.TrimSpace(err.Error())
}

func uniqueTrimmedWarningStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (a *App) videoContractImportConflictWarnings(contract protocol.VideoModelContract) []string {
	items, err := a.videoContracts.List()
	if err != nil {
		return nil
	}
	warnings := make([]string, 0)
	models := make(map[string]string)
	for _, item := range items {
		if strings.EqualFold(item.Contract.Name, contract.Name) {
			warnings = append(warnings, "契约名称已存在，请修改后再保存")
		}
		for _, model := range item.Contract.Models {
			models[strings.ToLower(strings.TrimSpace(model))] = item.Contract.Name
		}
	}
	for _, model := range contract.Models {
		if owner := models[strings.ToLower(strings.TrimSpace(model))]; owner != "" {
			warnings = append(warnings, fmt.Sprintf("模型 %s 已由契约 %s 管理", model, owner))
		}
	}
	return warnings
}

func decodeVideoModelContractMutation(w http.ResponseWriter, r *http.Request) (videoModelContractMutation, bool) {
	var body videoModelContractMutation
	if err := decodeStrictJSON(r.Body, &body); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid video model contract body")
		return videoModelContractMutation{}, false
	}
	return body, true
}

func decodeStrictJSON(reader io.Reader, out any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain a single JSON value")
		}
		return err
	}
	return nil
}

func (a *App) writeAdminVideoModelContracts(w http.ResponseWriter, item *videocontract.ManagedVideoModelContract) {
	items, err := a.videoContracts.List()
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load video model contracts")
		return
	}
	payload := map[string]any{"items": managedVideoModelContractResponses(items)}
	if item != nil {
		payload["item"] = managedVideoModelContractResponseFrom(*item)
	}
	util.WriteJSON(w, http.StatusOK, payload)
}

func managedVideoModelContractResponses(items []videocontract.ManagedVideoModelContract) []managedVideoModelContractResponse {
	result := make([]managedVideoModelContractResponse, 0, len(items))
	for _, item := range items {
		result = append(result, managedVideoModelContractResponseFrom(item))
	}
	return result
}

func managedVideoModelContractResponseFrom(item videocontract.ManagedVideoModelContract) managedVideoModelContractResponse {
	return managedVideoModelContractResponse{
		ID: item.ID, Contract: item.Contract, Draft: item.Draft, DraftEnabled: item.DraftEnabled,
		Enabled: item.Enabled, Revision: item.Revision, CreatedAt: item.CreatedAt,
		UpdatedAt: item.UpdatedAt, DraftUpdatedAt: item.DraftUpdatedAt,
	}
}
