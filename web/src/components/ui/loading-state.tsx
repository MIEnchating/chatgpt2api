import { Spinner } from "./spinner";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function LoadingState({ label = "正在加载", description, compact = false, className, ...props }: ComponentProps<"div"> & { label?: string; description?: string; compact?: boolean }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className={cn("flex min-w-0 items-center justify-center", compact ? "h-auto gap-2 text-left" : "h-full min-h-40 flex-col gap-3 px-6 py-8 text-center", className)} {...props}>
      <Spinner  />
      <div className="grid min-w-0 max-w-sm gap-1">
        <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{label}</p>
        {description ? <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</p> : null}
      </div>
    </div>
  );
}
