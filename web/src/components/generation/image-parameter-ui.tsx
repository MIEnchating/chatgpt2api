import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ImageParameterLabel({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-5 items-center gap-1 text-xs font-semibold text-foreground dark:text-foreground">
      <span>{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${String(children)}说明`}
            >
              <CircleHelp className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{help}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
