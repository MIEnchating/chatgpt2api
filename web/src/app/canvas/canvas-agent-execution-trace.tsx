import type { ReactNode } from "react";
import { memo, useEffect, useState, type SyntheticEvent } from "react";
import { ChevronRight, LoaderCircle, Workflow } from "lucide-react";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentTraceEntry } from "./agent/canvas-agent-types";
import { canvasAgentTraceProgress, canvasAgentTraceSections } from "./agent/canvas-agent-trace";
import { CanvasAgentExecution } from "./canvas-agent-execution";
import { CanvasAgentQuestionRecord } from "./canvas-agent-interaction";

export const CanvasAgentExecutionTrace = memo(function CanvasAgentExecutionTrace({ entries, nodes, running, activity, onFocusNode, renderText }: { entries: CanvasAgentTraceEntry[]; nodes: CanvasNode[]; running: boolean; activity?: string; onFocusNode?: (id: string) => void; renderText: (text: string) => ReactNode }) {
  const sections = canvasAgentTraceSections(entries);
  return <div data-agent-execution-trace className="w-full min-w-0 space-y-2" aria-label="Agent 执行过程">
    {sections.map((section, index) => {
      if (section.type === "question") return <CanvasAgentQuestionRecord key={section.entry.id} question={section.entry.question} answer={section.entry.answer} cancelled={section.entry.cancelled} />;
      const active = running && index === sections.length - 1;
      const label = active && activity ? activity : canvasAgentTraceProgress(section.entries, active);
      return <CanvasAgentExecutionSection key={section.entries[0].id} entries={section.entries} nodes={nodes} active={active} label={label} onFocusNode={onFocusNode} renderText={renderText} />;
    })}
  </div>;
});

function CanvasAgentExecutionSection({ entries, nodes, active, label, onFocusNode, renderText }: { entries: Exclude<CanvasAgentTraceEntry, { type: "question" }>[]; nodes: CanvasNode[]; active: boolean; label: string; onFocusNode?: (id: string) => void; renderText: (text: string) => ReactNode }) {
  const [expanded, setExpanded] = useState(active);
  useEffect(() => setExpanded(active), [active]);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setExpanded(active || event.currentTarget.open);
  return <div className="min-w-0">
    <details data-agent-execution-group open={expanded} onToggle={handleToggle} className="group/execution min-w-0 overflow-hidden rounded-xl border border-border/50 bg-card text-xs text-muted-foreground">
      <summary className="flex min-h-9 min-w-0 cursor-pointer list-none items-center gap-2 bg-muted/25 px-3 py-2 outline-none transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <Workflow className="size-3.5 shrink-0" />}
        <span data-agent-latest-step role={active ? "status" : undefined} title={label} className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </summary>
      {expanded ? <div className="relative border-t border-border/40 px-3 py-2 before:pointer-events-none before:absolute before:bottom-5 before:left-6 before:top-5 before:w-px before:bg-border/50">
        {entries.map((entry) => entry.type === "text" ? <div key={entry.id} className="relative bg-card py-2 pl-8 text-xs font-normal leading-[1.65] text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground/80">{renderText(entry.text)}</div> : <CanvasAgentExecution key={entry.id} entry={entry} nodes={nodes} running={active} onFocusNode={onFocusNode} />)}
      </div> : null}
    </details>
  </div>;
}
