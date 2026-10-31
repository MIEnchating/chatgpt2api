import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared collapsible header for agent surfaces (canvas task process, operation groups, execution records).
export function AgentDisclosureButton({ expanded, onToggle, leading, trailing, className, chevronClassName, children, ...props }: Omit<ComponentProps<"button">, "onClick"> & {
  expanded: boolean;
  onToggle: () => void;
  leading?: ReactNode;
  trailing?: ReactNode; chevronClassName?: string;
}) {
  return <button type="button" aria-expanded={expanded} onClick={onToggle} className={cn("flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
    {leading}
    {children}
    {trailing}
    <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90", chevronClassName)} />
  </button>;
}
