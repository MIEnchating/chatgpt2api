// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/task
import { Children, useEffect, useState, type ReactNode } from "react";
import { CircleCheck, Clock, CircleAlert, Pause, Square } from "lucide-react";
import { AGENT_RUN_STATE, type AgentRunStatus } from "@/lib/agent-run-state";
import { Spinner } from "@/components/ui/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
  TraceDescription,
} from "@/components/ui/trace";
export function Task({
  status,
  timing,
  timingLabel,
  children,
}: {
  status: AgentRunStatus;
  timing: ReactNode;
  timingLabel?: string;
  children: ReactNode;
}) {
  const complete = status === "success";
  const running = status === "running";
  const label = AGENT_RUN_STATE[status].label;
  const Icon = complete ? CircleCheck : status === "error" ? CircleAlert : status === "interrupted" ? Pause : status === "cancelled" ? Square : Clock;
  const [expanded, setExpanded] = useState(!complete);
  useEffect(() => setExpanded(!complete), [complete]);
  const line = (
    <TraceLine status={running ? "running" : status === "error" ? "error" : undefined}>
      <TraceIcon>{running ? <Spinner aria-hidden="true" /> : <Icon />}</TraceIcon>
      <TraceTitle>{label}</TraceTitle>
      {timing !== undefined && timing !== null ? <TraceDescription className="flex items-center gap-1">
        {timingLabel || (complete ? "用时" : "已处理")}{timing}
      </TraceDescription> : null}
    </TraceLine>
  );
  return (
    <Trace data-ai-element="task" data-status={status}>
      {Children.toArray(children).length ? (
        <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
          <TraceCollapsibleTrigger data-agent-process-toggle aria-label={label}>
            {line}
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent data-agent-process-content>
            <Trace>{children}</Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : line}
    </Trace>
  );
}
