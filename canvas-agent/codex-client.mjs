import { spawn } from "node:child_process";
import { readJSONLines } from "./json-lines.mjs";

export class CodexClient {
  constructor({ cwd, onMessage, onClose, command = "codex", spawnProcess = spawn }) {
    this.pending = new Map();
    this.serverRequests = new Set();
    this.sequence = 0;
    this.closed = false;
    const env = { ...process.env };
    delete env.CANVAS_AGENT_TOKEN;
    this.child = spawnProcess(command, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.stopReading = readJSONLines(this.child.stdout, (message) => {
      if (this.closed) return;
        if (message.method === "serverRequest/resolved") this.serverRequests.delete(message.params?.requestId);
        if (message.method) {
          if (message.id !== undefined) {
            if (this.serverRequests.size >= 144) return this.close(new Error("待处理的 Codex 请求过多"));
            this.serverRequests.add(message.id);
          }
          onMessage(message);
        } else {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          this.pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message || "Codex 请求失败"));
          else waiting.resolve(message.result);
        }
    }, (error) => this.close(error));
    this.child.stderr.resume();
    this.child.on("error", () => this.close(new Error("无法启动 Codex，请安装当前 Codex CLI 并先登录")));
    this.child.on("exit", () => this.close(new Error("Codex 进程已退出")));
    this.child.stdin.on("error", () => this.close(new Error("Codex 输入连接已关闭")));
    this.onClose = onClose;
    this.ready = this.request("initialize", { clientInfo: { name: "chatgpt2api_canvas", title: "ChatGPT2API Canvas", version: "0.1.0" }, capabilities: { experimentalApi: true } })
      .then(() => this.write({ method: "initialized", params: {} }));
    this.ready.catch(() => undefined);
  }
  write(message) {
    if (this.closed) throw new Error("Codex 已断开");
    if (this.child.stdin.writableLength > 4 * 1024 * 1024) { this.close(new Error("Codex 输入队列过大")); throw new Error("Codex 输入队列过大"); }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Codex 已断开"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); this.close(); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(id, result, error) {
    if (!this.serverRequests.delete(id)) throw new Error("该 Codex 请求已失效");
    this.write(error ? { id, error } : { id, result });
  }
  close(error = new Error("Codex 连接已关闭")) {
    if (this.closed) return;
    this.closed = true;
    this.stopReading();
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
    this.serverRequests.clear();
    this.child.stdin.destroy();
    this.child.kill();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 2000);
    timer.unref();
    this.onClose?.(error);
  }
}
