// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/test-results
import { Check } from "lucide-react";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export function TestResults({ checks, label }: { checks: readonly string[]; label: string }) {
  return <Trace aria-label={label}>
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><Check /></TraceIcon>
          <TraceTitle>{label}</TraceTitle>
          <TraceDescription>{checks.length} 项通过</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>{checks.map((check, index) => <TraceLine key={index}>
          <TraceIcon><Check /></TraceIcon>
          <TraceTitle className="whitespace-normal break-words">{check}</TraceTitle>
        </TraceLine>)}</Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>;
}
