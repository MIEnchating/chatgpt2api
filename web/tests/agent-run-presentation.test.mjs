import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canvasAgentMessageRunStatus } from "../src/app/canvas/agent/canvas-agent-run-state.ts";
import { canvasAgentToolMessage } from "../src/app/canvas/agent/canvas-agent-presentation.ts";
import { Task } from "../src/components/ai-elements/task.tsx";
import { Tool, ToolDetails } from "../src/components/ai-elements/tool.tsx";
import { RunStatus } from "../src/components/ai-elements/run-status.tsx";
import { CanvasAgentQuestionCard } from "../src/app/canvas/canvas-agent-interaction.tsx";
import { CanvasAgentExecution } from "../src/app/canvas/canvas-agent-execution.tsx";
import { CanvasAgentExecutionTrace } from "../src/app/canvas/canvas-agent-execution-trace.tsx";
import { ImageResults } from "../src/app/image/components/image-results.tsx";
import { Conversation } from "../src/components/ai-elements/conversation.tsx";
import { TooltipProvider } from "../src/components/ui/tooltip.tsx";

const render = (component, props, ...children) => renderToStaticMarkup(createElement(component, props, ...children));

test("video results preserve queued, saving, stopped and recoverable failure states", () => {
 const now = "2026-11-10T00:00:00Z";
 const scenarios = [
  { status: "loading", taskStatus: "queued", runStatus: "waiting", title: "视频排队中" },
  { status: "loading", taskStatus: "running", runStatus: "running", title: "正在生成视频" },
  { status: "loading", taskStatus: "running", taskProgress: 0, runStatus: "running", title: "正在生成视频" },
  { status: "loading", taskStatus: "running", taskProgress: 42, runStatus: "running", title: "正在生成视频" },
  { status: "loading", taskStatus: "running", taskProgress: 100, runStatus: "running", title: "正在保存视频", body: "正在获取生成结果" },
  { status: "error", runStatus: "error", title: "视频生成失败", body: "重试视频生成", error: "isolated failure" },
  { status: "error", canRecoverVideo: true, runStatus: "error", title: "原视频任务待恢复", body: "恢复原任务", error: "isolated save failure" },
  { status: "cancelled", canRecoverVideo: true, runStatus: "cancelled", title: "原视频任务待恢复", body: "恢复原任务" },
  { status: "cancelled", runStatus: "cancelled", title: "视频生成已终止", body: "此视频任务已停止" },
 ];
 for (const scenario of scenarios) {
  const turn = { id: "turn", createdAt: now, processingStartedAt: now, prompt: "隔离视频提示词", model: "isolated-video", mode: "video", size: "auto", count: 1, status: scenario.status === "loading" ? scenario.taskStatus === "queued" ? "queued" : "generating" : scenario.status, referenceImages: [], images: [{ id: "video", mediaType: "video", ...scenario }] };
  const html = render(TooltipProvider, {}, createElement(Conversation, {}, createElement(ImageResults, {
   conversationId: "conversation", selectedConversation: { id: "conversation", turns: [turn] }, progressByTurnKey: { "conversation:turn": { message: "正在生成视频" } }, progressNow: Date.parse(now) + 12000, formatConversationTime: () => "刚刚",
  })));
  if (scenario.status === "loading") {
   assert.match(html, /aria-label="视频 1"/);
   assert.doesNotMatch(html, /data-ai-element="run-status"/);
  } else {
   assert.match(html, new RegExp(`data-ai-element="run-status" data-status="${scenario.runStatus}"`));
   assert.ok(html.includes("视频 1 · isolated-video"));
   assert.match(html, /data-slot="card-footer"/);
  }
  assert.ok(html.includes(scenario.title), scenario.title);
  if (scenario.body) assert.ok(html.includes(scenario.body), scenario.body);
  if (scenario.status === "loading") assert.match(html, /终止生成/);
  else assert.doesNotMatch(html, />终止生成</);
  assert.equal((html.match(/data-slot="spinner"/g) || []).length, scenario.runStatus === "running" ? 1 : 0, "Each video task has at most one loading spinner");
  assert.equal(html.split(`>${scenario.title}<`).length - 1, 1, "The task status is shown once");
  const hasProgress = scenario.taskProgress !== undefined && scenario.taskProgress < 100;
  assert.equal(html.includes('data-slot="progress"'), hasProgress, "Only reported generation progress is shown");
  if (hasProgress) assert.ok(html.includes(`aria-valuenow="${scenario.taskProgress}"`));
  if (scenario.taskProgress === 100) assert.doesNotMatch(html, /data-status="success"|data-slot="progress"/);
  if (scenario.error) assert.ok(html.includes(scenario.error));
 }
});

