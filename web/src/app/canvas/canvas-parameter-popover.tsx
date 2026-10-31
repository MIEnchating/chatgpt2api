import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              disabled={disabled}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-background/75 px-2.5 text-xs font-medium text-foreground transition hover:border-border hover:bg-background disabled:opacity-50 data-[state=open]:border-brand-border data-[state=open]:bg-brand-soft data-[state=open]:text-brand [&_svg]:size-3.5 [&_svg]:shrink-0",
                active && "border-brand-border text-brand",
              )}
            >
              <span className="text-brand">{icon}</span>
              {summary ? <span className="font-semibold">{summary}</span> : <span>{label}</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        data-canvas-parameter-panel
        data-canvas-no-pan
        role="dialog"
        aria-label={label}
        className="z-[1200] max-w-[calc(100vw-1rem)] p-3"
        style={{ width }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      >
        <div className="pr-1">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
