package service

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestVideoContractAgentRepairsUsingToolResults(t *testing.T) {
	steps := 0
	agent := VideoContractAgent{
		Next: func(_ context.Context, history []map[string]any, step int) (VideoContractAgentTurn, error) {
			steps++
			if step == 2 && (history[len(history)-1]["role"] != "tool" || !strings.Contains(history[len(history)-1]["content"].(string), "missing duration")) {
				t.Fatal("tool failure was not fed back to model")
			}
			return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: fmt.Sprint(step), Name: "validate", Arguments: "{}"}}}, nil
		},
		Execute: func(_ context.Context, _, _ string) (string, bool, error) {
			if steps == 1 {
				return "", true, fmt.Errorf("missing duration")
			}
			return "done", true, nil
		},
	}
	if err := agent.Run(context.Background(), nil); err != nil || steps != 2 {
		t.Fatalf("steps=%d error=%v", steps, err)
	}
}

func TestVideoContractAgentBoundsAndCancellation(t *testing.T) {
	t.Run("step budget", func(t *testing.T) {
		count := 0
		agent := VideoContractAgent{Next: func(_ context.Context, _ []map[string]any, step int) (VideoContractAgentTurn, error) {
			return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: fmt.Sprint(step)}}}, nil
		}, Execute: func(context.Context, string, string) (string, bool, error) { count++; return "continue", false, nil }}
		if err := agent.Run(context.Background(), nil); err == nil || count != VideoContractAgentMaxSteps {
			t.Fatalf("count=%d error=%v", count, err)
		}
	})
	t.Run("cancel between response and tool", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		agent := VideoContractAgent{Next: func(context.Context, []map[string]any, int) (VideoContractAgentTurn, error) {
			cancel()
			return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: "call"}}}, nil
		}, Execute: func(context.Context, string, string) (string, bool, error) {
			t.Fatal("executed after cancellation")
			return "", false, nil
		}}
		if err := agent.Run(ctx, nil); err != context.Canceled {
			t.Fatalf("error=%v", err)
		}
	})
	for _, name := range []string{"missing call", "multiple calls", "duplicate id"} {
		t.Run(name, func(t *testing.T) {
			count := 0
			agent := VideoContractAgent{Next: func(context.Context, []map[string]any, int) (VideoContractAgentTurn, error) {
				calls := []VideoContractAgentCall{{ID: "same"}}
				if name == "missing call" {
					calls = nil
				}
				if name == "multiple calls" {
					calls = append(calls, VideoContractAgentCall{ID: "other"})
				}
				return VideoContractAgentTurn{Calls: calls}, nil
			}, Execute: func(context.Context, string, string) (string, bool, error) { count++; return "continue", false, nil }}
			if err := agent.Run(context.Background(), nil); err == nil || count > 1 {
				t.Fatalf("count=%d error=%v", count, err)
			}
		})
	}
}

func TestVideoContractAgentCorrectsToolCountOnce(t *testing.T) {
	t.Run("cancellation after correction", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		rounds := 0
		agent := VideoContractAgent{
			Next: func(context.Context, []map[string]any, int) (VideoContractAgentTurn, error) {
				rounds++
				return VideoContractAgentTurn{}, nil
			},
			OnCorrection: func(int, string) { cancel() },
			Execute: func(context.Context, string, string) (string, bool, error) {
				t.Fatal("executed rejected call")
				return "", false, nil
			},
		}
		if err := agent.Run(ctx, nil); err != context.Canceled || rounds != 1 {
			t.Fatalf("rounds=%d err=%v", rounds, err)
		}
	})
	t.Run("correction stays inside round budget", func(t *testing.T) {
		rounds, executions := 0, 0
		agent := VideoContractAgent{
			Next: func(_ context.Context, _ []map[string]any, step int) (VideoContractAgentTurn, error) {
				rounds++
				if step == 1 {
					return VideoContractAgentTurn{}, nil
				}
				return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: fmt.Sprint(step)}}}, nil
			},
			Execute: func(context.Context, string, string) (string, bool, error) {
				executions++
				return "continue", false, nil
			},
		}
		if err := agent.Run(context.Background(), nil); err == nil || rounds != VideoContractAgentMaxSteps || executions != VideoContractAgentMaxSteps-1 {
			t.Fatalf("rounds=%d executions=%d err=%v", rounds, executions, err)
		}
	})
	for _, count := range []int{0, 2} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			executed, corrections, rounds := 0, 0, 0
			agent := VideoContractAgent{
				Next: func(_ context.Context, history []map[string]any, step int) (VideoContractAgentTurn, error) {
					rounds++
					if step == 1 {
						calls := make([]VideoContractAgentCall, count)
						return VideoContractAgentTurn{Text: "检查文档", Calls: calls}, nil
					}
					last := history[len(history)-1]
					if last["role"] != "user" || !strings.Contains(last["content"].(string), "未执行任何工具") {
						t.Fatalf("missing correction: %#v", history)
					}
					for _, message := range history {
						if _, ok := message["tool_calls"]; ok {
							t.Fatal("rejected calls entered tool history")
						}
					}
					return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: "valid", Name: "finish"}}}, nil
				},
				Execute:      func(context.Context, string, string) (string, bool, error) { executed++; return "done", true, nil },
				OnCorrection: func(int, string) { corrections++ },
			}
			if err := agent.Run(context.Background(), nil); err != nil || executed != 1 || corrections != 1 || rounds != 2 {
				t.Fatalf("executed=%d corrections=%d rounds=%d error=%v", executed, corrections, rounds, err)
			}
		})
	}
	t.Run("budget is shared across successful tools", func(t *testing.T) {
		executed, rounds := 0, 0
		agent := VideoContractAgent{
			Next: func(_ context.Context, _ []map[string]any, step int) (VideoContractAgentTurn, error) {
				rounds++
				if step == 2 {
					return VideoContractAgentTurn{Calls: []VideoContractAgentCall{{ID: "valid"}}}, nil
				}
				return VideoContractAgentTurn{}, nil
			},
			Execute: func(context.Context, string, string) (string, bool, error) { executed++; return "continue", false, nil },
		}
		if err := agent.Run(context.Background(), nil); err == nil || executed != 1 || rounds != 3 {
			t.Fatalf("executed=%d rounds=%d error=%v", executed, rounds, err)
		}
	})
}
