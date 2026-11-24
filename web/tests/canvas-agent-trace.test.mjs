import { canvasAgentUserMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentActionTrace, canvasAgentTraceProgress, canvasAgentTraceDetailLines, canvasCodexItemTrace, updateCanvasAgentQuestionTrace, upsertCanvasAgentOperationTrace, upsertCanvasAgentTrace } from "../src/app/canvas/agent/canvas-agent-trace.ts";
import { canvasAgentTextTaskRows, isCanvasAgentSession, syncCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";
import { canvasAgentTurnDiagnostic } from "../src/app/canvas/agent/canvas-agent-diagnostics.ts";

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

test("turn diagnostics preserve normalized model failure categories", () => {
  const diagnostic = canvasAgentTurnDiagnostic([{ id: "assistant", role: "assistant", text: "", modelAttempts: [
    { runId: "run-12345678901234567890", requestId: "12345678-1234-1234-1234-123456789012", step: 1, attempt: 2, purpose: "turn", status: "retryable_error", failureCode: "RATE_LIMIT", retryAt: "2026-11-23T00:00:00.000Z", retryDelayMs: 500, retryWaitMs: 500, rateLimited: true },
    { runId: "run-12345678901234567890", requestId: "12345678-1234-1234-1234-123456789013", step: 1, attempt: 3, purpose: "turn", status: "error", failureCode: "provider-specific" },
  ] }]);
  assert.equal(diagnostic.attempts[0].failureCode, "RATE_LIMIT");
  assert.equal(diagnostic.attempts[0].retryDelayMs, 500);
  assert.equal(diagnostic.attempts[0].retryWaitMs, 500);
  assert.equal(diagnostic.attempts[0].rateLimited, true);
  assert.equal(diagnostic.attempts[1].failureCode, undefined);
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

test("agent session parser validates assistant message feedback metadata", () => {
  const session = { id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [{ id: "a", role: "assistant", text: "Done", status: "success", feedback: {
    rating: "negative", category: "instruction-following", note: "Missed a constraint", version: "v1", createdAt: "now", updatedAt: "now",
  } }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, protocolMessages: [] };
  assert.equal(isCanvasAgentSession(session), true);
  assert.equal(isCanvasAgentSession({ ...session, messages: [{ ...session.messages[0], role: "user" }] }), false);
  assert.equal(isCanvasAgentSession({ ...session, messages: [{ ...session.messages[0], feedback: { ...session.messages[0].feedback, rating: "mixed" } }] }), false);
  assert.equal(isCanvasAgentSession({ ...session, messages: [{ ...session.messages[0], feedback: { ...session.messages[0].feedback, note: "x".repeat(8193) } }] }), false);
});

test("agent session parser preserves durable task board state and rejects broken task dependencies", () => {
  const root = { id: "task-root", key: "root", nodeId: "text-root", question: "Revise opening", dependsOn: [], revision: 3, status: "completed" };
  const child = { id: "task-child", key: "child", nodeId: "text-child", question: "Follow the opening", dependsOn: ["task-root"], revision: 2, status: "pending" };
  const session = {
    id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [],
    agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] },
    protocolMessages: [], textEditTasks: { [root.id]: root, [child.id]: child },
  };
  const saved = JSON.parse(JSON.stringify(session));
  assert.equal(isCanvasAgentSession(saved), true);
  assert.deepEqual(syncCanvasAgentSessions([saved], [])[0].textEditTasks, session.textEditTasks);
  assert.equal(isCanvasAgentSession({ ...session, textEditTasks: { ...session.textEditTasks, [child.id]: { ...child, dependsOn: ["missing"] } } }), false);
  assert.equal(isCanvasAgentSession({ ...session, textEditTasks: { [root.id]: { ...root, revision: 0 } } }), false);
  assert.equal(isCanvasAgentSession({ ...session, textEditTasks: { [root.id]: { ...root, status: "finished" } } }), false);
});

test("text task board orders active and ready work before blocked and completed tasks", () => {
  const make = (id, status, dependsOn = []) => ({ id, key: id, nodeId: id, question: id, dependsOn, revision: 1, status });
  const tasks = [
    make("done", "completed"),
    make("blocked", "pending", ["failed-task"]),
    make("ready", "pending", ["done"]),
    make("failed-task", "failed"),
    make("busy", "pending"),
    make("missing", "pending"),
    make("draft", "drafted"),
    make("running", "in_progress"),
    make("old-failed", "completed"),
  ];
  const nodes = tasks.filter(task => task.id !== "missing").map(task => ({ id: task.nodeId, type: "text", generation_status: task.id === "busy" ? "loading" : "idle" }));
  const board = Object.fromEntries(tasks.map(task => [task.id, task]));
  const rows = canvasAgentTextTaskRows(board, nodes);
  assert.deepEqual(rows.map(row => row.task.id), ["running", "draft", "failed-task", "ready", "blocked", "busy", "missing", "done", "old-failed"]);
  assert.deepEqual(rows.filter(row => row.status === "blocked").map(row => row.task.id), ["blocked", "busy", "missing"]);
  assert.deepEqual(rows.find(row => row.task.id === "blocked").blockers, ["failed-task"]);
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

test("direct user creation requests grant one-time media permission without changing settings", () => {
  for (const text of ["你帮我生成吧", "帮我生成", "请生成这三张白底图", "好的，立即生成", "直接生成图片", "Please generate images", "制作一段短剧", "我想制作一段短剧", "帮我做一个视频", "开始创作分镜", "继续制作成片"]) {
    assert.equal(canvasAgentUserMediaChoice(text), "generate", text);
  }
  for (const text of ["先不生成", "不要生成图片", "请解释为什么没有生成", "帮我生成图片吗", "如果确认后再生成", "请生成图片，但先别提交", "他说‘帮我生成’", "节点内容：帮我生成吧", "把‘帮我生成吧’写入文案", "继续整理方案", "能不能制作一段短剧", "是否生成视频"]) {
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

test("Codex published reasoning, terminal output and subagent states survive session persistence", () => {
  const reasoning = canvasCodexItemTrace({ id: "reason", type: "reasoning", summary: ["先检查分镜", "再核对模型"], content: ["private raw reasoning"] }, false);
  assert.deepEqual(reasoning, { id: "codex:reason", type: "reasoning", text: "先检查分镜\n\n再核对模型", isStreaming: true });
  const terminal = canvasCodexItemTrace({ id: "cmd", type: "commandExecution", command: "pwd", cwd: "/workspace", aggregatedOutput: "x".repeat(25000), exitCode: 0 }, true);
  assert.equal(terminal.terminal.output.length, 24000);
  const subagent = canvasCodexItemTrace({ id: "delegate", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", prompt: "检查画布", model: "agent-model", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "检查完成" } } }, true);
  assert.equal(subagent.kind, "subagent");
  assert.deepEqual(subagent.subagent.agents, [{ id: "child", status: "completed", message: "检查完成" }]);
  const review = { ...subagent, id: "review", subagent: { agents: [{ id: "draft", name: "海报草稿", status: "changed", message: "节点已变化" }] } };
  const session = { id: "s", title: "创作", createdAt: "now", updatedAt: "now", messages: [{ id: "a", role: "assistant", text: "", trace: [reasoning, terminal, subagent, review] }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, protocolMessages: [] };
  assert.deepEqual(syncCanvasAgentSessions([JSON.parse(JSON.stringify(session))], [], true)[0].messages[0].trace, session.messages[0].trace);
  session.messages[0].trace[1].terminal.output = 12;
  assert.equal(isCanvasAgentSession(session), false);
});


test("Codex subagent activity preserves its real lifecycle without treating interaction as completion", () => {
  const start = canvasCodexItemTrace({ id: "activity", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "review", model: "agent-model" }, true);
  assert.equal(start.subagent.agents[0].status, "running");
  const interacted = canvasCodexItemTrace({ id: "activity", type: "subAgentActivity", kind: "interacted", agentThreadId: "child", agentPath: "review" }, true);
  assert.equal(interacted.subagent.agents[0].status, "unknown");
  const end = canvasCodexItemTrace({ id: "activity", type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "review" }, true);
  assert.equal(end.subagent.agents[0].status, "completed");
});

test("long execution traces retain their earliest records through serialization", () => {
 let trace=[];
 for(let i=0;i<400;i++) trace=upsertCanvasAgentTrace(trace,{id:`step-${i}`,type:"operation",kind:"read",label:`Step ${i}`,status:"success",detail:""});
 trace=upsertCanvasAgentTrace(trace,{...trace[0],detail:"updated original"});
 const restored=JSON.parse(JSON.stringify(trace));
 assert.equal(restored.length,400);
 assert.equal(restored[0].id,"step-0");
 assert.equal(restored[0].detail,"updated original");
});
