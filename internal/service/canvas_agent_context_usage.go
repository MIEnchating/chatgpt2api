package service

import (
	"encoding/json"
	"errors"
	"math"

	"chatgpt2api/internal/util"
)

// Publish the exact SDK filter estimate and budget, never private model inputs.
func (w *canvasAgentWorker) updateContextUsage(params map[string]any) error {
	value, exists := params["contextUsage"]
	if !exists {
		return nil
	}
	usage, ok := value.(map[string]any)
	if !ok {
		return errors.New("SDK 上下文统计无效")
	}
	used, usedOK := usage["usedTokens"].(float64)
	limit, limitOK := usage["maxTokens"].(float64)
	compacting, compactingOK := usage["compacting"].(bool)
	if !usedOK || !limitOK || !compactingOK || !finiteCanvasNumber(used) || !finiteCanvasNumber(limit) || used < 0 || limit <= 0 || used > 1<<53-1 || limit > 1<<53-1 || math.Trunc(used) != used || math.Trunc(limit) != limit {
		return errors.New("SDK 上下文统计无效")
	}
	previous := agentMap(w.session["contextUsage"])
	w.session["contextUsage"] = map[string]any{"model": w.req.Model, "usedTokens": used, "maxTokens": limit, "compacting": compacting, "basis": "compression-budget"}
	if previous["model"] == w.req.Model && previous["usedTokens"] == used {
		if tokens, ok := previous["inputTokens"]; ok {
			agentMap(w.session["contextUsage"])["inputTokens"] = tokens
		}
	}
	return nil
}

func (w *canvasAgentWorker) recordModelInputUsage(result map[string]any) {
	usage := agentMap(result["usage"])
	for _, key := range []string{"input_tokens", "prompt_tokens"} {
		value, exists := usage[key]
		if !exists {
			continue
		}
		var tokens float64
		switch number := value.(type) {
		case float64:
			tokens = number
		case int:
			tokens = float64(number)
		case int64:
			tokens = float64(number)
		case json.Number:
			var err error
			tokens, err = number.Float64()
			if err != nil {
				return
			}
		default:
			return
		}
		if !finiteCanvasNumber(tokens) || tokens < 0 || math.Trunc(tokens) != tokens || tokens > 1<<53-1 {
			return
		}
		context := agentMap(w.session["contextUsage"])
		if util.Clean(context["model"]) == w.req.Model {
			context["inputTokens"] = tokens
		}
		return
	}
}
