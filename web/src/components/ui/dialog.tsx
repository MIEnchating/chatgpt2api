// shadcn/ui (MIT). See LICENSE.shadcn.
import { XIcon } from "lucide-react"

import * as React from "react"
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/use-overlay-layer"
import { cn } from "@/lib/utils"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const layer = useOverlayLayer("modal");
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  return (
    <OverlayLayerProvider value={layer}><DialogPortal>
      <DialogOverlay style={{ zIndex: layer - 1 }} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          const ownerDocument = (event.currentTarget as HTMLElement).ownerDocument;
          const activeElement = ownerDocument.activeElement;
          const menuTriggerId = activeElement instanceof HTMLElement ? activeElement.closest("[role='menu']")?.getAttribute("aria-labelledby") : null;
          const menuTrigger = menuTriggerId ? ownerDocument.getElementById(menuTriggerId) : null;
          returnFocusRef.current = menuTrigger instanceof HTMLElement ? menuTrigger : activeElement instanceof HTMLElement && activeElement !== ownerDocument.body ? activeElement : null;
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented || !returnFocusRef.current?.isConnected) return;
          event.preventDefault();
          returnFocusRef.current.focus({ preventScroll: true });
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (event.target instanceof Element && event.target.closest("[data-sonner-toaster]")) event.preventDefault();
        }}
        data-overlay-layer={layer}
        style={{ ...style, zIndex: layer }}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col overflow-hidden w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          "[&>:is([data-slot=dialog-body],[data-slot=scroll-area])]:-mx-4 [&>:is([data-slot=dialog-body],[data-slot=scroll-area])]:w-auto [&>:is([data-slot=dialog-body],[data-slot=scroll-area])>[data-radix-scroll-area-viewport]]:px-4",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
               />
              <span className="sr-only">关闭</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal></OverlayLayerProvider>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-2 pr-8", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">关闭</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "cn-font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
