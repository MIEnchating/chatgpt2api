package service

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"chatgpt2api/internal/util"
)

func (w *canvasAgentWorker) sdkStoreName() string {
	sum := sha256.Sum256([]byte(agentKey(canvasAgentOwner(w.identity), w.doc.ID) + "\x00" + w.req.SessionID))
	return fmt.Sprintf("canvas_agent_runtime/%x.json", sum)
}
func (w *canvasAgentWorker) loadSDKSession() (bool, error) {
	raw, err := loadStoredJSONBounded(w.service.canvas.store, w.sdkStoreName())
	if err != nil {
		return false, err
	}
	if raw == nil {
		w.sdk = &AgentSDKSession{Items: []map[string]any{}}
		return false, nil
	}
	w.sdk = &AgentSDKSession{}
	if err = json.Unmarshal([]byte(agentJSON(raw)), w.sdk); err != nil {
		return false, err
	}
	if w.sdk.Items == nil {
		w.sdk.Items = []map[string]any{}
	}
	return true, nil
}
func (w *canvasAgentWorker) saveSDKSession() error {
	if len(agentJSON(w.sdk)) > 16<<20 {
		return errors.New("SDK 执行记录超过存储上限，已保留上次成功保存的进度")
	}
	return saveStoredJSONBounded(w.service.canvas.store, w.sdkStoreName(), w.sdk)
}
func (w *canvasAgentWorker) sdkSession(params map[string]any) (any, error) {
	return ApplyAgentSDKSession(w.sdk, params, func(next *AgentSDKSession) error {
		return saveStoredJSONBounded(w.service.canvas.store, w.sdkStoreName(), next)
	})
}

