import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "../src/components/ai-elements/context.tsx";
import * as canvasAgentMemory from "../src/app/canvas/agent/canvas-agent-memory.ts";

const { estimateCanvasAgentTokens } = canvasAgentMemory;

test("context updates measure retained history only once without changing token accounting", () => {
  let historyReads = 0;
  const body = "Retained complete tool history. ".repeat(50000);
  const messages = [
    { role: "user", content: "完整中文历史😀" },
    {
      role: "tool", toolCallId: "read", name: "get_node",
      get content() { historyReads++; return body; },
    },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(200000) } }] },
  ];
  const summary = "保留摘要";
  const contexts = [{}, { project: { title: "第一次改名" } }, { project: { title: "第二次改名😀", nodeCount: 2 } }];
  const expected = contexts.map(context => estimateCanvasAgentTokens({ messages, summary, context }));
  historyReads = 0;
  const replies = [];
  const scope = { postMessage: result => replies.push(result) };
  const source = readFileSync(new URL("../src/app/canvas/agent/canvas-agent-token-estimate.worker.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("exports", "require", "globalThis", code)({}, name => {
    assert.equal(name, "./canvas-agent-memory");
    return canvasAgentMemory;
  }, scope);
  scope.onmessage({ data: { type: "history", messages, summary } });
  for (const [index, context] of contexts.entries()) {
    scope.onmessage({ data: { type: "estimate", requestID: index + 1, context } });
  }
  assert.deepEqual(replies, [{ type: "ready" }, ...expected.map((tokens, index) => ({ requestID: index + 1, tokens }))]);
  assert.equal(historyReads, 1, "canvas-only updates must not repeatedly serialize the retained protocol history");
});

test("context indicators distinguish pending and failed estimates from measured zero usage", () => {
  const pending = renderToStaticMarkup(createElement(Context, { limit: 1000, rows: [] }));
  assert.match(pending, /aria-valuetext="正在估算"/);
  assert.doesNotMatch(pending, /aria-valuenow=|NaN|上限未知/);
  const failed = renderToStaticMarkup(createElement(Context, { limit: 1000, rows: [], error: "估算失败" }));
  assert.match(failed, /aria-valuetext="用量估算失败"/);
  assert.doesNotMatch(failed, /aria-valuenow=|NaN/);
  const zero = renderToStaticMarkup(createElement(Context, { tokens: 0, limit: 1000, measured: true, rows: [] }));
  assert.match(zero, /aria-valuenow="0"/);
  assert.match(zero, /aria-valuetext="0%"/);
});

function estimateHook(autoReady = true) {
  const workers = [], refs = [], effects = [];
  let state, pending = [], refIndex = 0, effectIndex = 0, mode;
  class ControlledWorker {
    constructor() {
      if (mode === "constructor") throw new Error("worker blocked");
      workers.push(this);
      this.terminated = 0;
      this.sent = [];
    }
    postMessage(input) {
      if (mode === "post-history" && input.type === "history" || mode === "post-context" && input.type === "estimate") throw new Error("cannot clone");
      this.sent.push(input);
    }
    terminate() { this.terminated++; }
  }
  const react = {
    useState: () => [state, next => { state = next; }],
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ||= { current: initial };
    },
    useEffect(callback, deps) {
      const index = effectIndex++;
      if (!effects[index] || !deps.every((value, i) => Object.is(value, effects[index].deps[i]))) pending.push({ index, callback, deps });
    },
  };
  const source = readFileSync(new URL("../src/app/canvas/use-canvas-agent-token-estimate.ts", import.meta.url), "utf8").replace("import.meta.url", '"https://canvas.example/use-canvas-agent-token-estimate.ts"');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("exports", "require", "Worker", "URL", code)(exports, name => { assert.equal(name, "react"); return react; }, ControlledWorker, URL);
  return {
    workers,
    state: () => state,
    failWith(value) { mode = value; },
    render(input, commit = true) {
      refIndex = 0;
      effectIndex = 0;
      pending = [];
      const result = exports.useCanvasAgentTokenEstimate(input);
      if (commit) this.commit();
      return result;
    },
    commit() {
      const updates = pending;
      pending = [];
      for (const update of updates) effects[update.index]?.cleanup?.();
      for (const update of updates) effects[update.index] = { deps: update.deps, cleanup: update.callback() };
      if (autoReady) for (const worker of workers) {
        if (!worker.terminated && !worker.ready) { worker.ready = true; worker.onmessage?.({ data: { type: "ready" } }); }
      }
    },
    unmount() {
      for (const effect of effects) effect?.cleanup?.();
      effects.length = 0;
    },
  };
}

