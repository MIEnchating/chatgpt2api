import assert from "node:assert/strict";
import test from "node:test";
import { canvasAgentDisplayTraces, canvasAgentToolPlan, canvasAgentLatestTracePlan, canvasAgentResponsePresentation, canvasAgentErrorStack, canvasAgentOperationContext } from "../src/app/canvas/agent/canvas-agent-presentation.ts";
import { planProgressLabel } from "../src/components/ai-elements/plan-progress.ts";

test("tool presentation joins input and output by call ID without changing saved traces", () => {
  const entries = [{ id: "tool:read", type: "operation", kind: "tool", label: "读取画布", status: "success", detail: "2 个节点" }];
  const protocol = [{ role: "assistant", toolCalls: [{ id: "read", name: "get_canvas_summary", arguments: { includeNodes: true } }] }, { role: "tool", toolCallId: "other", name: "get_canvas_summary", content: '{"ok":false}' }, { role: "tool", toolCallId: "read", name: "get_canvas_summary", content: '{"ok":true,"nodes":[]}' }];
  const [display] = canvasAgentDisplayTraces(entries, protocol);
  assert.equal(display.kind, "read");
  assert.deepEqual(display.tool, { name: "get_canvas_summary", input: { includeNodes: true }, output: { ok: true, nodes: [] } });
  assert.equal(entries[0].tool, undefined);
  assert.deepEqual(canvasAgentDisplayTraces(entries, []), entries);
});

test("a later accepted delivery resolves only earlier rejected delivery checks in the same task", () => {
  const entries = [
    { id: "tool:rejected", type: "operation", kind: "tool", label: "核对任务交付", status: "error", detail: "计划尚未完成" },
    { id: "tool:accepted", type: "operation", kind: "tool", label: "核对任务交付", status: "success", detail: "整理已完成" },
  ];
  const protocol = [
    { role: "assistant", toolCalls: [{ id: "rejected", name: "finish_task", arguments: { text: "完成" } }] },
    { role: "tool", toolCallId: "rejected", name: "finish_task", content: '{"ok":false,"code":"task_incomplete","message":"计划尚未完成"}' },
    { role: "assistant", toolCalls: [{ id: "accepted", name: "finish_task", arguments: { text: "整理已完成" } }] },
    { role: "tool", toolCallId: "accepted", name: "finish_task", content: '{"ok":true}' },
  ];
  const display = canvasAgentDisplayTraces(entries, protocol);
  assert.equal(display[0].status, "success");
  assert.equal(display[0].resolvedBy, "accepted");
  assert.deepEqual(display[0].tool.output, { ok: false, code: "task_incomplete", message: "计划尚未完成" });
  assert.equal(entries[0].status, "error");
  assert.equal(canvasAgentDisplayTraces(entries.slice(0, 1), protocol)[0].status, "error", "another request must not resolve this task's failure");
  assert.equal(canvasAgentDisplayTraces(entries, protocol.toReversed())[0].status, "error", "an earlier success must not resolve a later failure");
});

test("delivery acceptance does not hide a failed media operation", () => {
  const entries = [
    { id: "tool:media", type: "operation", kind: "generate", label: "生成视频", status: "error", detail: "参考 URL 无效" },
    { id: "tool:finish", type: "operation", kind: "tool", label: "交付", status: "success", detail: "" },
  ];
  const protocol = [
    { role: "assistant", toolCalls: [{ id: "media", name: "generate_node", arguments: { nodeId: "video" } }, { id: "finish", name: "finish_task", arguments: { text: "完成整理" } }] },
    { role: "tool", toolCallId: "media", name: "generate_node", content: '{"ok":false,"code":"task_incomplete"}' },
    { role: "tool", toolCallId: "finish", name: "finish_task", content: '{"ok":true}' },
  ];
  assert.equal(canvasAgentDisplayTraces(entries, protocol)[0].status, "error");
});

test("plan presentation accepts the current plan contract and rejects malformed steps", () => {
  const plan = { explanation: "先检查再生成", steps: [{ id: "read", title: "检查画布", status: "in_progress" }, { id: "create", title: "创建分镜", status: "pending" }] };
  assert.deepEqual(canvasAgentToolPlan(plan), plan);
  assert.deepEqual(canvasAgentToolPlan({ steps: plan.steps }), { explanation: "", steps: plan.steps });
  assert.equal(canvasAgentToolPlan({ ...plan, steps: [{ ...plan.steps[0], status: "invented" }] }), undefined);
  assert.equal(canvasAgentToolPlan({ ...plan, steps: [] }), undefined);
});

