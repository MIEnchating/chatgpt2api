import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function CanvasNodeEditor({ title, open, children, onClose }: {
  title: string;
  open: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (expanded && open) return <Dialog open onOpenChange={setExpanded}>
    <DialogContent data-canvas-node-editor data-canvas-no-pan data-canvas-no-zoom data-expanded="true" aria-describedby={undefined} showCloseButton={false} scrollable={false}
      className="group/editor h-[min(760px,calc(100dvh-2rem))] w-[min(880px,calc(100%-2rem))] gap-4 [&_.canvas-prompt-scroll-frame]:h-[min(52dvh,480px)] [&_.canvas-prompt-editor-resize]:h-[min(52dvh,480px)]"
      onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-0">
        <DialogTitle className="min-w-0 truncate text-sm">{title} · 输入与参数</DialogTitle>
        <TooltipButton tooltip="还原输入框" aria-label="还原输入框" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted" onClick={() => setExpanded(false)}><Minimize2 className="size-4" /></TooltipButton>
      </DialogHeader>
      <div className="min-h-0 flex-1">{children}</div>
    </DialogContent>
  </Dialog>;

  return <section data-canvas-node-editor data-expanded="false" aria-label={`${title}，节点编辑`} className={cn("group/editor relative flex h-[var(--canvas-node-editor-height)] w-full min-h-0 flex-col rounded-2xl border border-border bg-card shadow-[var(--shadow-elevated)]", !open && "hidden")} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="absolute right-2 top-2 z-30">
      <TooltipButton tooltip="放大输入框" aria-label="放大输入框" className="grid size-7 place-items-center rounded-lg bg-card/90 text-muted-foreground hover:bg-muted" onClick={() => setExpanded(true)}><Maximize2 className="size-3.5" /></TooltipButton>
    </div>
    <div className="min-h-0 flex-1 p-3">{children}</div>
  </section>;
}
