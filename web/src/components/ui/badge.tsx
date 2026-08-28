import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-5 max-w-full items-center justify-center gap-1 rounded-md border px-2 py-0.5 align-middle text-[11px] leading-4 font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-[#bfd1fb] bg-[#edf4ff] text-[#1456f0] dark:border-sky-800/80 dark:bg-sky-950/40 dark:text-sky-300",
        secondary:
          "border-border/70 bg-muted/65 text-muted-foreground dark:border-white/10 dark:bg-white/6 dark:text-white/65",
        outline:
          "border-border/80 bg-transparent text-foreground/75 dark:border-white/14 dark:text-white/72",
        success:
          "border-emerald-200/90 bg-emerald-50/80 text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/35 dark:text-emerald-300",
        warning:
          "border-amber-200/90 bg-amber-50/80 text-amber-700 dark:border-amber-800/80 dark:bg-amber-950/35 dark:text-amber-300",
        danger:
          "border-rose-200/90 bg-rose-50/80 text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/35 dark:text-rose-300",
        info:
          "border-sky-200/90 bg-sky-50/80 text-[#1456f0] dark:border-sky-800/80 dark:bg-sky-950/35 dark:text-sky-300",
        violet:
          "border-violet-200/90 bg-violet-50/80 text-violet-700 dark:border-violet-800/80 dark:bg-violet-950/35 dark:text-violet-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge };
