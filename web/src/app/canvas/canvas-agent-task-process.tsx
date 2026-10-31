import { useEffect, useState, type ReactNode } from "react";
import { Check, Clock, LoaderCircle } from "lucide-react";
import { AgentDisclosureButton } from "@/components/agent/agent-disclosure";
import type { CanvasAssistantMessage } from "./agent/canvas-agent-types";
import { CanvasAgentElapsed } from "./canvas-agent-elapsed";

export function CanvasAgentTaskProcess({ complete, running, timing, children }: {
  complete: boolean;
  running: boolean;
  timing: Pick<CanvasAssistantMessage, "elapsedMs" | "processingStartedAt">;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(!complete);
  useEffect(() => setExpanded(!complete), [complete]);
  return <section data-agent-task-process className="w-full min-w-0">
    <AgentDisclosureButton data-agent-process-toggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} leading={running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : complete ? <Check className="size-3.5 shrink-0" /> : <Clock className="size-3.5 shrink-0" />}>
      <span>{complete ? "用时" : "已处理"}</span>
      <CanvasAgentElapsed {...timing} durationOnly />
    </AgentDisclosureButton>
    {expanded ? <div data-agent-process-content className="ml-1.5 space-y-3 border-l border-border/60 py-2 pl-3">{children}</div> : null}
  </section>;
}
