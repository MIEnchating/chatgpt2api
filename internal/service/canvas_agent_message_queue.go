package service

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
	"github.com/google/uuid"
)

// Transfer queue state by session without copying model history.
func mergeCanvasAgentMessageQueues(current, incoming json.RawMessage, serverOnly bool, sessionID string) json.RawMessage {
	var stored, edited []map[string]any
	if json.Unmarshal(current, &stored) != nil || json.Unmarshal(incoming, &edited) != nil {
		return current
	}
	changed := false
	for _, session := range stored {
		id, ok := session["id"].(string)
		if !ok || sessionID != "" && id != sessionID {
			continue
		}
		for _, edit := range edited {
			editedID, ok := edit["id"].(string)
			if !ok || id != editedID {
				continue
			}
			if queue, ok := edit["messageQueue"]; ok && (!serverOnly || agentMap(queue)["serverManaged"] == true) {
				if serverOnly && session["engine"] == "codex" && edit["engine"] != "codex" {
					copied := util.CopyMap(agentMap(queue))
					delete(copied, "serverManaged")
					queue = copied
				}
				session["messageQueue"] = queue
				changed = true
			}
			break
		}
	}
	if !changed {
		return current
	}
	data, _ := json.Marshal(stored)
	return data
}

func validateCanvasAgentMessageQueue(value any) bool {
	queue, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if _, ok = queue["paused"].(bool); !ok {
		return false
	}
	messages, ok := queue["messages"].([]any)
	if !ok || len(messages) > 16 {
		return false
	}
	ids := map[string]bool{}
	for _, value := range messages {
		message, ok := value.(map[string]any)
		if !ok {
			return false
		}
		id, idOK := message["id"].(string)
		text, textOK := message["text"].(string)
		_, dateOK := message["createdAt"].(string)
		references, refsOK := message["references"].([]any)
		if !idOK || id == "" || len(id) > 128 || ids[id] || !textOK || strings.TrimSpace(text) == "" || len(text) > canvasDocumentMaxPrompt || !dateOK || !refsOK || len(references) > 50 {
			return false
		}
		if value, present := message["readOnly"]; present {
			if _, ok := value.(bool); !ok {
				return false
			}
		}
		if value, present := message["modelRequestLimit"]; present {
			if limit, ok := util.StrictInt(value); !ok || limit < 0 || limit > 1000 {
				return false
			}
		}
		for _, reference := range references {
			ref, ok := reference.(map[string]any)
			if !ok {
				return false
			}
			if _, ok = ref["id"].(string); !ok {
				return false
			}
			if _, ok = ref["title"].(string); !ok {
				return false
			}
			if _, ok = ref["type"].(string); !ok {
				return false
			}
		}
		ids[id] = true
	}
	if steering, exists := queue["steeringId"]; exists {
		id, ok := steering.(string)
		if !ok || !ids[id] {
			return false
		}
	}
	return true
}

type CanvasAgentQueueMutation struct {
	SessionID string             `json:"sessionId"`
	Action    string             `json:"action"`
	MessageID string             `json:"messageId"`
	Message   map[string]any     `json:"message"`
	AfterRun  string             `json:"afterRunId"`
	Settings  CanvasAgentRequest `json:"settings"`
}

