import assert from "node:assert/strict";
import { test } from "bun:test";
import { connectCanvasCodex, validateCanvasCodexEndpoint } from "../src/services/api/canvas-codex.ts";

test("canvas Codex accepts loopback HTTP endpoints without credentials or paths", () => {
  assert.equal(validateCanvasCodexEndpoint("http://localhost:3210/"), "http://localhost:3210");
  for (const value of ["https://example.com", "http://127.0.0.1:3210/other", "http://user:secret@localhost:3210", "http://127.0.0.1:3210?token=x"]) assert.throws(() => validateCanvasCodexEndpoint(value));
});

test("canvas Codex streams split events without cookies and closes the server session on abort", async () => {
  const originalFetch = globalThis.fetch; const requests = []; const events = [];
  const abort = new AbortController(); let stream;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { stream = controller; options.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json(url.endsWith("/sessions") ? { sessionId: "session", serviceId: "service" } : { ok: true });
  };
  try {
    const link = await connectCanvasCodex({ endpoint: "http://127.0.0.1:3210", token: "x".repeat(32), canvasId: "canvas", tools: [], signal: abort.signal, onEvent: (event) => events.push(event) });
    stream.enqueue(new TextEncoder().encode(': connected\n\ndata: {"type":"tool",'));
    stream.enqueue(new TextEncoder().encode('"requestId":"call","name":"get_canvas_summary","arguments":{}}\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(events[0].requestId, "call");
    await link.toolResult("call", { ok: true });
    abort.abort(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.at(-1).options.method, "DELETE");
    assert.ok(requests.every(({ options }) => options.credentials === "omit"));
    assert.ok(requests.every(({ options }) => options.headers.authorization === `Bearer ${"x".repeat(32)}`));
    assert.equal(events.length, 1);
  } finally { abort.abort(); globalThis.fetch = originalFetch; }
});

test("canvas Codex reports a broken event stream and deletes its session", async () => {
  const originalFetch = globalThis.fetch; const requests = []; const events = [];
  const abort = new AbortController(); let stream;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json(url.endsWith("/sessions") ? { sessionId: "session", serviceId: "service" } : {});
  };
  try {
    await connectCanvasCodex({ endpoint: "http://127.0.0.1:3210", token: "x".repeat(32), canvasId: "canvas", tools: [], signal: abort.signal, onEvent: (event) => events.push(event) });
    stream.close(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(events[0].type, "disconnected"); assert.equal(requests.at(-1).options.method, "DELETE");
  } finally { abort.abort(); globalThis.fetch = originalFetch; }
});

test("canvas Codex reports a non-JSON error response with its status instead of a parse failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  try {
    await assert.rejects(
      connectCanvasCodex({ endpoint: "http://127.0.0.1:3210", token: "x".repeat(32), canvasId: "canvas", tools: [], signal: new AbortController().signal, onEvent() {} }),
      /本地 Codex 连接失败（502）/,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("canvas Codex rejects a successful response that is not JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  try {
    await assert.rejects(
      connectCanvasCodex({ endpoint: "http://127.0.0.1:3210", token: "x".repeat(32), canvasId: "canvas", tools: [], signal: new AbortController().signal, onEvent() {} }),
      /本地 Codex 返回了无效响应/,
    );
  } finally { globalThis.fetch = originalFetch; }
});
