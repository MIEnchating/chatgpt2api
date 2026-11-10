// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/tool
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { CircleCheck, CircleAlert, Clock, Square, Wrench } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockContent,
  CodeBlockActions,
  CodeBlockCopyButton,
} from "@/components/ui/code-block";

export type ToolState = "pending" | "input-streaming" | "input-available" | "approval-requested" | "output-available" | "output-error" | "output-denied";
const TOOL_STATE_LABEL: Record<ToolState, string> = {
  pending: "待继续", "input-streaming": "正在接收参数", "input-available": "正在执行", "approval-requested": "等待确认",
  "output-available": "已完成", "output-error": "执行失败", "output-denied": "已停止",
};

export function Tool({ title, state, statusLabel, icon, children, expandOnRunning = true, expandOnError = true, expandOnSuccess = false, ...props }: Omit<ComponentProps<typeof Trace>, "title"> & {
  title: string;
  state: ToolState;
  statusLabel?: string;
  icon?: ReactNode;
  expandOnRunning?: boolean;
  expandOnError?: boolean;
  expandOnSuccess?: boolean;
}) {
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error";
  const shouldExpand = running && expandOnRunning || failed && expandOnError || state === "output-available" && expandOnSuccess;
  const [expanded, setExpanded] = useState(shouldExpand);
  useEffect(() => setExpanded(shouldExpand), [shouldExpand]);
  const Icon = failed ? CircleAlert : state === "output-available" ? CircleCheck : state === "output-denied" ? Square : state === "approval-requested" || state === "pending" ? Clock : Wrench;
  const line = <TraceLine status={running ? "running" : failed ? "error" : state === "pending" ? "pending" : undefined}>
    <TraceIcon>{icon || (running ? <Spinner aria-hidden="true" /> : <Icon />)}</TraceIcon>
    <TraceTitle>{title}</TraceTitle>
    {statusLabel || failed || state === "approval-requested" || state === "output-denied" || state === "pending" ? <TraceDescription>{statusLabel || TOOL_STATE_LABEL[state]}</TraceDescription> : null}
  </TraceLine>;
  return <Trace data-ai-element="tool" data-state={state} {...props}>
    {children ? <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
    </TraceCollapsible> : line}
  </Trace>;
}
export function ToolDetails({
  name,
  input,
  output,
}: {
  name: string;
  input?: unknown;
  output?: unknown;
}) {
  const sections = [
    { title: "输入", data: input },
    { title: "输出", data: output },
  ];
  return (
    <div data-ai-element="tool-details" className="min-w-0 space-y-3">
      {name ? <p className="break-all font-mono text-xs">{name}</p> : null}
      {sections.map(({ title, data }) => {
        if (data === undefined) return null;
        const text =
          typeof data === "string" ? data : JSON.stringify(data, null, 2);
        return (
          <CodeBlock key={title} size="sm">
            <CodeBlockHeader>
              <CodeBlockTitle>{title}</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton
                  value={text}
                  aria-label={`复制工具${title}`}
                />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent wrap className="max-h-48">
              {text}
            </CodeBlockContent>
          </CodeBlock>
        );
      })}
    </div>
  );
}
