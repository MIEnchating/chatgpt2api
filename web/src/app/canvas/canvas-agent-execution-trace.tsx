import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import { AgentDisclosureButton } from "@/components/agent/agent-disclosure";
import { AgentActivityLine } from "@/components/agent/agent-activity-line";
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
    {showActivity ? <AgentActivityLine data-agent-latest-step>{activity}</AgentActivityLine> : null}
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
    <AgentDisclosureButton
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      className="items-start" chevronClassName="mt-0.5"
      leading={current ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : failed ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : completed === entries.length ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <Clock className="mt-0.5 size-3.5 shrink-0" />}
      trailing={<span className="shrink-0 text-[10px] leading-5 tabular-nums">{failed ? "需处理 · " : ""}{completed}/{entries.length}</span>}
    >
      <span className="min-w-0 flex-1 leading-5"><span>{canvasAgentOperationCategoryLabels[category]}</span>{current && !expanded ? <span className="ml-2 break-words">{current.label}</span> : null}</span>
    </AgentDisclosureButton>
    {expanded ? <div className="ml-1.5 border-l border-border/50 pl-2.5">{entries.map((entry) => <CanvasAgentExecution key={entry.id} entry={entry} nodes={nodes} running={running} onFocusNode={onFocusNode} />)}</div> : null}
  </section>;
}
