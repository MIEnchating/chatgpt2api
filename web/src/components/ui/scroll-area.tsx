"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
};

function ScrollArea({ className, children, viewportClassName, viewportRef, ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type="hover"
      scrollHideDelay={350}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full max-h-[inherit] overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none select-none bg-transparent p-0.5 data-[state=hidden]:animate-[scroll-area-fade-out_180ms_ease-in_forwards] data-[state=visible]:animate-[scroll-area-fade-in_160ms_ease-out_forwards]",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[#a4a8b0]/75 transition-colors hover:bg-[#7f848d] dark:bg-[#717680]/80 dark:hover:bg-[#9298a3]"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
