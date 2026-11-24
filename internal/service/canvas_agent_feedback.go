package service

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"

	"chatgpt2api/internal/util"
)

type CanvasAgentFeedbackInput struct {
	Rating   string `json:"rating"`
	Category string `json:"category,omitempty"`
	Note     string `json:"note,omitempty"`
}

type CanvasAgentFeedbackRequest struct {
	SessionID string                    `json:"sessionId"`
	MessageID string                    `json:"messageId"`
	IfVersion string                    `json:"ifVersion"`
	Feedback  *CanvasAgentFeedbackInput `json:"feedback"`
}

type canvasAgentFeedback struct {
	CanvasAgentFeedbackInput
	Version   string `json:"version"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

var ErrCanvasAgentFeedbackConflict = errors.New("该消息的反馈已在其他页面更新，请重新打开反馈")

func (s *CanvasAgentService) SaveMessageFeedback(identity Identity, projectID string, request CanvasAgentFeedbackRequest) (CanvasDocument, error) {
	if projectID == "" || request.SessionID == "" || request.MessageID == "" || len(request.IfVersion) > 128 {
		return CanvasDocument{}, invalidCanvasDocument("无效的消息反馈请求")
	}
	if input := request.Feedback; input != nil {
		if input.Rating != "positive" && input.Rating != "negative" || len(input.Note) > 8192 {
			return CanvasDocument{}, invalidCanvasDocument("无效的反馈评价或说明过长")
		}
		switch input.Category {
		case "", "task-result", "instruction-following", "product-interaction", "service-stability", "resource-cost", "security-privacy-permission", "other":
		default:
			return CanvasDocument{}, invalidCanvasDocument("无效的反馈分类")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := canvasAgentOwner(identity)
	if s.active[agentKey(owner, projectID)] != nil {
		return CanvasDocument{}, ErrCanvasAgentBusy
	}
	for attempt := 0; ; attempt++ {
		document, err := s.canvas.Project(owner, projectID)
		if err != nil {
			return CanvasDocument{}, err
		}
		if document.AgentRun != nil && document.AgentRun.Status == "running" {
			return CanvasDocument{}, ErrCanvasAgentBusy
		}
		changed, err := updateCanvasAgentFeedback(&document, request)
		if err != nil || !changed {
			return document, err
		}
		saved, err := s.canvas.saveAgent(owner, document)
		if !errors.Is(err, ErrCanvasRevisionConflict) || attempt+1 == canvasWorkspaceSaveAttempts {
			return saved, err
		}
	}
}

func updateCanvasAgentFeedback(document *CanvasDocument, request CanvasAgentFeedbackRequest) (bool, error) {
	var sessions []map[string]json.RawMessage
	if len(document.AgentSessions) > 0 {
		if err := json.Unmarshal(document.AgentSessions, &sessions); err != nil {
			return false, err
		}
	}
	for _, session := range sessions {
		var id string
		_ = json.Unmarshal(session["id"], &id)
		if id != request.SessionID {
			continue
		}
		var inherited int
		_ = json.Unmarshal(session["inheritedMessageCount"], &inherited)
		var messages []map[string]json.RawMessage
		if err := json.Unmarshal(session["messages"], &messages); err != nil {
			return false, err
		}
		for index, message := range messages {
			var messageID, role, status, text string
			_ = json.Unmarshal(message["id"], &messageID)
			if messageID != request.MessageID {
				continue
			}
			_ = json.Unmarshal(message["role"], &role)
			_ = json.Unmarshal(message["status"], &status)
			_ = json.Unmarshal(message["text"], &text)
			if index < inherited || role != "assistant" || strings.TrimSpace(text) == "" || status == "thinking" || status == "running" {
				break
			}
			var current canvasAgentFeedback
			if data := message["feedback"]; len(data) > 0 {
				if err := json.Unmarshal(data, &current); err != nil {
					return false, err
				}
			}
			if request.Feedback == nil && current.Version == "" {
				return false, nil
			}
			if current.Version != request.IfVersion {
				return false, ErrCanvasAgentFeedbackConflict
			}
			if request.Feedback == nil {
				delete(message, "feedback")
			} else {
				input := *request.Feedback
				input.Note = strings.TrimSpace(input.Note)
				if current.Version != "" && current.CanvasAgentFeedbackInput == input {
					return false, nil
				}
				now := util.NowISO()
				next := canvasAgentFeedback{CanvasAgentFeedbackInput: input, Version: uuid.NewString(), CreatedAt: firstAgentString(current.CreatedAt, now), UpdatedAt: now}
				message["feedback"], _ = json.Marshal(next)
			}
			session["messages"], _ = json.Marshal(messages)
			document.AgentSessions, _ = json.Marshal(sessions)
			return true, nil
		}
		break
	}
	return false, invalidCanvasDocument("找不到可评价的 Agent 回复")
}