test("the current server execution overrides stale canvas message status", () => {
 for (const status of ["waiting", "interrupted", "cancelled", "error", "success"]) {
  assert.equal(canvasAgentMessageRunStatus({ id: "current", status: "running" }, { assistantId: "current", status }), status);
 }
 assert.equal(canvasAgentMessageRunStatus({ id: "history", status: "success" }, { assistantId: "current", status: "error" }), "success");
 assert.equal(canvasAgentMessageRunStatus({ id: "current", status: "thinking" }), "running");
});
test("a pending user question prevents presenting a task as complete", () => {
 assert.equal(canvasAgentMessageRunStatus({ id: "current", status: "success" }, { assistantId: "current", status: "success" }, true), "waiting");
 assert.equal(canvasAgentMessageRunStatus({ id: "current", status: "waiting" }, { assistantId: "current", status: "running" }, true), "running");
});
test("task headers distinguish saved terminal and waiting states", () => {
 for (const [status, label] of Object.entries({ waiting: "等待处理", interrupted: "执行中断", cancelled: "已停止", error: "执行失败" })) {
  const html = render(Task, { status, timing: "1s" }, "已保存的工具记录");
  assert.ok(html.includes(label)); assert.match(html, /aria-expanded="true"/); assert.doesNotMatch(html, /执行完成/);
 }
 assert.match(render(Task, { status: "success", timing: "1s" }, "记录"), /aria-expanded="false"/);
});
test("running task headers and activity lines use the same spinner", async () => {
 const { AgentActivityLine } = await import("../src/components/agent/agent-activity-line.tsx");
 const task = render(Task, { status: "running", timing: "1s" }, "记录");
 const activity = render(AgentActivityLine, {}, "正在处理任务");
 const spinner = html => html.match(/<svg(?=[^>]*data-slot="spinner")([^>]*)>/)?.[1].match(/class="([^"]*)"/)?.[1];
 assert.ok(spinner(task));
 assert.ok(spinner(activity));
 assert.equal(spinner(task), spinner(activity));
});
test("failed tools expose both copyable input and output for repair", () => {
 const html = render(Tool, { title: "校验配置", state: "output-error" }, createElement(ToolDetails, { name: "validate_contracts", input: { model: "test" }, output: "schema invalid" }));
 assert.match(html, /执行失败/); assert.match(html, /schema invalid/); assert.match(html, /复制工具输入/); assert.match(html, /复制工具输出/);
});
test("tools preserve stopped and explicit status labels and distinguish pending work from approval", () => {
 assert.match(render(Tool, { title: "读取文档", state: "output-denied" }), /已停止/);
 assert.match(render(Tool, { title: "读取文档", state: "output-denied", statusLabel: "已中断" }), /已中断/);
 assert.match(render(Tool, { title: "更新配置", state: "output-available", statusLabel: "已调整" }), /已调整/);
 const pending = render(Tool, { title: "生成图片", state: "pending" });
 assert.match(pending, /data-state="pending"/);
 assert.match(pending, /data-status="pending"/);
 assert.match(pending, /待继续/);
 assert.doesNotMatch(pending, /等待确认|data-slot="spinner"/);
 assert.match(render(Tool, { title: "删除文件", state: "approval-requested" }), /等待确认/);
});

