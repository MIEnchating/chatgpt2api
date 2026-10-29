import { canvasAgentToolContent } from "../src/app/canvas/agent/canvas-agent-tool-content.ts";
import { CANVAS_AGENT_CONVERSATION_PROMPT } from "../src/app/canvas/agent/canvas-agent-conversation.ts";
import { executeCanvasAgentResumedAction } from "../src/app/canvas/agent/canvas-agent-execution.ts";
import { canvasAgentActionTrace, canvasCodexItemTrace, upsertCanvasAgentOperationTrace } from "../src/app/canvas/agent/canvas-agent-trace.ts";
import { canvasAgentWaitingReason, resumeCanvasAgentMedia } from "../src/app/canvas/agent/canvas-agent-runtime.ts";
import { canvasAgentPlan, canvasAgentQuestion, canvasAgentQuestionMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";
import { describeCanvasAgentReference } from "../src/app/canvas/agent/canvas-agent-reference.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "bun:test";
import { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, isCanvasAgentMediaAction, normalizeCanvasAgentAction } from "../src/app/canvas/agent/canvas-agent-tools.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(options = {}) {
  const slots = []; const effects = []; let index = 0; let connectInput; let accountKey = "private-account-credential-id";
  const rpcCalls = []; const replies = []; const toolResults = []; const executions = []; const threadReady = [];
  const window = Object.assign(new EventTarget(), { location: { origin: "https://canvas.example" } });
  const link = { serviceId: "service", sessionId: "session", disconnect() {},
    async rpc(method, params) {
      rpcCalls.push({ method, params });
      if (method === "account/read") return { account: {} };
      if (method === "model/list" && options.modelPage) return options.modelPage(params);
      if (method === "model/list") return { data: [{ model: "codex-test", defaultReasoningEffort: "medium" }], nextCursor: null };
      if (method.startsWith("thread/")) return { thread: { id: "thread" } };
      if (method === "turn/start") return new Promise((resolve) => threadReady.push(resolve));
      return {};
    },
    async reply(id, result) { replies.push({ id, result }); }, async reject(id, message) { replies.push({ id, error: message }); },
    async toolResult(id, result) { toolResults.push({ id, result }); },
  };
  const dependencies = {
    "./canvas-agent-tool-content": { canvasAgentToolContent },
    "./canvas-agent-conversation": { CANVAS_AGENT_CONVERSATION_PROMPT },
    "./canvas-agent-reference": { describeCanvasAgentReference },
    "./canvas-agent-interaction": { canvasAgentPlan, canvasAgentQuestion, canvasAgentQuestionMediaChoice },
    react: {
      useRef(value) { const slot = index++; slots[slot] ??= { current: value }; return slots[slot]; },
      useState(value) { const slot = index++; if (!(slot in slots)) slots[slot] = value; return [slots[slot], (next) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }]; },
      useEffect(effect) { const slot = index++; if (!(slot in slots)) { slots[slot] = true; effects.push(effect()); } },
    },
    "@/lib/auth-session": { AUTH_SESSION_CHANGE_EVENT: "auth-change" },
    "@/lib/session": { getCachedAuthSession: () => ({ key: accountKey }) },
    "@/services/api/canvas-codex": { connectCanvasCodex: async (input) => { connectInput = input; return link; } },
    "@/services/api/agent-skills": { readAgentSkillFile: async () => ({ content: "skill" }) },
    "./canvas-agent-skills": { buildCanvasAgentSkillPrompt: () => "canvas prompt" },
    "./canvas-agent-tools": { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, isCanvasAgentMediaAction, normalizeCanvasAgentAction },
    "./canvas-agent-execution": { executeCanvasAgentResumedAction },
    "./canvas-agent-trace": { canvasAgentActionTrace, canvasCodexItemTrace, upsertCanvasAgentOperationTrace },
    "./canvas-agent-runtime": { canvasAgentWaitingReason, resumeCanvasAgentMedia, applyAgentState: (state, args) => ({ ...state, ...args }), applyTaskResult: (state) => state },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("../src/app/canvas/agent/canvas-codex-agent.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; }, window, crypto, TextEncoder, AbortController, AbortSignal, DOMException, Error });
  const input = { canvasId: "canvas", onDisconnect: options.onDisconnect || (() => {}), executeAction: async (action, onProgress) => { executions.push(action); return options.executeAction ? options.executeAction(action, onProgress) : { ok: true }; }, ask: options.ask || (async () => ({ accepted: true })) };
  let agent;
  function render() { index = 0; agent = module.exports.useCanvasCodexAgent(input); return agent; }
  render();
  const runInput = (controller = new AbortController()) => ({ model: "unused", relayTokenName: "", userText: "创建文字", references: [], protocolMessages: [], initialState: { phase: "intake", pendingTaskIds: [], completedTaskIds: [] }, signal: controller.signal, getContext: () => ({ project: { id: "canvas" }, generation: { autoGenerateMedia: true } }), executeAction: input.executeAction });
  return { render, runInput, rpcCalls, replies, toolResults, executions, threadReady, link, get connectInput() { return connectInput; },
    async connect() { await agent.connect("http://127.0.0.1:3210", "x".repeat(32)); render(); return agent; },
    event(event) { connectInput.onEvent(event); },
    sessionChange() { accountKey = "new-account"; window.dispatchEvent(new Event("auth-change")); },
    cleanup() { for (const effect of effects) effect?.(); },
  };
}

test("Codex connection hashes account and canvas scope instead of sending account identifiers", async () => {
  const f = fixture();
  try { const agent = await f.connect(); assert.equal(agent.connected, true); assert.match(f.connectInput.canvasId, /^[a-f0-9]{64}$/); assert.notEqual(f.connectInput.canvasId, "private-account-credential-id"); }
  finally { f.cleanup(); }
});

test("stopping before turn-start acknowledgement interrupts the acknowledged turn", async () => {
  const f = fixture();
  try {
    const agent = await f.connect(); const controller = new AbortController();
    const pending = agent.run(f.runInput(controller)); const rejected = assert.rejects(pending, /已停止/);
    await flush(); controller.abort(); f.threadReady[0]({ turn: { id: "late-turn" } });
    await rejected; await flush();
    assert.ok(f.rpcCalls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "late-turn"));
    f.event({ type: "rpc", message: { id: "late-call", method: "item/tool/call", params: { threadId: "thread", turnId: "late-turn", tool: "create_text_node", arguments: { title: "bad", content: "stale" }, callId: "call" } } });
    await flush(); assert.equal(f.executions.length, 0);
  } finally { f.cleanup(); }
});

