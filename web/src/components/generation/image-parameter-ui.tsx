import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ImageParameterLabel({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-5 items-center gap-1 text-xs font-semibold text-[#3f4147] dark:text-foreground">
      <span>{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-4 items-center justify-center rounded-full text-[#92959c] transition hover:bg-black/[0.05] hover:text-[#45515e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
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
