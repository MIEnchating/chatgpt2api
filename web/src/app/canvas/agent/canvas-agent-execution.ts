import { isCanvasAgentMediaAction, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentProtocolMessage } from "./canvas-agent-types";

export function canvasAgentPreviousActionResult(messages: readonly CanvasAgentProtocolMessage[], action: CanvasAgentAction): CanvasAgentToolResult | undefined {
  if (action.name === "generate_node") return;
  if (!/^(create_|generate_|edit_|delete_|update_|arrange_)/.test(action.name)) return;
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls || []) {
      if (call.name !== action.name) continue;
      try {
        const previous = normalizeCanvasAgentAction(call.name, call.arguments, call.id).arguments;
        if (Object.keys({ ...previous, ...action.arguments }).every((key) => JSON.stringify(previous[key]) === JSON.stringify(action.arguments[key]))) calls.add(call.id);
      } catch { /* Invalid calls cannot prove that an action completed. */ }
    }
  }
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || !calls.has(message.toolCallId)) continue;
    try {
      const result = JSON.parse(message.content);
      if (result.ok || isCanvasAgentMediaAction(action) && typeof result.nodeId === "string") return result;
    } catch { /* Only confirmed successful results can be reused. */ }
  }
}

export function canvasAgentPendingMediaNodeIDs(messages: readonly CanvasAgentProtocolMessage[]) {
  const mediaCalls = new Set<string>();
  const mediaNodes = new Set<string>();
  const latest = new Map<string, CanvasAgentToolResult>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls || []) if (isCanvasAgentMediaAction(call as CanvasAgentAction)) mediaCalls.add(call.id);
    }
    if (message.role !== "tool") continue;
    try {
      const result = JSON.parse(message.content);
      if (typeof result.nodeId !== "string") continue;
      if (mediaCalls.has(message.toolCallId)) mediaNodes.add(result.nodeId);
      latest.set(result.nodeId, { ...latest.get(result.nodeId), ...result });
    } catch { /* Only recorded media nodes are eligible for recovery. */ }
  }
  return [...mediaNodes].filter((id) => {
    const result = latest.get(id)!;
    return result.status !== "success" && result.status !== "completed" && result.status !== "cancelled";
  });
}

export async function executeCanvasAgentResumedAction(messages: readonly CanvasAgentProtocolMessage[], action: CanvasAgentAction, execute: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>) {
  const previous = canvasAgentPreviousActionResult(messages, action);
  if (previous && isCanvasAgentMediaAction(action) && typeof previous.nodeId === "string") {
    return execute(normalizeCanvasAgentAction("generate_node", { nodeId: previous.nodeId }, action.id));
  }
  return previous || execute(action);
}