test("MCP cancellation dismisses its queued confirmation and the next call remains usable", async () => {
  let started; const waiting = new Promise((resolve) => { started = resolve; });
  const f = fixture({ ask: async (_, signal) => new Promise((resolve) => { started(); signal.addEventListener("abort", () => resolve({ accepted: false }), { once: true }); }) });
  try {
    await f.connect();
    f.event({ type: "tool", source: "mcp", requestId: "write", name: "delete_node", arguments: { nodeId: "n" } });
    await waiting; f.event({ type: "tool-cancel", requestId: "write" });
    f.event({ type: "tool", source: "mcp", requestId: "read", name: "get_canvas_summary", arguments: {} });
    await flush();
    assert.equal(f.executions.length, 1); assert.equal(f.executions[0].name, "get_canvas_summary");
    assert.equal(f.toolResults.length, 1); assert.equal(f.toolResults[0].id, "read");
  } finally { f.cleanup(); }
});

test("resolved Codex approvals cannot execute and account changes disconnect pending work", async () => {
  let started; const waiting = new Promise((resolve) => { started = resolve; }); let aborted = false;
  const f = fixture({ ask: async (_, signal) => new Promise((resolve) => { started(); signal.addEventListener("abort", () => { aborted = true; resolve({ accepted: false }); }, { once: true }); }) });
  try {
    const agent = await f.connect();
    const pending = agent.run(f.runInput()); const rejected = assert.rejects(pending, /断开/);
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    f.event({ type: "rpc", message: { id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: "test" } } });
    await waiting;
    f.event({ type: "rpc", message: { method: "serverRequest/resolved", params: { requestId: "approval" } } });
    await flush(); assert.equal(aborted, true); assert.equal(f.replies.length, 0);
    f.sessionChange(); await rejected; assert.equal(f.render().connected, false);
    f.event({ type: "tool", source: "mcp", requestId: "old-account", name: "get_canvas_summary", arguments: {} });
    await flush(); assert.equal(f.executions.length, 0);
  } finally { f.cleanup(); }
});


test("a new turn ignores old SSE events and replays only its acknowledged events", async () => {
  const f = fixture();
  try {
    const agent = await f.connect(); const firstController = new AbortController();
    const first = agent.run(f.runInput(firstController)); const stopped = assert.rejects(first, /已停止/);
    await flush(); f.threadReady[0]({ turn: { id: "old" } }); await flush(); firstController.abort(); await stopped;
    const next = agent.run({ ...f.runInput(), codexThreadId: "thread", codexServiceId: "service" });
    await flush();
    for (const message of [
      { method: "turn/started", params: { threadId: "thread", turn: { id: "old" } } },
      { method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "old", delta: "旧内容" } },
      { method: "turn/completed", params: { threadId: "thread", turn: { id: "old", status: "interrupted" } } },
      { id: "old-call", method: "item/tool/call", params: { threadId: "thread", turnId: "old", tool: "get_canvas_summary", arguments: {}, callId: "old-tool" } },
      { method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "new", delta: "当前回复" } },
      { method: "turn/completed", params: { threadId: "thread", turn: { id: "new", status: "completed" } } },
    ]) f.event({ type: "rpc", message });
    f.threadReady[1]({ turn: { id: "new" } });
    assert.equal((await next).reply, "当前回复"); await flush(); assert.equal(f.executions.length, 0);
  } finally { f.cleanup(); }
});

