// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/stack-trace
import { Bug } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "@/components/ui/trace";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockActions,
  CodeBlockCopyButton,
} from "@/components/ui/code-block";
export function StackTrace({ stack }: { stack: string }) {
  return (
    <Trace data-ai-element="stack-trace">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon>
              <Bug />
            </TraceIcon>
            <TraceTitle>错误堆栈</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockActions>
              <CodeBlockCopyButton value={stack} aria-label="复制错误堆栈" />
            </CodeBlockActions>
            <CodeBlockContent wrap className="max-h-64">
              {stack}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
