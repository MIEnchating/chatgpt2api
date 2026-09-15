import type { CanvasAgentToolCall } from "./canvas-agent-types";
import { normalizeCanvasAgentAction } from "./canvas-agent-tools";

export const MAX_AGENT_ACTIONS_PER_TURN = 12;

export function parseCanvasAgentToolArguments(value: unknown): Pick<CanvasAgentToolCall, "arguments" | "argumentsError"> {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { arguments: parsed as Record<string, unknown> };
  } catch {
    return { arguments: {}, argumentsError: "工具 arguments 必须是合法的 JSON 对象" };
  }
}

export function normalizeCanvasAgentBatch(toolCalls: CanvasAgentToolCall[], toolError?: string) {
  if (toolError) throw new Error(toolError);
  if (toolCalls.length > MAX_AGENT_ACTIONS_PER_TURN) throw new Error(`每批最多执行 ${MAX_AGENT_ACTIONS_PER_TURN} 个工具操作`);
  const ids = new Set<string>();
  return toolCalls.map((call) => {
    if (!call.id || ids.has(call.id)) throw new Error("工具调用 ID 缺失或重复");
    ids.add(call.id);
    if (call.argumentsError) throw new Error(call.argumentsError);
    return normalizeCanvasAgentAction(call.name, call.arguments, call.id);
  });
}
