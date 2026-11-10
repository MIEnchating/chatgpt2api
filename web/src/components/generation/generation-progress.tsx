import { Progress } from "@/components/ui/progress";
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
      <Progress
        value={value ?? null}
        aria-label={label}
        aria-valuetext={value === undefined ? "等待进度更新" : `${value}%`}
      />
    </div>
  );
}
