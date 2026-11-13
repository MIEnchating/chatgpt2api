import type { CanvasAgentContext } from "./canvas-agent-context";
import type { CanvasAgentProtocolMessage } from "./canvas-agent-types";
import { measureCanvasAgentTokenInput } from "./canvas-agent-memory";

type EstimateRequest =
  | { type: "history"; messages: CanvasAgentProtocolMessage[]; summary?: string }
  | { type: "estimate"; requestID: number; context: CanvasAgentContext };

let history: ReturnType<typeof measureCanvasAgentTokenInput> | undefined;

globalThis.onmessage = (event: MessageEvent<EstimateRequest>) => {
  const request = event.data;
  if (request.type === "history") {
    try {
      history = measureCanvasAgentTokenInput({ messages: request.messages, summary: request.summary });
    } catch {
      history = undefined;
    }
    return;
  }
  try {
    if (!history) throw new Error("Transcript has not been loaded");
    const context = measureCanvasAgentTokenInput({ context: request.context });
    // Combine the measured top-level JSON objects and their image counts.
    const bytes = history.bytes + context.bytes - 1;
    const tokens = Math.ceil(bytes / 3) + 8 + history.imageTokens + context.imageTokens;
    globalThis.postMessage({ requestID: request.requestID, tokens });
  } catch {
    globalThis.postMessage({ requestID: request.requestID, error: "上下文用量估算失败" });
  }
};

globalThis.postMessage({ type: "ready" });
