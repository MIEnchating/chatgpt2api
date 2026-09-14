import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type SectionNavigationItem<T extends string = string> = {
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
        "card-surface min-w-0 rounded-xl border border-border p-2 shadow-[var(--shadow-card)] lg:sticky lg:top-0",
        className,
      )}
    >
      <div className="px-2 pt-1 pb-2 lg:pb-3">
        <h1 className="break-words text-base font-semibold text-foreground">{title}</h1>
        <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <nav
        className="hide-scrollbar flex min-w-0 gap-1 overflow-x-auto p-1 lg:grid lg:overflow-visible"
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
                "flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card lg:w-full lg:gap-2.5",
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
