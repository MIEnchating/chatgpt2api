package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCanvasAgentSessionMetadataBuildsBoundedTurnPreviews(t *testing.T) {
	prompt := "  首条   用户请求\n需要保留完整语义。  "
	response := strings.Repeat("最终回复 ", 40)
	raw, err := json.Marshal(map[string]any{
		"id": "session-1", "title": "创作", "createdAt": "created", "updatedAt": "updated",
		"messages": []map[string]any{
			{"role": "user", "text": prompt, "status": "success"},
			{"role": "assistant", "text": "中间输出", "status": "running", "elapsedMs": 900, "trace": []map[string]any{{"type": "operation"}}},
			{"role": "assistant", "text": response, "status": "success", "elapsedMs": 2500, "trace": []map[string]any{{"type": "operation"}, {"type": "operation"}}, "modelAttempts": []map[string]any{{"attempt": 1}, {"attempt": 2}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	summary, err := canvasAgentSessionMetadata(raw)
	if err != nil {
		t.Fatal(err)
	}
	if summary.PromptPreview != "首条 用户请求 需要保留完整语义。" {
		t.Fatalf("prompt preview = %q", summary.PromptPreview)
	}
	if len([]rune(summary.ResponsePreview)) != 96 || !strings.HasSuffix(summary.ResponsePreview, "…") {
		t.Fatalf("response preview is not bounded: %q", summary.ResponsePreview)
	}
	if summary.TurnCount != 1 || summary.ElapsedMs != 2500 || summary.OperationCount != 3 || summary.RetryCount != 1 {
		t.Fatalf("session stats = %+v", summary)
	}
}
