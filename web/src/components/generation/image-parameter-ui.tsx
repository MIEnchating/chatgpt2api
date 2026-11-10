import { Button } from "@/components/ui/button";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ImageParameterLabel({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1 text-xs font-semibold text-foreground dark:text-foreground">
      <span className="min-w-0 break-words">{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs"
              type="button"
              className="inline-flex shrink-0 items-center justify-center"
              aria-label={`${String(children)}说明`}
            >
              <CircleHelp  />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{help}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