test("file approval includes the matching paths and diffs and refuses missing changes", async () => {
  const approvals = []; const f = fixture({ ask: async (approval) => { approvals.push(approval); return { accepted: true }; } });
  try {
    const agent = await f.connect(); const pending = agent.run(f.runInput()); void pending.catch(() => {});
    await flush();
    const changes = [{ path: "/tmp/art.txt", kind: { type: "update", move_path: null }, diff: "-old\n+new" }];
    f.event({ type: "rpc", message: { method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "file", type: "fileChange", changes } } } });
    f.event({ type: "rpc", message: { id: "approve", method: "item/fileChange/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "file" } } });
    assert.equal(approvals.length, 0);
    f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    assert.deepEqual(JSON.parse(approvals[0].details).changes, changes);
    assert.equal(f.replies[0].result.decision, "accept");
    f.event({ type: "rpc", message: { id: "missing", method: "item/fileChange/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "not-captured" } } });
    await flush(); assert.equal(approvals.length, 1); assert.equal(f.replies.at(-1).result.decision, "decline");
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } } }); await pending;
  } finally { f.cleanup(); }
});

test("an aborted long-running canvas action releases the tool queue immediately", async () => {
  let finishOld; const f = fixture({ executeAction: async (action) => action.name === "delete_node" ? new Promise((resolve) => { finishOld = resolve; }) : { ok: true } });
  try {
    await f.connect();
    f.event({ type: "tool", source: "mcp", requestId: "old", name: "delete_node", arguments: { nodeId: "n" } });
    await flush(); assert.ok(finishOld);
    f.event({ type: "tool-cancel", requestId: "old" });
    f.event({ type: "tool", source: "mcp", requestId: "next", name: "get_canvas_summary", arguments: {} });
    await flush(); assert.equal(f.toolResults[0].id, "next");
    finishOld({ ok: true }); await flush(); assert.equal(f.toolResults.length, 1);
  } finally { f.cleanup(); }
});

test("Codex sends image attachments without inventing canvas node identifiers", async () => {
  const f = fixture();
  try {
    const agent = await f.connect();
    const controller = new AbortController();
    const pending = agent.run({ ...f.runInput(controller), references: [{ id: "attachment-one", source: "attachment", type: "image", title: "photo.png", dataUrl: "data:image/png;base64,AAAA" }] });
    const rejected = assert.rejects(pending, /已停止/);
    await flush();
    const input = f.rpcCalls.find((call) => call.method === "turn/start").params.input;
    assert.match(input[0].text, /消息附件/);
    assert.doesNotMatch(input[0].text, /节点 attachment-one/);
    assert.match(input[1].text, /附件 attachment-one/);
    assert.equal(input[2].url, "data:image/png;base64,AAAA");
    controller.abort();
    await rejected;
  } finally { f.cleanup(); }
});

test("reading an attachment returns visual content to Codex without adding a user upload", async () => {
  const f = fixture({ executeAction: async () => ({ ok: true, reference: { id: "photo", source: "attachment", type: "image", title: "正面", url: "https://cdn.example.test/product.png" } }) });
  try {
    const agent = await f.connect();
    const pending = agent.run(f.runInput());
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    f.event({ type: "rpc", message: { id: "read-photo", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "get_reference", arguments: { referenceId: "photo" }, callId: "read-photo" } } });
    await flush(); await flush();
    const content = f.replies.find((reply) => reply.id === "read-photo").result.contentItems;
    assert.equal(JSON.parse(content[0].text).reference.id, "photo");
    assert.deepEqual(content[1], { type: "inputImage", imageUrl: "https://cdn.example.test/product.png" });
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "turn", turn: { status: "completed" } } } });
    const result = await pending;
    assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
  } finally { f.cleanup(); }
});

test("Codex plan and question tools use the current run and wait for a real answer", async () => {
  let resolveAnswer;
  const questions = [];
  const checkpoints = [];
  const f = fixture({ ask: async (request) => { questions.push(request); return new Promise((resolve) => { resolveAnswer = resolve; }); } });
  try {
    const agent = await f.connect();
    const pending = agent.run({ ...f.runInput(), onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const tool = (name, args, id) => f.event({ type: "rpc", message: { id, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: name, arguments: args, callId: id } } });
    tool("update_plan", { explanation: "确认方向", steps: [{ id: "brief", title: "确认风格", status: "in_progress" }] }, "plan");
    await flush();
    assert.equal(checkpoints.at(-1).state.plan.steps[0].title, "确认风格");
    tool("ask_user_question", { question: "选择风格", reason: "需要确定视觉方向", options: ["纪实", "插画"], kind: "clarification" }, "question");
    await flush();
    assert.equal(questions.length, 1);
    assert.ok(!f.replies.some((reply) => reply.id === "question"));
    assert.equal(f.executions.length, 0);
    resolveAnswer({ accepted: true, answers: { [questions[0].questions[0].id]: "插画" } }); await flush();
    const response = f.replies.find((reply) => reply.id === "question");
    assert.deepEqual(JSON.parse(response.result.contentItems[0].text), { ok: true, answer: "插画" });
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "turn", turn: { status: "completed" } } } });
    const result = await pending;
    assert.equal(result.state.plan.steps[0].id, "brief");
  } finally { f.cleanup(); }
});

