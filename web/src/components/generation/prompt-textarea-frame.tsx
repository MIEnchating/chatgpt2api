import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function PromptTextareaFrame({ children, className }: { children: ReactNode; className?: string }) {
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
    syncTextareaHeight();
    textarea.addEventListener("input", scheduleSync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    observer?.observe(frame);
    return () => {
      textarea.removeEventListener("input", scheduleSync);
      observer?.disconnect();
      if (frameID !== null) cancelAnimationFrame(frameID);
    };
  }, [children, syncTextareaHeight]);

  return (
    <div ref={frameRef} className={cn("canvas-prompt-scroll-frame relative min-w-0 w-full overflow-hidden", className)}>
      <ScrollArea className="h-full" viewportClassName="h-full" viewClass="w-full" viewStyle={{ minHeight: "100%" }}>
        {children}
      </ScrollArea>
    </div>
  );
}