test("paused canvas tools and unstarted nodes remain pending without requesting approval", () => {
 const base = { id: "paused", type: "operation", kind: "read", label: "读取画布", detail: "", status: "running", tool: { name: "get_canvas_summary", input: {} } };
 const paused = render(CanvasAgentExecution, { nodes: [], running: false, entry: base });
 assert.match(paused, /data-state="pending"/);
 assert.match(paused, /待继续/);
 assert.doesNotMatch(paused, /approval-requested|data-slot="spinner"/);
 const idle = render(CanvasAgentExecution, { nodes: [{ id: "image", type: "image", title: "参考图" }], running: false, entry: { ...base, kind: "generate", status: "waiting", nodeId: "image" } });
 assert.match(idle, /待生成/);
 assert.match(idle, /data-state="pending"/);
 assert.doesNotMatch(idle, /approval-requested/);
});
test("running tools stay collapsed and canvas errors expose readable messages instead of JSON", () => {
 const html = render(Tool, { title: "继续节点生成", state: "input-available", expandOnRunning: false }, "参数");
 assert.match(html, /aria-expanded="false"/);
 assert.equal(canvasAgentToolMessage({ code: "media_retry_requires_confirmation", message: "请先征得用户明确同意", ok: false }), "请先征得用户明确同意");
 assert.equal(canvasAgentToolMessage('{"code":"media_retry_requires_confirmation","message":"请先征得用户明确同意","ok":false}'), "请先征得用户明确同意");
 assert.equal(canvasAgentToolMessage(""), undefined);
});
test("canvas read steps without visible details cannot expand an empty panel", () => {
 const html = render(CanvasAgentExecution, { nodes: [], running: false, entry: { id: "read", type: "operation", kind: "read", label: "已读取画布", detail: "内部读取摘要", status: "success", tool: { name: "get_canvas_summary", input: {}, output: { ok: true, nodeCount: 12 } } } });
 assert.match(html, /已读取画布/);
 assert.doesNotMatch(html, /aria-expanded|trace-collapsible-trigger|内部读取摘要/);
});
test("canvas failed steps expand only their readable error details", () => {
 const html = render(CanvasAgentExecution, { nodes: [], running: false, entry: { id: "failed", type: "operation", kind: "read", label: "读取画布失败", detail: "内部错误", status: "error", tool: { name: "get_canvas_summary", input: {}, output: { ok: false, message: "画布版本已更新，请重新读取" } } } });
 assert.match(html, /aria-expanded="true"/);
 assert.match(html, /画布版本已更新，请重新读取/);
 assert.doesNotMatch(html, /内部错误|&quot;ok&quot;/);
});
test("canvas execution shows plans, workflow contents and failed node context", () => {
 const base = { id: "step", type: "operation", label: "正在更新执行计划", status: "success", detail: "操作已完成" };
 const plan = render(CanvasAgentExecution, { nodes: [], running: false, entry: { ...base, kind: "plan", tool: { name: "update_plan", input: { steps: [{ id: "one", title: "制作分镜", status: "in_progress" }] } } } });
 assert.match(plan, /执行计划/); assert.match(plan, /制作分镜/);
 const workflow = render(CanvasAgentExecution, { nodes: [], running: false, entry: { ...base, kind: "workflow", label: "搭建画布工作流", tool: { name: "create_canvas_workflow", input: { steps: [{ key: "one", title: "林夏" }, { key: "two", title: "公寓", dependsOn: ["one"] }] } } } });
 assert.match(workflow, /林夏/); assert.match(workflow, /公寓（依赖：林夏）/);
 const failed = render(CanvasAgentExecution, { nodes: [], running: false, entry: { ...base, kind: "edit", label: "正在更新节点", status: "error", detail: "节点不存在", tool: { name: "update_node", input: { nodeId: "missing-node" } } } });
 assert.match(failed, /missing-node/); assert.match(failed, /节点不存在/);
});
test("a tool batch containing an execution plan does not nest a second progress plan", () => {
 const html = render(CanvasAgentExecutionTrace, {
  nodes: [], running: true, renderText: (text) => text,
  entries: [
   { id: "read", type: "operation", kind: "read", label: "已读取节点", status: "success", detail: "", tool: { name: "get_node", input: {}, output: { ok: true } } },
   { id: "plan", type: "operation", kind: "plan", label: "正在更新执行计划", status: "success", detail: "", tool: { name: "update_plan", input: { steps: [{ id: "check", title: "核对任务", status: "in_progress" }] }, output: { ok: true } } },
  ],
 });
 assert.match(html, /执行计划/);
 assert.match(html, /核对任务/);
 assert.doesNotMatch(html, /执行步骤/);
});
test("confirmation displays its reason without selecting or submitting an answer", () => {
 let answers = 0;
 const html = render(CanvasAgentQuestionCard, { active: true, busy: false, onAnswer: () => { answers++; return true; }, question: { id: "approval", kind: "confirmation", question: "删除选中节点？", reason: "删除后相关连线会清理", options: ["确认删除", "取消"], request: "删除节点" } });
 assert.match(html, /需要确认/); assert.match(html, /删除后相关连线会清理/); assert.match(html, /Agent 等待确认/); assert.equal(answers, 0);
});
test("stopping feedback stays distinct from a completed cancellation", () => {
 const html = render(RunStatus, { status: "running", stopping: true });
 assert.match(html, /正在停止/); assert.match(html, /aria-busy="true"/); assert.doesNotMatch(html, /执行完成/);
});