test("Codex media confirmation overrides a previous deferral before executing the existing node", async () => {
  const checkpoints = [];
  const f = fixture({ ask: async () => ({ accepted: true, answers: { approval: "立即生成" } }) });
  try {
    const agent = await f.connect();
    const initial = f.runInput();
    const pending = agent.run({ ...initial, initialState: { ...initial.initialState, mediaGenerationDeferred: true }, onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const params = { threadId: "thread", turnId: "turn" };
    f.event({ type: "rpc", message: { id: "approval", method: "item/tool/requestUserInput", params: { ...params, questions: [{ id: "approval", question: "是否现在生成已有的图片？" }] } } });
    await flush();
    assert.equal(f.replies.find((reply) => reply.id === "approval").result.answers.approval.answers[0], "立即生成");
    assert.equal(checkpoints.at(-1).state.mediaGenerationDeferred, false);
    f.event({ type: "rpc", message: { id: "generate", method: "item/tool/call", params: { ...params, tool: "generate_node", arguments: { nodeId: "existing-image" }, callId: "generate" } } });
    await flush();
    assert.deepEqual(f.executions.map((action) => [action.name, action.arguments.nodeId]), [["generate_node", "existing-image"]]);
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
    await pending;
  } finally { f.cleanup(); }
});

test("cancelling either Codex question mechanism prevents later writes in that turn", async () => {
  for (const nativeQuestion of [false, true]) {
    const f = fixture({ ask: async () => ({ accepted: false }) });
    try {
      const agent = await f.connect();
      const pending = agent.run(f.runInput());
      await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
      const params = { threadId: "thread", turnId: "turn" };
      f.event({ type: "rpc", message: nativeQuestion
        ? { id: "question", method: "item/tool/requestUserInput", params: { ...params, questions: [{ id: "q", question: "采用什么比例？" }] } }
        : { id: "question", method: "item/tool/call", params: { ...params, tool: "ask_user_question", callId: "q", arguments: { question: "采用什么比例？", reason: "影响构图", options: [], kind: "clarification" } } } });
      await flush();
      f.event({ type: "rpc", message: { id: "write", method: "item/tool/call", params: { ...params, tool: "create_text_node", callId: "write", arguments: { title: "不得创建", content: "用户已取消" } } } });
      await flush();
      assert.equal(f.executions.length, 0);
      assert.equal(JSON.parse(f.replies.find((reply) => reply.id === "write").result.contentItems[0].text).code, "user_cancelled");
      f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } } });
      await pending;
      const next = agent.run(f.runInput());
      await flush(); f.threadReady[1]({ turn: { id: "next" } }); await flush();
      f.event({ type: "rpc", message: { id: "allowed", method: "item/tool/call", params: { ...params, turnId: "next", tool: "create_text_node", callId: "new", arguments: { title: "新的请求", content: "允许执行" } } } });
      await flush(); assert.equal(f.executions.length, 1);
      f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turn: { id: "next", status: "completed" } } } }); await next;
    } finally { f.cleanup(); }
  }
});

test("finishing a Codex turn dismisses unresolved approvals and ignores late answers", async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  const f = fixture({ ask: async (_, signal) => new Promise((resolve) => {
    started(); signal.addEventListener("abort", () => { aborted = true; resolve({ accepted: true }); }, { once: true });
  }) });
  try {
    const agent = await f.connect(); const pending = agent.run(f.runInput());
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    f.event({ type: "rpc", message: { id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: "test" } } });
    await waiting;
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } } });
    await pending; await flush();
    assert.equal(aborted, true);
    assert.equal(f.replies.length, 0);
  } finally { f.cleanup(); }
});


test("cancelled Codex questions also decline subsequent local operation approvals", async () => {
  let prompts = 0;
  const f = fixture({ ask: async () => { prompts++; return { accepted: false }; } });
  try {
    const agent = await f.connect(); const pending = agent.run(f.runInput());
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const params = { threadId: "thread", turnId: "turn" };
    f.event({ type: "rpc", message: { id: "q", method: "item/tool/requestUserInput", params: { ...params, questions: [{ id: "q", question: "比例？" }] } } });
    await flush();
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      f.event({ type: "rpc", message: { id: method, method, params } });
      await flush(); assert.equal(f.replies.find((reply) => reply.id === method).result.decision, "decline");
    }
    assert.equal(prompts, 1);
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } }); await pending;
  } finally { f.cleanup(); }
});

test("repeated empty model pages stop instead of looping forever", async () => {
  const f = fixture({ modelPage: () => ({ data: [], nextCursor: "repeated" }) });
  try { const agent = await f.connect(); assert.equal(agent.connected, false); assert.match(agent.error, /分页重复/); assert.equal(f.rpcCalls.filter((call) => call.method === "model/list").length, 2); }
  finally { f.cleanup(); }
});

