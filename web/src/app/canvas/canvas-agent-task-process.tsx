import type { ReactNode } from "react";
import { Task } from "@/components/ai-elements/task";
import type { CanvasAssistantMessage } from "./agent/canvas-agent-types";
import { CanvasAgentElapsed } from "./canvas-agent-elapsed";
import type { AgentRunStatus } from "@/lib/agent-run-state";

export function CanvasAgentTaskProcess({
  status,
  timing,
  children,
}: {
  status: AgentRunStatus;
  timing: Pick<CanvasAssistantMessage, "elapsedMs" | "processingStartedAt">;
  children: ReactNode;
}) {
  return (
    <div data-agent-task-process className="min-w-0">
      <Task
        status={status}
        timing={<CanvasAgentElapsed {...timing} durationOnly />}
      >
        {children}
      </Task>
    </div>
  );
}
