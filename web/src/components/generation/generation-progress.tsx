import { normalizeGenerationProgress } from "@/lib/generation-task-contract";
import { cn } from "@/lib/utils";

export function GenerationProgress({ progress, label = "生成进度", className }: {
  progress?: number;
  label?: string;
  className?: string;
}) {
  const value = normalizeGenerationProgress(progress);
  return (
    <div className={cn("min-w-0 w-full space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        <span className="shrink-0 tabular-nums">{value === undefined ? "等待进度更新" : `${value}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={value === undefined ? "等待进度更新" : `${value}%`}
        className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/20"
      >
        <div
          className={cn(
            "h-full rounded-full bg-brand transition-[width] duration-500 motion-reduce:transition-none",
            value === undefined && "animate-[generation-progress-indeterminate_1.5s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
          style={{ width: value === undefined ? "30%" : `${value}%` }}
        />
      </div>
    </div>
  );
}
