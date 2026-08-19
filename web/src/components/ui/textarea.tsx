import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-32 w-full rounded-lg border border-input bg-background px-3 py-3 text-sm shadow-[0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
