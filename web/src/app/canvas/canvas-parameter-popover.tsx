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
        className="min-h-0 max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1rem)] overflow-hidden"
        style={{ width }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 pb-3">
          <ItemMedia variant="icon" className="grid size-7 shrink-0 place-items-center [&_svg]:size-4">{icon}</ItemMedia>
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <ScrollArea data-slot="canvas-parameter-body" className="-mx-2.5 min-h-0 min-w-0 flex-1" contentClassName="px-2.5 py-2">
          {children}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
