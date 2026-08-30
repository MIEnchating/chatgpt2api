import { cn } from "@/lib/utils";

export function GenerationSizeBadge({
  children,
  highResolution = false,
}: {
  children: string;
  highResolution?: boolean;
}) {
  return (
    <span className={cn(
      "shrink-0 rounded-md bg-[#f3f4f6] px-2 py-0.5 font-mono text-[11px] text-[#686b73] dark:bg-muted dark:text-muted-foreground",
      highResolution && "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
    )}>
      {children}
    </span>
  );
}
