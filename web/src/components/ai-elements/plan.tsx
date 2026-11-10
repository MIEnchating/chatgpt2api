// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/plan
import { CircleCheck, Circle, CircleDot, Clock, Route } from "lucide-react";
import { planProgressLabel } from "./plan-progress";
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
export type PlanStep = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "deferred";
};

export function Plan({
  steps,
  explanation,
  running,
}: {
  steps: PlanStep[];
  explanation: string;
  running: boolean;
}) {
  return (
    <Trace data-ai-element="plan">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceIcon>
              <Route />
            </TraceIcon>
            <TraceTitle>执行计划</TraceTitle>
            <TraceDescription>
              {planProgressLabel(steps)}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {explanation ? (
            <p className="mb-3 whitespace-pre-wrap text-sm">{explanation}</p>
          ) : null}
          <Trace role="list">
            {steps.map((step) => (
              <TraceLine
                key={step.id}
                role="listitem"
                className="items-start"
                status={
                  step.status === "in_progress" && running
                    ? "running"
                    : step.status === "pending" || step.status === "deferred"
                      ? "pending"
                      : undefined
                }
              >
                <TraceIcon>
                  {step.status === "completed" ? (
                    <CircleCheck />
                  ) : step.status === "deferred" ? (
                    <Clock />
                  ) : step.status === "in_progress" ? (
                    <CircleDot />
                  ) : (
                    <Circle />
                  )}
                </TraceIcon>
                <TraceTitle className="whitespace-normal break-words">
                  {step.title}
                  {step.status === "deferred" ? " · 暂缓" : ""}
                </TraceTitle>
              </TraceLine>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
