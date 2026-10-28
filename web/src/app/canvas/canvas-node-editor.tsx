import type { ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function CanvasNodeEditor({ title, open, children, onClose, onFocus }: {
  title: string;
  open: boolean;
  children: ReactNode;
  onClose: () => void;
  onFocus: () => void;
}) {
  return <section data-canvas-node-editor aria-label={`${title}，节点编辑`} className={cn("relative flex h-[var(--canvas-node-editor-height)] w-full min-h-0 flex-col rounded-2xl border border-border bg-card/96 shadow-[var(--shadow-elevated)] backdrop-blur-xl", !open && "hidden")} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="absolute right-2 top-2 z-30">
      <TooltipButton tooltip="定位放大输入" aria-label="定位放大输入" className="grid size-7 place-items-center rounded-lg bg-card/90 text-muted-foreground hover:bg-muted" onClick={onFocus}><Maximize2 className="size-3.5" /></TooltipButton>
    </div>
    <div className="min-h-0 flex-1 p-3">{children}</div>
  </section>;
}
