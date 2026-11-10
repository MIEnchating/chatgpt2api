import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import type { SettingsNavigationItem } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useActiveNavigation } from "@/lib/use-active-navigation";

export function SectionNavigation({ items, activeId, title }: { items: SettingsNavigationItem[]; activeId: string; title: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const activeItem = items.find((item) => item.id === activeId);
  const search = query.trim().toLocaleLowerCase();
  const visibleItems = items.filter((item) => `${item.label} ${item.group} ${item.keywords}`.toLocaleLowerCase().includes(search));
  const groups = [...new Set(visibleItems.map((item) => item.group))];
  const navigationRef = useActiveNavigation(`${activeId}:${query}:${open}`);

  return (
    <aside data-section-navigation className="flex min-h-0 min-w-0 flex-col border-b border-border p-4 md:h-full md:border-r md:border-b-0">
      <div className="flex min-h-9 items-center justify-between gap-2 pb-3">
        <h1 className="px-2 text-lg font-semibold">{title}</h1>
        <Button variant="ghost" className="min-w-0 md:hidden" aria-label="展开设置分类" aria-expanded={open} aria-controls="settings-navigation-content" onClick={() => setOpen((value) => !value)}>
          <span className="truncate">{activeItem?.label}</span><ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </Button>
      </div>
      <div id="settings-navigation-content" className={cn("hidden min-h-0 flex-col gap-4 md:flex md:flex-1", open && "flex")}>
        <SearchInput containerClassName="h-10" value={query} onValueChange={setQuery} placeholder="搜索设置" />
        {/* The viewport gutter completes the right inset while the rail stays at the sidebar edge. */}
        <ScrollArea className="-mx-4 max-h-[50dvh] min-h-0 w-[calc(100%+2rem)] flex-1 md:max-h-none" contentClassName="space-y-5 pb-3 pl-4 pr-1">
          <nav ref={navigationRef} aria-label="设置分类" onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a"));
            const index = links.indexOf(document.activeElement as HTMLAnchorElement);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + links.length) % links.length;
            links[next]?.focus();
          }} className="space-y-5">
            {groups.map((group) => <div key={group} className="space-y-1">
              <h2 className="px-2 pb-1 text-xs text-muted-foreground">{group}</h2>
              {visibleItems.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                const active = item.id === activeId;
                return <Button asChild key={item.id} variant={active ? "secondary" : "ghost"} className="h-11 w-full justify-start gap-2 px-3 font-normal">
                  <Link to={item.href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}><Icon className="size-[18px] shrink-0" /><span className="min-w-0 truncate">{item.label}</span></Link>
                </Button>;
              })}
            </div>)}
          </nav>
          {visibleItems.length === 0 ? <EmptyState compact title="没有匹配的设置" action={<Button variant="link" size="sm" onClick={() => setQuery("")}>清除搜索</Button>} /> : null}
        </ScrollArea>
      </div>
    </aside>
  );
}
