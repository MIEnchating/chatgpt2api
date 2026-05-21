import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ eyebrow, title, actions, className }: PageHeaderProps) {
  void eyebrow;
  void title;
  if (!actions) {
    return null;
  }

  return (
    <section
      className={cn(
        "flex flex-wrap items-center justify-end gap-2",
        className,
      )}
    >
      {actions}
    </section>
  );
}
