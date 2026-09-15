import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "bun:test";
import { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction } from "../src/app/canvas/agent/canvas-agent-tools.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(options = {}) {
  const slots = []; const effects = []; let index = 0; let connectInput; let accountKey = "private-account-credential-id";
  const rpcCalls = []; const replies = []; const toolResults = []; const executions = []; const threadReady = [];
  const window = Object.assign(new EventTarget(), { location: { origin: "https://canvas.example" } });
  const link = { serviceId: "service", sessionId: "session", disconnect() {},
    async rpc(method, params) {
      rpcCalls.push({ method, params });
      if (method === "account/read") return { account: {} };
      if (method === "model/list") return { data: [{ model: "codex-test", defaultReasoningEffort: "medium" }], nextCursor: null };
      if (method.startsWith("thread/")) return { thread: { id: "thread" } };
      if (method === "turn/start") return new Promise((resolve) => threadReady.push(resolve));
      return {};
    },
    async reply(id, result) { replies.push({ id, result }); }, async reject(id, message) { replies.push({ id, error: message }); },
    async toolResult(id, result) { toolResults.push({ id, result }); },
  };
  const dependencies = {
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
    "./canvas-agent-tools": { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction },
    "./canvas-agent-runtime": { applyAgentState: (state, args) => ({ ...state, ...args }), applyTaskResult: (state) => state },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("../src/app/canvas/agent/canvas-codex-agent.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; }, window, crypto, TextEncoder, AbortController, AbortSignal, DOMException });
  const input = { canvasId: "canvas", onDisconnect() {}, executeAction: async (action) => { executions.push(action); return options.executeAction ? options.executeAction(action) : { ok: true }; }, ask: options.ask || (async () => ({ accepted: true })) };
  let agent;
  function render() { index = 0; agent = module.exports.useCanvasCodexAgent(input); return agent; }
  render();
  const runInput = (controller = new AbortController()) => ({ model: "unused", relayTokenName: "", userText: "创建文字", references: [], protocolMessages: [], initialState: { phase: "intake" }, signal: controller.signal, getContext: () => ({ project: { id: "canvas" } }), executeAction: input.executeAction });
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