test("tasks without process content do not expose an empty disclosure", () => {
 for (const status of ["success", "running", "error"]) {
  const html = render(Task, { status, timing: "1s" }, [null, false, undefined]);
  assert.match(html, /data-ai-element="task"/);
  assert.doesNotMatch(html, /aria-expanded|data-agent-process-toggle/);
 }
});

test("failed canvas tasks expose retry even without response text", async () => {
 const { CanvasAgentConversation } = await import("../src/app/canvas/canvas-agent-conversation.tsx");
 const { Conversation } = await import("../src/components/ai-elements/conversation.tsx");
 const { TooltipProvider } = await import("../src/components/ui/tooltip.tsx");
 const renderConversation = props => render(TooltipProvider, {}, createElement(Conversation, {}, createElement(CanvasAgentConversation, props)));
 const props = { messages: [{ id: "user", role: "user", text: "继续生成" }, { id: "agent", role: "assistant", text: "", status: "running" }], nodes: [], onRetry() {}, onEdit() {}, editDisabled: false, busy: false };
 for (const status of ["error", "interrupted", "cancelled"]) {
  const html = renderConversation({ ...props, run: { assistantId: "agent", status }, resumable: true, onResume() {} });
  assert.match(html, /data-agent-retry-actions/);
  assert.match(html, /<button[^>]*>.*重试<\/button>/);
  assert.doesNotMatch(html, /继续未完成任务/);
 }
 const busy = renderConversation({ ...props, run: { assistantId: "agent", status: "error" }, busy: true });
 assert.match(busy, /<button[^>]*disabled=""[^>]*>.*重试<\/button>/);
 const uncertain = renderConversation({ ...props, messages: [{ id: "user", role: "user", text: "继续" }, { id: "agent", role: "assistant", text: "执行状态待核实：工具任务已结束，但未返回执行结果。请先核对画布状态。", status: "error" }], resumable: true, onResume() {} });
 assert.match(uncertain, /data-agent-status-unknown="true"/);
 assert.match(uncertain, /执行状态待核实/);
 assert.doesNotMatch(uncertain, /data-agent-retry-actions|继续未完成任务|aria-label="重试"/);
 for (const extra of [{ run: { assistantId: "agent", status: "running" } }, { run: { assistantId: "agent", status: "waiting" }, pendingQuestion: "确认删除？", resumable: true, onResume() {} }]) {
  const html = renderConversation({ ...props, ...extra });
  assert.doesNotMatch(html, /data-agent-retry-actions|aria-label="重试"/);
 }
 const awaitingMediaChoice = renderConversation({ ...props, run: { assistantId: "agent", status: "waiting" }, resumable: false, onResume() {} });
 assert.doesNotMatch(awaitingMediaChoice, /data-agent-retry-actions|继续未完成任务/);
});
