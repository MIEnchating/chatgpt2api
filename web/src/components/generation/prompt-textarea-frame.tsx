import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function PromptTextareaFrame({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  const syncTextareaHeight = useCallback(() => {
    const frame = frameRef.current;
    const textarea = frame?.querySelector("textarea");
    if (!frame || !textarea) return;
    const viewport = frame.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    const scrollTop = viewport?.scrollTop || 0;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(frame.clientHeight, textarea.scrollHeight)}px`;
    // Measuring the collapsed textarea must not reset the surrounding scroll position.
    if (viewport) viewport.scrollTop = scrollTop;
  }, []);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const textarea = frame?.querySelector("textarea");
    if (!frame || !textarea) return;
    let frameID: number | null = null;
    const scheduleSync = () => {
      if (frameID !== null) cancelAnimationFrame(frameID);
      frameID = requestAnimationFrame(() => {
        frameID = null;
        syncTextareaHeight();
      });
    };
    textarea.addEventListener("input", scheduleSync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    observer?.observe(frame);
    return () => {
      textarea.removeEventListener("input", scheduleSync);
      observer?.disconnect();
      if (frameID !== null) cancelAnimationFrame(frameID);
    };
  }, [syncTextareaHeight]);

  useLayoutEffect(syncTextareaHeight, [value, syncTextareaHeight]);

  return (
    <div ref={frameRef} className={cn("canvas-prompt-scroll-frame relative min-w-0 w-full overflow-hidden", className)}>
      <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden h-full" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain h-full"><div className="min-w-0 w-full" style={{ minHeight: "100%" }}>
        {children}
      </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
    </div>
  );
}
