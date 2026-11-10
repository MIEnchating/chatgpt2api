// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/reasoning
import { useState } from "react";
import {
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

export function Reasoning({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState<boolean>();
  if (!text.trim()) return null;
  return (
    <TraceCollapsible
      data-ai-element="reasoning"
      open={open ?? isStreaming}
      onOpenChange={setOpen}
    >
      <TraceCollapsibleTrigger>
        <TraceLine status={isStreaming ? "running" : undefined}>
          <TraceTitle>{isStreaming ? "正在推理" : "推理摘要"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="max-h-64 overflow-y-auto whitespace-pre-wrap">
        {text}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
