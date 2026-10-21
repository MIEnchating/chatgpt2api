import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type SelectOpenContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const SelectOpenContext = React.createContext<SelectOpenContextValue | null>(null);

function Select(allProps: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const {
    defaultOpen,
    onOpenChange,
    open,
    value,
    ...props
  } = allProps;
  const hasControlledValue = Object.prototype.hasOwnProperty.call(allProps, "value");
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen ?? false);
  const actualOpen = open ?? internalOpen;
  const setOpen = React.useCallback((nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  return (
    <SelectOpenContext.Provider value={{ open: actualOpen, setOpen }}>
      <SelectPrimitive.Root
        data-slot="select"
        open={actualOpen}
        onOpenChange={setOpen}
        {...(hasControlledValue ? { value: value ?? "" } : {})}
        {...props}
      />
    </SelectOpenContext.Provider>
  );
}

function SelectGroup(
  { className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>,
) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn("flex flex-col gap-0.5", className)} {...props} />;
}

function SelectValue(
  props: React.ComponentProps<typeof SelectPrimitive.Value>,
) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  const select = React.useContext(SelectOpenContext);

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm whitespace-nowrap shadow-xs outline-none transition-[border-color,box-shadow,background-color] duration-150 enabled:hover:border-ring/40 enabled:hover:bg-accent/30 data-[state=open]:border-foreground/25 data-[state=open]:bg-accent/30 motion-reduce:transition-none data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/20 [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left [&>span>span]:whitespace-nowrap",
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented && select?.open) {
          event.preventDefault();
          select.setOpen(false);
        }
      }}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown data-slot="select-icon" className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-in-out motion-reduce:transition-none", select?.open && "rotate-180")} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "relative z-[100] max-w-[calc(100vw-1rem)] min-w-[8rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-popover)] origin-[var(--radix-select-content-transform-origin)] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 motion-reduce:animate-none",
          position === "popper" &&
            "w-[var(--radix-select-trigger-width)] min-w-[min(12rem,calc(100vw-1rem))]",
          className,
        )}
        position={position}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...props}
      >
        <ScrollArea
          viewportTag={SelectPrimitive.Viewport}
          manageKeyboard={false}
          maxHeight="min(24rem, calc(var(--radix-select-content-available-height) - 0.5rem))"
          className="w-full"
          viewportClassName="w-full overscroll-contain p-1"
          viewClass="flex flex-col gap-0.5"
        >
          {children}
        </ScrollArea>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg py-2 pr-9 pl-3 text-sm leading-5 outline-none select-none transition-colors duration-150 motion-reduce:transition-none data-[disabled]:pointer-events-none data-[disabled]:opacity-60 data-[state=checked]:bg-accent data-[state=checked]:font-medium data-[state=checked]:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1",
        className,
      )}
      {...props}
    >
      <span className="absolute right-3 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>
        <span className="inline-flex max-w-full min-w-0 items-center gap-2 whitespace-normal [overflow-wrap:anywhere] [&_svg]:shrink-0">
          {children}
        </span>
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
};
