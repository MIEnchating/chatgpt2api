import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 backdrop-blur-[2px]",
        className,
      )}
      {...props}
    />
  );
}

type DialogContentProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  "onOpenAutoFocus"
> & {
  showCloseButton?: boolean;
  scrollable?: boolean;
};

function DialogContent({
  className,
  children,
  showCloseButton = true,
  scrollable = true,
  ...props
}: DialogContentProps) {
  const dialogChildren = flattenDialogChildren(children);
  const headers = dialogChildren.filter(isDialogHeaderElement);
  const footers = dialogChildren.filter(isDialogFooterElement);
  const body = dialogChildren.filter(
    (child) => !isDialogHeaderElement(child) && !isDialogFooterElement(child),
  );

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 flex max-h-[calc(100dvh-2rem)] w-[min(calc(100%-2rem),35rem)] min-w-0 max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-4 overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground outline-none p-[var(--dialog-padding)] [--dialog-padding:1.25rem] shadow-[var(--shadow-dialog)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 sm:[--dialog-padding:1.5rem] [&:has([data-slot=dialog-footer]:not([data-flush=true]))]:pb-3",
          className,
        )}
        {...props}
      >
        {scrollable ? (
          <>
            {headers}
            {body.length > 0 ? (
              <ScrollArea
                data-slot="dialog-body"
                className="-mx-1 min-h-0 min-w-0 flex-1 px-1"
                viewportClassName="overscroll-contain py-1"
                viewClass="grid min-w-0 gap-4"
              >
                {body}
              </ScrollArea>
            ) : null}
            {footers}
          </>
        ) : children}
        {showCloseButton ? (
          <DialogPrimitive.Close data-slot="dialog-auto-close" aria-label="关闭" className="absolute top-3 right-3 z-30 inline-flex size-9 items-center justify-center rounded-lg bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 sm:top-4 sm:right-4">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function flattenDialogChildren(children: React.ReactNode): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
      result.push(...flattenDialogChildren(child.props.children));
      return;
    }
    result.push(child);
  });
  return result;
}

function isDialogHeaderElement(child: React.ReactNode) {
  return React.isValidElement(child) && child.type === DialogHeader;
}

function isDialogFooterElement(child: React.ReactNode) {
  return React.isValidElement(child) && child.type === DialogFooter;
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("min-w-0 shrink-0 flex flex-col gap-2 pr-10 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  flush = false,
  ...props
}: React.ComponentProps<"div"> & { flush?: boolean }) {
  return (
    <div
      data-slot="dialog-footer"
      data-flush={flush || undefined}
      className={cn(
        "z-10 flex min-w-0 shrink-0 flex-col-reverse gap-2 bg-card sm:flex-row sm:flex-wrap sm:items-center sm:justify-end [&>[data-slot=button]]:min-w-18",
        flush && "min-h-15 border-t border-border bg-card px-5 py-3 sm:px-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-display min-w-0 text-xl leading-7 font-semibold [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
};
