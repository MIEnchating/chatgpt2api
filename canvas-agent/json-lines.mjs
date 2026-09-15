import { StringDecoder } from "node:string_decoder";

export function readJSONLines(input, onMessage, onError, maxBytes = 4 * 1024 * 1024) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stopped = false;
  const stop = () => { stopped = true; input.removeListener("data", onData); input.removeListener("end", onEnd); };
  const fail = (error) => { stop(); onError(error); };
  function onData(chunk) {
    if (stopped) return;
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let split;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
      if (Buffer.byteLength(line) > maxBytes) return fail(new Error("协议消息过大"));
      try { onMessage(JSON.parse(line)); } catch { return fail(new Error("无效的 JSON 协议消息")); }
      if (stopped) return;
    }
    if (Buffer.byteLength(buffer) > maxBytes) fail(new Error("协议消息过大"));
  }
  function onEnd() { if (buffer.trim()) fail(new Error("协议消息未完整结束")); else stop(); }
  input.on("data", onData); input.on("end", onEnd);
  return stop;
}
