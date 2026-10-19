import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title?: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
  return (
    <header
      data-page-header
      className={cn(
        "flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1",
        className,
      )}
    >
      {title ? (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <h1 className="text-xl leading-8 font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
            {meta ? <span className="rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{meta}</span> : null}
          </div>
          {description ? <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {actions ? <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  );
}
