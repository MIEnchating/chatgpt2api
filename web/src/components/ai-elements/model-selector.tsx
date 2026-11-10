// AI Elements Model Selector: https://elements.ai-sdk.dev/components/model-selector
// Search composition: https://ui.shadcn.com/docs/ai-elements/radix/model-selector
import type { ComponentProps, ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function ModelSelector(props: ComponentProps<typeof Popover>) {
  return <Popover {...props} />;
}

export function ModelSelectorTrigger(props: ComponentProps<typeof PopoverTrigger>) {
  return <PopoverTrigger {...props} />;
}

export function ModelSelectorContent({ title = "选择模型", className, children, ...props }: ComponentProps<typeof PopoverContent> & { title?: ReactNode }) {
  return <PopoverContent aria-label={typeof title === "string" ? title : undefined} align="start" className={cn("w-[min(20rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] gap-0 overflow-hidden p-0", className)} {...props}>
    <Command className="min-h-0">{children}</Command>
  </PopoverContent>;
}

export function ModelSelectorInput(props: ComponentProps<typeof CommandInput>) {
  return <CommandInput {...props} />;
}

export function ModelSelectorList({ className, ...props }: ComponentProps<typeof CommandList>) {
  return <CommandList className={cn("min-h-0 max-h-[min(24rem,calc(var(--radix-popover-content-available-height)-3rem))]", className)} {...props} />;
}

export function ModelSelectorEmpty(props: ComponentProps<typeof CommandEmpty>) {
  return <CommandEmpty {...props} />;
}

export function ModelSelectorGroup(props: ComponentProps<typeof CommandGroup>) {
  return <CommandGroup {...props} />;
}

export function ModelSelectorItem(props: ComponentProps<typeof CommandItem>) {
  return <CommandItem {...props} />;
}

export function ModelSelectorName({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("flex-1 truncate text-left", className)} {...props} />;
}