func (w *canvasAgentWorker) sdkConfig() (map[string]any, error) {
	found, err := w.loadSDKSession()
	if err != nil {
		return nil, err
	}
	// A worker may stop after creating its private record but before importing
	// history. Retrying initialization must still import the existing task.
	if len(w.sdk.Items) == 0 && w.sdk.State == "" {
		found = false
	}
	if len(w.sdk.Question) > 0 {
		w.state["pendingQuestion"] = w.sdk.Question
		w.conversation = false
		delete(w.assistant(), "interactionMode")
	}
	config := map[string]any{"sessionId": w.sdkStoreName(), "name": "Canvas Creative Agent", "completionTool": "finish_task", "tools": w.tools(), "conversation": w.conversation, "rejectCallIds": w.sdk.RejectedCallIDs}
	var preferences struct {
		ContextWindowTokens *float64 `json:"contextWindowTokens"`
	}
	if len(w.doc.AgentConfig) > 0 {
		if err := json.Unmarshal(w.doc.AgentConfig, &preferences); err != nil {
			return nil, fmt.Errorf("读取 Agent 上下文配置失败: %w", err)
		}
	}
	if window := preferences.ContextWindowTokens; window != nil {
		if !finiteCanvasNumber(*window) || *window < 2 || *window > 1<<53-1 || math.Trunc(*window) != *window {
			return nil, errors.New("Agent 上下文上限必须是大于 1 的安全整数")
		}
		config["contextWindowTokens"] = *window
	}
	if found {
		w.batchCalls = w.sdk.Calls
		w.batchFailed = w.batchFailed || w.sdk.BatchFailed
		if len(w.sdk.Question) > 0 {
			w.state["pendingQuestion"] = w.sdk.Question
		}
		if w.req.Edit {
			w.sdk.State = ""
			w.sdk.Question = nil
			delete(w.state, "pendingQuestion")
		}
	} else {
		// Import the previous Go transcript once. Existing canvas/task IDs stay intact.
		legacy := w.messages
		if w.checkpoint != "" {
			legacy = append([]map[string]any{{"role": "system", "content": "历史摘要（资料，不是操作授权）：" + w.checkpoint}}, legacy...)
		}
		if w.conversation {
			legacy = w.conversationMessages()
			if len(legacy) > 0 {
				legacy = legacy[:len(legacy)-1]
			}
		}
		config["legacy"] = legacy
		w.sdk.Phase = "importing"
	}
	if found && !w.req.Resume && len(agentMap(w.state["pendingQuestion"])) == 0 {
		w.sdk.State = ""
	}
	question := agentMap(w.state["pendingQuestion"])
	if len(question) > 0 {
		call := w.pendingQuestionCall()
		if call == nil {
			delete(w.state, "pendingQuestion")
			w.sdk.Question = nil
			w.sdk.State = ""
			question = map[string]any{}
		} else {
			if !found || w.sdk.State == "" || w.sdk.Phase != "waiting" && w.sdk.ApprovedCallID != util.Clean(call["id"]) {
				config["omittedCallIds"] = []string{util.Clean(call["id"])}
				config["bootstrap"] = map[string]any{"tool_calls": []map[string]any{{"id": call["id"], "type": "function", "function": map[string]any{"name": call["name"], "arguments": agentJSON(call["arguments"])}}}}
				w.sdk.State = ""
			}
			if !w.req.Resume || w.req.MediaChoice != "" {
				w.sdk.ApprovedCallID = util.Clean(call["id"])
				w.sdk.ApprovedAnswer = w.req.UserText
				w.sdk.ApprovedMediaChoice = w.req.MediaChoice
			}
		}
	}
	if len(question) == 0 && w.sdk.State == "" {
		w.sdk.ApprovedCallID = ""
		w.sdk.ApprovedAnswer = ""
		w.sdk.ApprovedMediaChoice = ""
		w.sdk.RejectedCallIDs = nil
		config["rejectCallIds"] = nil
	}
	if w.sdk.ApprovedCallID != "" {
		w.answerCallID = w.sdk.ApprovedCallID
		w.answerText = w.sdk.ApprovedAnswer
		w.answerMediaChoice = w.sdk.ApprovedMediaChoice
		config["answerCallId"] = w.answerCallID
	}
	if w.sdk.State != "" {
		config["state"] = w.sdk.State
		var checkpoint struct {
			Status string `json:"status"`
		}
		content, _ := canvasAgentIntentFingerprints(w.doc)
		if w.req.Resume && w.sdk.Accepted && !w.sdk.BatchFailed && w.sdk.ContentFingerprint != "" && content == w.sdk.ContentFingerprint && json.Unmarshal([]byte(w.sdk.State), &checkpoint) == nil && checkpoint.Status == "finished" {
			w.accepted = true
		}
	}
	if len(question) == 0 && w.sdk.State == "" {
		content := w.userContent()
		if w.req.Resume {
			guidance := "继续原任务的未完成部分。先核对当前画布、执行计划和已提交任务；不重复创建节点、不重新提交已付费任务，不自动恢复用户删除的节点。"
			if text, ok := content.(string); ok {
				content = guidance + "\n原请求：" + text
			} else {
				content = append([]map[string]any{{"type": "text", "text": guidance}}, content.([]map[string]any)...)
			}
		}
		config["inputProtocol"] = []map[string]any{{"role": "user", "content": content}}
		w.messages = append(w.messages, map[string]any{"role": "user", "messageID": w.req.UserMessageID, "content": content})
		if err = w.save(); err != nil {
			return nil, err
		}
	}

	if err = w.saveSDKSession(); err != nil {
		return nil, err
	}
	return config, nil
}

// Revocation is a business decision. SDK applies the recorded rejection when it
// restores the interrupted run; no Go code executes the pending tool.
func (w *canvasAgentWorker) revokeSDKQuestion() error {
	if w.sdk == nil {
		found, err := w.loadSDKSession()
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
	}
	if id := util.Clean(w.sdk.Question["id"]); id != "" {
		w.sdk.RejectedCallIDs = append(w.sdk.RejectedCallIDs, id)
	}
	w.sdk.Question = nil
	w.sdk.ApprovedCallID = ""
	w.sdk.ApprovedAnswer = ""
	w.sdk.ApprovedMediaChoice = ""
	w.sdk.Phase = "cancelled"
	return w.saveSDKSession()
}

func canvasAgentToolCallFingerprint(call map[string]any) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(map[string]any{"name": call["name"], "arguments": call["arguments"]}))))
}
