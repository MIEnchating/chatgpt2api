import { PromptInput } from "@/components/ai-elements/prompt-input";
import { Card } from "@/components/ui/card";
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
    <DialogContent data-canvas-node-editor data-canvas-no-pan data-canvas-no-zoom data-expanded="true" aria-describedby={undefined} showCloseButton={false}
      className={cn("sm:max-w-none", cn("h-[min(760px,calc(100dvh-2rem))] [&_.canvas-prompt-scroll-frame]:h-[min(52dvh,480px)] [&_.canvas-prompt-editor-resize]:h-[min(52dvh,480px)]", "group/editor w-[min(880px,calc(100%-2rem))]"))}
      onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="min-w-0 truncate">{title} · 输入与参数</DialogTitle>
        <TooltipButton tooltip="还原输入框" aria-label="还原输入框" className="grid shrink-0 place-items-center" onClick={() => setExpanded(false)}><Minimize2  /></TooltipButton>
      </DialogHeader>
      <div className="min-h-0 flex-1"><PromptInput className="h-full min-h-0 flex-col items-stretch">{children}</PromptInput></div>
    </DialogContent>
  </Dialog>;

  return <Card className={cn("gap-0 overflow-visible p-0", !open && "hidden")}>
    <PromptInput data-canvas-node-editor data-expanded="false" aria-label={`${title}，节点编辑`} className="group/editor relative flex h-[var(--canvas-node-editor-height)] w-full min-h-0 flex-col items-stretch" onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
      <div className="absolute right-2 top-2 z-30">
        <TooltipButton tooltip="放大输入框" aria-label="放大输入框" className="grid place-items-center" onClick={() => setExpanded(true)}><Maximize2  /></TooltipButton>
      </div>
      <div className="min-h-0 w-full flex-1 pt-3">{children}</div>
    </PromptInput>
  </Card>;
}