test("discarded estimate mounts never transfer history and readiness uses only the latest context", () => {
  const hook = estimateHook(false);
  const first = { messages: [{ role: "tool", content: "Retained complete history. ".repeat(100000) }], summary: "完整摘要", context: { project: { title: "原名称" } } };
  hook.render(first);
  const discarded = hook.workers[0], late = discarded.onmessage;
  assert.deepEqual(discarded.sent, [], "a worker must be ready before the main thread clones the complete history");
  hook.unmount();
  hook.render(first);
  late({ data: { type: "ready" } });
  assert.deepEqual(discarded.sent, []);
  const worker = hook.workers[1];
  const latest = { ...first, context: { project: { title: "最新名称" } } };
  hook.render(latest);
  assert.deepEqual(worker.sent, []);
  worker.onmessage({ data: { type: "ready" } });
  assert.deepEqual(worker.sent, [{ type: "history", messages: first.messages, summary: first.summary }, { type: "estimate", requestID: 2, context: latest.context }]);
  worker.onmessage({ data: { type: "ready" } });
  assert.equal(worker.sent.length, 2, "duplicate readiness must not retransfer retained history");
  worker.onmessage({ data: { requestID: 1, tokens: 999 } });
  assert.deepEqual(hook.render(latest), {});
  worker.onmessage({ data: { requestID: 2, tokens: 321 } });
  assert.equal(hook.render(latest).tokens, 321);
  hook.unmount();
  assert.equal(worker.terminated, 1);
});

test("context-only estimates transfer the complete transcript once and ignore obsolete request results", () => {
  const hook = estimateHook();
  const messages = [{ role: "user", content: "完整原会话" }, { role: "tool", toolCallId: "read", name: "get_node", content: "Retained. ".repeat(100000) }];
  const first = { messages, summary: "完整摘要", context: { project: { title: "原名称" } } };
  assert.deepEqual(hook.render(first), {});
  assert.equal(hook.workers.length, 1);
  const worker = hook.workers[0], late = worker.onmessage;
  assert.deepEqual(worker.sent, [
    { type: "history", messages, summary: first.summary },
    { type: "estimate", requestID: 1, context: first.context },
  ]);
  worker.onmessage({ data: { requestID: 1, tokens: 123 } });
  assert.equal(hook.render(first).tokens, 123);
  assert.equal(worker.terminated, 0);
  const second = { ...first, context: { project: { title: "新名称" } } };
  assert.deepEqual(hook.render(second, false), {});
  late({ data: { requestID: 1, tokens: 999 } });
  hook.commit();
  assert.equal(hook.workers.length, 1);
  assert.equal(worker.sent.filter(message => message.type === "history").length, 1);
  assert.deepEqual(worker.sent.at(-1), { type: "estimate", requestID: 2, context: second.context });
  late({ data: { requestID: 1, tokens: 777 } });
  assert.deepEqual(hook.render(second), {});
  worker.onmessage({ data: { requestID: 2, tokens: 0 } });
  assert.equal(hook.render(second).tokens, 0);
  const saved = hook.state();
  hook.unmount();
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  late({ data: { requestID: 2, tokens: 444 } });
  assert.equal(hook.state(), saved);
});

test("changing transcript or summary releases the previous worker and retains every new history field", () => {
  const hook = estimateHook();
  const first = { messages: [{ role: "user", content: "原会话" }], context: {} };
  hook.render(first);
  const old = hook.workers[0], late = old.onmessage;
  const second = { ...first, messages: [{ role: "assistant", toolCalls: [{ id: "call", name: "get_node", arguments: { id: "node", nested: { retained: true } } }] }, { role: "tool", toolCallId: "call", name: "get_node", content: "完整工具结果" }] };
  assert.deepEqual(hook.render(second), {});
  assert.equal(old.terminated, 1);
  assert.equal(hook.workers.length, 2);
  assert.deepEqual(hook.workers[1].sent[0], { type: "history", messages: second.messages, summary: undefined });
  late({ data: { requestID: 1, tokens: 999 } });
  assert.deepEqual(hook.render(second), {});
  const third = { ...second, summary: "新的压缩摘要" };
  hook.render(third);
  assert.equal(hook.workers[1].terminated, 1);
  assert.deepEqual(hook.workers[2].sent[0], { type: "history", messages: third.messages, summary: third.summary });
  hook.workers[2].onmessage({ data: { requestID: 1, tokens: 345 } });
  assert.equal(hook.render(third).tokens, 345);
  hook.unmount();
  assert.equal(hook.workers[2].terminated, 1);
});