test("Codex records questions, tool results and replies for engine handoff", async () => {
  const f = fixture({ ask: async () => ({ accepted: true, answers: { ratio: "9:16" } }) });
  const checkpoints = [];
  try {
    const agent = await f.connect();
    const prior = [{ role: "user", content: "制作一张海报" }, { role: "assistant", content: "已确认数量为一张" }];
    const pending = agent.run({ ...f.runInput(), protocolMessages: prior, references: [{ id: "a", source: "attachment", type: "image", title: "product", dataUrl: "data:image/png;base64,AAAA" }], onCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint)) });
    await flush();
    assert.match(f.rpcCalls.find((call) => call.method === "turn/start").params.input[0].text, /已确认数量为一张/);
    f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const params = { threadId: "thread", turnId: "turn" };
    f.event({ type: "rpc", message: { id: "ratio", method: "item/tool/requestUserInput", params: { ...params, questions: [{ id: "ratio", question: "采用什么比例？" }] } } }); await flush();
    f.event({ type: "rpc", message: { id: "create", method: "item/tool/call", params: { ...params, callId: "create", tool: "create_text_node", arguments: { title: "方案", content: "一张竖版海报" } } } }); await flush();
    f.event({ type: "rpc", message: { method: "item/completed", params: { ...params, item: { type: "agentMessage", text: "已保存竖版海报方案" } } } });
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
    const result = await pending;
    assert.ok(result.protocolMessages.some((message) => message.role === "user" && /9:16/.test(message.content)));
    const toolResult = result.protocolMessages.find((message) => message.role === "tool");
    assert.equal(JSON.parse(toolResult.content).ok, true);
    assert.equal(result.protocolMessages.find((message) => message.toolCalls)?.toolCalls[0].id, toolResult.toolCallId);
    assert.equal(result.protocolMessages.at(-1).content, "已保存竖版海报方案");
    assert.doesNotMatch(JSON.stringify(checkpoints), /base64/);
    assert.ok(checkpoints.some((checkpoint) => checkpoint.protocolMessages.some((message) => message.role === "tool" && JSON.parse(message.content).code === "execution_unknown")));
    assert.deepEqual(prior, [{ role: "user", content: "制作一张海报" }, { role: "assistant", content: "已确认数量为一张" }]);
  } finally { f.cleanup(); }
});


test("malformed Codex arguments leave a serializable failed result without executing", async () => {
  const f = fixture();
  try {
    const agent = await f.connect(); const pending = agent.run(f.runInput());
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const params = { threadId: "thread", turnId: "turn" };
    f.event({ type: "rpc", message: { id: "bad", method: "item/tool/call", params: { ...params, callId: "bad", tool: "create_text_node", arguments: ["invalid"] } } }); await flush();
    assert.equal(f.executions.length, 0);
    assert.match(f.replies.find((reply) => reply.id === "bad").error, /JSON 对象/);
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
    const result = await pending;
    const call = result.protocolMessages.find((message) => message.toolCalls).toolCalls[0];
    assert.equal(Array.isArray(call.arguments), false);
    assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool").content).code, "tool_failed");
  } finally { f.cleanup(); }
});

test("Codex retry resumes the same thread and reuses confirmed node writes", async () => {
  const f = fixture();
  try {
    const agent = await f.connect();
    const call = { id: "created", name: "create_text_node", arguments: { title: "方案", content: "正文" } };
    const history = [{ role: "user", content: "创建方案" }, { role: "assistant", toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ ok: true, nodeId: "saved-node" }) }];
    const pending = agent.run({ ...f.runInput(), resume: true, protocolMessages: history, codexThreadId: "original-thread", codexServiceId: "service" });
    await flush();
    assert.ok(f.rpcCalls.some((item) => item.method === "thread/resume" && item.params.threadId === "original-thread"));
    assert.match(f.rpcCalls.find((item) => item.method === "turn/start").params.input[0].text, /继续上次中断/);
    f.threadReady[0]({ turn: { id: "retry-turn" } }); await flush();
    const params = { threadId: "thread", turnId: "retry-turn" };
    f.event({ type: "rpc", message: { id: "repeat", method: "item/tool/call", params: { ...params, tool: call.name, arguments: call.arguments, callId: "repeat" } } }); await flush();
    assert.equal(f.executions.length, 0);
    const reply = f.replies.find((item) => item.id === "repeat");
    assert.equal(reply.result.success, true);
    assert.equal(JSON.parse(reply.result.contentItems[0].text).nodeId, "saved-node");
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
    const result = await pending;
    assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
    assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "codex-retry-turn-repeat").content).nodeId, "saved-node");
  } finally { f.cleanup(); }
});

