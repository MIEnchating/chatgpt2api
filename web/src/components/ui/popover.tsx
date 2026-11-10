// shadcn/ui (MIT). See LICENSE.shadcn.
"use client"

import * as React from "react"
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/use-overlay-layer"
import { cn } from "@/lib/utils"
import { Popover as PopoverPrimitive } from "radix-ui"

const popoverContentClassName = "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [&>:is([data-slot=popover-body],[data-slot=scroll-area])]:-mx-2.5 [&>:is([data-slot=popover-body],[data-slot=scroll-area])]:w-auto [&>:is([data-slot=popover-body],[data-slot=scroll-area])>[data-radix-scroll-area-viewport]]:px-2.5";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onOpenAutoFocus,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const layer = useOverlayLayer("popover");
  return (
    <OverlayLayerProvider value={layer}><PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        onOpenAutoFocus={(event) => { onOpenAutoFocus?.(event); event.preventDefault(); }}
        data-overlay-layer={layer}
        style={{ ...style, zIndex: layer }}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          popoverContentClassName,
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal></OverlayLayerProvider>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export { popoverContentClassName,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
