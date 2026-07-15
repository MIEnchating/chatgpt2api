import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  actions: ReactNode;
  className?: string;
};

export function PageHeader({ actions, className }: PageHeaderProps) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-2",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
    </section>
  );
}
