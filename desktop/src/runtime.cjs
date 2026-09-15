"use strict";
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function backendEnvironment(source, rootDir, port, adminPassword, instanceToken) {
  const result = {};
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]);
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase())) result[key] = value;
  return { ...result, ROOT_DIR: rootDir, STORAGE_BACKEND: "sqlite", STORAGE_DATABASE_URL: `sqlite:///${path.join(rootDir, "data", "chatgpt2api.db").replaceAll("\\", "/")}`, LISTEN_HOST: "127.0.0.1", PORT: String(port), DESKTOP_RUNTIME: "1", DESKTOP_INSTANCE_TOKEN: instanceToken, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: adminPassword };
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}

async function healthCheck(origin, { signal, instanceToken = "", fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(3000);
  const response = await fetchImpl(`${origin}/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error", cache: "no-store" });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") { await response.body?.cancel(); throw new Error("服务器健康检查未通过"); }
  if (instanceToken && response.headers.get("x-desktop-instance") !== instanceToken) { await response.body?.cancel(); throw new Error("本地端口由其他服务占用"); }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error("服务器健康检查响应过大");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (JSON.parse(Buffer.concat(chunks).toString("utf8")).status !== "ok") throw new Error("服务器健康检查未通过");
}

class LocalRuntime {
  constructor({ executable, rootDir, spawnImpl = spawn, portAllocator = unusedLoopbackPort, checkHealth = healthCheck, startupTimeoutMs = 90000, shutdownTimeoutMs = 15000, forceWaitMs = 3000, onUnexpectedExit = () => {} }) {
    Object.assign(this, { executable, rootDir, spawnImpl, portAllocator, checkHealth, startupTimeoutMs, shutdownTimeoutMs, forceWaitMs, onUnexpectedExit });
    this.child = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.readyOrigin = "";
    this.startController = null;
    this.stopping = false;
  }
  start(adminPassword = "") {
    if (this.readyOrigin && this.child && this.child.exitCode === null && this.child.signalCode === null) return Promise.resolve(this.readyOrigin);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(adminPassword).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }
  async startInternal(adminPassword) {
    if (this.stopPromise) await this.stopPromise;
    this.stopping = false;
    const controller = new AbortController();
    this.startController = controller;
    const startupTimer = setTimeout(() => controller.abort(new Error("本地服务启动超时，请重试并检查本地数据目录")), this.startupTimeoutMs);
    let failure = null;
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      const port = await this.portAllocator();
      controller.signal.throwIfAborted();
      const token = randomBytes(24).toString("hex");
      const origin = `http://127.0.0.1:${port}`;
      const env = backendEnvironment(process.env, this.rootDir, port, adminPassword, token);
      const child = this.spawnImpl(this.executable, [], { cwd: this.rootDir, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      env.ADMIN_PASSWORD = "";
      adminPassword = "";
      this.child = child;
      this.closed = new Promise((resolve) => {
        child.once("error", (error) => { failure = new Error(`本地服务无法启动：${error.code || "spawn error"}`); controller.abort(failure); resolve(); });
        child.once("close", (code) => {
          failure = new Error(`本地服务已退出（${code ?? "signal"}）`);
          controller.abort(failure);
          const wasReady = Boolean(this.readyOrigin);
          this.readyOrigin = "";
          if (wasReady && !this.stopping) this.onUnexpectedExit(failure);
          resolve();
        });
      });
      // Drain pipes without retaining tokens or private request data.
      child.stdout?.resume();
      child.stderr?.resume();
      child.stdin?.on("error", () => {});
      while (true) {
        controller.signal.throwIfAborted();
        if (failure || child.exitCode !== null || child.signalCode !== null) throw failure || new Error("本地服务提前退出");
        try {
          await this.checkHealth(origin, { signal: controller.signal, instanceToken: token });
          controller.signal.throwIfAborted();
          if (failure || child.exitCode !== null || child.signalCode !== null) throw failure || new Error("本地服务提前退出");
          this.readyOrigin = origin;
          return origin;
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason || failure || error;
          await delay(200, undefined, { signal: controller.signal });
        }
      }
    } catch (error) {
      const reason = controller.signal.reason || failure || error;
      await this.stop();
      throw reason;
    } finally {
      clearTimeout(startupTimer);
      if (this.startController === controller) this.startController = null;
    }
  }
  stop() {
    this.stopping = true;
    this.startController?.abort(new Error("正在停止本地服务"));
    if (!this.stopPromise) this.stopPromise = this.stopChild().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
  async stopChild() {
    this.stopping = true;
    this.readyOrigin = "";
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      let timer;
      const graceful = await Promise.race([this.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs); })]);
      clearTimeout(timer);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        child.kill();
        let forcedTimer;
        const killed = await Promise.race([this.closed.then(() => true), new Promise((resolve) => { forcedTimer = setTimeout(() => resolve(false), this.forceWaitMs); })]);
        clearTimeout(forcedTimer);
        if (!killed) throw new Error("本地服务尚未退出，请重试退出操作");
      }
    }
    if (this.child === child) this.child = null;
  }
}

async function checkDevelopmentServices({ fetchImpl = fetch } = {}) {
  await healthCheck("http://127.0.0.1:8090", { fetchImpl });
  const response = await fetchImpl("http://127.0.0.1:8002/@vite/client", { signal: AbortSignal.timeout(3000), redirect: "error" });
  if (!response.ok || !(await response.text()).includes("WebSocket")) throw new Error("请先运行项目的 Vite 开发服务（8002），后端固定使用 8090");
  return "http://127.0.0.1:8002";
}
module.exports = { LocalRuntime, backendEnvironment, unusedLoopbackPort, healthCheck, checkDevelopmentServices };
