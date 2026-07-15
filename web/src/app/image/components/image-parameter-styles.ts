import { cn } from "@/lib/utils";

export function imageParameterChoiceClass(active: boolean, className?: string) {
  return cn(
    "min-w-0 rounded-md border border-transparent bg-transparent px-2 text-xs text-[#5f626a] transition hover:bg-white/70 hover:text-[#222222] dark:text-muted-foreground dark:hover:bg-background/60 dark:hover:text-foreground",
    active &&
      "border-white bg-white font-semibold text-[#1456f0] shadow-sm hover:bg-white dark:border-border dark:bg-background dark:text-sky-300 dark:hover:bg-background",
    className,
  );
}
