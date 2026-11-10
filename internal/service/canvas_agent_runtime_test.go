package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestCanvasAgentCancelledQuestionNeverApprovesDeletion(t *testing.T) {
	w := memoryWorker(t, func(context.Context, Identity, AgentModelRequest) (map[string]any, error) {
		t.Error("a stopped run must not call the model")
		return agentTurn(), nil
	})
	w.doc.Nodes = []CanvasNode{{ID: "keep", Type: "text", Title: "保留", Prompt: "保留", GenerationStatus: "success", Width: 320, Height: 320, ScaleX: 1, ScaleY: 1}}
	w.messages = []map[string]any{{"role": "assistant", "toolCalls": []map[string]any{{"id": "delete", "name": "delete_node", "arguments": map[string]any{"nodeId": "keep"}}}}}
	w.state["pendingQuestion"] = map[string]any{"id": "delete", "purpose": "delete_node", "nodeId": "keep", "nodeFingerprint": w.deletionFingerprint("keep"), "question": "确认删除？", "reason": "删除确认", "request": "删除", "kind": "confirmation", "options": []string{}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.ctx, w.req.UserText = ctx, "确认删除"
	w.run()
	_, session, _ := agentSession(w.doc, w.req.SessionID)
	if w.doc.AgentRun.Status != "cancelled" || len(w.doc.Nodes) != 1 || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) != 0 || w.doc.AgentRun.SDKState != "" {
		t.Fatalf("stopped question approved or remained stuck: run=%+v, nodes=%d", w.doc.AgentRun, len(w.doc.Nodes))
	}
}

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

