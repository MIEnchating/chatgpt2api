import { Spinner } from "@/components/ui/spinner";
// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/subagent
import { Bot, CircleCheck, Circle, CircleAlert } from "lucide-react";
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
export type SubagentData = {
  prompt?: string;
  model?: string;
  agents: { id: string; status: string; message?: string }[];
};
export function Subagent({ prompt, model, agents }: SubagentData) {
  return (
    <div data-ai-element="subagent" className="min-w-0 space-y-3">
      {model ? <p className="text-xs">模型：{model}</p> : null}
      {prompt ? <p className="whitespace-pre-wrap text-sm">{prompt}</p> : null}
      <Trace>
        {agents.map((agent) => {
          const line = <TraceLine status={agent.status === "running" ? "running" : agent.status === "errored" ? "error" : undefined}>
              <TraceIcon>
                {agent.status === "running" ? (
                  <Spinner aria-hidden="true" />
                ) : agent.status === "completed" ? (
                  <CircleCheck />
                ) : agent.status === "errored" ? (
                  <CircleAlert />
                ) : agent.status === "pendingInit" ? (
                  <Circle />
                ) : (
                  <Bot />
                )}
              </TraceIcon>
              <TraceTitle title={agent.id}>子代理 {agent.id}</TraceTitle>
              <TraceDescription>
                {(
                  {
                    running: "运行中",
                    completed: "已完成",
                    errored: "失败",
                    pendingInit: "准备中",
                    shutdown: "已结束",
                    interrupted: "已中断",
                    notFound: "未找到",
                    unknown: "状态未返回",
                  } as Record<string, string>
                )[agent.status] || agent.status}
              </TraceDescription>
            </TraceLine>;
          return agent.message?.trim() ? <TraceCollapsible key={agent.id}>
            <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="whitespace-pre-wrap">{agent.message}</TraceCollapsibleContent>
          </TraceCollapsible> : <div key={agent.id}>{line}</div>;
        })}
      </Trace>
    </div>
  );
}
