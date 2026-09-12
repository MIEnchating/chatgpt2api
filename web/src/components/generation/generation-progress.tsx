import { normalizeGenerationProgress } from "@/lib/generation-task-contract";
import { cn } from "@/lib/utils";

export function GenerationProgress({ progress, label = "生成进度", className }: {
  progress?: number;
  label?: string;
  className?: string;
}) {
  const value = normalizeGenerationProgress(progress);
  return (
    <div className={cn("w-full space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{value === undefined ? "等待进度更新" : `${value}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={value === undefined ? "等待进度更新" : `${value}%`}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/15 ring-1 ring-inset ring-foreground/10"
      >
        <div
          className={cn(
            "h-full rounded-full bg-blue-600 transition-[width] duration-500 motion-reduce:transition-none dark:bg-blue-400",
            value === undefined && "animate-[generation-progress-indeterminate_1.5s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
          style={{ width: value === undefined ? "30%" : `${value}%` }}
        />
      </div>
    </div>
  );
}
