import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, actions, className }: PageHeaderProps) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <h1 className="min-w-0 truncate text-xl leading-7 font-semibold text-foreground">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </section>
  );
}
