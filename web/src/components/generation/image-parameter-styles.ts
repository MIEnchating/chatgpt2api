import { cn } from "@/lib/utils";

export function imageParameterChoiceClass(active: boolean, className?: string) {
  return cn(
    "min-w-0 rounded-md border border-transparent bg-transparent px-2 text-xs text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-current",
    active &&
      "border-border bg-background font-semibold text-brand shadow-sm hover:bg-background hover:text-brand",
    className,
  );
}
