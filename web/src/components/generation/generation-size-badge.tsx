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
      "inline-flex min-w-0 max-w-full items-center break-words rounded-md bg-muted px-2 py-0.5 font-mono text-xs leading-5 text-muted-foreground dark:bg-muted dark:text-muted-foreground",
      highResolution && "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
    )}>
      {children}
    </span>
  );
}
