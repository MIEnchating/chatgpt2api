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
        compact ? "min-h-32 py-8" : "min-h-44 py-10",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="mb-3 grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
      ) : null}
      <p className="max-w-full text-sm leading-6 font-medium text-foreground [overflow-wrap:anywhere]">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex max-w-full flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
