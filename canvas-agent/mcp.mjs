import { readJSONLines } from "./json-lines.mjs";
import { pathToFileURL } from "node:url";

export function createCanvasMCP({ endpoint, token, sessionId, fetchRequest = fetch }) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("MCP 只连接本机 Canvas Agent 地址");
  if (!token || !sessionId) throw new Error("需要 CANVAS_AGENT_TOKEN 和 CANVAS_AGENT_SESSION_ID");
  const controller = new AbortController();
  const requests = new Map();
  async function call(path, body, signal) {
    const response = await fetchRequest(`${url.origin}/sessions/${encodeURIComponent(sessionId)}/${path}`, {
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, signal, AbortSignal.timeout(125_000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "画布连接失败");
    return result;
  }
  let initialized = false;
  return {
    close: () => controller.abort(),
    async handle(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
      const id = message.id;
      if (message.method === "notifications/cancelled") { requests.get(message.params?.requestId)?.abort(); return null; }
      if (message.method === "notifications/initialized") { initialized = true; return null; }
      if (id === undefined) return null;
      if (requests.size >= 128 || requests.has(id)) return { jsonrpc: "2.0", id, error: { code: -32600, message: "请求过多或 ID 重复" } };
      const request = new AbortController();
      requests.set(id, request);
      try {
        let result;
        if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chatgpt2api-canvas", version: "0.1.0" } };
        else if (!initialized) throw new Error("MCP 尚未初始化");
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = await call("tools", undefined, request.signal);
        else if (message.method === "tools/call") {
          const value = await call("tools-call", { name: message.params?.name, arguments: message.params?.arguments || {} }, request.signal);
          result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: value?.ok === false };
        } else return { jsonrpc: "2.0", id, error: { code: -32601, message: "不支持的 MCP 方法" } };
        return { jsonrpc: "2.0", id, result };
      } catch (error) { return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "MCP 请求失败" } }; } finally { requests.delete(id); }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mcp = createCanvasMCP({ endpoint: process.env.CANVAS_AGENT_URL || "http://127.0.0.1:3210", token: process.env.CANVAS_AGENT_TOKEN, sessionId: process.env.CANVAS_AGENT_SESSION_ID });
  const stopReading = readJSONLines(process.stdin, (message) => {
    void mcp.handle(message).then((reply) => { if (reply) process.stdout.write(JSON.stringify(reply) + "\n"); });
  }, (error) => { process.stderr.write(error.message + "\n"); mcp.close(); process.stdin.destroy(); process.exitCode = 1; });
  process.stdin.on("end", () => mcp.close());
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { mcp.close(); stopReading(); process.stdin.destroy(); });
}
