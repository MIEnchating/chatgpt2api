import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentTraceEntry } from "./agent/canvas-agent-types";
import { canvasAgentOperationGroups, canvasAgentOperationCategoryLabels, type CanvasAgentOperation, type CanvasAgentOperationCategory } from "./agent/canvas-agent-operation-groups";
import { CanvasAgentExecution } from "./canvas-agent-execution";
import { CanvasAgentQuestionRecord } from "./canvas-agent-interaction";

export const CanvasAgentExecutionTrace = memo(function CanvasAgentExecutionTrace({ entries, pendingQuestion, nodes, running, activity, onFocusNode, renderText }: { pendingQuestion?: string; entries: CanvasAgentTraceEntry[]; nodes: CanvasNode[]; running: boolean; activity?: string; onFocusNode?: (id: string) => void; renderText: (text: string) => ReactNode }) {
  const groups = useMemo(() => canvasAgentOperationGroups(entries), [entries]);
  const currentOperation = entries.findLast((entry) => entry.type === "operation");
  const showActivity = running && (!currentOperation || currentOperation.status !== "running") && activity;
  return <div data-agent-execution-trace className="w-full min-w-0 space-y-2" aria-label="Agent 执行过程">
    {groups.map((entry) => {
      if (entry.type === "question") return entry.question === pendingQuestion && !entry.answer && !entry.cancelled ? null : <CanvasAgentQuestionRecord key={entry.id} question={entry.question} answer={entry.answer} cancelled={entry.cancelled} />;
      if (entry.type === "text") return <div key={entry.id} data-agent-process-text className="text-sm leading-6 text-foreground/90">{renderText(entry.text)}</div>;
      return <CanvasAgentOperationBatch key={entry.id} entries={entry.entries} category={entry.category} nodes={nodes} running={running} onFocusNode={onFocusNode} />;
    })}
    {showActivity ? <div data-agent-latest-step role="status" className="flex items-start gap-2 py-1 text-xs leading-5 text-muted-foreground"><LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" /><span>{activity}</span></div> : null}
  </div>;
});

function CanvasAgentOperationBatch({ entries, category, nodes, running, onFocusNode }: {
  entries: CanvasAgentOperation[];
  category: CanvasAgentOperationCategory;
  nodes: CanvasNode[];
  running: boolean;
  onFocusNode?: (id: string) => void;
}) {
  const current = running ? entries.find((entry) => entry.status === "running") : undefined;
  const failed = entries.some((entry) => entry.status === "error");
  const completed = entries.filter((entry) => entry.status === "success" || entry.status === "changed").length;
  const active = Boolean(current);
  const [expanded, setExpanded] = useState(active);
  useEffect(() => { if (active) setExpanded(true); }, [active]);
  return <section data-agent-operation-group={category} className="min-w-0">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex w-full min-w-0 items-start gap-2 rounded-md py-2 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {current ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : failed ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />  : completed === entries.length ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <Clock className="mt-0.5 size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 leading-5"><span>{canvasAgentOperationCategoryLabels[category]}</span>{current && !expanded ? <span className="ml-2 break-words">{current.label}</span> : null}</span>
      <span className="shrink-0 text-[10px] leading-5 tabular-nums">{failed ? "需处理 · " : ""}{completed}/{entries.length}</span>
      <ChevronRight className={`mt-0.5 size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
    </button>
    {expanded ? <div className="ml-1.5 border-l border-border/50 pl-2.5">{entries.map((entry) => <CanvasAgentExecution key={entry.id} entry={entry} nodes={nodes} running={running} onFocusNode={onFocusNode} />)}</div> : null}
  </section>;
}