func (s *CanvasAgentService) UpdateQueue(identity Identity, project string, update CanvasAgentQueueMutation) (CanvasDocument, error) {
	document, err := s.changeQueue(identity, project, update.SessionID, "", func(doc CanvasDocument, session map[string]any, queue map[string]any) (bool, error) {
		items := util.AsMapSlice(queue["messages"])
		if session["engine"] == "codex" {
			return false, invalidCanvasDocument("当前对话由本地 Codex 执行")
		}
		target := update.MessageID
		if update.Action == "append" {
			if !validateCanvasAgentMessageQueue(map[string]any{"paused": false, "messages": []any{update.Message}}) {
				return false, invalidCanvasDocument("无效的排队消息")
			}
			target = util.Clean(update.Message["id"])
			if target == "" {
				return false, invalidCanvasDocument("排队消息缺少标识")
			}
			references := append([]map[string]any{}, util.AsMapSlice(update.Message["references"])...)
			for _, ref := range references {
				if !slices.Contains([]string{"image", "panorama", "text", "video", "audio", "config", "director", "script", "group"}, util.Clean(ref["type"])) {
					return false, invalidCanvasDocument("无效的排队消息引用")
				}
				if ref["source"] != "attachment" {
					delete(ref, "source")
				}
				for _, key := range []string{"label", "url", "storageKey", "mimeType", "text"} {
					if _, ok := ref[key].(string); !ok {
						delete(ref, key)
					}
				}
				delete(ref, "dataUrl")
			}
			cleaned := make([]any, 0, len(references))
			for _, ref := range references {
				cleaned = append(cleaned, ref)
			}
			message := map[string]any{"id": target, "text": util.Clean(update.Message["text"]), "createdAt": update.Message["createdAt"], "references": cleaned, "readOnly": update.Message["readOnly"] == true}
			if limit, present := update.Message["modelRequestLimit"]; present {
				message["modelRequestLimit"] = limit
			}
			update.Message = message
		}
		index := slices.IndexFunc(items, func(item map[string]any) bool { return item["id"] == target })
		switch update.Action {
		case "append":
			if index >= 0 || canvasQueueMessageUsed(session, target) {
				return false, nil
			}
			if len(items) >= 16 {
				return false, invalidCanvasDocument("最多排队 16 条消息")
			}
			if text := util.Clean(update.Message["text"]); canvasAgentHistoryMention.MatchString(text) {
				sessions, _, err := agentSession(doc, update.SessionID)
				if err != nil {
					return false, err
				}
				history, err := captureCanvasAgentHistoryReferences(sessions, update.SessionID, text)
				if err != nil {
					return false, err
				}
				update.Message["historyReference"] = history
			}
			queue["messages"] = append(items, update.Message)
		case "steer":
			if len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
				return false, invalidCanvasDocument("请先回答或取消当前问题，再引导对话")
			}
			if index < 0 {
				return false, nil
			}
			queue["steeringId"] = target
			queue["paused"] = false
		case "remove":
			if index < 0 {
				return false, nil
			}
			removeCanvasQueuedMessage(queue, items, index)
		case "pause":
			queue["paused"] = true
			delete(queue, "steeringId")
		case "resume", "unpause":
			queue["paused"] = false
		default:
			return false, invalidCanvasDocument("无效的队列操作")
		}
		return true, nil
	})
	if err != nil || document.AgentRun == nil || document.AgentRun.SessionID != update.SessionID || update.Settings.Model == "" {
		return document, err
	}
	if update.Action == "resume" || update.Action == "steer" || update.Action == "append" && document.AgentRun.ID == update.AfterRun && document.AgentRun.Status == "success" {
		settings := queuedCanvasRunSettings(update.Settings, document.AgentRun.ID, update.SessionID, update.Action == "resume" || update.Action == "steer")
		return s.Start(identity, project, settings)
	}
	return document, nil
}

func (s *CanvasAgentService) changeQueue(identity Identity, project, sessionID, lease string, change func(CanvasDocument, map[string]any, map[string]any) (bool, error)) (CanvasDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := canvasAgentOwner(identity)
	for attempt := 0; attempt < canvasWorkspaceSaveAttempts; attempt++ {
		doc, err := s.canvas.Project(owner, project)
		if err != nil {
			return doc, err
		}
		sessions, session, err := agentSession(doc, sessionID)
		if err != nil {
			return doc, err
		}
		queue := agentMap(session["messageQueue"])
		if queue["messages"] == nil {
			queue["messages"] = []any{}
			queue["paused"] = false
		}
		changed, err := change(doc, session, queue)
		if err != nil || !changed {
			return doc, err
		}
		queue["serverManaged"] = true
		session["messageQueue"] = queue
		doc.AgentSessions, err = json.Marshal(sessions)
		if err != nil {
			return doc, err
		}
		var saved CanvasDocument
		if lease == "" {
			saved, err = s.canvas.saveWithAgent(owner, doc, &doc.Revision, true, "", sessionID)
		} else {
			saved, err = s.canvas.saveAgentWithLease(owner, doc, lease)
		}
		if err == nil {
			s.notifyProgress(identity, project)
			return saved, nil
		}
		if !errors.Is(err, ErrCanvasRevisionConflict) {
			return saved, err
		}
	}
	return CanvasDocument{}, ErrCanvasRevisionConflict
}

func canvasQueueMessageUsed(session map[string]any, id string) bool {
	return slices.ContainsFunc(util.AsMapSlice(session["messages"]), func(message map[string]any) bool {
		return message["queueMessageId"] == id
	})
}

func removeCanvasQueuedMessage(queue map[string]any, items []map[string]any, index int) {
	if queue["steeringId"] == items[index]["id"] {
		delete(queue, "steeringId")
	}
	queue["messages"] = slices.Delete(items, index, index+1)
}

func canvasQueuedUserMessage(item map[string]any, id string) map[string]any {
	return map[string]any{"id": id, "role": "user", "text": item["text"], "status": "success", "queueMessageId": item["id"], "references": item["references"]}
}

func queuedCanvasRunSettings(settings CanvasAgentRequest, afterRun, session string, resume bool) CanvasAgentRequest {
	settings.SessionID = session
	settings.queueAfterRun = afterRun
	settings.queueResume = resume
	settings.Resume = false
	settings.Edit = false
	settings.MediaChoice = ""
	settings.GoalContinuation = 0
	settings.goalRevision = ""
	settings.goalMediaRestricted = false
	return settings
}

