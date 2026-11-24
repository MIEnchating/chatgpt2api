package service

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"chatgpt2api/internal/util"
)

type CanvasAgentHistoryBranchRequest struct {
	SessionID string `json:"sessionId"`
	MessageID string `json:"messageId"`
	BranchID  string `json:"branchId"`
	Revision  int64  `json:"revision"`
}

func (s *CanvasAgentService) BranchHistory(identity Identity, project string, request CanvasAgentHistoryBranchRequest) (CanvasDocument, error) {
	if strings.TrimSpace(request.SessionID) == "" || strings.TrimSpace(request.MessageID) == "" || request.Revision < 0 {
		return CanvasDocument{}, invalidCanvasDocument("请选择要分支的消息")
	}
	if len(request.BranchID) == 0 || len(request.BranchID) > 128 || strings.ContainsAny(request.BranchID, "\x00 /\t\r\n") {
		return CanvasDocument{}, invalidCanvasDocument("无效的分支标识")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	owner := canvasAgentOwner(identity)
	if s.active[agentKey(owner, project)] != nil {
		return CanvasDocument{}, ErrCanvasAgentBusy
	}
	document, err := s.canvas.Project(owner, project)
	if err != nil {
		return document, err
	}
	if _, existing, err := agentSession(document, request.BranchID); err == nil {
		if existing["parentSessionId"] != request.SessionID || existing["forkAtMessageId"] != request.MessageID {
			return CanvasDocument{}, invalidCanvasDocument("分支标识已被使用")
		}
		return document, nil
	} else if !errors.Is(err, errCanvasAgentSessionNotFound) {
		return document, err
	}
	if document.Revision != request.Revision {
		return CanvasDocument{}, CanvasRevisionConflictError{Expected: request.Revision, Actual: document.Revision}
	}
	sessions, source, err := agentSession(document, request.SessionID)
	if err != nil {
		return CanvasDocument{}, err
	}
	messages := util.AsMapSlice(source["messages"])
	index := slices.IndexFunc(messages, func(message map[string]any) bool { return message["id"] == request.MessageID })
	if index < 0 || messages[index]["role"] != "user" && messages[index]["role"] != "assistant" {
		return CanvasDocument{}, invalidCanvasDocument("找不到所选对话消息")
	}

	inherited := make([]map[string]any, 0, index+1)
	protocol := make([]map[string]any, 0, index+1)
	for _, message := range messages[:index+1] {
		snapshot := util.CopyMap(message)
		delete(snapshot, "agentStateBefore")
		delete(snapshot, "contextCheckpointBefore")
		delete(snapshot, "feedback")
		delete(snapshot, "historyReference")
		delete(snapshot, "goalMediaRestricted")
		inherited = append(inherited, snapshot)
		role := util.Clean(message["role"])
		text := util.Clean(message["text"])
		if (role == "user" || role == "assistant") && text != "" {
			protocol = append(protocol, map[string]any{"role": role, "messageID": message["id"], "content": text})
		}
	}
	title := []rune(firstAgentString(util.Clean(source["title"]), "对话"))
	now := util.NowISO()
	branch := map[string]any{
		"id": request.BranchID, "title": string(title[:min(48, len(title))]) + " · 分支",
		"createdAt": now, "updatedAt": now, "engine": firstAgentString(util.Clean(source["engine"]), "native"),
		"parentSessionId": request.SessionID, "forkAtMessageId": request.MessageID, "inheritedMessageCount": len(inherited),
		"messages": inherited, "protocolMessages": protocol,
		"agentState": map[string]any{
			"phase": "intake", "approvedNodeIds": []string{}, "referenceNodeIds": []string{},
			"pendingTaskIds": []string{}, "completedTaskIds": []string{},
		},
	}
	if skills, present := source["activeSkillIds"]; present {
		branch["activeSkillIds"] = skills
	}
	document.AgentSessions, err = json.Marshal(append(sessions, branch))
	if err != nil {
		return CanvasDocument{}, err
	}
	document.ActiveAgentSessionID = request.BranchID
	return s.canvas.saveAgent(owner, document)
}
