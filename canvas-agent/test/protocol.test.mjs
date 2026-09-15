import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexClient } from "../codex-client.mjs";
import { readJSONLines } from "../json-lines.mjs";
import { createCanvasMCP } from "../mcp.mjs";

function fakeChild(received) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.stdin = new Writable({ write(data, _, done) {
    const message = JSON.parse(data.toString()); received.push(message);
    if (message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n"));
    done();
  } });
  child.kill = () => { child.exitCode = 0; return true; };
  return child;
}
test("uses the current app-server handshake and pairs responses by request ID", async () => {
  const received = []; const events = []; const child = fakeChild(received);
  const client = new CodexClient({ cwd: "/tmp/canvas-test", onMessage: (message) => events.push(message), spawnProcess: (command, args, options) => {
    assert.equal(command, "codex"); assert.deepEqual(args, ["app-server"]); assert.equal(options.cwd, "/tmp/canvas-test"); assert.equal(options.env.CANVAS_AGENT_TOKEN, undefined); return child;
  } });
  try {
    await client.ready;
    assert.equal(received[0].params.capabilities.experimentalApi, true);
    assert.equal(received[0].jsonrpc, undefined);
    assert.equal(received[1].method, "initialized");
    const first = client.request("model/list", {}); const second = client.request("account/read", {});
    child.stdout.write('{"id":3,"result":{"account":null}}\n{"id":2,"result":{"data":[]}}\n');
    assert.deepEqual(await first, { data: [] }); assert.deepEqual(await second, { account: null });
    child.stdout.write('{"id":"call","method":"item/tool/call","params":{}}\n');
    assert.equal(events.length, 1);
    client.reply("call", { success: true, contentItems: [] });
    assert.equal(received.at(-1).id, "call"); assert.throws(() => client.reply("call", {}), /失效/);
  } finally { client.close(); }
});
test("closing Codex rejects pending requests and removes resolved server requests", async () => {
  const received = []; const child = fakeChild(received);
  const client = new CodexClient({ cwd: "/tmp/canvas-test", onMessage() {}, spawnProcess: () => child });
  await client.ready;
  child.stdout.write('{"id":"call","method":"item/tool/call","params":{}}\n{"method":"serverRequest/resolved","params":{"requestId":"call"}}\n');
  assert.throws(() => client.reply("call", {}), /失效/);
  const pending = client.request("model/list", {});
  client.close(); await assert.rejects(pending, /关闭/); assert.equal(child.exitCode, 0);
});
test("limits incomplete JSONL input and retains split UTF-8 characters", () => {
  const input = new PassThrough(); const messages = []; const errors = [];
  readJSONLines(input, (message) => messages.push(message), (error) => errors.push(error), 64);
  const bytes = Buffer.from('{"text":"中文"}\n');
  input.write(bytes.subarray(0, 10)); input.write(bytes.subarray(10));
  assert.deepEqual(messages, [{ text: "中文" }]);
  input.write("x".repeat(65)); assert.match(errors[0].message, /过大/);
  input.end('{"ignored":true}\n'); assert.equal(messages.length, 1);
});
test("rejects incomplete and invalid JSONL frames", () => {
  for (const content of ['{"x":', 'invalid\n']) {
    const input = new PassThrough(); const errors = [];
    readJSONLines(input, () => assert.fail("must not dispatch"), (error) => errors.push(error));
    if (content.endsWith("\n")) input.write(content); else { input.write(content); input.emit("end"); }
    assert.equal(errors.length, 1);
  }
});

test("MCP exposes tools and reports failed canvas operations as tool errors", async () => {
  const requests = [];
  const mcp = createCanvasMCP({ endpoint: "http://127.0.0.1:3210", token: "token", sessionId: "canvas-1", fetchRequest: async (url, options) => {
    requests.push({ url, options }); return Response.json(url.endsWith("/tools") ? { tools: [{ name: "create_text_node", inputSchema: { type: "object" } }] } : { ok: false, message: "用户拒绝" });
  } });
  const init = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  await mcp.handle({ method: "notifications/initialized" });
  assert.equal((await mcp.handle({ id: 2, method: "tools/list" })).result.tools.length, 1);
  assert.equal((await mcp.handle({ id: 3, method: "tools/call", params: { name: "create_text_node", arguments: {} } })).result.isError, true);
  assert.equal(requests[0].options.headers.authorization, "Bearer token"); assert.ok(requests[1].url.endsWith("/sessions/canvas-1/tools-call")); mcp.close();
});
test("MCP cancellation aborts the matching HTTP call", async () => {
  let started; const reached = new Promise((resolve) => { started = resolve; });
  const mcp = createCanvasMCP({ endpoint: "http://localhost:3210", token: "token", sessionId: "canvas", fetchRequest: async (_, options) => new Promise((_, reject) => { options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); started(); }) });
  await mcp.handle({ id: 1, method: "initialize" }); await mcp.handle({ method: "notifications/initialized" });
  const pending = mcp.handle({ id: "pending", method: "tools/call", params: { name: "create_text_node" } });
  await reached; await mcp.handle({ method: "notifications/cancelled", params: { requestId: "pending" } });
  assert.match((await pending).error.message, /cancelled/); mcp.close();
});
test("MCP refuses remote or credential-bearing connection URLs", () => {
  for (const endpoint of ["https://example.com", "http://localhost@evil.example", "http://127.0.0.1:3210/path", "http://127.0.0.1:3210?token=bad"]) assert.throws(() => createCanvasMCP({ endpoint, token: "x", sessionId: "x" }));
});
