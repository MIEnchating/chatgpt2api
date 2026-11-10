import { memo, useMemo, type ReactNode } from "react";
import { ChainOfThought } from "@/components/ai-elements/chain-of-thought";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { AgentActivityLine } from "@/components/agent/agent-activity-line";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentTraceEntry } from "./agent/canvas-agent-types";
import { canvasAgentOperationGroups, canvasAgentSummarizeNodeOperations, type CanvasAgentOperation } from "./agent/canvas-agent-operation-groups";
import { CanvasAgentExecution } from "./canvas-agent-execution";
import { CanvasAgentQuestionRecord } from "./canvas-agent-interaction";

export const CanvasAgentExecutionTrace = memo(function CanvasAgentExecutionTrace({ entries, nodes, running, activity, onFocusNode, renderText }: { entries: CanvasAgentTraceEntry[]; nodes: CanvasNode[]; running: boolean; activity?: string; onFocusNode?: (id: string) => void; renderText: (text: string) => ReactNode }) {
  const groups = useMemo(() => canvasAgentOperationGroups(entries), [entries]);
  const currentOperation = entries.findLast((entry) => entry.type === "operation");
  const showActivity = running && (!currentOperation || currentOperation.status !== "running") && activity;
  return <div data-agent-execution-trace className="w-full min-w-0 space-y-2" aria-label="Agent 执行过程">
    {groups.map((entry) => {
      if (entry.type === "reasoning") return <Reasoning key={entry.id} text={entry.text} isStreaming={running && entry.isStreaming} />;
      if (entry.type === "question") return <CanvasAgentQuestionRecord key={entry.id} question={entry.question} answer={entry.answer} cancelled={entry.cancelled} />;
      if (entry.type === "text") return <div key={entry.id} data-agent-process-text className="text-sm leading-6 text-foreground/90">{renderText(entry.text)}</div>;
      return <CanvasAgentOperationBatch key={entry.id} entries={entry.entries} nodes={nodes} running={running} onFocusNode={onFocusNode} />;
    })}
    {showActivity ? <AgentActivityLine data-agent-latest-step>{activity}</AgentActivityLine> : null}
  </div>;
});

function CanvasAgentOperationBatch({ entries, nodes, running, onFocusNode }: {
  entries: CanvasAgentOperation[];
  nodes: CanvasNode[];
  running: boolean;
  onFocusNode?: (id: string) => void;
}) {
  const summarized = canvasAgentSummarizeNodeOperations(entries);
  if (summarized.length === 1) return <CanvasAgentExecution entry={summarized[0]} nodes={nodes} running={running} onFocusNode={onFocusNode} />;
  const current = running ? summarized.find((entry) => entry.status === "running") : undefined;
  const failed = summarized.some((entry) => entry.status === "error");
  const completed = summarized.filter((entry) => entry.status === "success" || entry.status === "changed").length;
  return <div data-agent-operation-group className="min-w-0"><ChainOfThought title="执行步骤" active={Boolean(current)} failed={failed} completed={completed} total={summarized.length}>
    {summarized.map((entry) => <CanvasAgentExecution key={entry.id} entry={entry} nodes={nodes} running={running} onFocusNode={onFocusNode} />)}
  </ChainOfThought></div>;
}
