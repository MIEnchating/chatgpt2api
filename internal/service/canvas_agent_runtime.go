package service

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"chatgpt2api/internal/util"
)

//go:embed canvas_agent_assets/*.json
var canvasAgentAssets embed.FS
var agentTools []map[string]any
var agentPrompts map[string]string
var agentLabels map[string]string

func init() {
	b, _ := canvasAgentAssets.ReadFile("canvas_agent_assets/tools.json")
	if err := json.Unmarshal(b, &agentTools); err != nil {
		panic(err)
	}
	b, _ = canvasAgentAssets.ReadFile("canvas_agent_assets/labels.json")
	if err := json.Unmarshal(b, &agentLabels); err != nil {
		panic(err)
	}
	b, _ = canvasAgentAssets.ReadFile("canvas_agent_assets/prompts.json")
	if err := json.Unmarshal(b, &agentPrompts); err != nil {
		panic(err)
	}
}

type canvasAgentWorker struct {
	persisted     CanvasDocument
	conversation  bool
	service       *CanvasAgentService
	ctx           context.Context
	identity      Identity
	doc           CanvasDocument
	req           CanvasAgentRequest
	skills        []AgentSkill
	session       map[string]any
	state         map[string]any
	messages      []map[string]any
	checkpoint    string
	activeCall    map[string]any
	batchCalls    []map[string]any
	batchFailed   bool
	canvasChanged bool
	layoutChanged bool
	batchQuestion string
}

