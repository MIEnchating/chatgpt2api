export async function readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  options: { signal?: AbortSignal; maxEventCharacters?: number; idleTimeoutMs?: number } = {},
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let eventCharacters = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idleError: Error | undefined;
  const maxEventCharacters = options.maxEventCharacters ?? 16 * 1024 * 1024;
  const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  const resetIdleTimeout = () => {
    clearTimeout(timeout);
    if (options.idleTimeoutMs) timeout = setTimeout(() => {
      idleError = new Error("SSE 连接长时间未收到数据");
      void reader.cancel(idleError).catch(() => {});
    }, options.idleTimeoutMs);
  };
  const consume = (final = false) => {
    while (pending.length) {
      const newline = pending.search(/[\r\n]/);
      if (newline < 0 || (!final && newline === pending.length - 1 && pending[newline] === "\r")) break;
      const line = pending.slice(0, newline);
      const length = pending[newline] === "\r" && pending[newline + 1] === "\n" ? 2 : 1;
      pending = pending.slice(newline + length);
      eventCharacters += line.length;
      if (eventCharacters > maxEventCharacters) throw new Error("SSE 事件超过大小限制");
      if (!line) {
        options.signal?.throwIfAborted();
        if (data.length) onData(data.join("\n"));
        data = [];
        eventCharacters = 0;
      } else if (line === "data" || line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (pending.length + eventCharacters > maxEventCharacters) throw new Error("SSE 事件超过大小限制");
  };
  try {
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", abort, { once: true });
    while (true) {
      resetIdleTimeout();
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      if (idleError) throw idleError;
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      consume();
    }
    pending += decoder.decode();
    consume(true);
    if ((pending && !pending.startsWith(":")) || data.length) throw new Error("SSE 连接意外结束，最后一条事件不完整");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function assertServerSentEventContentType(contentType: unknown) {
  if (!/^text\/event-stream(?:;|$)/i.test(String(contentType || ""))) {
    throw new Error("服务端未返回 SSE 事件流");
  }
}
