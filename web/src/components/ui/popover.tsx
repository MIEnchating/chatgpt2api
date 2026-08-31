"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverContentProps = Omit<
  React.ComponentProps<typeof PopoverPrimitive.Content>,
  "onOpenAutoFocus"
> & {
  scrollable?: boolean;
};

function PopoverContent({
  className,
  children,
  align = "center",
  sideOffset = 6,
  scrollable = true,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        onOpenAutoFocus={(event) => event.preventDefault()}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] overscroll-contain rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] outline-none",
          className,
        )}
        {...props}
      >
        {scrollable ? (
          <ScrollArea className="max-h-[var(--radix-popover-content-available-height)]" viewportClassName="max-h-[var(--radix-popover-content-available-height)]">
            {children}
          </ScrollArea>
        ) : children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
