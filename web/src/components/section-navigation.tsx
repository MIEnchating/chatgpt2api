import type { LucideIcon } from "lucide-react";

import { useActiveNavigation } from "@/lib/use-active-navigation";
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
  const navigationRef = useActiveNavigation(activeId);

  return (
    <aside
      data-section-navigation
      className={cn(
        "card-surface min-w-0 rounded-xl border border-border p-2 shadow-[var(--shadow-card)] lg:sticky lg:top-0",
        className,
      )}
    >
      <div className="mb-2 border-b border-border/70 px-3 pt-1 pb-2 lg:pt-3 lg:pb-4">
        <h1 className="break-words text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 hidden break-words text-xs leading-5 text-muted-foreground lg:block">{description}</p>
      </div>
      <nav
        ref={navigationRef}
        className="hide-scrollbar flex min-w-0 gap-1 overflow-x-auto p-1 lg:grid lg:overflow-visible"
        aria-label={ariaLabel}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-controls={item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex min-h-10 min-w-0 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card lg:w-full lg:gap-2.5",
                active
                  ? "bg-brand-soft font-semibold text-brand ring-1 ring-inset ring-brand-border"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 whitespace-nowrap lg:whitespace-normal lg:break-words">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
