import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-32 w-full min-w-0 resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-6 shadow-xs outline-none transition-[border-color,box-shadow,background-color] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