func TestAgentCallsPlanExplanationIsOptional(t *testing.T) {
	for name, explanation := range map[string]string{
		"omitted": "",
		"empty":   `"explanation":"",`,
		"blank":   `"explanation":"  ",`,
		"present": `"explanation":"确认需求后制作",`,
	} {
		t.Run(name, func(t *testing.T) {
			args := `{` + explanation + `"steps":[{"id":"brief","title":"确认需求","status":"in_progress"}]}`
			calls, err := agentCalls([]map[string]any{{"id": "plan", "function": map[string]any{"name": "update_plan", "arguments": args}}})
			if err != nil || len(calls) != 1 {
				t.Fatalf("plan rejected: calls=%v, error=%v", calls, err)
			}
		})
	}
	for name, args := range map[string]string{
		"missing steps": `{"explanation":"确认需求"}`,
		"empty steps":   `{"steps":[]}`,
		"null":          `{"explanation":null,"steps":[{"id":"brief","title":"确认需求","status":"pending"}]}`,
		"wrong type":    `{"explanation":42,"steps":[{"id":"brief","title":"确认需求","status":"pending"}]}`,
		"too long":      `{"explanation":"` + strings.Repeat("长", 501) + `","steps":[{"id":"brief","title":"确认需求","status":"pending"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := agentCalls([]map[string]any{{"id": "plan", "function": map[string]any{"name": "update_plan", "arguments": args}}}); err == nil {
				t.Fatal("invalid plan accepted")
			}
		})
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

func TestCanvasAgentPublicHistoryOmitsOldResponseCopiesWithoutChangingPrivateHistory(t *testing.T) {
	w := memoryWorker(t, nil)
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	w.sdk.State = "saved-sdk-checkpoint"
	for i := 0; i < 4; i++ {
		message := map[string]any{"role": "assistant", "content": "Original visible reply", "toolCalls": []map[string]any{{"id": "saved-call", "name": "update_node", "arguments": map[string]any{"nodeId": "video", "title": "Keep title"}}}, "responseItems": []map[string]any{{"type": "reasoning", "encrypted_content": strings.Repeat("opaque", 26000)}}}
		w.messages = append(w.messages, message, map[string]any{"role": "tool", "name": "update_node", "toolCallId": "saved-call", "content": `{"ok":true,"nodeId":"video"}`})
		w.sdk.Items = append(w.sdk.Items, message)
	}
	latest := map[string]any{"role": "assistant", "content": "Latest uncommitted reply", "reasoningContent": "latest reasoning", "responseItems": []map[string]any{{"type": "reasoning", "encrypted_content": "latest opaque value"}}}
	w.messages = append(w.messages, latest)
	if err := w.saveSDKSession(); err != nil {
		t.Fatal(err)
	}
	private, original := agentJSON(w.sdk), agentJSON(w.messages)
	w.session["protocolMessages"] = w.messages
	if len(agentJSON(w.session)) < canvasDocumentMaxAgentDataBytes {
		t.Fatal("fixture does not exceed the public session limit")
	}
	if err := w.save(); err != nil {
		t.Fatalf("public history copies blocked progress saving: %v", err)
	}
	_, saved, _ := agentSession(w.doc, w.req.SessionID)
	public := agentJSON(saved)
	if strings.Contains(public, strings.Repeat("opaque", 26000)) || !strings.Contains(public, "latest opaque value") || !strings.Contains(public, "saved-call") || !strings.Contains(public, "Original visible reply") {
		t.Fatal("public projection lost visible history, tool pairing or the uncommitted response")
	}
	if original != agentJSON(w.messages) || private != agentJSON(w.sdk) {
		t.Fatal("public history cleanup mutated the actual model or SDK history")
	}
	if _, err := w.loadSDKSession(); err != nil || private != agentJSON(w.sdk) {
		t.Fatalf("private SDK history was not preserved: %v", err)
	}
}

func TestCanvasAgentPublicToolJournalDoesNotBlockFinalSave(t *testing.T) {
	w := memoryWorker(t, nil)
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	w.sdk.State = "durable-checkpoint"
	for i := 0; i < 100; i++ {
		name := "get_canvas_summary"
		if i%2 == 0 {
			name = "update_script_node"
		}
		w.messages = append(w.messages, map[string]any{"role": "tool", "name": name, "toolCallId": fmt.Sprint(i), "content": agentJSON(map[string]any{"ok": true, "nodeId": "script-original", "status": "success", "node": map[string]any{"id": "script-original", "text": strings.Repeat("x", 6200)}})})
	}
	w.sdk.Items = w.messages
	if err := w.saveSDKSession(); err != nil {
		t.Fatal(err)
	}
	original, private := agentJSON(w.messages), agentJSON(w.sdk)
	if len(original) <= canvasDocumentMaxAgentDataBytes {
		t.Fatal("fixture must exceed the public journal limit")
	}
	if err := w.finish("success", "制作方案已保存，已有视频保持不变。"); err != nil {
		t.Fatalf("accumulated tool output blocked the final save: %v", err)
	}
	_, saved, _ := agentSession(w.doc, w.req.SessionID)
	if len(w.doc.AgentSessions) >= canvasDocumentMaxAgentDataBytes/2 || w.doc.AgentRun.Status != "success" {
		t.Fatalf("public journal was not reduced: bytes=%d status=%s", len(w.doc.AgentSessions), w.doc.AgentRun.Status)
	}
	for _, message := range util.AsMapSlice(saved["protocolMessages"]) {
		result := map[string]any{}
		if err := json.Unmarshal([]byte(util.Clean(message["content"])), &result); err != nil || result["ok"] != true || result["nodeId"] != "script-original" || result["detailsOmitted"] != true {
			t.Fatalf("tool identity or result lost: %v %v", result, err)
		}
	}
	if original != agentJSON(w.messages) || private != agentJSON(w.sdk) {
		t.Fatal("public projection changed the full execution history")
	}
}

func TestCanvasAgentPublicJournalKeepsErrorsAndApprovals(t *testing.T) {
	for _, result := range []map[string]any{
		{"ok": false, "message": strings.Repeat("diagnostic", 150)},
		{"ok": true, "requiresUserReview": true, "question": strings.Repeat("review", 250)},
	} {
		w := memoryWorker(t, nil)
		if _, err := w.loadSDKSession(); err != nil {
			t.Fatal(err)
		}
		w.sdk.State = "checkpoint"
		original := agentJSON(result)
		w.messages = []map[string]any{{"role": "tool", "content": original}}
		if err := w.save(); err != nil {
			t.Fatal(err)
		}
		_, saved, _ := agentSession(w.doc, w.req.SessionID)
		if got := util.AsMapSlice(saved["protocolMessages"])[0]["content"]; got != original {
			t.Fatalf("public journal lost an error or approval: %v", got)
		}
	}
}

func TestCanvasAgentPublicJournalKeepsToolContentWithoutPrivateCheckpoint(t *testing.T) {
	w := memoryWorker(t, nil)
	original := agentJSON(map[string]any{"ok": true, "node": map[string]any{"id": "script", "text": strings.Repeat("body", 1200)}})
	w.messages = []map[string]any{{"role": "tool", "content": original}}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	_, saved, _ := agentSession(w.doc, w.req.SessionID)
	if got := util.AsMapSlice(saved["protocolMessages"])[0]["content"]; got != original {
		t.Fatalf("tool history without a private checkpoint was trimmed: %v", got)
	}
}

func TestCanvasAgentSnapshotReclaimsSavedResponseCopiesBeforeNextUserMessage(t *testing.T) {
	w := memoryWorker(t, nil)
	if _, err := w.loadSDKSession(); err != nil {
		t.Fatal(err)
	}
	old := map[string]any{"role": "assistant", "content": "Visible original reply", "responseItems": []map[string]any{{"type": "reasoning", "encrypted_content": strings.Repeat("opaque", 65000)}}}
	w.sdk.Items = []map[string]any{old}
	if err := w.saveSDKSession(); err != nil {
		t.Fatal(err)
	}
	private := agentJSON(w.sdk)
	sessions, session, _ := agentSession(w.doc, w.req.SessionID)
	toolContent := agentJSON(map[string]any{"ok": true, "nodeId": "original-script", "node": map[string]any{"id": "original-script", "text": strings.Repeat("body", 1200)}})
	session["protocolMessages"] = []map[string]any{old, {"role": "tool", "content": toolContent}, {"role": "assistant", "content": "Latest reply"}}
	w.doc.AgentSessions, _ = json.Marshal(sessions)
	w.doc.AgentRun.Status = "error"
	if len(w.doc.AgentSessions) <= canvasDocumentMaxAgentDataBytes/2 {
		t.Fatal("fixture does not exercise the near-limit cleanup")
	}
	if _, err := w.service.canvas.saveAgent(w.identity.ID, w.doc); err != nil {
		t.Fatal(err)
	}
	doc, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil || len(doc.AgentSessions) > canvasDocumentMaxAgentDataBytes/2 || !strings.Contains(string(doc.AgentSessions), "Visible original reply") {
		t.Fatalf("snapshot did not release room for the next request: %v", err)
	}
	_, compacted, _ := agentSession(doc, w.req.SessionID)
	if got := util.Clean(util.AsMapSlice(compacted["protocolMessages"])[1]["content"]); strings.Contains(got, "bodybody") || !strings.Contains(got, "original-script") {
		t.Fatalf("snapshot did not compact the tool body while preserving its identity: %s", got)
	}
	again, err := w.service.Snapshot(w.identity, w.doc.ID)
	if err != nil || again.Revision != doc.Revision {
		t.Fatalf("repeated snapshot rewrote an unchanged journal: %v", err)
	}
	if _, err := w.loadSDKSession(); err != nil || agentJSON(w.sdk) != private {
		t.Fatalf("snapshot changed private execution history: %v", err)
	}
}

func TestCanvasAgentRecordKeepsToolResultsBeforeLaterContext(t *testing.T) {
	call := map[string]any{"id": "question", "name": "ask_user_question"}
	w := &canvasAgentWorker{messages: []map[string]any{
		{"role": "assistant", "toolCalls": []map[string]any{call}},
		{"role": "system", "content": "原素材已移除，请按当前画布继续"},
		{"role": "user", "content": "用户的真实回答"},
	}}
	w.record(call, map[string]any{"ok": true, "answer": "用户的真实回答"})
	if len(w.messages) != 4 || w.messages[1]["role"] != "tool" || w.messages[2]["role"] != "system" || w.messages[3]["role"] != "user" || !canvasAgentCompleteToolRounds(w.messages) {
		t.Fatalf("tool answer was separated from its call: %v", w.messages)
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

func TestCanvasAgentStorageLimitIsNotReportedAsModelContextLimit(t *testing.T) {
	w := memoryWorker(t, nil)
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	w.messages = []map[string]any{{"role": "tool", "content": strings.Repeat("large receipt", 50000)}}
	if err := w.finish("success", "done"); err == nil {
		t.Fatal("oversized public session unexpectedly saved")
	}
	saved, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AgentRun.Status != "error" || !strings.Contains(saved.AgentRun.Error, "512 KB 存储上限") || !strings.Contains(saved.AgentRun.Error, "与模型上下文 token 上限无关") {
		t.Fatalf("storage failure conflated with model context: %+v", saved.AgentRun)
	}
}
