import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ eyebrow, title, actions, className }: PageHeaderProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          {eyebrow}
        </div>
        <h1 className="text-[1.75rem] leading-[1.18] font-semibold text-foreground sm:text-[2rem]">
          {title}
        </h1>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
    </section>
  );
}