test("operation context identifies nodes and shows workflow steps and dependencies", () => {
  const nodes = [{ id: "a", title: "林夏" }, { id: "b", title: "公寓" }];
  const operation = { id: "read", type: "operation", kind: "read", label: "读取节点", status: "success", detail: "", tool: { name: "get_node", input: { nodeId: "a" } } };
  assert.equal(canvasAgentOperationContext(operation, nodes).nodeName, "林夏");
  assert.equal(canvasAgentOperationContext({ ...operation, tool: { name: "get_node", input: { nodeId: "deleted" } } }, nodes).nodeName, "deleted");
  const create = canvasAgentOperationContext({ ...operation, kind: "workflow", tool: { name: "create_canvas_workflow", input: { groupTitle: "场景", steps: [{ key: "a", title: "林夏" }, { key: "b", title: "公寓", dependsOn: ["a"] }] } } }, nodes);
  assert.equal(create.workflowName, "场景");
  assert.deepEqual(create.details, ["林夏", "公寓（依赖：林夏）"]);
  const run = canvasAgentOperationContext({ ...operation, kind: "workflow", tool: { name: "run_canvas_workflow", input: { nodeIds: ["a", "deleted"] } } }, nodes);
  assert.deepEqual(run.details, ["林夏", "deleted"]);
});

test("task plans come only from that task's plan trace and never fall back to session state", () => {
  const priorPlan = { explanation: "旧任务", steps: [{ id: "old", title: "补齐旧分镜", status: "deferred" }] };
  const currentPlan = { explanation: "当前任务", steps: [{ id: "current", title: "检查其他节点", status: "in_progress" }] };
  assert.deepEqual(canvasAgentLatestTracePlan([{ id: "old", type: "operation", kind: "plan", label: "更新计划", status: "success", detail: "", tool: { name: "update_plan", input: priorPlan } }]), priorPlan);
  assert.equal(canvasAgentLatestTracePlan([]), undefined);
  assert.deepEqual(canvasAgentLatestTracePlan([
    { id: "old", type: "operation", kind: "plan", label: "更新计划", status: "success", detail: "", tool: { name: "update_plan", input: priorPlan } },
    { id: "current", type: "operation", kind: "plan", label: "更新计划", status: "success", detail: "", tool: { name: "update_plan", input: currentPlan } },
  ]), currentPlan);
});

test("plan progress distinguishes deferred work from unfinished active work", () => {
  assert.equal(planProgressLabel([{ status: "completed" }, { status: "completed" }, { status: "deferred" }]), "2/2 · 1 项暂缓");
  assert.equal(planProgressLabel([{ status: "completed" }, { status: "pending" }, { status: "deferred" }]), "1/2 · 1 项暂缓");
  assert.equal(planProgressLabel([{ status: "deferred" }]), "1 项暂缓");
  assert.equal(planProgressLabel([{ status: "completed" }, { status: "pending" }]), "1/2");
});

test("response presentation exposes published summaries only and validates explicit citations", () => {
  const result = canvasAgentResponsePresentation([{ role: "assistant", reasoningContent: "private reasoning", responseItems: [
    { type: "reasoning", id: "reason", encrypted_content: "opaque", content: "private", summary: [{ type: "summary_text", text: "检查已有分镜" }] },
    { type: "message", content: [{ type: "output_text", annotations: [
      { type: "url_citation", url: "https://example.com/docs", title: "模型文档" },
      { type: "url_citation", url: "https://example.com/docs", title: "模型文档" },
      { type: "url_citation", url: "javascript:alert(1)", title: "invalid" },
      { type: "url_citation", url: "https://secret@example.com", title: "credentials" },
      { type: "url_citation", url: "/relative" },
    ] }] },
  ] }]);
  assert.deepEqual(result.reasoning, [{ id: "reason", text: "检查已有分镜" }]);
  assert.deepEqual(result.sources, [{ url: "https://example.com/docs", title: "模型文档" }]);
  assert.doesNotMatch(JSON.stringify(result), /private|opaque|invalid|credentials/);
});

test("ordinary errors do not become fabricated stack traces", () => {
  assert.equal(canvasAgentErrorStack("未知 SDK 请求 session"), undefined);
  const stack = "Error: tool failed\n    at execute (/app/tool.ts:12:3)";
  assert.equal(canvasAgentErrorStack(stack), stack);
  assert.equal(canvasAgentErrorStack({ error: { stack } }), stack);
});
