import { AlertCircle, Clock, LoaderCircle } from "lucide-react";
import type { CanvasNode } from "@/services/api/canvas";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";

export function CanvasAgentResults({ nodes, onFocus }: { nodes: CanvasNode[]; onFocus?: (id: string) => void }) {
  if (!nodes.length) return null;
  return <div aria-label="回复中的画布节点" className="flex w-full min-w-0 flex-wrap gap-2">
    {nodes.map((node) => {
      const pending = ["queued", "loading", "running"].includes(String(node.generation_status));
      const failed = ["error", "failed"].includes(String(node.generation_status));
      const waiting = !pending && !failed && !node.url;
      return <span key={node.id} data-agent-result={node.id} className="inline-flex max-w-full min-w-0 items-center gap-1.5">
        <CanvasAgentNodeChip node={node} onFocus={onFocus} />
        {pending ? <LoaderCircle aria-label="正在生成" className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : failed ? <AlertCircle aria-label="生成失败" className="size-3.5 shrink-0 text-destructive" /> : waiting ? <Clock aria-label="待生成" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </span>;
    })}
  </div>;
}
