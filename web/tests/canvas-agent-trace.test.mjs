import { canvasAgentUserMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentActionTrace, canvasAgentTraceProgress, canvasAgentTraceDetailLines, canvasCodexItemTrace, updateCanvasAgentQuestionTrace, upsertCanvasAgentOperationTrace, upsertCanvasAgentTrace } from "../src/app/canvas/agent/canvas-agent-trace.ts";
import { isCanvasAgentSession, syncCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";

test("trace updates keep operation position and survive session serialization and refresh", () => {
  const intro = { id: "intro", type: "text", text: "先读取当前画布。" };
  const action = { id: "read", name: "get_canvas_summary", arguments: {} };
  let trace = upsertCanvasAgentTrace([intro], canvasAgentActionTrace(action, { ok: false, code: "execution_unknown" }));
  trace = upsertCanvasAgentTrace(trace, { id: "next", type: "text", text: "接着创建节点。" });
  trace = upsertCanvasAgentTrace(trace, canvasAgentActionTrace(action, { ok: true }));
  assert.deepEqual(trace.map((entry) => entry.id), ["intro", "tool:read", "next"]);
  assert.equal(trace[1].status, "success");
  const session = { id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [{ id: "a", role: "assistant", text: "", status: "running", trace }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, protocolMessages: [] };
  const saved = JSON.parse(JSON.stringify(session));
  assert.equal(isCanvasAgentSession(saved), true);
  const restored = syncCanvasAgentSessions([saved], [], true)[0];
  assert.deepEqual(restored.messages[0].trace, trace);
  assert.equal(restored.resumeAssistantMessageId, "a");
  saved.messages[0].trace[1].status = "pretend-success";
  assert.equal(isCanvasAgentSession(saved), false);
});

test("answered and cancelled questions update their original trace row and survive refresh", () => {
  const question = { id: "question-1", type: "question", question: "要生成角色图吗？" };
  const answered = updateCanvasAgentQuestionTrace([question], "question-1", { answer: "暂不生成", cancelled: false });
  assert.deepEqual(answered[0], { ...question, answer: "暂不生成", cancelled: false });
  const cancelled = updateCanvasAgentQuestionTrace([question], "question-1", { cancelled: true });
  assert.deepEqual(cancelled[0], { ...question, cancelled: true });
  const session = { id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [{ id: "a", role: "assistant", text: "", trace: answered }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, protocolMessages: [] };
  assert.deepEqual(syncCanvasAgentSessions([JSON.parse(JSON.stringify(session))], [], true)[0].messages[0].trace, answered);
});

test("canvas clicks add only the clicked node when the canvas has a multi-node selection", async () => {
  const { pendingCanvasAgentReferences } = await import("../src/app/canvas/agent/canvas-agent-reference.ts");
  const references = [
    { id: "a", nodeID: "a", kind: "image", label: "节点A", title: "节点A", active: true },
    { id: "b", nodeID: "b", kind: "image", label: "节点B", title: "节点B", active: true },
  ];
  assert.deepEqual(pendingCanvasAgentReferences(references, ["a", "b"], "b", [], new Set()), [references[1]]);
  assert.deepEqual(pendingCanvasAgentReferences(references, ["a", "b"], null, [], new Set()), []);
  assert.deepEqual(pendingCanvasAgentReferences(references, ["b"], "b", ["b"], new Set()), []);
  assert.deepEqual(pendingCanvasAgentReferences(references, ["b"], null, [], new Set(["b"])), []);
});

test("trace marks deferred and never-started work as waiting, not successful", () => {
  const action = { id: "image", name: "generate_image", arguments: { prompt: "杯子" } };
  assert.equal(canvasAgentActionTrace(action, { ok: true, nodeId: "n", submitted: false, status: "idle" }).status, "waiting");
  assert.equal(canvasAgentActionTrace(action, { ok: false, code: "execution_not_started" }).status, "waiting");
  assert.equal(canvasAgentActionTrace({ id: "resume", name: "generate_node", arguments: { nodeId: "n" } }, { ok: false, code: "execution_not_started" }).label, "等待继续生成");
});

test("canvas changes remain recoverable after trace persistence", () => {
  const trace = canvasAgentActionTrace({ id: "read", name: "get_node", arguments: { nodeId: "removed" } }, { ok: false, code: "canvas_changed", recoverable: true, message: "节点已移除，正在重新核对素材" });
  assert.equal(trace.status, "changed");
  assert.doesNotMatch(trace.label, /失败|正在/);
  const session = { id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [{ id: "a", role: "assistant", text: "", status: "running", trace: [trace] }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, protocolMessages: [] };
  assert.equal(isCanvasAgentSession(JSON.parse(JSON.stringify(session))), true);
});

test("Codex traces ignore reasoning and unsupported items and preserve actual failures", () => {
  assert.equal(canvasCodexItemTrace({ id: "reason", type: "reasoning", text: "hidden reasoning" }, true), undefined);
  assert.equal(canvasCodexItemTrace({ id: "unknown", type: "unknown" }, true), undefined);
  const result = canvasCodexItemTrace({ id: "cmd", type: "commandExecution", command: "false", exitCode: 1, status: "completed" }, true);
  assert.equal(result.status, "error");
  assert.equal(canvasCodexItemTrace({ id: "file", type: "fileChange", changes: [], status: "declined" }, true).status, "error");
  assert.ok(canvasCodexItemTrace({ id: "long", type: "commandExecution", command: "test", aggregatedOutput: "x".repeat(20000) }, true).detail.length <= 1200);
});

test("canvas inspection traces show concise useful result details", () => {
  const trace = canvasAgentActionTrace({ id: "summary", name: "get_canvas_summary", arguments: {} }, {
    ok: true, project: { title: "品牌项目" }, nodes: [{ title: "主海报", type: "image" }, { title: "副标题", type: "text" }],
  });
  assert.equal(trace.label, "读取了画布");
  assert.match(trace.detail, /画布：品牌项目/);
  assert.match(trace.detail, /找到 2 个节点：主海报、副标题/);
  assert.ok(trace.detail.length < 200);
});

test("operation details omit duplicate node title and ID when the node chip is shown", () => {
  const node = { id: "node-42", title: "FEINX | 宣传图执行提示词与排版稿" };
  const trace = canvasAgentActionTrace({ id: "create", name: "create_text_node", arguments: { title: node.title, content: "宣传图执行提示词与排版稿" } }, {
    ok: true, nodeId: node.id, node: { id: node.id, title: node.title, type: "text" },
  });
  assert.equal(trace.detail, "节点：FEINX | 宣传图执行提示词与排版稿（text）");
  assert.deepEqual(canvasAgentTraceDetailLines(trace.detail, node), []);
});

test("execution details omit repeated node titles and identifiers from the chip", () => {
  assert.deepEqual(canvasAgentTraceDetailLines("节点：FEINX | 宣传图（text）\n名称：FEINX | 宣传图\n提示词：产品白底图", { id: "node-42", title: "FEINX | 宣传图" }), ["提示词：产品白底图"]);
});


test("recovered media updates the original task row without adding a duplicate", () => {
  const initial = canvasAgentActionTrace({ id: "generation", name: "generate_image", arguments: { title: "杯子" } }, { ok: false, nodeId: "cup", taskId: "task-1", status: "loading", submitted: true });
  const recovered = canvasAgentActionTrace({ id: "resume", name: "generate_node", arguments: { nodeId: "cup" } }, { ok: true, nodeId: "cup", taskId: "task-1", status: "success", submitted: true });
  const trace = upsertCanvasAgentOperationTrace([initial], recovered);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].id, initial.id);
  assert.equal(trace[0].label, "生成任务已完成");
});

test("direct user generation requests grant permission without approving questions, quotes or refusals", () => {
  for (const text of ["你帮我生成吧", "帮我生成", "请生成这三张白底图", "好的，立即生成", "直接生成图片", "Please generate images"]) {
    assert.equal(canvasAgentUserMediaChoice(text), "generate", text);
  }
  for (const text of ["先不生成", "不要生成图片", "请解释为什么没有生成", "帮我生成图片吗", "如果确认后再生成", "请生成图片，但先别提交", "他说‘帮我生成’", "节点内容：帮我生成吧", "把‘帮我生成吧’写入文案", "继续整理方案"]) {
    assert.equal(canvasAgentUserMediaChoice(text), undefined, text);
  }
});

test("execution summaries show the latest action without an execution prefix", () => {
  assert.equal(canvasAgentTraceProgress([{ type: "operation", kind: "edit", status: "success", label: "更新了执行计划" }]), "更新了执行计划");
});

test("operation details omit status echoes and internal IDs without losing useful results", () => {
  const entry = { label: "正在读取生成配置", kind: "read" };
  for (const detail of ["操作已完成", "已完成。", "已保存到画布", "准备执行：正在读取生成配置", "已读取生成配置", "任务：canvas-agent-media-2fe403485177ae76201c206b", "任务ID: task-123", " \n\n"]) {
    assert.deepEqual(canvasAgentTraceDetailLines(detail, undefined, entry), []);
  }
  assert.deepEqual(canvasAgentTraceDetailLines("操作已完成\n任务：task-123\n画幅：3:4\n数量：1 张\n", undefined, entry), ["画幅：3:4", "数量：1 张"]);
  assert.deepEqual(canvasAgentTraceDetailLines("生成失败：余额不足，请更换密钥后重试。", undefined, entry), ["生成失败：余额不足，请更换密钥后重试。"]);
  for (const kind of ["command", "file"]) assert.deepEqual(canvasAgentTraceDetailLines("操作已完成\n任务：task-123", undefined, { label: "运行工具", kind }), ["操作已完成", "任务：task-123"]);
});

test("display filtering preserves raw task IDs used to merge repeated generation events", () => {
  const first = { id: "first", type: "operation", kind: "generate", label: "生成图片", status: "running", detail: "任务：task-123" };
  assert.deepEqual(canvasAgentTraceDetailLines(first.detail, undefined, first), []);
  const merged = upsertCanvasAgentOperationTrace([first], { ...first, id: "next", status: "success" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "first");
  assert.equal(merged[0].detail, "任务：task-123");
});
