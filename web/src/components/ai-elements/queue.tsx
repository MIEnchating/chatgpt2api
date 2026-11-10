import { Spinner } from "@/components/ui/spinner";
// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/queue
import { CircleCheck, Circle, Clock, ListTodo } from "lucide-react";
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
import type { PlanStep } from "./plan";
import { planProgressLabel } from "./plan-progress";
export function Queue({
  steps,
  running,
  explanation,
}: {
  steps: PlanStep[];
  running: boolean;
  explanation?: string;
}) {
  const done = steps.filter((step) => step.status === "completed"),
    pending = steps.filter(
      (step) => step.status === "pending" || step.status === "in_progress",
    ),
    deferred = steps.filter((step) => step.status === "deferred");
  const executing =
    running && pending.some((step) => step.status === "in_progress");
  const groups = [
    { title: "待处理", items: pending },
    { title: "暂缓", items: deferred },
    { title: "已完成", items: done },
  ];
  return (
    <Trace data-ai-element="queue">
      <TraceCollapsible>
        <TraceCollapsibleTrigger aria-label="Agent 执行计划">
          <TraceLine
            status={executing ? "running" : undefined}
          >
            <TraceIcon>
              {executing ? (
                <Spinner
                  data-agent-plan-loading
                  aria-hidden="true"
                />
              ) : (
                <ListTodo />
              )}
            </TraceIcon>
            <TraceTitle>执行计划</TraceTitle>
            <TraceDescription>
              {planProgressLabel(steps)}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {explanation ? <p className="mb-3 text-sm">{explanation}</p> : null}
          <Trace role="list">
            {groups.map(({ title, items: group }) => {
              if (!group.length) return null;
              return (
                <div key={title} className="flex flex-col gap-2">
                  <p className="text-xs">
                    {title} · {group.length}
                  </p>
                  {group.map((step) => (
                    <TraceLine
                      key={step.id}
                      role="listitem"
                      className="items-start"
                      status={
                        step.status === "in_progress" && running
                          ? "running"
                          : step.status === "completed"
                            ? undefined
                            : "pending"
                      }
                    >
                      <TraceIcon
                        aria-hidden={false}
                        role="img"
                        aria-label={
                          step.status === "in_progress"
                            ? running
                              ? "进行中"
                              : "待继续"
                            : {
                                pending: "待处理",
                                completed: "已完成",
                                deferred: "暂缓",
                              }[step.status]
                        }
                      >
                        {step.status === "completed" ? (
                          <CircleCheck />
                        ) : step.status === "in_progress" && running ? (
                          <Spinner
                            data-agent-plan-loading
                            aria-hidden="true"
                          />
                        ) : step.status === "deferred" ? (
                          <Clock />
                        ) : (
                          <Circle />
                        )}
                      </TraceIcon>
                      <TraceTitle className="whitespace-normal break-words">
                        {step.title}
                      </TraceTitle>
                    </TraceLine>
                  ))}
                </div>
              );
            })}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
