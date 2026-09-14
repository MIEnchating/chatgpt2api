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
  props: React.ComponentProps<typeof SelectPrimitive.Group>,
) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
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
        "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm whitespace-nowrap shadow-xs outline-none transition-[border-color,box-shadow,background-color] data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/20 [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left [&>span>span]:whitespace-nowrap",
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
        <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition-transform duration-200 ease-in-out", select?.open && "rotate-180")} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "relative z-[100] max-w-[calc(100vw-1rem)] min-w-[8rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-popover)] data-[state=closed]:animate-out data-[state=open]:animate-in",
          position === "popper" &&
            "min-w-[min(var(--radix-select-trigger-width),calc(100vw-1rem))] data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
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
        "relative flex min-h-9 w-full min-w-0 cursor-default items-center gap-2 rounded-lg py-2 pr-8 pl-3 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-60 data-[state=checked]:bg-accent data-[state=checked]:font-medium data-[state=checked]:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-ring/30 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-4 items-center justify-center">
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
