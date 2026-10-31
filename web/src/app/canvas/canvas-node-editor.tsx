import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function CanvasNodeEditor({ title, open, children, onClose, onFocus }: {
  title: string;
  open: boolean;
  children: ReactNode;
  onClose: () => void;
  onFocus: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;

  // After the editor grows, re-fit the viewport so the enlarged input stays fully visible.
  useEffect(() => {
    if (expanded && open) focusRef.current();
  }, [expanded, open]);

  const label = expanded ? "还原输入框" : "放大输入框";
  return <section data-canvas-node-editor data-expanded={expanded} aria-label={`${title}，节点编辑`} className={cn("group/editor relative flex w-full min-h-0 flex-col rounded-2xl border border-border bg-card/96 shadow-[var(--shadow-elevated)] backdrop-blur-xl", expanded ? "h-[min(72dvh,680px)]" : "h-[var(--canvas-node-editor-height)]", !open && "hidden")} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="absolute right-2 top-2 z-30">
      <TooltipButton tooltip={label} aria-label={label} aria-pressed={expanded} className="grid size-7 place-items-center rounded-lg bg-card/90 text-muted-foreground hover:bg-muted" onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</TooltipButton>
    </div>
    <div className="min-h-0 flex-1 p-3">{children}</div>
  </section>;
}
