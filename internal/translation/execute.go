package translation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/dop251/goja"
)

type Channel struct {
	Source  string `json:"source"`
	BaseURL string `json:"base_url"`
}
type Result struct {
	URLs     []string
	Progress int
	TaskIDs  []string
}
type Engine struct {
	vm         *goja.Runtime
	rule, poll *goja.Object
	headers    map[string]any
	channel    Channel
	key        string
	client     *http.Client
	interval   time.Duration
}
type requestPlan struct {
	URL          string         `json:"url"`
	Headers      map[string]any `json:"headers"`
	Params       map[string]any `json:"params"`
	Body         any            `json:"body"`
	Format       string         `json:"format"`
	ResponseType string         `json:"responseType"`
}

func New(channel Channel, model, key string, variables map[string]any, client *http.Client) (*Engine, error) {
	programs, err := Programs(channel.Source)
	if err != nil {
		return nil, err
	}
	program := programs[model]
	if program == nil {
		return nil, nil
	}
	if client == nil {
		return nil, fmt.Errorf("缺少请求客户端")
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) > 0 && (req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host) {
			return fmt.Errorf("转换请求不允许跨来源重定向")
		}
		if len(via) >= 5 {
			return fmt.Errorf("重定向次数过多")
		}
		if client.CheckRedirect != nil {
			return client.CheckRedirect(req, via)
		}
		return nil
	}
	e := &Engine{vm: goja.New(), channel: channel, key: key, client: &clientCopy, interval: 3 * time.Second}
	e.vm.SetMaxCallStackSize(128)
	err = limited(e.vm, func() error {
		for _, name := range []string{"model", "prompt", "size", "aspectRatio", "quality", "count", "resolution", "seconds", "mode", "negativePrompt", "generateAudio", "watermark", "voice", "audioFormat", "speed", "instructions", "firstFrame", "lastFrame"} {
			e.vm.Set(name, goja.Undefined())
		}
		for _, name := range []string{"images", "videos", "audios"} {
			e.vm.Set(name, []string{})
		}
		for name, value := range variables {
			e.vm.Set(name, value)
		}
		e.vm.Set("model", model)
		value, err := e.vm.RunProgram(program)
		if err != nil {
			return err
		}
		root := value.ToObject(e.vm)
		e.rule = root.Get("rule").ToObject(e.vm)
		poll := e.rule.Get("poll")
		if absent(poll) {
			poll = root.Get("poll")
		}
		if !absent(poll) && poll.ToBoolean() {
			var ok bool
			e.poll, ok = poll.(*goja.Object)
			if !ok {
				return fmt.Errorf("poll 必须是对象")
			}
		}
		if err := plain(e.vm, root.Get("headers"), &e.headers); err != nil {
			return err
		}
		if e.poll != nil {
			var success []any
			if err := plain(e.vm, e.poll.Get("success"), &success); err != nil {
				return err
			}
			if len(success) == 0 || absent(e.poll.Get("taskId")) || absent(e.poll.Get("status")) {
				return fmt.Errorf("查询配置需要 taskId、status 和 success")
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if e.poll != nil {
		if _, _, err := e.plan(true); err != nil {
			return nil, err
		}
	}
	return e, nil
}
func absent(v goja.Value) bool { return v == nil || goja.IsUndefined(v) || goja.IsNull(v) }

func (e *Engine) plan(query bool) (requestPlan, string, error) {
	var plan requestPlan
	method := ""
	err := limited(e.vm, func() error {
		rule := e.rule
		if query {
			rule = e.poll
		}
		if rule == nil {
			return fmt.Errorf("缺少查询配置")
		}
		for _, candidate := range methods {
			value := rule.Get(candidate)
			if absent(value) {
				continue
			}
			if method != "" {
				return fmt.Errorf("必须且只能配置一种请求方法")
			}
			method = candidate
			if err := plain(e.vm, value, &plan); err != nil {
				return err
			}
		}
		if method == "" || plan.URL == "" {
			return fmt.Errorf("请求缺少方法或 url")
		}
		return nil
	})
	return plan, method, err
}

func (e *Engine) request(ctx context.Context, query bool, id string) (*http.Request, string, error) {
	plan, method, err := e.plan(query)
	if err != nil {
		return nil, "", err
	}
	rawPlan, err := json.Marshal(plan)
	if err != nil {
		return nil, "", err
	}
	customAuth := bytes.Contains(rawPlan, []byte("{channelKey}"))
	replace := func(s string) string { return strings.NewReplacer("{taskId}", id, "{channelKey}", e.key).Replace(s) }
	escaped := strings.NewReplacer("{taskId}", url.PathEscape(id), "{channelKey}", url.QueryEscape(e.key)).Replace(plan.URL)
	target, err := url.Parse(escaped)
	if err != nil {
		return nil, "", err
	}
	if !target.IsAbs() {
		target, err = url.Parse(strings.TrimRight(e.channel.BaseURL, "/") + "/" + strings.TrimLeft(escaped, "/"))
	}
	if err != nil || target == nil || target.Host == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, "", fmt.Errorf("无效请求地址")
	}
	text := func(v any) string {
		if s, ok := v.(string); ok {
			return replace(s)
		}
		b, _ := json.Marshal(v)
		return string(b)
	}
	params := target.Query()
	for name, v := range plan.Params {
		params.Del(name)
		if values, ok := v.([]any); ok {
			for _, v := range values {
				params.Add(name, text(v))
			}
		} else {
			params.Set(name, text(v))
		}
	}
	target.RawQuery = params.Encode()
	var body io.Reader
	contentType := ""
	switch plan.Format {
	case "", "json":
		if plan.Body != nil {
			b, err := json.Marshal(replaceValues(plan.Body, replace))
			if err != nil {
				return nil, "", err
			}
			body = bytes.NewReader(b)
			contentType = "application/json"
		}
	case "raw":
		if plan.Body != nil {
			body = strings.NewReader(text(plan.Body))
		}
	case "urlencoded", "formData":
		fields, ok := plan.Body.(map[string]any)
		if !ok {
			return nil, "", fmt.Errorf("表单 body 必须为对象")
		}
		form := url.Values{}
		for k, v := range fields {
			if values, ok := v.([]any); ok {
				for _, v := range values {
					form.Add(k, text(v))
				}
			} else {
				form.Add(k, text(v))
			}
		}
		if plan.Format == "urlencoded" {
			body = strings.NewReader(form.Encode())
			contentType = "application/x-www-form-urlencoded"
		} else {
			buf := new(bytes.Buffer)
			writer := multipart.NewWriter(buf)
			for k, values := range form {
				for _, v := range values {
					if err := writer.WriteField(k, v); err != nil {
						return nil, "", err
					}
				}
			}
			if err := writer.Close(); err != nil {
				return nil, "", err
			}
			body = buf
			contentType = writer.FormDataContentType()
		}
	default:
		return nil, "", fmt.Errorf("未知请求格式 %s", plan.Format)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, "", err
	}
	for _, headers := range []map[string]any{e.headers, plan.Headers} {
		for k, v := range headers {
			if strings.Contains(fmt.Sprint(v), "{channelKey}") {
				customAuth = true
			}
			req.Header.Set(k, text(v))
		}
	}
	if !customAuth && req.Header.Get("Authorization") == "" && req.Header.Get("X-Api-Key") == "" && req.Header.Get("X-Goog-Api-Key") == "" {
		req.Header.Set("Authorization", "Bearer "+e.key)
	}
	if contentType != "" && (req.Header.Get("Content-Type") == "" || plan.Format == "formData") {
		req.Header.Set("Content-Type", contentType)
	}
	if plan.ResponseType == "" {
		plan.ResponseType = "json"
	}
	switch plan.ResponseType {
	case "json", "text", "blob", "arraybuffer":
	default:
		return nil, "", fmt.Errorf("未知响应格式")
	}
	return req, plan.ResponseType, nil
}

func replaceValues(v any, f func(string) string) any {
	switch x := v.(type) {
	case string:
		return f(x)
	case []any:
		for i := range x {
			x[i] = replaceValues(x[i], f)
		}
	case map[string]any:
		for k := range x {
			x[k] = replaceValues(x[k], f)
		}
	}
	return v
}
func (e *Engine) selectValue(selector goja.Value, data any) (any, error) {
	if absent(selector) {
		return data, nil
	}
	if fn, ok := goja.AssertFunction(selector); ok {
		v, err := fn(goja.Undefined(), e.vm.ToValue(data))
		if err != nil {
			return nil, err
		}
		if absent(v) {
			return nil, nil
		}
		if _, ok := v.Export().(*goja.Promise); ok {
			return nil, fmt.Errorf("提取函数必须同步返回")
		}
		var result any
		err = plain(e.vm, v, &result)
		return result, err
	}
	if _, ok := selector.Export().(string); !ok {
		return nil, fmt.Errorf("提取器必须是字段路径或函数")
	}
	path := selector.String()
	if path == "" {
		return data, nil
	}
	for _, part := range strings.Split(path, ".") {
		switch v := data.(type) {
		case map[string]any:
			data = v[part]
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(v) {
				return nil, nil
			}
			data = v[i]
		default:
			return nil, nil
		}
	}
	return data, nil
}

type responseError struct {
	status  int
	message string
}

func (e responseError) Error() string { return e.message }
func (e *Engine) send(ctx context.Context, kind string, query bool, id string) (Result, bool, error) {
	var result Result
	req, format, err := e.request(ctx, query, id)
	if err != nil {
		return result, false, err
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return result, true, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (128<<20)+1))
	if err != nil {
		return result, true, err
	}
	if len(data) > 128<<20 {
		return result, false, fmt.Errorf("响应超过 128 MiB")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, resp.StatusCode == 429 || resp.StatusCode >= 500, responseError{resp.StatusCode, fmt.Sprintf("自定义接口返回 HTTP %d", resp.StatusCode)}
	}
	var payload any
	jsonErr := json.Unmarshal(data, &payload)
	if format == "text" {
		payload = string(data)
	}
	if format == "json" && jsonErr != nil {
		return result, false, fmt.Errorf("接口没有返回有效 JSON")
	}
	var complete bool
	var defaultResult bool
	err = limited(e.vm, func() error {
		selector := e.rule.Get("error")
		if !absent(selector) {
			value, err := e.selectValue(selector, payload)
			if err != nil {
				return err
			}
			if value != nil && e.vm.ToValue(value).ToBoolean() {
				return fmt.Errorf("上游错误：%v", value)
			}
		} else if obj, ok := payload.(map[string]any); ok && obj["error"] != nil && obj["error"] != "" {
			return fmt.Errorf("上游错误：%v", obj["error"])
		}
		if query {
			status, err := e.selectValue(e.poll.Get("status"), payload)
			if err != nil {
				return err
			}
			var success, failure []any
			if err := plain(e.vm, e.poll.Get("success"), &success); err != nil {
				return err
			}
			if err := plain(e.vm, e.poll.Get("failure"), &failure); err != nil {
				return err
			}
			for _, v := range failure {
				if reflect.DeepEqual(v, status) {
					return fmt.Errorf("上游任务失败：%v", status)
				}
			}
			for _, v := range success {
				if reflect.DeepEqual(v, status) {
					complete = true
				}
			}
			if !absent(e.poll.Get("progress")) {
				p, err := e.selectValue(e.poll.Get("progress"), payload)
				if err != nil {
					return err
				}
				n, _ := strconv.ParseFloat(fmt.Sprint(p), 64)
				result.Progress = max(0, min(99, int(n)))
			}
			if !complete {
				return nil
			}
		} else if e.poll != nil {
			ids, err := e.selectValue(e.poll.Get("taskId"), payload)
			if err != nil {
				return err
			}
			values, ok := ids.([]any)
			if !ok {
				values = []any{ids}
			}
			seen := map[string]bool{}
			for _, v := range values {
				if v == nil {
					continue
				}
				id := fmt.Sprint(v)
				if id != "" && !seen[id] {
					result.TaskIDs = append(result.TaskIDs, id)
					seen[id] = true
				}
			}
			if len(result.TaskIDs) == 0 || len(result.TaskIDs) > 100 {
				return fmt.Errorf("任务 ID 数量必须为 1 到 100")
			}
			return nil
		}
		if format == "blob" || format == "arraybuffer" {
			mime := strings.Split(resp.Header.Get("Content-Type"), ";")[0]
			if mime == "" {
				mime = http.DetectContentType(data)
			}
			if len(data) == 0 || jsonErr == nil || strings.HasPrefix(mime, "text/") {
				return fmt.Errorf("接口未返回媒体文件")
			}
			result.URLs = []string{"data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)}
		} else {
			selector := e.rule.Get("result")
			defaultResult = absent(selector) || selector.String() == ""
			value, err := e.selectValue(selector, payload)
			if err != nil {
				return err
			}
			mime := map[string]string{"image": "image/png", "audio": "audio/mpeg", "video": "video/mp4"}[kind]
			if kind == "audio" {
				if v := e.vm.Get("audioFormat"); !absent(v) {
					if audioMime := map[string]string{"wav": "audio/wav", "pcm": "audio/pcm", "flac": "audio/flac", "aac": "audio/aac", "opus": "audio/opus"}[v.String()]; audioMime != "" {
						mime = audioMime
					}
				}
			}
			result.URLs = mediaURLs(value, kind, mime, 0)
		}
		if len(result.URLs) == 0 && !(kind == "video" && query && defaultResult && strings.HasSuffix(req.URL.Path, "/videos/"+id)) {
			return fmt.Errorf("响应中没有可用媒体结果")
		}
		result.Progress = 100
		return nil
	})
	if err == nil && kind == "video" && result.Progress == 100 {
		var target *url.URL
		if len(result.URLs) == 1 {
			candidate, parseErr := url.Parse(result.URLs[0])
			if parseErr == nil && candidate.Scheme == req.URL.Scheme && candidate.Host == req.URL.Host && strings.HasSuffix(candidate.Path, "/content") && strings.Contains(candidate.Path, "/videos/") {
				target = candidate
			}
		}
		if len(result.URLs) == 0 && query && defaultResult {
			candidate := *req.URL
			candidate.Path += "/content"
			if candidate.RawPath != "" {
				candidate.RawPath += "/content"
			}
			target = &candidate
		}
		if target != nil {
			return e.download(ctx, req, target)
		}
	}
	return result, false, err
}

func (e *Engine) download(ctx context.Context, original *http.Request, target *url.URL) (Result, bool, error) {
	params := original.URL.Query()
	for k, v := range target.Query() {
		params[k] = v
	}
	target.RawQuery = params.Encode()
	req := original.Clone(ctx)
	req.URL = target
	req.Method = http.MethodGet
	req.Body = nil
	req.GetBody = nil
	req.ContentLength = 0
	req.Header.Del("Content-Type")
	req.Header.Del("Content-Length")
	resp, err := e.client.Do(req)
	if err != nil {
		return Result{}, true, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (128<<20)+1))
	if err != nil {
		return Result{}, true, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, resp.StatusCode == 429 || resp.StatusCode >= 500, fmt.Errorf("下载媒体失败：HTTP %d", resp.StatusCode)
	}
	mime := strings.Split(resp.Header.Get("Content-Type"), ";")[0]
	if len(data) == 0 || len(data) > 128<<20 || json.Valid(data) || strings.HasPrefix(mime, "text/") {
		return Result{}, false, fmt.Errorf("下载结果不是有效媒体文件")
	}
	if !strings.HasPrefix(mime, "video/") {
		mime = "video/mp4"
	}
	return Result{Progress: 100, URLs: []string{"data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)}}, false, nil
}
func mediaURLs(value any, kind, mime string, depth int) []string {
	if depth > 10 {
		return nil
	}
	var out []string
	switch v := value.(type) {
	case string:
		v = strings.TrimSpace(v)
		u, err := url.Parse(v)
		if err == nil && u.User == nil && ((u.Scheme == "http" || u.Scheme == "https") && u.Host != "" || strings.HasPrefix(v, "data:"+kind+"/")) {
			return []string{v}
		}
		if raw, err := base64.StdEncoding.DecodeString(v); err == nil && len(raw) > 0 {
			return []string{"data:" + mime + ";base64," + v}
		}
	case []any:
		for _, item := range v {
			out = append(out, mediaURLs(item, kind, mime, depth+1)...)
		}
	case map[string]any:
		for _, key := range []string{"mime_type", "mimeType"} {
			if value, ok := v[key].(string); ok && strings.HasPrefix(value, kind+"/") {
				mime = value
			}
		}
		if s, ok := v["b64_json"].(string); ok {
			if _, err := base64.StdEncoding.DecodeString(s); err == nil {
				return []string{"data:" + mime + ";base64," + s}
			}
		}
		for _, key := range []string{"url", "uri", "download_url", "image_url", "video_url", "audio_url", "data", "result", "results", "outputs", "images", "videos", "audios", "base64"} {
			out = append(out, mediaURLs(v[key], kind, mime, depth+1)...)
		}
	}
	return out
}

// Execute submits once. Temporary polling failures never resubmit generation.
func (e *Engine) Execute(ctx context.Context, kind string, onProgress func(int)) (result Result, err error) {
	defer func() {
		if err != nil && e.key != "" {
			message := err.Error()
			for _, s := range []string{e.key, url.QueryEscape(e.key), url.PathEscape(e.key)} {
				message = strings.ReplaceAll(message, s, "[redacted]")
			}
			err = fmt.Errorf("%s", message)
		}
	}()
	result, _, err = e.send(ctx, kind, false, "")
	if err != nil || len(result.TaskIDs) == 0 {
		return result, err
	}
	ids := result.TaskIDs
	done := map[string]Result{}
	progress := map[string]int{}
	for len(done) < len(ids) {
		for _, id := range ids {
			if _, ok := done[id]; ok {
				continue
			}
			polled, retryable, err := e.send(ctx, kind, true, id)
			if err != nil {
				if ctx.Err() != nil {
					return result, ctx.Err()
				}
				if retryable {
					continue
				}
				return result, err
			}
			progress[id] = max(progress[id], polled.Progress)
			if polled.Progress == 100 {
				done[id] = polled
			}
		}
		sum := 0
		for _, p := range progress {
			sum += p
		}
		if onProgress != nil {
			onProgress(sum / len(ids))
		}
		if len(done) < len(ids) {
			timer := time.NewTimer(e.interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return result, ctx.Err()
			case <-timer.C:
			}
		}
	}
	result.Progress = 100
	for _, id := range ids {
		result.URLs = append(result.URLs, done[id].URLs...)
	}
	return result, nil
}