test("hidden panels and cancelled estimates release retained history without reporting failures", () => {
  const hook = estimateHook(), input = { messages: [], context: {} };
  hook.render(input);
  const worker = hook.workers[0], late = worker.onmessage;
  hook.render(undefined);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  late({ data: { requestID: 1, error: "cancelled" } });
  assert.deepEqual(hook.render(undefined), {});
  assert.deepEqual(hook.render(input), {});
  assert.equal(hook.workers.length, 2);
  hook.unmount();
  assert.equal(hook.workers[1].terminated, 1);
  hook.unmount();
  assert.equal(hook.workers[1].terminated, 1);
});

test("worker failures are explicit, release resources and never fabricate zero usage", () => {
  for (const failure of ["constructor", "post-history", "post-context", "error", "messageerror", "invalid", "negative", "nonfinite", "reported-error"]) {
    const hook = estimateHook(), input = { messages: [], context: {} };
    if (["constructor", "post-history", "post-context"].includes(failure)) hook.failWith(failure);
    hook.render(input);
    const worker = hook.workers[0];
    if (failure === "error") {
      let prevented = false;
      worker.onerror({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    }
    if (failure === "messageerror") worker.onmessageerror();
    if (failure === "invalid") worker.onmessage({ data: { requestID: 1 } });
    if (failure === "negative") worker.onmessage({ data: { requestID: 1, tokens: -1 } });
    if (failure === "nonfinite") worker.onmessage({ data: { requestID: 1, tokens: NaN } });
    if (failure === "reported-error") worker.onmessage({ data: { requestID: 1, error: "private details must not escape" } });
    const result = hook.render(input);
    assert.match(result.error, /估算/);
    assert.equal(result.tokens, undefined);
    assert.doesNotMatch(result.error, /private details/);
    if (worker) assert.equal(worker.terminated, 1);
    hook.render({ ...input, context: { changed: true } });
    assert.equal(hook.workers.length, failure === "constructor" ? 0 : 1);
    hook.unmount();
    if (worker) assert.equal(worker.terminated, 1);
  }
});

test("an unknown request result cannot end the current estimate or fabricate an error", () => {
  const hook = estimateHook(), input = { messages: [], context: {} };
  hook.render(input);
  const worker = hook.workers[0];
  for (const data of [{ requestID: 0, tokens: 999 }, { requestID: 2, error: "out of order" }, {}]) {
    worker.onmessage({ data });
    assert.deepEqual(hook.render(input), {});
  }
  worker.onmessage({ data: { requestID: 1, tokens: 42 } });
  assert.equal(hook.render(input).tokens, 42);
  hook.unmount();
});

test("the actual retained-history worker preserves exact UTF-8 and image accounting across context updates", async () => {
  const worker = new Worker(new URL("../src/app/canvas/agent/canvas-agent-token-estimate.worker.ts", import.meta.url).href, { type: "module" });
  let requestID = 0;
  const request = context => new Promise((resolve, reject) => {
    const id = ++requestID;
    const timer = setTimeout(() => reject(new Error("token worker did not respond")), 5000);
    worker.onmessage = event => {
      if (event.data?.requestID !== id) return;
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = error => { clearTimeout(timer); reject(error); };
    worker.postMessage({ type: "estimate", requestID: id, context });
  });
  try {
    assert.deepEqual(await request({}), { requestID: 1, error: "上下文用量估算失败" });
    const unicode = ("中文😀" + String.fromCharCode(92, 34, 10, 0xd800)).repeat(3000);
    for (const input of [
      { messages: [], context: {} },
      { messages: [{ role: "user", content: unicode }], summary: undefined, context: {} },
      { messages: [{ role: "user", content: [{ type: "text", text: "参考图" }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(200000) } }] }], summary: "保留摘要", context: {} },
    ]) {
      worker.postMessage({ type: "history", messages: input.messages, summary: input.summary });
      for (const context of [input.context, { project: { title: unicode, nodeCount: 3 } }]) {
        const actual = await request(context);
        assert.deepEqual(actual, { requestID, tokens: estimateCanvasAgentTokens({ ...input, context }) });
      }
    }
    const cyclic = { private: "do not expose" }; cyclic.self = cyclic;
    assert.deepEqual(await request(cyclic), { requestID, error: "上下文用量估算失败" });
  } finally {
    worker.terminate();
  }
});
