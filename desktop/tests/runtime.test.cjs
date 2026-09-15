"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { LocalRuntime, backendEnvironment, healthCheck, checkDevelopmentServices } = require("../src/runtime.cjs");
class FakeChild extends EventEmitter {
  constructor({ graceful = true, killWorks = true } = {}) {
    super(); this.exitCode = null; this.signalCode = null; this.ends = 0; this.kills = 0;
    this.stdout = this.stderr = { resume() {} }; this.stdin = new EventEmitter();
    this.stdin.end = () => { this.ends++; if (graceful) queueMicrotask(() => this.close(0)); };
    this.kill = () => { this.kills++; if (killWorks) queueMicrotask(() => this.close(null, "SIGTERM")); return killWorks; };
  }
  close(code, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit("close", code, signal); }
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-runtime-test-"));
  const child = options.child || new FakeChild(); const calls = [];
  const runtime = new LocalRuntime({ executable: "backend.exe", rootDir: root, portAllocator: async () => 45678, spawnImpl: (file, args, spawnOptions) => { calls.push({ file, args, env: { ...spawnOptions.env }, options: spawnOptions }); return child; }, checkHealth: async () => {}, shutdownTimeoutMs: 5, forceWaitMs: 5, ...options });
  t.after(async () => { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { runtime, child, calls };
}
test("local runtime starts once, confines its environment, and exits through stdin EOF", async (t) => {
  const { runtime, child, calls } = await fixture(t);
  const [first, second] = await Promise.all([runtime.start("bootstrap-example-password"), runtime.start("ignored-second-password")]);
  assert.equal(first, "http://127.0.0.1:45678"); assert.equal(first, second); assert.equal(calls.length, 1);
  assert.equal(calls[0].env.ADMIN_PASSWORD, "bootstrap-example-password"); assert.equal(calls[0].options.env.ADMIN_PASSWORD, "");
  assert.equal(calls[0].env.LISTEN_HOST, "127.0.0.1"); assert.equal(calls[0].env.DESKTOP_RUNTIME, "1");
  assert.equal(calls[0].env.DESKTOP_INSTANCE_TOKEN.length, 48); assert.equal(calls[0].options.shell, false); assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  await runtime.stop(); assert.equal(child.ends, 1); assert.equal(child.kills, 0); assert.equal(runtime.child, null);
});
test("inherited deployment credentials cannot switch the desktop database or bootstrap user", () => {
  const env = backendEnvironment({ PATH: "path", SystemRoot: "windows", ADMIN_PASSWORD: "host-secret", ROOT_DIR: "host-data", STORAGE_DATABASE_URL: "postgres://secret", OPENAI_API_KEY: "secret" }, "/desktop/data", 43210, "new-password", "nonce");
  assert.equal(env.SystemRoot, "windows"); assert.equal(env.PATH, "path"); assert.equal(env.ROOT_DIR, "/desktop/data"); assert.equal(env.STORAGE_BACKEND, "sqlite"); assert.ok(env.STORAGE_DATABASE_URL.startsWith("sqlite:///")); assert.equal(env.ADMIN_USERNAME, "admin"); assert.equal(env.ADMIN_PASSWORD, "new-password"); assert.equal(env.OPENAI_API_KEY, undefined);
});
test("shutdown waits for graceful exit before force termination", async (t) => {
  const { runtime, child } = await fixture(t, { child: new FakeChild({ graceful: false }) }); await runtime.start(); await runtime.stop(); assert.equal(child.ends, 1); assert.equal(child.kills, 1); assert.equal(runtime.child, null);
});
test("failed termination retains its handle for retry instead of abandoning a process", async (t) => {
  const child = new FakeChild({ graceful: false, killWorks: false }); const { runtime } = await fixture(t, { child });
  await runtime.start(); await assert.rejects(runtime.stop(), /尚未退出/); assert.equal(runtime.child, child); child.close(0); await runtime.stop(); assert.equal(runtime.child, null);
});
test("startup timeout stops the owned process and permits retry", async (t) => {
  let healthy = false; let count = 0; let latest;
  const { runtime } = await fixture(t, { startupTimeoutMs: 20, spawnImpl: () => { count++; latest = new FakeChild(); return latest; }, checkHealth: async () => { if (!healthy) throw new Error("not ready"); } });
  await assert.rejects(runtime.start(), /启动超时/); assert.equal(latest.ends, 1); assert.equal(runtime.child, null); healthy = true; assert.equal(await runtime.start(), "http://127.0.0.1:45678"); assert.equal(count, 2);
});
test("health success after child exit cannot mark a foreign server ready", async (t) => {
  const child = new FakeChild(); const { runtime } = await fixture(t, { child, checkHealth: async () => { child.close(1); } }); await assert.rejects(runtime.start(), /已退出/); assert.equal(runtime.readyOrigin, "");
});
test("quitting during port selection never spawns a late orphan", async (t) => {
  let enter; const entered = new Promise((resolve) => { enter = resolve; }); let release; const allocated = new Promise((resolve) => { release = resolve; });
  const { runtime, calls } = await fixture(t, { portAllocator: () => { enter(); return allocated; } }); const rejection = assert.rejects(runtime.start(), /停止/);
  await entered; await runtime.stop(); release(12345); await rejection; assert.equal(calls.length, 0);
});
test("unexpected service exit notifies the connection UI once", async (t) => {
  const failures = []; const { runtime, child } = await fixture(t, { onUnexpectedExit: (error) => failures.push(error.message) }); await runtime.start(); child.close(3); assert.equal(runtime.readyOrigin, ""); assert.deepEqual(failures, ["本地服务已退出（3）"]);
});
test("health checks require the child nonce and bound remote responses", async (t) => {
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("x-desktop-instance", "owned"); response.end('{"status":"ok"}'); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`; await healthCheck(origin, { instanceToken: "owned" }); await assert.rejects(healthCheck(origin, { instanceToken: "foreign" }), /其他服务/);
  await assert.rejects(healthCheck(origin, { fetchImpl: async (_url, options) => { assert.equal(options.redirect, "error"); return new Response("x".repeat(5000), { headers: { "content-type": "application/json" } }); } }), /过大/);
});
test("development checks only existing Vite 8002 and Go 8090 services", async () => {
  const requested = []; const fetchImpl = async (url) => { requested.push(url); return url.endsWith("/health") ? new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } }) : new Response("const ws = new WebSocket(url)"); };
  assert.equal(await checkDevelopmentServices({ fetchImpl }), "http://127.0.0.1:8002"); assert.deepEqual(requested, ["http://127.0.0.1:8090/health", "http://127.0.0.1:8002/@vite/client"]);
  await assert.rejects(checkDevelopmentServices({ fetchImpl: async (url) => url.endsWith("/health") ? new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } }) : new Response("<html>compiled preview</html>") }), /Vite/);
});
