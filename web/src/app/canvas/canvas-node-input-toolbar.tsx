import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

export function CanvasNodeInputToolbar({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div data-canvas-input-toolbar className="flex min-w-0 shrink-0 items-center gap-2">
    <ScrollArea className="min-w-0 flex-1" viewportClassName="overscroll-contain" viewClass="flex w-max min-w-full items-center gap-1.5 [&>[data-canvas-inline-model]]:w-36 [&>[data-canvas-inline-model]]:flex-none">
      {children}
    </ScrollArea>
    {action ? <div className="shrink-0">{action}</div> : null}
  </div>;
}
