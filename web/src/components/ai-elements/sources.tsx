// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/sources
import { ArrowUpRight, Globe } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "@/components/ui/trace";
export type Source = { url: string; title: string };
export function Sources({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <Trace data-ai-element="sources">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <Globe />
            </TraceIcon>
            <TraceTitle>{sources.length} 个来源</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {sources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                <TraceLine>
                  <TraceTitle>{source.title}</TraceTitle>
                  <TraceIcon>
                    <ArrowUpRight />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
