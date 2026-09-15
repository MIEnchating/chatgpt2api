import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexClient } from "./codex-client.mjs";

const MAX_BODY = 4 * 1024 * 1024;
const METHODS = new Set(["account/read", "model/list", "thread/start", "thread/resume", "thread/archive", "turn/start", "turn/interrupt"]);
const INTERNAL_TOOLS = new Set(["read_skill_file", "set_agent_state"]);
const BROWSER_REQUESTS = new Set(["item/tool/call", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"]);

export function createCanvasAgentServer({ token, origins, codexCommand = "codex", createClient = (input) => new CodexClient({ ...input, command: codexCommand }) }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("连接密钥至少 32 字符");
  if (!origins?.length || origins.some((origin) => new URL(origin).origin !== origin || !/^https?:/.test(origin))) throw new Error("必须指定准确的画布网页 Origin");
  const allowedOrigins = new Set(origins);
  const sessions = new Map();
  const threadOwners = new Map();
  const serviceId = randomUUID();
  const secret = Buffer.from(token);
  const authorized = (value) => { const given = Buffer.from(value || ""); return given.length === secret.length && timingSafeEqual(given, secret); };
  function emit(session, event) {
    if (session.closed) return;
    const payload = JSON.stringify(event);
    if (payload.length > MAX_BODY) return closeSession(session);
    if (session.stream) {
      if (session.stream.writableLength > MAX_BODY) return closeSession(session);
      session.stream.write(`data: ${payload}\n\n`);
    } else if (session.queue.length < 100) session.queue.push(payload);
    else closeSession(session);
  }
  function closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    clearTimeout(session.expiry);
    clearInterval(session.heartbeat);
    for (const request of session.pending.values()) { clearTimeout(request.timer); request.reject(new Error("画布连接已关闭")); }
    session.pending.clear();
    session.client?.close();
    session.stream?.end();
    if (session.cwd) void rm(session.cwd, { recursive: true, force: true });
  }
  async function clientFor(session) {
    if (!session.client) {
      session.cwd = await mkdtemp(join(tmpdir(), "chatgpt2api-codex-"));
      if (session.closed) { await rm(session.cwd, { recursive: true, force: true }); throw new Error("画布连接已关闭"); }
      session.client = createClient({ cwd: session.cwd, onMessage: (message) => {
        if (session.closed) return;
        if (message.method === "turn/completed") session.activeTurn = null;
        if (message.id !== undefined && !BROWSER_REQUESTS.has(message.method)) {
          session.client.reply(message.id, undefined, { code: -32601, message: "画布客户端不支持此请求" });
          return;
        }
        emit(session, { type: "rpc", message });
      }, onClose: (error) => { emit(session, { type: "disconnected", message: error.message }); closeSession(session); } });
    }
    await session.client.ready;
    if (session.closed) throw new Error("画布连接已关闭");
    return session.client;
  }
  async function rpc(session, method, params = {}) {
    if (!METHODS.has(method)) throw new Error("不允许的 Codex 方法");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Codex 参数必须为对象");
    const client = await clientFor(session);
    let safe;
    if (method === "model/list") safe = { cursor: typeof params.cursor === "string" ? params.cursor : undefined, limit: 100, includeHidden: false };
    else if (method === "account/read") safe = { refreshToken: false };
    else if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/resume") {
        const owner = threadOwners.get(params.threadId);
        if (owner?.canvasId !== session.canvasId || (owner.sessionId !== session.id && sessions.has(owner.sessionId))) throw new Error("该任务不属于当前画布连接或仍在另一页面使用");
      }
      safe = { ...(method === "thread/resume" ? { threadId: params.threadId } : { dynamicTools: session.tools.map((tool) => ({ type: "function", ...tool })) }),
        model: typeof params.model === "string" ? params.model : undefined, developerInstructions: typeof params.developerInstructions === "string" ? params.developerInstructions : "只通过画布工具完成创作。",
        cwd: session.cwd, sandbox: "read-only", approvalPolicy: "on-request" };
    } else {
      if (threadOwners.get(params.threadId)?.canvasId !== session.canvasId || !session.threads.has(params.threadId)) throw new Error("该任务不属于当前画布连接");
      safe = { threadId: params.threadId };
      if (method === "turn/start") {
        if (session.activeTurn) throw new Error("已有 Codex 任务正在执行");
        if (!Array.isArray(params.input) || !params.input.length || params.input.some((item) => !["text", "image"].includes(item?.type))) throw new Error("只允许文本和图片输入");
        safe.input = params.input.map((item) => item.type === "text" ? { type: "text", text: String(item.text || ""), text_elements: [] } : { type: "image", url: String(item.url || "") });
        if (typeof params.model === "string") safe.model = params.model;
        if (typeof params.effort === "string") safe.effort = params.effort;
        session.activeTurn = "starting";
      }
      if (method === "turn/interrupt") safe.turnId = params.turnId;
    }
    try {
      const result = await client.request(method, safe);
      if (result?.thread?.id) { threadOwners.set(result.thread.id, { canvasId: session.canvasId, sessionId: session.id }); session.threads.add(result.thread.id); }
      if (method === "turn/start" && session.activeTurn) session.activeTurn = result?.turn?.id || null;
      return result;
    } catch (error) { if (method === "turn/start") session.activeTurn = null; throw error; }
  }
  function callTool(session, name, args, response) {
    if (!session.stream || INTERNAL_TOOLS.has(name) || !session.tools.some((tool) => tool.name === name)) throw new Error("画布未连接或工具不存在");
    if (session.pending.size >= 12) throw new Error("画布最多同时接受 12 个外部操作");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (settle, value) => { clearTimeout(timer); response.removeListener("close", cancelled); session.pending.delete(requestId); settle(value); };
      const cancelled = () => { if (!response.writableEnded) { emit(session, { type: "tool-cancel", requestId }); finish(reject, new Error("外部请求已取消")); } };
      const timer = setTimeout(() => { emit(session, { type: "tool-cancel", requestId }); finish(reject, new Error("画布操作超时")); }, 120_000);
      response.on("close", cancelled);
      session.pending.set(requestId, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error), timer });
      emit(session, { type: "tool", source: "mcp", requestId, name, arguments: args });
    });
  }
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) return json(response, 403, { error: "Host 不允许" });
    if (origin && !allowedOrigins.has(origin)) return json(response, 403, { error: "Origin 不允许" });
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-headers", "authorization,content-type");
      response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      response.setHeader("access-control-allow-private-network", "true");
    }
    response.setHeader("cache-control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (!authorized(request.headers.authorization?.replace(/^Bearer /, ""))) return json(response, 401, { error: "连接密钥无效" });
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/sessions" && request.method === "POST") {
        if (sessions.size >= 8) throw new Error("本地连接最多 8 个画布");
        const body = await readJSON(request);
        if (typeof body.canvasId !== "string" || !body.canvasId || !Array.isArray(body.tools) || body.tools.length > 64) throw new Error("画布连接参数无效");
        const names = new Set();
        const tools = body.tools.map((tool) => {
          if (!tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== "string" || !tool.inputSchema || tool.inputSchema.type !== "object") throw new Error("工具定义无效");
          names.add(tool.name);
          return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        });
        const session = { id: randomUUID(), canvasId: body.canvasId, tools, queue: [], pending: new Map(), threads: new Set(), closed: false };
        session.expiry = setTimeout(() => closeSession(session), 30_000);
        sessions.set(session.id, session);
        return json(response, 201, { sessionId: session.id, serviceId });
      }
      const match = path.match(/^\/sessions\/([^/]+)(?:\/(events|rpc|reply|tools|tools-call|tool-results))?$/);
      const session = match && sessions.get(match[1]);
      if (!session) return json(response, 404, { error: "画布连接不存在" });
      if (!match[2] && request.method === "DELETE") { closeSession(session); return json(response, 200, { ok: true }); }
      if (match[2] === "events" && request.method === "GET") {
        if (session.stream) throw new Error("该画布已有事件连接");
        clearTimeout(session.expiry);
        session.stream = response;
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.write(": connected\n\n");
        for (const item of session.queue) response.write(`data: ${item}\n\n`);
        session.queue = [];
        session.heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        response.on("close", () => closeSession(session));
        return;
      }
      if (match[2] === "tools" && request.method === "GET") return json(response, 200, { tools: session.tools.filter((tool) => !INTERNAL_TOOLS.has(tool.name)) });
      if (request.method !== "POST") return json(response, 405, { error: "方法不允许" });
      const body = await readJSON(request);
      if (match[2] === "rpc") {
        if (body.method === "turn/interrupt") return json(response, 200, await rpc(session, body.method, body.params));
        if (session.rpcBusy) throw new Error("请等待当前 Codex 请求完成");
        session.rpcBusy = true;
        try { return json(response, 200, await rpc(session, body.method, body.params)); } finally { session.rpcBusy = false; }
      }
      if (match[2] === "reply") { if (!session.client) throw new Error("Codex 尚未连接"); session.client.reply(body.id, body.result, body.error); return json(response, 200, { ok: true }); }
      if (match[2] === "tools-call") return json(response, 200, await callTool(session, body.name, body.arguments, response));
      if (match[2] === "tool-results") {
        const waiting = session.pending.get(body.requestId);
        if (!waiting) throw new Error("画布操作已失效");
        clearTimeout(waiting.timer); session.pending.delete(body.requestId); waiting.resolve(body.result);
        return json(response, 200, { ok: true });
      }
      json(response, 404, { error: "资源不存在" });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : "本地连接请求失败" }); else response.end(); }
  });
  server.on("close", () => { for (const session of sessions.values()) closeSession(session); });
  return { server, close: async () => { for (const session of sessions.values()) closeSession(session); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }, serviceId };
}
function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
async function readJSON(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("仅接受 JSON 请求");
  let size = 0;
  const parts = [];
  for await (const part of request) { size += part.length; if (size > MAX_BODY) throw new Error("请求内容过大"); parts.push(part); }
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须为对象");
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const origins = args.flatMap((value, index) => value === "--origin" ? [args[index + 1]] : []);
  const position = args.indexOf("--port");
  const port = position >= 0 ? Number(args[position + 1]) : 3210;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口必须为 1024–65535");
  const binaryPosition = args.indexOf("--codex-bin");
  const codexCommand = binaryPosition >= 0 ? args[binaryPosition + 1] : "codex";
  if (!codexCommand) throw new Error("--codex-bin 需要提供可执行文件路径");
  const token = randomBytes(32).toString("hex");
  const bridge = createCanvasAgentServer({ token, origins, codexCommand });
  bridge.server.on("error", (error) => { process.stderr.write(`本地服务启动失败：${error.message}\n`); process.exitCode = 1; });
  bridge.server.listen(port, "127.0.0.1", () => process.stdout.write(`Canvas Agent: http://127.0.0.1:${port}\n连接密钥（仅复制到自己的画布页面）：${token}\n`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void bridge.close().then(() => process.exit(0)));
}
