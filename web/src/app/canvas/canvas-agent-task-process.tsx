import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Clock, LoaderCircle } from "lucide-react";
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
    <button type="button" data-agent-process-toggle aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : complete ? <Check className="size-3.5 shrink-0" /> : <Clock className="size-3.5 shrink-0" />}
      <span>{complete ? "用时" : "已处理"}</span>
      <CanvasAgentElapsed {...timing} durationOnly />
      <ChevronRight className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
    </button>
    {expanded ? <div data-agent-process-content className="ml-1.5 space-y-3 border-l border-border/60 py-2 pl-3">{children}</div> : null}
  </section>;
}
