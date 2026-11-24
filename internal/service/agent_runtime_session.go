package service

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"chatgpt2api/internal/util"
)

// SDK history is private server state, independent of browser canvas snapshots.
type AgentSDKSession struct {
	ModelContext        json.RawMessage   `json:"modelContext,omitempty"`
	ReadOnly            bool              `json:"readOnly,omitempty"`
	Items               []map[string]any  `json:"items"`
	ContentFingerprint  string            `json:"contentFingerprint,omitempty"`
	LayoutFingerprint   string            `json:"layoutFingerprint,omitempty"`
	BatchFailed         bool              `json:"batchFailed,omitempty"`
	Accepted            bool              `json:"accepted,omitempty"`
	State               string            `json:"state,omitempty"`
	Calls               []map[string]any  `json:"calls,omitempty"`
	Transactions        map[string]string `json:"transactions,omitempty"`
	RunID               string            `json:"runId,omitempty"`
	Phase               string            `json:"phase,omitempty"`
	Question            map[string]any    `json:"question,omitempty"`
	ApprovedCallID      string            `json:"approvedCallId,omitempty"`
	ApprovedAnswer      string            `json:"approvedAnswer,omitempty"`
	ApprovedMediaChoice string            `json:"approvedMediaChoice,omitempty"`
	RejectedCallIDs     []string          `json:"rejectedCallIds,omitempty"`
	RetryWaitMS         int64             `json:"retryWaitMs,omitempty"`
}

// Carry a compacted projection forward once its source history is committed.
func (s *AgentSDKSession) retainCompactedContext(preferCheckpoint bool) error {
	if s.State == "" {
		return nil
	}
	var state struct {
		ModelContext json.RawMessage `json:"modelContext"`
	}
	if err := json.Unmarshal([]byte(s.State), &state); err != nil {
		return err
	}
	if len(state.ModelContext) == 0 {
		return nil
	}
	var projection struct {
		Through     int               `json:"through"`
		Compactions []json.RawMessage `json:"compactions"`
	}
	if err := json.Unmarshal(state.ModelContext, &projection); err != nil {
		return err
	}
	if len(projection.Compactions) == 0 || projection.Through <= 0 || projection.Through > len(s.Items) {
		return nil
	}
	var previous struct {
		Through int `json:"through"`
	}
	if len(s.ModelContext) > 0 {
		if err := json.Unmarshal(s.ModelContext, &previous); err != nil {
			return err
		}
		// Manual compaction may have replaced a projection at the same boundary.
		if previous.Through > projection.Through || previous.Through == projection.Through && !preferCheckpoint {
			return nil
		}
	}
	s.ModelContext = state.ModelContext
	return nil
}

// ApplyAgentSDKSession commits history transactions only after durable storage accepts them.
func ApplyAgentSDKSession(current *AgentSDKSession, params map[string]any, save func(*AgentSDKSession) error) (any, error) {
	// Commit a copy so failed persistence cannot acknowledge an uncommitted mutation.
	next := &AgentSDKSession{}
	if err := json.Unmarshal([]byte(agentJSON(current)), next); err != nil {
		return nil, err
	}
	var result any = map[string]any{"ok": true}
	switch params["action"] {
	case "get":
		items := next.Items
		if limit := util.ToInt(params["limit"], 0); limit > 0 && limit < len(items) {
			items = items[len(items)-limit:]
		}
		return items, nil
	case "append":
		next.Items = append(next.Items, util.AsMapSlice(params["items"])...)
	case "pop":
		if len(next.Items) == 0 {
			return nil, nil
		}
		result = next.Items[len(next.Items)-1]
		next.Items = next.Items[:len(next.Items)-1]
	case "clear":
		next.Items = []map[string]any{}
		next.Transactions = nil
	case "transaction":
		id := util.Clean(params["operationId"])
		transaction := agentMap(params["transaction"])
		if id == "" {
			return nil, errors.New("SDK 历史事务缺少 ID")
		}
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(transaction))))
		if previous, ok := next.Transactions[id]; ok {
			if previous != hash {
				return nil, errors.New("SDK 历史事务 ID 冲突")
			}
			return result, nil
		}
		switch transaction["type"] {
		case "append_items":
			next.Items = append(next.Items, util.AsMapSlice(transaction["items"])...)
		case "replace_suffix":
			suffix := util.AsMapSlice(transaction["expectedSuffix"])
			start := len(next.Items) - len(suffix)
			if start < 0 || agentJSON(next.Items[start:]) != agentJSON(suffix) {
				return nil, errors.New("SDK 历史事务尾部冲突")
			}
			next.Items = append(next.Items[:start], util.AsMapSlice(transaction["replacement"])...)
		default:
			return nil, errors.New("未知 SDK 历史事务")
		}
		if next.Transactions == nil {
			next.Transactions = map[string]string{}
		}
		next.Transactions[id] = hash
	case "mutate":
		for _, mutation := range util.AsMapSlice(params["mutations"]) {
			if mutation["type"] != "replace_function_call" {
				return nil, errors.New("未知 SDK 历史修改")
			}
			for i, item := range next.Items {
				if item["type"] == "function_call" && item["callId"] == mutation["callId"] {
					next.Items[i] = agentMap(mutation["replacement"])
				}
			}
		}
	default:
		return nil, errors.New("未知 SDK Session 操作")
	}
	if err := save(next); err != nil {
		return nil, err
	}
	*current = *next
	return result, nil
}
