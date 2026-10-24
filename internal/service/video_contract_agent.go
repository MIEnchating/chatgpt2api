package service

import (
	"context"
	"encoding/json"
	"fmt"
)

const VideoContractAgentMaxSteps = 12

type VideoContractAgentCall struct {
	ID        string
	Name      string
	Arguments string
}

type VideoContractAgentTurn struct {
	Text  string
	Calls []VideoContractAgentCall
}

type VideoContractAgent struct {
	Next         func(context.Context, []map[string]any, int) (VideoContractAgentTurn, error)
	Execute      func(context.Context, string, string) (string, bool, error)
	OnCorrection func(int, string)
}

// Run keeps tool execution sequential, bounded and cancellable. Tool failures
// are returned to the model as data; only the executor can accept completion.
func (a VideoContractAgent) Run(ctx context.Context, messages []map[string]any) error {
	seen := map[string]bool{}
	corrected := false
	for step := 1; step <= VideoContractAgentMaxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		turn, err := a.Next(ctx, messages, step)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(turn.Calls) != 1 {
			if step == VideoContractAgentMaxSteps {
				break
			}
			if corrected {
				return fmt.Errorf("分析模型在格式纠正后仍未每轮调用一个文档工具，请选择支持工具调用的文本模型")
			}
			corrected = true
			reason := fmt.Sprintf("上一轮返回了 %d 个工具调用，本轮未执行任何工具。请纠正格式：每轮必须且只能调用一个文档工具，不得仅返回文本或并行调用；继续当前任务。", len(turn.Calls))
			// Rejected calls never enter the tool protocol or execute side effects.
			if turn.Text != "" {
				messages = append(messages, map[string]any{"role": "assistant", "content": turn.Text})
			}
			messages = append(messages, map[string]any{"role": "user", "content": reason})
			if a.OnCorrection != nil {
				a.OnCorrection(step, reason)
			}
			continue
		}
		call := turn.Calls[0]
		if call.ID == "" || seen[call.ID] {
			return fmt.Errorf("分析模型返回了缺失或重复的工具调用编号")
		}
		seen[call.ID] = true
		messages = append(messages, map[string]any{
			"role": "assistant", "content": turn.Text,
			"tool_calls": []map[string]any{{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": call.Arguments}}},
		})
		output, done, toolErr := a.Execute(ctx, call.Name, call.Arguments)
		if err := ctx.Err(); err != nil {
			return err
		}
		if toolErr != nil {
			encoded, _ := json.Marshal(map[string]any{"error": toolErr.Error()})
			output = string(encoded)
		} else if done {
			return nil
		}
		messages = append(messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": output})
	}
	return fmt.Errorf("文档分析已达到 %d 轮上限，请缩小文档范围后重试", VideoContractAgentMaxSteps)
}