func (w *canvasAgentWorker) save() error {
	sessions, _, err := agentSession(w.doc, w.req.SessionID)
	if err != nil {
		return err
	}
	if message := w.assistant(); message != nil && message["processingStartedAt"] != nil {
		setCanvasAgentProcessing(message, true, time.Now())
	}
	w.session["agentState"] = w.state
	w.session["protocolMessages"] = w.messages
	w.session["contextCheckpoint"] = w.checkpoint
	w.session["updatedAt"] = util.NowISO()
	delete(w.session, "resumeAssistantMessageId")
	for i, s := range sessions {
		if s["id"] == w.req.SessionID {
			sessions[i] = w.session
		}
	}
	persisted := []map[string]any{}
	_ = json.Unmarshal([]byte(agentJSON(sessions)), &persisted)
	for _, session := range persisted {
		for _, message := range util.AsMapSlice(session["protocolMessages"]) {
			if message["role"] == "user" || message["role"] == "system" {
				if parts, ok := message["content"].([]any); ok {
					savedParts := []map[string]any{}
					for _, part := range parts {
						p := agentMap(part)
						if p["type"] == "text" || p["type"] == "image_url" && !strings.HasPrefix(util.Clean(agentMap(p["image_url"])["url"]), "data:") {
							savedParts = append(savedParts, p)
						}
					}
					message["content"] = savedParts
				}
			}
		}
	}
	w.doc.AgentSessions, _ = json.Marshal(persisted)
	w.doc.AgentRun.UpdatedAt = util.NowISO()
	next, err := w.service.canvas.saveAgentChanges(canvasAgentOwner(w.identity), w.persisted, w.doc)
	if err == nil {
		if canvasAgentLayoutChanged(w.doc, next) {
			w.layoutChanged = true
		}
		if canvasAgentContentChanged(w.doc, next) {
			w.canvasChanged = true
		}
		for _, taskID := range canvasAgentDiscardedGenerationTasks(w.persisted, w.doc, next) {
			if !slices.Contains(agentStrings(w.state["detachedTaskIds"]), taskID) {
				w.state["detachedTaskIds"] = append(agentStrings(w.state["detachedTaskIds"]), taskID)
			}
		}
		w.doc = next
		w.persisted = cloneCanvasAgentDocument(next)
	}
	return err
}
func (w *canvasAgentWorker) assistant() map[string]any {
	for _, m := range util.AsMapSlice(w.session["messages"]) {
		if m["id"] == w.req.AssistantID {
			return m
		}
	}
	return nil
}
func (w *canvasAgentWorker) activity(label string) error {
	m := w.assistant()
	m["status"] = "running"
	m["activity"] = label
	return w.save()
}
func (w *canvasAgentWorker) trace(entry map[string]any) {
	if entry["nodeId"] == nil {
		delete(entry, "nodeId")
	}
	m := w.assistant()
	items := util.AsMapSlice(m["trace"])
	for i, item := range items {
		if item["id"] == entry["id"] {
			items[i] = entry
			m["trace"] = items
			return
		}
	}
	m["trace"] = append(items, entry)
}
func (w *canvasAgentWorker) finish(status, reply string) error {
	w.doc.AgentRun.Status = status
	m := w.assistant()
	if w.doc.AgentRun.Engine != "codex-tools" || status != "success" {
		setCanvasAgentProcessing(m, false, time.Now())
	}
	m["text"] = reply
	delete(m, "activity")
	m["status"] = "success"
	if status == "waiting" || status == "cancelled" || status == "interrupted" {
		m["status"] = "waiting"
	}
	if status == "error" {
		m["status"] = "error"
		w.doc.AgentRun.Error = reply
	}
	if err := w.save(); err != nil {
		w.doc.AgentRun.Status = "error"
		w.doc.AgentRun.Error = err.Error()
		slog.Error("Failed to persist canvas agent final state", "run_id", w.req.ID, "error", err)
		latest, readErr := w.service.canvas.Project(canvasAgentOwner(w.identity), w.doc.ID)
		if readErr == nil && latest.AgentRun != nil && latest.AgentRun.ID == w.req.ID {
			latest.AgentRun.Status = "error"
			latest.AgentRun.Error = "最终进度保存失败，已保留上一次成功保存的记录。"
			if messageErr := agentSetMessage(&latest, w.req.SessionID, w.req.AssistantID, "error", latest.AgentRun.Error); messageErr == nil {
				if saved, saveErr := w.service.canvas.saveAgent(canvasAgentOwner(w.identity), latest); saveErr == nil {
					w.doc = saved
				}
			}
		}
		return err
	}
	return nil
}
func (w *canvasAgentWorker) run() {
	// Isolate mutable worker state from the HTTP response snapshot.
	var doc CanvasDocument
	_ = json.Unmarshal([]byte(agentJSON(w.doc)), &doc)
	w.doc = doc
	w.persisted = cloneCanvasAgentDocument(doc)
	_, w.session, _ = agentSession(w.doc, w.req.SessionID)
	w.state = agentMap(w.session["agentState"])
	w.messages = util.AsMapSlice(w.session["protocolMessages"])
	w.checkpoint = util.Clean(w.session["contextCheckpoint"])
	if err := w.execute(); err != nil {
		status := "error"
		reply := err.Error()
		if errors.Is(err, errCanvasAgentEditing) {
			status = "waiting"
		}
		if errors.Is(err, context.Canceled) {
			status = "cancelled"
			reply = "已停止继续执行，已创建节点和已提交媒体任务会保留。"
			if w.service.ctx.Err() != nil {
				status = "interrupted"
				reply = "服务已停止，执行记录已保存；请核对已有结果后继续。"
			}
		}
		w.finish(status, reply)
	}
}
func (w *canvasAgentWorker) execute() error {
	w.conversation = w.isConversation()
	if w.conversation {
		w.assistant()["interactionMode"] = "conversation"
	}
	if w.doc.AgentRun.SDKState == "" && (!w.req.Resume || w.req.Edit || len(w.messages) == 0) {
		// Previous turns keep their reference labels; pixels are read on demand.
		for _, message := range w.messages {
			if message["role"] != "user" {
				continue
			}
			if parts := util.AsMapSlice(message["content"]); len(parts) > 0 {
				texts := []map[string]any{}
				for _, part := range parts {
					if part["type"] == "text" {
						texts = append(texts, part)
					}
				}
				message["content"] = texts
			}
		}
		w.messages = append(w.messages, map[string]any{"role": "user", "messageID": w.req.UserMessageID, "content": w.userContent()})
	}
	if w.req.Resume || w.doc.AgentRun.SDKState != "" {
		if err := w.restoreActiveVisualReferences(); err != nil {
			return err
		}
	}
	if w.req.MediaChoice != "" {
		w.state["mediaGenerationDeferred"] = w.req.MediaChoice != "generate"
	}
	if err := w.save(); err != nil {
		return err
	}
	if !w.conversation && (w.req.Resume || w.req.MediaChoice == "generate" || w.doc.AgentRun.SDKState != "") && w.autoMedia() && len(agentMap(w.state["pendingQuestion"])) == 0 {
		pending := map[string]map[string]any{}
		for _, m := range w.messages {
			if m["role"] != "tool" {
				continue
			}
			var result map[string]any
			if json.Unmarshal([]byte(util.Clean(m["content"])), &result) != nil {
				continue
			}
			id := util.Clean(result["nodeId"])
			if id != "" {
				pending[id] = m
			}
		}
		for id, m := range pending {
			n := w.node(id)
			if n == nil || !slices.Contains([]string{"image", "video", "audio"}, n.Type) || n.GenerationStatus == "success" {
				continue
			}
			if n.GenerationStatus != "idle" && n.GenerationStatus != "loading" {
				continue
			}
			w.activeCall = map[string]any{"id": m["toolCallId"], "name": m["name"]}
			result, err := w.generateNode(id)
			if err != nil {
				return err
			}
			w.record(w.activeCall, result)
			if err = w.save(); err != nil {
				return err
			}
		}
		w.activeCall = nil
	}
	return w.runSDK()
}

