import { Spinner } from "@/components/ui/spinner";
// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/chain-of-thought
import { useEffect, useState, type ReactNode } from "react";
import { CircleCheck, CircleAlert, Clock } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
} from "@/components/ui/trace";

export function ChainOfThought({
  title,
  active,
  failed,
  completed,
  total,
  children,
}: {
  title: string;
  active: boolean;
  failed: boolean;
  completed: number;
  total: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  return (
    <Trace data-ai-element="chain-of-thought">
      <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={active ? "running" : failed ? "error" : undefined}
          >
            <TraceIcon>
              {active ? (
                <Spinner aria-hidden="true" />
              ) : failed ? (
                <CircleAlert />
              ) : completed === total ? (
                <CircleCheck />
              ) : (
                <Clock />
              )}
            </TraceIcon>
            <TraceTitle>
              {title}
            </TraceTitle>
            <TraceDescription>
              {failed ? "需处理 · " : ""}
              {completed}/{total}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>{children}</Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
