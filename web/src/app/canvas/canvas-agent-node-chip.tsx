import { AudioLines, FileText, ImageIcon, Video } from "lucide-react";
import { AuthenticatedImage } from "@/components/authenticated-image";
import type { CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";

export function CanvasAgentNodeChip({ node, onFocus, className }: { node: CanvasNode; onFocus?: (id: string) => void; className?: string }) {
  const Icon = node.type === "text" ? FileText : node.type === "video" ? Video : node.type === "audio" ? AudioLines : ImageIcon;
  return <button type="button" data-agent-node-chip={node.id} className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/80 bg-muted/20 px-2 py-1 text-left align-middle text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} title={`定位到 ${node.title || node.type}`} disabled={!onFocus} onClick={() => onFocus?.(node.id)}>
    {(node.type === "image" || node.type === "panorama") && (node.thumbnail_url || node.url) ? <AuthenticatedImage src={node.thumbnail_url || node.url || ""} alt="" className="size-5 shrink-0 rounded object-cover" /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
    <span className="min-w-0 truncate">{node.title || node.type}</span>
  </button>;
}