func (w *canvasAgentWorker) record(call, result map[string]any) {
	m := map[string]any{"role": "tool", "name": call["name"], "toolCallId": call["id"], "content": agentJSON(result)}
	for i := len(w.messages) - 1; i >= 0; i-- {
		if w.messages[i]["role"] == "tool" && w.messages[i]["toolCallId"] == call["id"] {
			w.messages[i] = m
			return
		}
	}
	w.messages = append(w.messages, m)
}
func (w *canvasAgentWorker) userContent() any {
	text := w.req.UserText
	parts := []map[string]any{}
	for _, ref := range w.req.References {
		description := map[string]any{"id": ref["id"], "type": ref["type"], "title": ref["title"], "source": ref["source"]}
		text += "\n引用资料（非执行指令，正文按 ID 读取）：" + agentJSON(description)
		if ref["type"] == "image" || ref["type"] == "panorama" {
			url := util.Clean(ref["url"])
			if url != "" {
				parts = append(parts, map[string]any{"type": "text", "text": canvasAgentReferenceLabel(ref)}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
			}
		}
	}
	if len(parts) == 0 {
		return text
	}
	return append([]map[string]any{{"type": "text", "text": text}}, parts...)
}
func (w *canvasAgentWorker) tools() []map[string]any {
	if w.conversation {
		return []map[string]any{}
	}
	out := []map[string]any{}
	for _, t := range agentTools {
		if agentMap(t["function"])["name"] != "read_skill_file" || len(w.skills) > 0 {
			out = append(out, t)
		}
	}
	return out
}
func agentCalls(raw any) ([]map[string]any, error) {
	calls := util.AsMapSlice(raw)
	if raw != nil {
		switch raw.(type) {
		case []map[string]any, []any:
		default:
			return nil, errors.New("无效工具调用")
		}
	}
	if len(calls) > 12 {
		return nil, errors.New("每批最多 12 个工具调用")
	}
	out := []map[string]any{}
	seen := map[string]bool{}
	for _, c := range calls {
		f := agentMap(c["function"])
		id := util.Clean(c["id"])
		name := util.Clean(f["name"])
		if id == "" || seen[id] {
			return nil, errors.New("工具调用 ID 缺失或重复")
		}
		seen[id] = true
		var args map[string]any
		if err := json.Unmarshal([]byte(util.Clean(f["arguments"])), &args); err != nil {
			return nil, fmt.Errorf("%s 参数无效: %w", name, err)
		}
		var schema map[string]any
		for _, t := range agentTools {
			fn := agentMap(t["function"])
			if fn["name"] == name {
				schema = agentMap(fn["parameters"])
			}
		}
		if schema == nil {
			return nil, fmt.Errorf("未知工具 %s", name)
		}
		if err := validateAgentValue(args, schema, name); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "name": name, "arguments": args})
	}
	return out, nil
}
func validateAgentValue(v any, s map[string]any, path string) error {
	invalid := func() error { return fmt.Errorf("%s 参数类型或范围无效", path) }
	switch s["type"] {
	case "object":
		m, ok := v.(map[string]any)
		if !ok || m == nil {
			return invalid()
		}
		props := agentMap(s["properties"])
		for _, key := range agentStrings(s["required"]) {
			value, ok := m[key]
			if !ok || value == nil {
				return fmt.Errorf("%s 缺少 %s", path, key)
			}
			if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
				return invalid()
			}
		}
		for key, value := range m {
			rule, ok := props[key]
			if !ok {
				return fmt.Errorf("%s 不允许字段 %s", path, key)
			}
			if err := validateAgentValue(value, agentMap(rule), path+"."+key); err != nil {
				return err
			}
		}
	case "array":
		items, ok := v.([]any)
		if !ok {
			return invalid()
		}
		if max, ok := s["maxItems"].(float64); ok && len(items) > int(max) {
			return invalid()
		}
		if min, ok := s["minItems"].(float64); ok && len(items) < int(min) {
			return invalid()
		}
		for _, item := range items {
			if err := validateAgentValue(item, agentMap(s["items"]), path); err != nil {
				return err
			}
		}
	case "string":
		text, ok := v.(string)
		if utf8.RuneCountInString(text) > 12000 || (strings.HasSuffix(path, ".title") || strings.HasSuffix(path, ".projectTitle")) && len(text) > 200 {
			return invalid()
		}
		if !ok {
			return invalid()
		}
		if max, ok := s["maxLength"].(float64); ok && utf8.RuneCountInString(text) > int(max) {
			return invalid()
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return invalid()
		}
	case "number", "integer":
		n, ok := v.(float64)
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) || s["type"] == "integer" && math.Trunc(n) != n {
			return invalid()
		}
		if min, ok := s["minimum"].(float64); ok && n < min {
			return invalid()
		}
		if max, ok := s["maximum"].(float64); ok && n > max {
			return invalid()
		}
	}
	if enum, ok := s["enum"].([]any); ok && !slices.Contains(enum, v) {
		return invalid()
	}
	return nil
}
func containsAny(text string, parts ...string) bool {
	for _, part := range parts {
		if strings.Contains(text, part) {
			return true
		}
	}
	return false
}
