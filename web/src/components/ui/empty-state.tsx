import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type EmptyStateProps = ComponentProps<"div"> & {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  compact?: boolean;
};

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-empty-state
      className={cn(
        "flex min-w-0 flex-col items-center justify-center px-4 sm:px-6 text-center",
        compact ? "min-h-32 py-6" : "min-h-48 py-10 sm:py-12",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="mb-4 grid size-12 shrink-0 place-items-center rounded-2xl border border-border/70 bg-muted/40 text-muted-foreground shadow-xs">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <p className="max-w-full text-sm leading-6 font-semibold text-foreground [overflow-wrap:anywhere]">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex w-full max-w-full flex-wrap justify-center gap-2 [&>[data-slot=button]]:max-w-full [&>[data-slot=button]]:whitespace-normal">{action}</div> : null}
    </div>
  );
}