test("Codex waits for saved media recovery before resuming its thread and rejects premature completion", async () => {
  for (const status of ["success", "error"]) {
    let finish;
    const f = fixture({ executeAction: () => new Promise((resolve) => { finish = resolve; }) });
    try {
      const agent = await f.connect();
      const call = { id: "saved-image", name: "edit_image", arguments: { prompt: "产品白底图", sourceNodeIds: [], attachmentIds: ["reference"] } };
      const history = [{ role: "user", content: "生成产品图" }, { role: "assistant", toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ ok: true, submitted: false, nodeId: "saved-node", status: "idle" }) }];
      const plan = { explanation: "", steps: [{ id: "generate", title: "生成产品图", status: "in_progress" }] };
      const initial = f.runInput();
      const checkpoints = [];
      const pending = agent.run({ ...initial, initialState: { ...initial.initialState, plan }, resume: true, protocolMessages: history, codexThreadId: "original-thread", codexServiceId: "service", onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
      await flush();
      assert.deepEqual(f.executions.map((action) => [action.name, action.arguments.nodeId]), [["generate_node", "saved-node"]]);
      assert.equal(f.rpcCalls.some((call) => call.method.startsWith("thread/") || call.method === "turn/start"), false);
      finish({ ok: status === "success", submitted: true, nodeId: "saved-node", taskId: "saved-task", status });
      await flush();
      assert.ok(f.rpcCalls.some((call) => call.method === "thread/resume" && call.params.threadId === "original-thread"));
      assert.equal(checkpoints.at(-1).state.completedTaskIds.includes("saved-task"), status === "success");
      f.threadReady[0]({ turn: { id: "media-turn" } }); await flush();
      const params = { threadId: "thread", turnId: "media-turn" };
      f.event({ type: "rpc", message: { id: "complete", method: "item/tool/call", params: { ...params, tool: "update_plan", arguments: { explanation: "生成结果检查完成", steps: [{ ...plan.steps[0], status: "completed" }] }, callId: "complete" } } });
      await flush();
      const response = f.replies.find((item) => item.id === "complete");
      assert.ok(response.result, JSON.stringify(response));
      const reply = response.result;
      assert.equal(reply.success, status === "success");
      if (status === "error") assert.equal(JSON.parse(reply.contentItems[0].text).code, "media_not_finished");
      f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
      const result = await pending;
      assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
      assert.equal(result.state.plan.steps[0].status, status === "success" ? "completed" : "in_progress");
    } finally { f.cleanup(); }
  }
});

test("Codex defers media while continuing text work and keeping output-dependent steps deferred", async () => {
  const f = fixture();
  try {
    const agent = await f.connect();
    const call = { id: "saved-image", name: "generate_image", arguments: { prompt: "产品图", sourceNodeIds: [] } };
    const history = [{ role: "user", content: "制作产品图" }, { role: "assistant", toolCalls: [call] }, { role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify({ ok: true, nodeId: "saved-node", submitted: false, status: "idle" }) }];
    const pending = agent.run({ ...f.runInput(), resume: true, mediaGenerationChoice: "defer", protocolMessages: history });
    await flush();
    assert.equal(f.executions.length, 0);
    assert.match(f.rpcCalls.find((entry) => entry.method === "thread/start").params.developerInstructions, /暂不生成，继续规划/);
    assert.match(f.rpcCalls.find((entry) => entry.method === "turn/start").params.input[0].text, /暂不生成/);
    f.threadReady[0]({ turn: { id: "defer-turn" } }); await flush();
    const params = { threadId: "thread", turnId: "defer-turn" };
    f.event({ type: "rpc", message: { id: "denied", method: "item/tool/call", params: { ...params, tool: "generate_node", arguments: { nodeId: "saved-node" }, callId: "denied" } } }); await flush();
    assert.equal(JSON.parse(f.replies.find((entry) => entry.id === "denied").result.contentItems[0].text).code, "media_generation_deferred");
    f.event({ type: "rpc", message: { id: "copy", method: "item/tool/call", params: { ...params, tool: "create_text_node", arguments: { title: "宣传方案", content: "可以继续完成的方案" }, callId: "copy" } } }); await flush();
    assert.deepEqual(f.executions.map((entry) => entry.name), ["create_text_node"]);
    f.event({ type: "rpc", message: { id: "plan", method: "item/tool/call", params: { ...params, tool: "update_plan", arguments: { explanation: "方案先完成，图片稍后生成", steps: [{ id: "image", title: "生成图片", status: "deferred" }, { id: "copy", title: "整理方案", status: "completed" }] }, callId: "plan" } } }); await flush();
    assert.equal(f.replies.find((entry) => entry.id === "plan").result.success, true);
    f.event({ type: "rpc", message: { method: "turn/completed", params: { ...params, turn: { status: "completed" } } } });
    const result = await pending;
    assert.equal(result.state.mediaGenerationDeferred, true);
    assert.deepEqual(Array.from(result.state.plan.steps, (step) => step.status), ["deferred", "completed"]);
    assert.equal(canvasAgentWaitingReason(result.state, result.protocolMessages), "");
  } finally { f.cleanup(); }
});

