import type { ReactNode } from "react";
import { SectionNavigation } from "@/components/section-navigation";
import type { SettingsNavigationItem } from "@/lib/settings-navigation";

export function SettingsWorkspace({ activeId, children, items, title }: { activeId: string; children: ReactNode; items: SettingsNavigationItem[]; title: string }) {
  return <div data-settings-workspace className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[248px_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[264px_minmax(0,1fr)]">
    <SectionNavigation items={items} activeId={activeId} title={title} />
    <section id={activeId} aria-label={items.find((item) => item.id === activeId)?.label} className="min-h-0 min-w-0 p-4 sm:p-6 lg:p-10">
      <div data-settings-content className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </section>
  </div>;
}