// Admission and queue removal are saved with the new run in a single revision.
func admitCanvasQueuedRun(doc CanvasDocument, req *CanvasAgentRequest) (CanvasDocument, bool, error) {
	run := doc.AgentRun
	if run == nil || run.ID != req.queueAfterRun || run.SessionID != req.SessionID || run.Status == "running" || run.Status != "success" && !req.queueResume {
		return doc, false, nil
	}
	sessions, session, err := agentSession(doc, req.SessionID)
	if err != nil {
		return doc, false, err
	}
	if session["engine"] == "codex" || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
		return doc, false, nil
	}
	queue := agentMap(session["messageQueue"])
	items := util.AsMapSlice(queue["messages"])
	if queue["paused"] == true || len(items) == 0 {
		return doc, false, nil
	}
	index := slices.IndexFunc(items, func(item map[string]any) bool { return item["id"] == queue["steeringId"] })
	if index < 0 {
		index = 0
	}
	item := items[index]
	req.ID = "queue-" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(req.SessionID+"\x00"+util.Clean(item["id"]))).String()
	req.UserMessageID, req.AssistantID = req.ID+"-user", req.ID+"-assistant"
	req.UserText = util.Clean(item["text"])
	req.ReadOnly = item["readOnly"] == true
	if limit, present := item["modelRequestLimit"]; present {
		req.ModelRequestLimit = util.ToInt(limit, 0)
	}
	req.References = util.AsMapSlice(item["references"])
	req.historyReference = ""
	if queue["serverManaged"] == true {
		req.historyReference, _ = item["historyReference"].(string)
	}
	req.SelectedNodeIDs = nil
	messages := util.AsMapSlice(session["messages"])
	session["messages"] = append(messages, canvasQueuedUserMessage(item, req.UserMessageID), map[string]any{
		"id": req.AssistantID, "role": "assistant", "text": "", "status": "thinking", "replyToMessageID": req.UserMessageID,
	})
	removeCanvasQueuedMessage(queue, items, index)
	queue["serverManaged"] = true
	doc.AgentSessions, err = json.Marshal(sessions)
	return doc, true, err
}

// Admission of a steering message is recorded in the visible transcript before
// the worker projects it into private history. Its ID is stable across resume.
func (w *canvasAgentWorker) steeringMessages() ([]map[string]any, error) {
	if w.conversation || w.goalRoundPending || len(agentMap(w.state["pendingQuestion"])) > 0 {
		return nil, nil
	}
	_, stored, err := agentSession(w.doc, w.req.SessionID)
	if err != nil {
		return nil, err
	}
	if agentMap(stored["messageQueue"])["steeringId"] != nil {
		doc, err := w.service.changeQueue(w.identity, w.doc.ID, w.req.SessionID, w.req.leaseToken, func(doc CanvasDocument, session, queue map[string]any) (bool, error) {
			if doc.AgentRun == nil || doc.AgentRun.ID != w.req.ID || queue["paused"] == true || queue["serverManaged"] != true {
				return false, nil
			}
			items := util.AsMapSlice(queue["messages"])
			id := util.Clean(queue["steeringId"])
			if id == "" {
				return false, nil
			}
			index := slices.IndexFunc(items, func(item map[string]any) bool { return item["id"] == id })
			if index < 0 {
				return false, nil
			}
			if items[index]["readOnly"] == true && !w.readOnly || util.ToInt(items[index]["modelRequestLimit"], w.req.ModelRequestLimit) != w.req.ModelRequestLimit {
				return false, nil
			}
			if !canvasQueueMessageUsed(session, id) {
				messages := util.AsMapSlice(session["messages"])
				position := slices.IndexFunc(messages, func(message map[string]any) bool { return message["id"] == w.req.AssistantID })
				if position < 0 {
					return false, invalidCanvasDocument("找不到待引导的 Agent 回复")
				}
				message := canvasQueuedUserMessage(items[index], uuid.NewString())
				if history, ok := items[index]["historyReference"].(string); ok {
					message["historyReference"] = history
				}
				message["steeringAssistantId"] = w.req.AssistantID
				session["messages"] = slices.Insert(messages, position, message)
			}
			removeCanvasQueuedMessage(queue, items, index)
			return true, nil
		})
		if err != nil {
			return nil, err
		}
		_, stored, err = agentSession(doc, w.req.SessionID)
		if err != nil {
			return nil, err
		}
		w.doc = doc
		w.persisted = cloneCanvasAgentDocument(doc)
		w.session["messages"] = stored["messages"]
	}
	var steering []map[string]any
	for _, message := range util.AsMapSlice(stored["messages"]) {
		if message["steeringAssistantId"] != w.req.AssistantID || message["role"] != "user" {
			continue
		}
		var references []map[string]any
		for _, reference := range util.AsMapSlice(message["references"]) {
			resolved, err := canvasAgentReference(w.doc, stored, util.Clean(reference["id"]), util.Clean(reference["source"]))
			if err == nil {
				references = append(references, resolved)
			}
		}
		history, _ := message["historyReference"].(string)
		steering = append(steering, map[string]any{"id": message["id"], "content": canvasAgentUserContentWithHistory(util.Clean(message["text"]), references, history)})
	}
	return steering, nil
}
