import { Button } from "@/components/ui/button";
import { AudioLines, FileText, ImageIcon, Video } from "lucide-react";
import { AuthenticatedImage } from "@/components/authenticated-image";
import type { CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";

export function CanvasAgentNodeChip({ node, onFocus, className }: { node: CanvasNode; onFocus?: (id: string) => void; className?: string }) {
  const Icon = node.type === "text" ? FileText : node.type === "video" ? Video : node.type === "audio" ? AudioLines : ImageIcon;
  return <Button variant="outline" type="button" data-agent-node-chip={node.id} className={cn("inline-flex max-w-full min-w-0 items-center text-left align-middle justify-start", className)} title={`定位到 ${node.title || node.type}`} disabled={!onFocus} onClick={() => onFocus?.(node.id)}>
    {(node.type === "image" || node.type === "panorama") && (node.thumbnail_url || node.url) ? <AuthenticatedImage src={node.thumbnail_url || node.url || ""} alt="" className="size-5 shrink-0 rounded object-cover" /> : <Icon className="shrink-0 text-muted-foreground" />}
    <span className="min-w-0 truncate">{node.title || node.type}</span>
  </Button>;
}
