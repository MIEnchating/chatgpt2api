// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/suggestion
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Suggestions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("no-scrollbar flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain", className)} {...props} />;
}

export function Suggestion({ suggestion, onClick, children, className, disabled, ...props }: Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
}) {
  return <Button type="button" variant="outline" size="sm" className={cn("shrink-0", className)} disabled={disabled}
    onClick={() => { if (!disabled) onClick?.(suggestion); }} {...props}>{children ?? suggestion}</Button>;
}
