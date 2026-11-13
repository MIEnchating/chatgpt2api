import type { AgentRunStatus } from "@/lib/agent-run-state";
import type { CanvasAssistantMessage } from "./canvas-agent-types";

export const CANVAS_AGENT_RESULT_UNKNOWN_PREFIX = "执行状态待核实：";

export function canvasAgentResultStatusUnknown(message?: Pick<CanvasAssistantMessage, "text">) {
  return message?.text.startsWith(CANVAS_AGENT_RESULT_UNKNOWN_PREFIX) === true;
}

export function canvasAgentMessageRunStatus(
  message: Pick<CanvasAssistantMessage, "id" | "status">,
  run?: { assistantId: string; status: AgentRunStatus },
  pendingQuestion = false,
): AgentRunStatus {
  const status = run?.assistantId === message.id ? run.status : message.status;
  if (status === "running" || status === "thinking") return "running";
  if (pendingQuestion) return "waiting";
  return status || "interrupted";
}
