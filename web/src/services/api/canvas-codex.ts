export type CanvasCodexEvent =
  | { type: "rpc"; message: CanvasCodexRPC }
  | { type: "tool"; source: "mcp"; requestId: string; name: string; arguments: unknown }
  | { type: "tool-cancel"; requestId: string }
  | { type: "disconnected"; message: string };
export type CanvasCodexRPC = { id?: number | string; method: string; params: Record<string, unknown> };
export type CanvasCodexModel = { id: string; model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }> };
export type CanvasCodexLink = Awaited<ReturnType<typeof connectCanvasCodex>>;

export function validateCanvasCodexEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.hash || url.search) throw new Error("请输入本机 HTTP 地址，例如 http://127.0.0.1:3210");
  return url.origin;
}

export async function connectCanvasCodex(input: {
  endpoint: string; token: string; canvasId: string; tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  signal: AbortSignal; onEvent: (event: CanvasCodexEvent) => void;
}) {
  const endpoint = validateCanvasCodexEndpoint(input.endpoint);
  if (input.token.trim().length < 32) throw new Error("请输入本地服务显示的完整连接密钥");
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let sessionId = "";
  async function request<T>(path: string, body?: unknown, method = "POST", requestSignal: AbortSignal = signal): Promise<T> {
    const response = await fetch(endpoint + path, { method, headers: { authorization: `Bearer ${input.token.trim()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal, credentials: "omit" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "本地 Codex 连接失败");
    return result as T;
  }
  const opened = await request<{ sessionId: string; serviceId: string }>("/sessions", { canvasId: input.canvasId, tools: input.tools });
  sessionId = opened.sessionId;
  const root = `/sessions/${encodeURIComponent(sessionId)}`;
  const disconnect = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    void request(root, undefined, "DELETE", AbortSignal.timeout(3000)).catch(() => undefined);
  };
  input.signal.addEventListener("abort", disconnect, { once: true });
  if (input.signal.aborted) { disconnect(); throw new DOMException("连接已取消", "AbortError"); }
  let streamResponse: Response;
  try {
    streamResponse = await fetch(endpoint + root + "/events", { headers: { authorization: `Bearer ${input.token.trim()}` }, signal, credentials: "omit" });
    if (!streamResponse.ok || !streamResponse.body) throw new Error("无法建立本地事件连接");
  } catch (error) { disconnect(); throw error; }
  const reader = streamResponse.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) throw new Error("本地 Codex 服务已断开");
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 4 * 1024 * 1024) throw new Error("本地消息过大");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data && !signal.aborted) input.onEvent(JSON.parse(data) as CanvasCodexEvent);
        }
      }
    } catch (error) { if (!signal.aborted) input.onEvent({ type: "disconnected", message: error instanceof Error ? error.message : "本地服务连接中断" }); }
    finally { reader.releaseLock(); input.signal.removeEventListener("abort", disconnect); disconnect(); }
  })();
  return {
    sessionId, serviceId: opened.serviceId, disconnect,
    rpc: <T>(method: string, params: unknown = {}) => request<T>(root + "/rpc", { method, params }),
    reply: (id: number | string, result: unknown) => request(root + "/reply", { id, result }),
    reject: (id: number | string, message: string) => request(root + "/reply", { id, error: { code: -32603, message } }),
    toolResult: (requestId: string, result: unknown) => request(root + "/tool-results", { requestId, result }),
  };
}
