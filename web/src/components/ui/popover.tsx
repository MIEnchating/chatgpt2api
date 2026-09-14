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
          "z-50 flex min-w-0 flex-col max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] overflow-hidden overscroll-contain rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-popover)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      >
        {scrollable ? (
          <ScrollArea className="min-h-0 min-w-0 flex-1" maxHeight="calc(var(--radix-popover-content-available-height) - 1.5rem)">
            {children}
          </ScrollArea>
        ) : children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
