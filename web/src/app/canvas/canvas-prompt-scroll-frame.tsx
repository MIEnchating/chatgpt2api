import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function CanvasPromptScrollFrame({ children, className }: { children: ReactNode; className?: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  const syncTextareaHeight = useCallback(() => {
    const frame = frameRef.current;
    const textarea = frame?.querySelector("textarea");
    if (!frame || !textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(frame.clientHeight, textarea.scrollHeight)}px`;
  }, []);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const textarea = frame?.querySelector("textarea");
    if (!frame || !textarea) return;
    const scheduleSync = () => requestAnimationFrame(syncTextareaHeight);
    syncTextareaHeight();
    textarea.addEventListener("input", scheduleSync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    observer?.observe(frame);
    return () => {
      textarea.removeEventListener("input", scheduleSync);
      observer?.disconnect();
    };
  }, [children, syncTextareaHeight]);

  return (
    <div ref={frameRef} className={cn("canvas-prompt-scroll-frame relative w-full overflow-hidden", className)}>
      <ScrollArea className="h-full" viewportClassName="h-full" viewClass="w-full" viewStyle={{ minHeight: "100%" }}>
        {children}
      </ScrollArea>
    </div>
  );
}
