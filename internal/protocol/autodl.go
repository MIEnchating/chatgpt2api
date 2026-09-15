package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/model"
)

const autoDLRoot = "/api/v1/comfyui"

type AutoDLHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}
type AutoDLClient struct{ HTTP AutoDLHTTPClient }

func AutoDLURL(baseURL, endpoint string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("AutoDL Base URL 无效")
	}
	return strings.TrimRight(u.String(), "/") + endpoint, nil
}

func AutoDLTaskPath(id string, poll bool) string {
	prefix := autoDLRoot + "/comfyui_workflow/"
	if poll {
		prefix += "result/"
	}
	return prefix + url.PathEscape(id)
}

func (c AutoDLClient) request(ctx context.Context, baseURL, method, endpoint, key string, body any) (json.RawMessage, error) {
	target, err := AutoDLURL(baseURL, endpoint)
	if err != nil {
		return nil, err
	}
	var data []byte
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Authorization", key)
	}
	if c.HTTP == nil {
		return nil, errors.New("AutoDL HTTP 客户端未初始化")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err = io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 4<<20 {
		return nil, errors.New("AutoDL 响应超过大小限制")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, HTTPError{Status: http.StatusBadGateway, Message: fmt.Sprintf("AutoDL 返回 HTTP %d", res.StatusCode)}
	}
	var envelope struct {
		Code string          `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil || !strings.EqualFold(envelope.Code, "Success") || len(envelope.Data) == 0 || bytes.Equal(envelope.Data, []byte("null")) {
		return nil, HTTPError{Status: http.StatusBadGateway, Message: "AutoDL 返回无效或失败的响应"}
	}
	return envelope.Data, nil
}

func (c AutoDLClient) Workflows(ctx context.Context, baseURL string) ([]model.AutoDLWorkflow, error) {
	items := make([]model.AutoDLWorkflow, 0)
	seen := map[string]bool{}
	for page := 1; page <= 100; page++ {
		data, err := c.request(ctx, baseURL, http.MethodPost, autoDLRoot+"/workflows", "", map[string]int{"page_index": page, "page_size": 100})
		if err != nil {
			return nil, err
		}
		var result struct {
			List    []model.AutoDLWorkflow `json:"list"`
			MaxPage int                    `json:"max_page"`
		}
		if json.Unmarshal(data, &result) != nil || result.List == nil || result.MaxPage < 0 {
			return nil, errors.New("AutoDL 工作流目录格式无效")
		}
		for _, item := range result.List {
			if item.UUID != "" && !seen[item.UUID] {
				item.Kind = AutoDLWorkflowKind(item)
				items = append(items, item)
				seen[item.UUID] = true
			}
		}
		if page >= result.MaxPage || len(result.List) == 0 {
			return items, nil
		}
	}
	return nil, errors.New("AutoDL 工作流目录页数超过限制")
}

func (c AutoDLClient) Workflow(ctx context.Context, baseURL, id string) (model.AutoDLWorkflow, error) {
	if strings.TrimSpace(id) == "" {
		return model.AutoDLWorkflow{}, errors.New("请输入 AutoDL 工作流 ID")
	}
	data, err := c.request(ctx, baseURL, http.MethodGet, autoDLRoot+"/workflows/"+url.PathEscape(id), "", nil)
	if err != nil {
		return model.AutoDLWorkflow{}, err
	}
	var item model.AutoDLWorkflow
	if json.Unmarshal(data, &item) != nil || item.UUID != id || len(item.InputRules) == 0 {
		return model.AutoDLWorkflow{}, errors.New("AutoDL 工作流详情格式无效")
	}
	item.Kind = AutoDLWorkflowKind(item)
	return item, nil
}

// Workflow rules determine media capabilities; unknown IDs are not guessed.
func AutoDLWorkflowKind(item model.AutoDLWorkflow) string {
	if item.Kind == "audio" || item.Kind == "video" {
		return item.Kind
	}
	if _, ok := item.InputRules["prompt_text"]; ok {
		return "audio"
	}
	for _, key := range []string{"duration", "first_frame", "ref_video", "resolution"} {
		if _, ok := item.InputRules[key]; ok {
			return "video"
		}
	}
	return "unknown"
}

func AutoDLRequest(workflow model.AutoDLWorkflow, input map[string]any) (map[string]any, error) {
	output := make(map[string]any)
	if raw, exists := input["workflow_inputs"]; exists && raw != nil {
		fields, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("workflow_inputs 必须是对象")
		}
		for field, value := range fields {
			if _, ok := workflow.InputRules[field]; !ok {
				return nil, fmt.Errorf("工作流不支持参数 %s", field)
			}
			output[field] = value
		}
	}
	for source, target := range map[string]string{"prompt": "prompt", "input": "prompt_text", "reference_audio": "prompt_simple", "first_frame_url": "first_frame", "last_frame_url": "last_frame", "seconds": "duration", "resolution": "resolution"} {
		if _, ok := workflow.InputRules[target]; ok {
			if value, exists := input[source]; exists && value != nil && value != "" {
				output[target] = value
			}
		}
	}
	if _, ok := workflow.InputRules["audio_duration"]; ok {
		if value, exists := input["seconds"]; exists {
			output["audio_duration"] = value
		}
	}
	for source, prefix := range map[string]string{"reference_image_urls": "ref_image", "reference_video_urls": "ref_video", "reference_audio_urls": "ref_audio"} {
		values, err := autoDLReferences(input[source])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", source, err)
		}
		fields := autoDLReferenceFields(workflow.InputRules, prefix)
		if source == "reference_image_urls" && input["first_frame_url"] == nil {
			frames := []string{}
			for _, field := range []string{"first_frame", "last_frame"} {
				if _, exists := workflow.InputRules[field]; exists {
					frames = append(frames, field)
				}
			}
			fields = append(frames, fields...)
		}
		if source == "reference_audio_urls" {
			if _, exists := workflow.InputRules["prompt_simple"]; exists {
				fields = append([]string{"prompt_simple"}, fields...)
			}
		}
		if len(values) > len(fields) {
			return nil, fmt.Errorf("AutoDL 工作流最多支持 %d 个 %s", len(fields), source)
		}
		for index, value := range values {
			output[fields[index]] = value
		}
	}
	for field, rule := range workflow.InputRules {
		value, exists := output[field]
		if !exists {
			value = rule.Default
			if autoDLMediaRule(rule) {
				value = nil
			}
		}
		if value == nil || value == "" {
			if rule.Required {
				return nil, fmt.Errorf("AutoDL 缺少必填参数 %s", field)
			}
			continue
		}
		normalized, err := autoDLRuleValue(rule, value)
		if err != nil {
			return nil, fmt.Errorf("AutoDL 参数 %s: %w", field, err)
		}
		output[field] = normalized
		if autoDLMediaRule(rule) || field == "first_frame" || field == "last_frame" || field == "prompt_simple" || strings.HasPrefix(field, "ref_image") || strings.HasPrefix(field, "ref_video") || strings.HasPrefix(field, "ref_audio") {
			text, ok := normalized.(string)
			if !ok {
				return nil, fmt.Errorf("%s 必须是素材 URL", field)
			}
			if err := publicMediaURL(text); err != nil {
				return nil, err
			}
		}
	}
	return output, nil
}

func autoDLMediaRule(rule model.AutoDLInputRule) bool {
	return rule.Type == "image" || rule.Type == "audio" || rule.Type == "video"
}

func autoDLReferences(value any) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	var values []string
	switch v := value.(type) {
	case []string:
		values = append(values, v...)
	case []any:
		for _, item := range v {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("参考素材必须是 URL 字符串数组")
			}
			values = append(values, text)
		}
	default:
		return nil, errors.New("参考素材必须是 URL 字符串数组")
	}
	for _, value := range values {
		if err := publicMediaURL(value); err != nil {
			return nil, err
		}
	}
	return values, nil
}

func autoDLReferenceFields(rules map[string]model.AutoDLInputRule, prefix string) []string {
	fields := make([]string, 0)
	for field := range rules {
		if field == prefix {
			fields = append(fields, field)
		} else if strings.HasPrefix(field, prefix+"_") {
			if number, err := strconv.Atoi(strings.TrimPrefix(field, prefix+"_")); err == nil && number >= 0 {
				fields = append(fields, field)
			}
		}
	}
	sort.Slice(fields, func(i, j int) bool {
		if fields[i] == prefix {
			return true
		}
		if fields[j] == prefix {
			return false
		}
		a, _ := strconv.Atoi(strings.TrimPrefix(fields[i], prefix+"_"))
		b, _ := strconv.Atoi(strings.TrimPrefix(fields[j], prefix+"_"))
		return a < b
	})
	return fields
}

func autoDLRuleValue(rule model.AutoDLInputRule, value any) (any, error) {
	if rule.Type == "integer" || rule.Type == "number" || rule.Type == "float" {
		var number float64
		switch v := value.(type) {
		case string:
			var err error
			number, err = strconv.ParseFloat(v, 64)
			if err != nil {
				return nil, errors.New("必须是数字")
			}
		case float64:
			number = v
		case int:
			number = float64(v)
		case json.Number:
			var err error
			number, err = v.Float64()
			if err != nil {
				return nil, errors.New("必须是数字")
			}
		default:
			return nil, errors.New("必须是数字")
		}
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, errors.New("数字必须有限")
		}
		if rule.Min != nil && number < *rule.Min || rule.Max != nil && number > *rule.Max {
			return nil, errors.New("超出工作流允许范围")
		}
		if rule.Type == "integer" && number != math.Trunc(number) {
			return nil, errors.New("必须是整数")
		}
		return number, nil
	}
	if rule.Type == "boolean" {
		if _, ok := value.(bool); !ok {
			return nil, errors.New("必须是布尔值")
		}
		return value, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, errors.New("必须是字符串")
	}
	length := utf8.RuneCountInString(text)
	if rule.MinLength != nil && length < *rule.MinLength || rule.MaxLength != nil && length > *rule.MaxLength {
		return nil, errors.New("文本长度超出工作流允许范围")
	}
	if len(rule.Options) > 0 {
		for _, option := range rule.Options {
			if option.Label == text {
				return text, nil
			}
		}
		return nil, errors.New("不属于工作流选项")
	}
	return text, nil
}

type AutoDLTask struct {
	ID      string         `json:"task_id"`
	Status  string         `json:"status"`
	Message string         `json:"message"`
	Results []AutoDLResult `json:"results"`
}
type AutoDLResult struct {
	Type       string `json:"type"`
	URL        string `json:"url"`
	FileType   string `json:"file_type"`
	OutputType string `json:"output_type"`
}

func (c AutoDLClient) Task(ctx context.Context, baseURL, id, key string, input map[string]any) (AutoDLTask, error) {
	method := http.MethodGet
	if input != nil {
		method = http.MethodPost
	}
	var body any
	if input != nil {
		body = input
	}
	data, err := c.request(ctx, baseURL, method, AutoDLTaskPath(id, input == nil), key, body)
	if err != nil {
		return AutoDLTask{}, err
	}
	var task AutoDLTask
	if json.Unmarshal(data, &task) != nil || task.ID == "" || task.Status == "" {
		return task, errors.New("AutoDL 任务响应格式无效")
	}
	return task, nil
}

func (task AutoDLTask) Output(kind string) (string, string, error) {
	for _, item := range task.Results {
		if item.Type != kind || item.OutputType != "" && item.OutputType != "output" {
			continue
		}
		if err := publicMediaURL(item.URL); err != nil {
			return "", "", err
		}
		mime := kind + "/" + strings.TrimPrefix(item.FileType, ".")
		if mime == "audio/mp3" {
			mime = "audio/mpeg"
		}
		return item.URL, mime, nil
	}
	return "", "", errors.New("AutoDL 任务没有返回匹配的产物")
}
