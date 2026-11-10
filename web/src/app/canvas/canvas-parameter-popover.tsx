import { ScrollArea } from "@/components/ui/scroll-area";
import { ItemMedia } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";


// Toolbar button that opens one group of node parameters in a floating panel,
// so settings no longer stack under the prompt editor.
export function CanvasParameterPopover({ icon, label, summary, width = 380, disabled = false, active = false, children }: {
  icon: ReactNode;
  label: string;
  summary?: ReactNode;
  width?: number;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0"><PopoverTrigger asChild>
            <Button variant={active ? "secondary" : "outline"}
              type="button"
              aria-label={label}
              disabled={disabled}
              className="inline-flex shrink-0 items-center whitespace-nowrap transition disabled:opacity-50 [&_svg]:shrink-0"
            >
              <span className="text-primary">{icon}</span>
              {summary ? <span className="font-semibold">{summary}</span> : <span>{label}</span>}
            </Button>
          </PopoverTrigger></span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        data-canvas-parameter-panel
        data-canvas-no-pan
        role="dialog"
        aria-label={label}
        className="max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1rem)]"
        style={{ width }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      ><ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="flex items-center gap-2 border-b border-border/60 pb-3">
          <ItemMedia variant="icon" className="grid size-7 shrink-0 place-items-center [&_svg]:size-4">{icon}</ItemMedia>
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <div className="min-w-0">{children}</div>
      </ScrollArea></PopoverContent>
    </Popover>
  );
}
