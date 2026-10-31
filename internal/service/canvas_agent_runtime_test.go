package service

import (
	"strings"
	"testing"
)

func TestContainsAny(t *testing.T) {
	if !containsAny("生成海报", "视频", "海报") {
		t.Fatal("containsAny() missed a matching part")
	}
	if containsAny("生成海报", "视频") || containsAny("anything") {
		t.Fatal("containsAny() matched without a matching part")
	}
}

func TestValidateAgentValueObjectRules(t *testing.T) {
	schema := map[string]any{
		"type":       "object",
		"required":   []any{"name"},
		"properties": map[string]any{"name": map[string]any{"type": "string", "maxLength": float64(5)}, "count": map[string]any{"type": "integer", "minimum": float64(1), "maximum": float64(3)}},
	}
	for name, testCase := range map[string]struct {
		value map[string]any
		valid bool
	}{
		"valid":             {map[string]any{"name": "abc", "count": float64(2)}, true},
		"missing required":  {map[string]any{"count": float64(2)}, false},
		"blank required":    {map[string]any{"name": "  "}, false},
		"unknown field":     {map[string]any{"name": "abc", "extra": true}, false},
		"string too long":   {map[string]any{"name": "abcdef"}, false},
		"wrong type":        {map[string]any{"name": float64(1)}, false},
		"fractional int":    {map[string]any{"name": "a", "count": 1.5}, false},
		"integer too small": {map[string]any{"name": "a", "count": float64(0)}, false},
		"integer too large": {map[string]any{"name": "a", "count": float64(4)}, false},
	} {
		if err := validateAgentValue(testCase.value, schema, "tool"); (err == nil) != testCase.valid {
			t.Errorf("%s: validateAgentValue() error = %v, want valid=%v", name, err, testCase.valid)
		}
	}
}

func TestValidateAgentValueArrayAndEnumRules(t *testing.T) {
	array := map[string]any{"type": "array", "minItems": float64(1), "maxItems": float64(2), "items": map[string]any{"type": "string"}}
	if err := validateAgentValue([]any{"a"}, array, "tool"); err != nil {
		t.Fatalf("valid array rejected: %v", err)
	}
	for name, value := range map[string]any{"empty": []any{}, "too many": []any{"a", "b", "c"}, "wrong item": []any{float64(1)}, "not array": "a"} {
		if err := validateAgentValue(value, array, "tool"); err == nil {
			t.Errorf("%s: invalid array accepted", name)
		}
	}
	enum := map[string]any{"type": "string", "enum": []any{"a", "b"}}
	if err := validateAgentValue("a", enum, "tool"); err != nil {
		t.Fatalf("enum member rejected: %v", err)
	}
	if err := validateAgentValue("c", enum, "tool"); err == nil {
		t.Fatal("value outside the enum accepted")
	}
	if err := validateAgentValue(strings.Repeat("x", 12001), map[string]any{"type": "string"}, "tool"); err == nil {
		t.Fatal("string above the global length limit accepted")
	}
	if err := validateAgentValue(strings.Repeat("x", 201), map[string]any{"type": "string"}, "tool.title"); err == nil {
		t.Fatal("title above 200 bytes accepted")
	}
}

func TestAgentCallsRejectsMalformedBatches(t *testing.T) {
	call := func(id, name, arguments string) map[string]any {
		return map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": arguments}}
	}
	if calls, err := agentCalls(nil); err != nil || len(calls) != 0 {
		t.Fatalf("agentCalls(nil) = (%v, %v), want empty", calls, err)
	}
	if _, err := agentCalls("not a list"); err == nil {
		t.Fatal("agentCalls accepted a non-list value")
	}
	tooMany := make([]map[string]any, 13)
	for index := range tooMany {
		tooMany[index] = call(string(rune('a'+index)), "x", "{}")
	}
	if _, err := agentCalls(tooMany); err == nil {
		t.Fatal("agentCalls accepted more than 12 calls")
	}
	for name, calls := range map[string][]map[string]any{
		"missing id":        {call("", "x", "{}")},
		"invalid arguments": {call("1", "x", "{")},
		"unknown tool":      {call("1", "definitely_not_a_tool", "{}")},
	} {
		if _, err := agentCalls(calls); err == nil {
			t.Errorf("%s: agentCalls accepted the batch", name)
		}
	}
}

func TestCanvasAgentToolsHideSkillReaderWithoutSkills(t *testing.T) {
	contains := func(tools []map[string]any, name string) bool {
		for _, tool := range tools {
			if agentMap(tool["function"])["name"] == name {
				return true
			}
		}
		return false
	}
	if !contains(agentTools, "read_skill_file") {
		t.Fatal("embedded tool catalog lost read_skill_file")
	}
	w := &canvasAgentWorker{}
	if contains(w.tools(), "read_skill_file") {
		t.Fatal("read_skill_file offered without selected skills")
	}
	w.skills = []AgentSkill{{ID: "s"}}
	if !contains(w.tools(), "read_skill_file") {
		t.Fatal("read_skill_file hidden despite selected skills")
	}
	w.conversation = true
	if len(w.tools()) != 0 {
		t.Fatal("conversation mode must not expose tools")
	}
}

func TestCanvasAgentRecordReplacesExistingToolResult(t *testing.T) {
	w := &canvasAgentWorker{messages: []map[string]any{{"role": "tool", "toolCallId": "c1", "content": "old"}}}
	call := map[string]any{"id": "c1", "name": "get_node"}
	w.record(call, map[string]any{"ok": true})
	if len(w.messages) != 1 || w.messages[0]["content"] == "old" {
		t.Fatalf("existing result was not replaced: %#v", w.messages)
	}
	w.record(map[string]any{"id": "c2", "name": "get_node"}, map[string]any{"ok": true})
	if len(w.messages) != 2 || w.messages[1]["toolCallId"] != "c2" {
		t.Fatalf("new result was not appended: %#v", w.messages)
	}
}

func TestCanvasAgentUserContentOnlyAttachesImageReferences(t *testing.T) {
	w := &canvasAgentWorker{req: CanvasAgentRequest{UserText: "请参考"}}
	if got := w.userContent(); got != "请参考" {
		t.Fatalf("userContent() without references = %#v", got)
	}
	w.req.References = []map[string]any{
		{"id": "a", "type": "text", "title": "note", "source": "attachment", "url": "https://example.test/n"},
		{"id": "b", "type": "image", "title": "pic", "source": "attachment", "url": "https://example.test/p.png"},
	}
	parts, ok := w.userContent().([]map[string]any)
	if !ok || len(parts) != 3 {
		t.Fatalf("userContent() = %#v, want text plus one labeled image", w.userContent())
	}
	if parts[2]["type"] != "image_url" || !strings.Contains(parts[0]["text"].(string), "引用资料") {
		t.Fatalf("unexpected parts: %#v", parts)
	}
}
