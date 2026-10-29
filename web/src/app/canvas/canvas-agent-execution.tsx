import { useEffect, useState, type SyntheticEvent } from "react";
import { BookOpen, ChevronRight, CircleAlert, FileText, Image, LoaderCircle, Pencil, Plus, Sparkles, Terminal, Wrench, ListChecks, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentTraceEntry } from "./agent/canvas-agent-types";
import { canvasAgentTraceDetailLines } from "./agent/canvas-agent-trace";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";

const ICONS = { plan: ListChecks, workflow: Workflow, read: BookOpen, image: Image, create: Plus, edit: Pencil, generate: Sparkles, command: Terminal, file: FileText, tool: Wrench };

export function CanvasAgentExecution({ entry, nodes, running, onFocusNode }: {
  entry: Extract<CanvasAgentTraceEntry, { type: "operation" }>;
  nodes: CanvasNode[];
  running: boolean;
  onFocusNode?: (id: string) => void;
}) {
  const node = nodes.find((item) => item.id === entry.nodeId);
  const detailLines = canvasAgentTraceDetailLines(entry.detail, node, entry);
  const detail = detailLines.join("\n");
  const mediaStatus = entry.kind === "generate" && entry.status === "running" ? node?.generation_status : undefined;
  const status = mediaStatus === "success" ? "success" : mediaStatus === "error" ? "error" : entry.status === "running" && !running && mediaStatus !== "loading" ? "waiting" : entry.status;
  const Icon = status === "running" ? LoaderCircle : status === "error" ? CircleAlert : ICONS[entry.kind];
  const statusLabel = { running: "执行中", success: "已完成", error: "失败", waiting: "待继续", changed: "已调整" }[status];
  const details = Boolean(detail);
  const [expanded, setExpanded] = useState(status === "running");
  useEffect(() => setExpanded(status === "running"), [status]);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setExpanded(event.currentTarget.open);
  const summary = <>
    <span className="min-w-0 flex-1 break-words leading-5"><span className="font-medium text-foreground/90">{status === "success" ? entry.label.replace(/^正在/, "已") : status === "changed" ? entry.label.replace(/^正在/, "") : entry.label}</span></span>
    <span className={cn("shrink-0 text-[10px] font-normal leading-4", status === "running" && "text-brand", status === "error" && "text-destructive")}>{statusLabel}</span>
    {details ? <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} /> : null}
  </>;
  return <div data-agent-operation={entry.id} className="relative grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 py-1.5">
    <span className={cn("relative z-10 mt-0.5 flex size-6 items-center justify-center rounded-lg bg-card text-muted-foreground", status === "running" && "bg-brand-soft text-brand", status === "error" && "text-destructive")}>
      <Icon aria-hidden="true" className={cn("size-3.5", status === "running" && "animate-spin")} />
    </span>
    <div className="min-w-0 pt-0.5">
      {details ? <details open={expanded} onToggle={handleToggle} className="group/operation min-w-0 flex-1 text-xs text-muted-foreground">
        <summary className="flex min-h-6 min-w-0 cursor-pointer list-none items-center gap-2 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">{summary}</summary>
        {expanded ? <div className="my-2 min-w-0 border-l border-border/60 pl-3">
          <pre className={cn("max-h-48 max-w-full overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]", entry.kind === "command" || entry.kind === "file" ? "font-mono" : "font-sans")}>{detail}</pre>
        </div> : null}
      </details> : <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs text-muted-foreground">{summary}</div>}
      {node && onFocusNode ? <CanvasAgentNodeChip node={node} onFocus={onFocusNode} className="mt-1.5" /> : null}
    </div>
  </div>;
}
