import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "./empty";
import { cn } from "@/lib/utils";

type EmptyStateProps = ComponentProps<"div"> & {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  compact?: boolean;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
};

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  compact = false,
  headingLevel,
  className,
  ...props
}: EmptyStateProps) {
  return <Empty data-empty-state className={cn(compact ? "min-h-32" : "min-h-48", className)} {...props}>
    <EmptyHeader>
      {Icon ? <EmptyMedia variant="icon"><Icon aria-hidden="true" /></EmptyMedia> : null}
      <EmptyTitle role={headingLevel ? "heading" : undefined} aria-level={headingLevel}>{title}</EmptyTitle>
      {description ? <EmptyDescription>{description}</EmptyDescription> : null}
    </EmptyHeader>
    {action ? <EmptyContent>{action}</EmptyContent> : null}
  </Empty>;
}
