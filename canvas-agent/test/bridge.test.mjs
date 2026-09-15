import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { createCanvasAgentServer } from "../server.mjs";

const token = "test-local-bridge-credential-0123456789";
const origin = "http://127.0.0.1:8002";
const tool = { name: "create_text_node", description: "Create text", inputSchema: { type: "object", properties: {} } };
async function fixture(t) {
  const clients = [];
  const bridge = createCanvasAgentServer({ token, origins: [origin], createClient(options) {
    const client = { ...options, ready: Promise.resolve(), calls: [], closed: false,
      async request(method, params) { this.calls.push({ method, params }); return method.startsWith("thread/") ? { thread: { id: params.threadId || `thread-${clients.length}` } } : method === "turn/start" ? { turn: { id: "turn-1" } } : {}; },
      reply() {}, close() { this.closed = true; },
    }; clients.push(client); return client;
  } });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(() => bridge.close());
  async function request(path, body, options = {}) {
    return fetch(endpoint + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, origin, ...(body ? { "content-type": "application/json" } : {}), ...options.headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...options });
  }
  const session = async (canvasId = "account-a:canvas") => (await request("/sessions", { canvasId, tools: [tool] })).json();
  async function stream(id) {
    const controller = new AbortController();
    const response = await request(`/sessions/${id}/events`, undefined, { signal: controller.signal });
    const reader = response.body.getReader();
    t.after(() => controller.abort());
    let buffer = "";
    return { controller, async next() {
      while (true) {
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("stream closed");
        buffer += new TextDecoder().decode(value);
      }
    } };
  }
  return { endpoint, request, session, stream, clients };
}

test("requires a local host, allowed Origin and exact bearer token", async (t) => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ authorization: "Bearer invalid", origin }, 401], [{ authorization: `Bearer ${token}`, origin: "https://evil.example" }, 403]]) {
    const response = await f.request("/sessions", { canvasId: "x", tools: [tool] }, { headers });
    assert.equal(response.status, status, JSON.stringify(headers));
  }
  const forgedHost = await new Promise((resolve, reject) => { const request = httpRequest(f.endpoint, { headers: { host: "evil.example", authorization: `Bearer ${token}` } }, (response) => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); request.end(); });
  assert.equal(forgedHost, 403);
  const preflight = await f.request("/sessions", undefined, { method: "OPTIONS", headers: { origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
});

test("enforces current dynamic tool schema, local cwd, approval and sandbox limits", async (t) => {
  const f = await fixture(t); const { sessionId } = await f.session();
  const response = await f.request(`/sessions/${sessionId}/rpc`, { method: "thread/start", params: { cwd: "/root", approvalPolicy: "never", sandbox: "danger-full-access", dynamicTools: [], model: "test-model" } });
  assert.equal(response.status, 200);
  const call = f.clients[0].calls[0];
  assert.equal(call.params.sandbox, "read-only"); assert.equal(call.params.approvalPolicy, "on-request");
  assert.match(call.params.cwd, /chatgpt2api-codex-/);
  assert.deepEqual(call.params.dynamicTools, [{ type: "function", ...tool }]);
  const refused = await f.request(`/sessions/${sessionId}/rpc`, { method: "command/exec", params: { command: "anything" } });
  assert.equal(refused.status, 400); assert.equal(f.clients[0].calls.length, 1);
});

test("isolates threads from other accounts and concurrent page connections", async (t) => {
  const f = await fixture(t);
  const a = await f.session();
  const thread = (await (await f.request(`/sessions/${a.sessionId}/rpc`, { method: "thread/start" })).json()).thread.id;
  for (const scope of ["account-b:canvas", "account-a:canvas"]) {
    const b = await f.session(scope);
    assert.equal((await f.request(`/sessions/${b.sessionId}/rpc`, { method: "thread/resume", params: { threadId: thread } })).status, 400);
  }
  await f.request(`/sessions/${a.sessionId}`, undefined, { method: "DELETE" });
  const resumed = await f.session();
  assert.equal((await f.request(`/sessions/${resumed.sessionId}/rpc`, { method: "thread/resume", params: { threadId: thread } })).status, 200);
});

test("relays MCP calls through the connected page and resolves its result", async (t) => {
  const f = await fixture(t); const { sessionId } = await f.session(); const stream = await f.stream(sessionId);
  const pending = f.request(`/sessions/${sessionId}/tools-call`, { name: tool.name, arguments: { title: "test" } });
  const event = await stream.next();
  assert.equal(event.type, "tool"); assert.equal(event.name, tool.name);
  const result = { ok: true, nodeId: "created" };
  assert.equal((await f.request(`/sessions/${sessionId}/tool-results`, { requestId: event.requestId, result })).status, 200);
  assert.deepEqual(await (await pending).json(), result);
  assert.equal(f.clients.length, 0, "MCP calls do not start a Codex process");
});

test("cancels disconnected MCP calls before delayed browser confirmation", async (t) => {
  const f = await fixture(t); const { sessionId } = await f.session(); const stream = await f.stream(sessionId);
  const controller = new AbortController();
  const pending = f.request(`/sessions/${sessionId}/tools-call`, { name: tool.name, arguments: {} }, { signal: controller.signal });
  const event = await stream.next();
  controller.abort(); await assert.rejects(pending);
  assert.deepEqual(await stream.next(), { type: "tool-cancel", requestId: event.requestId });
  assert.equal((await f.request(`/sessions/${sessionId}/tool-results`, { requestId: event.requestId, result: { ok: true } })).status, 400);
});

test("closing a page terminates its Codex client and pending MCP calls", async (t) => {
  const f = await fixture(t); const { sessionId } = await f.session(); const stream = await f.stream(sessionId);
  await f.request(`/sessions/${sessionId}/rpc`, { method: "thread/start" });
  const pending = f.request(`/sessions/${sessionId}/tools-call`, { name: tool.name, arguments: {} });
  await stream.next();
  await f.request(`/sessions/${sessionId}`, undefined, { method: "DELETE" });
  assert.equal((await pending).status, 400); assert.equal(f.clients[0].closed, true);
  assert.equal((await f.request(`/sessions/${sessionId}/tools`)).status, 404);
});

test("permits turn interruption while a turn-start response is pending", async (t) => {
  const f = await fixture(t); const { sessionId } = await f.session();
  const threadId = (await (await f.request(`/sessions/${sessionId}/rpc`, { method: "thread/start" })).json()).thread.id;
  let acknowledge; let started;
  const reached = new Promise((resolve) => { started = resolve; });
  f.clients[0].request = async (method) => method === "turn/start" ? new Promise((resolve) => { acknowledge = resolve; started(); }) : {};
  const pending = f.request(`/sessions/${sessionId}/rpc`, { method: "turn/start", params: { threadId, input: [{ type: "text", text: "hi" }] } });
  await reached;
  assert.equal((await f.request(`/sessions/${sessionId}/rpc`, { method: "turn/interrupt", params: { threadId, turnId: "turn" } })).status, 200);
  acknowledge({ turn: { id: "turn" } }); await pending;
});
