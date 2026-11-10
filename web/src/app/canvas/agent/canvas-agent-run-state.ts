import type { AgentRunStatus } from "@/lib/agent-run-state";
import type { CanvasAssistantMessage } from "./canvas-agent-types";

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
