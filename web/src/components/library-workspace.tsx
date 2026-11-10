import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function LibraryWorkspace({
  title,
  sidebar,
  footer,
  children,
}: {
  title: string;
  sidebar: ReactNode;
  footer?: ReactNode;
  children: (sidebarToggle: ReactNode) => ReactNode;
}) {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarID = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousContentLeft = useRef<number | null>(null);
  const open = desktop ? desktopOpen : mobileOpen;
  useLayoutEffect(() => {
    const content = contentRef.current;
    const previousLeft = previousContentLeft.current;
    previousContentLeft.current = null;
    if (!content || previousLeft === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const offset = previousLeft - content.getBoundingClientRect().left;
    if (!offset) return;
    // Animate position only so container queries resolve once at the final width.
    const animation = content.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
      { duration: 200, easing: "cubic-bezier(0, 0, 0.2, 1)" },
    );
    return () => animation.cancel();
  }, [open]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const change = () => setDesktop(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const label = open ? "收起资料分类" : "展开资料分类";
  const toggle = (
    <TooltipHint content={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-expanded={open}
        aria-controls={sidebarID}
        onClick={() => {
          previousContentLeft.current = contentRef.current?.getBoundingClientRect().left ?? null;
          if (desktop) setDesktopOpen((value) => !value);
          else setMobileOpen((value) => !value);
        }}
      >
        {open ? <PanelLeftClose /> : <PanelLeftOpen />}
      </Button>
    </TooltipHint>
  );
  return (
    <div
      data-library-workspace
      className={cn(
        "relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[0px_minmax(0,1fr)] md:grid-rows-1",
        desktopOpen && "md:grid-cols-[224px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)]",
      )}
    >
      <aside
        id={sidebarID}
        aria-label={`${title}分类`}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "row-start-1 min-h-0 min-w-0 overflow-hidden bg-background md:absolute md:inset-y-0 md:left-0 md:z-10 md:block md:w-[224px] md:transition-transform md:duration-200 md:ease-out motion-reduce:transition-none xl:w-[248px]",
          !open && "hidden md:-translate-x-full",
        )}
      >
        <div
          className="flex h-full min-h-0 min-w-0 flex-col border-b border-border md:w-[224px] md:border-r md:border-b-0 xl:w-[248px]"
        >
          <div className="flex h-16 shrink-0 items-center px-5">
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col"
            onClick={(event) => {
              if (!desktop && event.target instanceof Element && event.target.closest("[data-library-filter]"))
                setMobileOpen(false);
            }}
          >
            <ScrollArea
              className="max-h-[min(35dvh,200px)] min-h-0 flex-1 md:max-h-none"
              contentClassName="space-y-6 pl-4 pr-1 pb-5"
            >
              {sidebar}
            </ScrollArea>
            {footer ? <div className="shrink-0 px-4 py-4">{footer}</div> : null}
          </div>
        </div>
      </aside>
      <div ref={contentRef} className="row-start-2 flex min-h-0 min-w-0 flex-col md:col-start-2 md:row-start-1">{children(toggle)}</div>
    </div>
  );
}