test("Codex saves tool progress before media completion and keeps it on detach", async () => {
  let checkpoint;
  let saved;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const reasons = [];
  const f = fixture({
    onDisconnect: (reason) => { reasons.push(reason); if (reason) controller.abort(reason); },
    executeAction: async (_action, progress) => {
      assert.equal(JSON.parse(saved.protocolMessages.at(-1).content).code, "execution_unknown");
      progress({ ok: true, nodeId: "existing-image", taskId: "existing-task", submitted: true, status: "loading" });
      saved = structuredClone(checkpoint);
      started();
      return new Promise(() => {});
    },
  });
  try {
    const agent = await f.connect();
    const pending = agent.run({ ...f.runInput(controller), onCheckpoint: (value) => { checkpoint = structuredClone(value); }, persist: async () => { saved = structuredClone(checkpoint); } });
    const stopped = assert.rejects(pending);
    await flush();
    f.threadReady[0]({ turn: { id: "media-progress" } }); await flush();
    f.event({ type: "rpc", message: { id: "media-call", method: "item/tool/call", params: { threadId: "thread", turnId: "media-progress", callId: "image", tool: "generate_image", arguments: { prompt: "Cup", title: "Cup", size: "1:1", count: 1, sourceNodeIds: [] } } } });
    await ready;
    assert.equal(JSON.parse(saved.protocolMessages.at(-1).content).nodeId, "existing-image");
    assert.equal(JSON.parse(saved.protocolMessages.at(-1).content).taskId, "existing-task");
    f.cleanup(); await stopped;
    assert.equal(reasons.at(-1), "canvas-detached");
    assert.equal(JSON.parse(checkpoint.protocolMessages.at(-1).content).nodeId, "existing-image");
  } finally { f.cleanup(); }
});

test("Codex does not start a turn if its recovery checkpoint cannot be saved", async () => {
  const f = fixture();
  try {
    const agent = await f.connect();
    await assert.rejects(agent.run({ ...f.runInput(), persist: async () => { throw new Error("save failed"); } }), /save failed/);
    assert.equal(f.rpcCalls.some((call) => call.method === "turn/start"), false);
  } finally { f.cleanup(); }
});

test("Codex streams commentary and real command, file and image events in order", async () => {
  const f = fixture();
  try {
    const agent = await f.connect();
    const trace = [];
    const pending = agent.run({ ...f.runInput(), onTrace: (entry) => trace.push(entry) });
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    const event = (method, params) => f.event({ type: "rpc", message: { method, params: { threadId: "thread", turnId: "turn", ...params } } });
    event("item/agentMessage/delta", { itemId: "intro", delta: "我先检查" });
    event("item/agentMessage/delta", { itemId: "intro", delta: "现有节点。" });
    event("item/completed", { item: { id: "intro", type: "agentMessage", text: "我先检查现有节点。" } });
    event("item/started", { item: { id: "cmd", type: "commandExecution", command: "pwd", status: "inProgress" } });
    assert.equal(trace.at(-1).status, "running");
    event("item/commandExecution/outputDelta", { itemId: "cmd", delta: "/workspace" });
    assert.match(trace.at(-1).detail, /\/workspace/);
    event("item/completed", { item: { id: "cmd", type: "commandExecution", command: "pwd", aggregatedOutput: "/workspace", exitCode: 0, status: "completed" } });
    event("item/completed", { item: { id: "file", type: "fileChange", status: "completed", changes: [{ path: "notes.txt", diff: "+done" }] } });
    event("item/completed", { item: { id: "image", type: "imageView", path: "/workspace/result.png" } });
    event("item/completed", { item: { id: "answer", type: "agentMessage", text: "检查完成。" } });
    event("turn/completed", { turn: { id: "turn", status: "completed" } });
    const result = await pending;
    assert.equal(result.reply, "检查完成。");
    assert.equal(trace[1].text, "我先检查现有节点。");
    assert.equal(trace[0].id, trace[2].id);
    assert.equal(trace[3].id, trace[4].id);
    assert.deepEqual(trace.filter((entry) => entry.type === "operation" && entry.status === "success").map((entry) => entry.label), ["运行了命令", "编辑了文件", "查看了图片"]);
    assert.match(trace.find((entry) => entry.kind === "command" && entry.status === "success").detail, /pwd\n退出码：0\n\/workspace/);
    assert.equal(trace.at(-1).text, result.reply);
  } finally { f.cleanup(); }
});

test("Codex canvas tool traces update the same row through execution and failure", async () => {
  const f = fixture({ executeAction: async () => { throw new Error("节点更新失败"); } });
  try {
    const agent = await f.connect(); const trace = [];
    const pending = agent.run({ ...f.runInput(), onTrace: (entry) => trace.push(entry) });
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    f.event({ type: "rpc", message: { id: "read", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "get_node", arguments: { nodeId: "node" }, callId: "read" } } });
    await flush(); await flush();
    assert.equal(trace[0].status, "running");
    assert.equal(trace.at(-1).status, "error");
    assert.equal(trace[0].id, trace.at(-1).id);
    assert.match(trace.at(-1).detail, /节点更新失败/);
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "turn", turn: { status: "completed" } } } });
    await pending;
  } finally { f.cleanup(); }
});

