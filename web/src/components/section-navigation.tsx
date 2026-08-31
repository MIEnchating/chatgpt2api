import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type SectionNavigationItem<T extends string = string> = {
  id: T;
  label: string;
  icon: LucideIcon;
};

type SectionNavigationProps<T extends string> = {
  title: string;
  description: string;
  items: SectionNavigationItem<T>[];
  activeId: T;
  ariaLabel: string;
  onSelect: (id: T) => void;
  className?: string;
};

export function SectionNavigation<T extends string>({
  title,
  description,
  items,
  activeId,
  ariaLabel,
  onSelect,
  className,
}: SectionNavigationProps<T>) {
  return (
    <aside
      data-section-navigation
      className={cn(
        "card-surface rounded-xl border border-border/80 p-2 shadow-[0_4px_16px_rgba(24,40,72,0.05)] lg:sticky lg:top-0",
        className,
      )}
    >
      <div className="px-2 pt-1 pb-2 lg:pb-3">
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <nav
        className="hide-scrollbar flex gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0"
        aria-label={ariaLabel}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors lg:w-full lg:gap-2.5",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
