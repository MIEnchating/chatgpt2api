import { InputGroupAddon } from "@/components/ui/input-group";
import type { ReactNode } from "react";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";

export function CanvasNodeInputToolbar({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <InputGroupAddon align="block-end" data-canvas-input-toolbar className="min-w-0 shrink-0" onClick={(event) => event.stopPropagation()}>
    <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 flex w-max min-w-full items-center justify-end gap-1.5 [&>[data-canvas-inline-model]]:max-w-64 [&>[data-canvas-inline-model]]:flex-none">
      {children}
    </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
    {action ? <div className="shrink-0">{action}</div> : null}
  </InputGroupAddon>;
}