test("a plain user request releases Codex media deferral without opening global auto generation", async () => {
  const f = fixture({ executeAction: async (action) => ({ ok: true, nodeId: action.arguments.nodeId, status: "success", submitted: true }) });
  try {
    const agent = await f.connect();
    const base = f.runInput();
    let authorized = false;
    const call = { id: "saved", name: "generate_image", arguments: { prompt: "白底图" } };
    const pending = agent.run({ ...base, userText: "你帮我生成吧", initialState: { ...base.initialState, mediaGenerationDeferred: true },
      protocolMessages: [{ role: "assistant", toolCalls: [call] }, { role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify({ ok: true, nodeId: "original", submitted: false, status: "idle" }) }],
      getContext: () => ({ project: { id: "canvas" }, generation: { autoGenerateMedia: false } }),
      onMediaGenerationChoice: (choice) => { authorized = choice === "generate"; },
    });
    await flush();
    assert.equal(authorized, true);
    assert.deepEqual(f.executions.map((action) => [action.name, action.arguments.nodeId]), [["generate_node", "original"]]);
    assert.match(f.rpcCalls.find((item) => item.method === "thread/start").params.developerInstructions, /本轮明确授权生成/);
    f.threadReady[0]({ turn: { id: "plain-approval" } }); await flush();
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "plain-approval", turn: { status: "completed" } } } });
    assert.equal((await pending).state.mediaGenerationDeferred, false);
  } finally { f.cleanup(); }
});

test("Codex keeps backend workflow review state through progress checkpoints", async () => {
  const backendState = { phase: "review", pendingTaskIds: [], completedTaskIds: [], pendingWorkflowReview: { nodeIds: ["poster"] }, approvedWorkflowReviewPrompts: { poster: "digest" } };
  const f = fixture({ executeAction: async () => ({ ok: true, agentState: backendState }) });
  try {
    const agent = await f.connect(); const checkpoints = [];
    const pending = agent.run({ ...f.runInput(), onCheckpoint: checkpoint => checkpoints.push(checkpoint) });
    await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
    f.event({ type: "rpc", message: { id: "workflow", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "get_canvas_summary", arguments: {}, callId: "workflow" } } });
    await flush(); await flush();
    assert.deepEqual(checkpoints.at(-1).state, backendState);
    assert.equal(f.executions[0].id, "codex-turn-workflow");
    f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "turn", turn: { status: "completed" } } } });
    assert.deepEqual((await pending).state, backendState);
  } finally { f.cleanup(); }
});
test("Codex workflow approval waits for the user and forwards free text or cancellation", async () => {
  for (const answer of ["确认审核并生成", "暂不生成，请修改颜色", ""]) {
    let resolveAnswer; let questionID; const answers = [];
    const f = fixture({ ask: request => { questionID = request.questions[0].id; return new Promise(resolve => { resolveAnswer = resolve; }); } });
    try {
      const agent = await f.connect(); const base = f.runInput();
      const pending = agent.run({ ...base, onWorkflowReviewAnswer: async text => { answers.push(text); return { ...base.initialState, mediaGenerationDeferred: text !== "确认审核并生成" }; } });
      await flush(); f.threadReady[0]({ turn: { id: "turn" } }); await flush();
      f.event({ type: "rpc", message: { id: "review", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "ask_user_question", arguments: { question: "确认这些提示词吗？", reason: "审核后才生成", options: ["确认审核并生成（推荐）", "暂不生成"], kind: "confirmation", purpose: "workflow_review" }, callId: "review" } } });
      await flush(); assert.deepEqual(answers, []);
      resolveAnswer({ accepted: Boolean(answer), answers: { [questionID]: answer } });
      await flush(); await flush(); assert.deepEqual(answers, [answer]);
      f.event({ type: "rpc", message: { method: "turn/completed", params: { threadId: "thread", turnId: "turn", turn: { status: "completed" } } } });
      assert.equal((await pending).state.mediaGenerationDeferred, answer !== "确认审核并生成");
    } finally { f.cleanup(); }
  }
});

test("Codex small talk skips prior media recovery and blocks canvas tools", async () => {
  const f = fixture();
  try {
    const agent = await f.connect(); const base = f.runInput();
    const pending = agent.run({ ...base, userText:"你好啊",conversationOnly:true,resume:true,protocolMessages:[{role:"tool",name:"generate_image",toolCallId:"old",content:JSON.stringify({ok:true,nodeId:"old",submitted:false,status:"idle"})}] });
    await flush();
    assert.equal(f.executions.length,0);
    const instructions=f.rpcCalls.find(call=>call.method==="thread/start").params.developerInstructions;
    assert.match(instructions,/当前轮只聊天/);
    assert.doesNotMatch(instructions,/canvas prompt/);
    f.threadReady[0]({turn:{id:"conversation"}});await flush();
    f.event({type:"rpc",message:{id:"bad-tool",method:"item/tool/call",params:{threadId:"thread",turnId:"conversation",tool:"get_canvas_summary",arguments:{},callId:"read"}}});
    await flush();await flush();assert.equal(f.executions.length,0);
    assert.equal(JSON.parse(f.replies[0].result.contentItems[0].text).code,"conversation_only");
    f.event({type:"rpc",message:{method:"turn/completed",params:{threadId:"thread",turnId:"conversation",turn:{status:"completed"}}}});
    await pending;
  } finally {f.cleanup();}
});
